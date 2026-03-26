import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const sns = new SNSClient();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

const { SNS_SECURITY_FINDINGS_TOPIC_ARN, DYNAMODB_TABLE } = process.env;

function safeJsonParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export const handler = async (event) => {
  for (const record of event.Records || []) {
    const job = safeJsonParse(record.body) || {};
    const { scanId, repoFullName } = job;

    let errorMessage = job.error || 'Scan failed (no error details in payload)';

    // Best-effort: scan worker writes `error` into DynamoDB before failing.
    if (repoFullName && scanId) {
      try {
        const res = await ddb.send(new GetCommand({
          TableName: DYNAMODB_TABLE,
          Key: { repoName: repoFullName, scanId },
        }));
        errorMessage = res?.Item?.error || errorMessage;
      } catch (ddbErr) {
        console.error('Failed to read DynamoDB error:', ddbErr);
      }
    }

    if (!SNS_SECURITY_FINDINGS_TOPIC_ARN) {
      console.error('SNS_SECURITY_FINDINGS_TOPIC_ARN is not configured');
      continue;
    }

    const messageObj = {
      type: 'SCAN_FAILED',
      repoName: repoFullName,
      scanId,
      error: errorMessage,
    };

    const messageText = [
      `SAST scan failed`,
      `repoName: ${repoFullName}`,
      `scanId: ${scanId}`,
      `error: ${errorMessage}`,
    ].join('\n');

    try {
      await sns.send(new PublishCommand({
        TopicArn: SNS_SECURITY_FINDINGS_TOPIC_ARN,
        Subject: `SAST scan failed: ${repoFullName}`,
        Message: messageText,
      }));
    } catch (publishErr) {
      // Avoid re-processing the same DLQ message if SNS publishing fails.
      console.error('SNS publish failed (DLQ notifier):', publishErr);
    }
  }
};

