import crypto from 'crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const sqs = new SQSClient();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

const { SQS_QUEUE_URL, DYNAMODB_TABLE, GITHUB_WEBHOOK_SECRET } = process.env;

function verifySignature(payload, signature) {
  if (!GITHUB_WEBHOOK_SECRET) return true; // skip if no secret configured
  if (!signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(payload, 'utf-8')
    .digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

export const handler = async (event) => {
  const body = event.body;
  const signature = event.headers?.['x-hub-signature-256'];
  const githubEvent = event.headers?.['x-github-event'];

  // Verify webhook signature
  if (!verifySignature(body, signature)) {
    console.error('Invalid webhook signature');
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  // Respond to ping events (GitHub sends this when webhook is first configured)
  if (githubEvent === 'ping') {
    console.log('Received ping event');
    return { statusCode: 200, body: JSON.stringify({ message: 'pong' }) };
  }

  const payload = JSON.parse(body);

  // Determine if this is a relevant event
  let repoFullName, cloneUrl, branch, commitSha, prNumber, sender;

  if (githubEvent === 'pull_request') {
    const action = payload.action;
    if (!['opened', 'synchronize', 'reopened'].includes(action)) {
      return { statusCode: 200, body: JSON.stringify({ message: `Ignoring PR action: ${action}` }) };
    }
    repoFullName = payload.repository.full_name;
    cloneUrl = payload.repository.clone_url;
    branch = payload.pull_request.head.ref;
    commitSha = payload.pull_request.head.sha;
    prNumber = payload.pull_request.number;
    sender = payload.sender.login;
  } else if (githubEvent === 'push') {
    repoFullName = payload.repository.full_name;
    cloneUrl = payload.repository.clone_url;
    branch = payload.ref.replace('refs/heads/', '');
    commitSha = payload.after;
    sender = payload.sender.login;
  } else {
    return { statusCode: 200, body: JSON.stringify({ message: `Ignoring event: ${githubEvent}` }) };
  }

  const scanId = `${Date.now()}-${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  // Write initial scan record to DynamoDB
  await ddb.send(new PutCommand({
    TableName: DYNAMODB_TABLE,
    Item: {
      repoName: repoFullName,
      scanId,
      status: 'QUEUED',
      createdAt,
      branch,
      commitSha,
      ...(prNumber && { prNumber }),
      sender,
    },
  }));

  // Enqueue scan job to SQS
  await sqs.send(new SendMessageCommand({
    QueueUrl: SQS_QUEUE_URL,
    MessageBody: JSON.stringify({
      scanId,
      repoFullName,
      cloneUrl,
      branch,
      commitSha,
      prNumber,
    }),
  }));

  console.log(`Queued scan ${scanId} for ${repoFullName}@${branch} (${commitSha.slice(0, 7)})`);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Scan queued', scanId }),
  };
};
