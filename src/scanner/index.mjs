import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { scanDirectory, scanCode } from './scanner.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());
const s3 = new S3Client();
const sns = new SNSClient();
const cw = new CloudWatchClient();

const { DYNAMODB_TABLE, S3_REPORTS_BUCKET, GITHUB_TOKEN, SNS_SECURITY_FINDINGS_TOPIC_ARN } = process.env;
const CW_NAMESPACE = 'SASTScanner';

// GitHub issue/PR comment body max is 65536 UTF-8 chars; leave margin for header/footer.
const GITHUB_COMMENT_MAX_CHARS = 62000;

function sortFindingsForDisplay(vulns) {
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return [...vulns].sort((a, b) => {
    const sa = order[a.severity] ?? 3;
    const sb = order[b.severity] ?? 3;
    if (sa !== sb) return sa - sb;
    const fa = a.file || '';
    const fb = b.file || '';
    if (fa !== fb) return fa.localeCompare(fb);
    return (a.line || 0) - (b.line || 0);
  });
}

function formatFindingBlock(v, index) {
  const desc = v.description ? `\n  - detail: ${v.description}` : '';
  const ev = v.evidence ? `\n  - evidence: \`${String(v.evidence).replace(/`/g, "'")}\`` : '';
  return [
    `#### ${index + 1}. \`${v.id}\` (${v.severity}) — ${v.name}`,
    `- **File:** \`${v.file}:${v.line}\``,
    `- **Message:** ${v.message}${desc}${ev}`,
  ].join('\n');
}

function buildFullPrCommentBody({ scanId, repoFullName, report, allVulnerabilities }) {
  const sorted = sortFindingsForDisplay(allVulnerabilities);
  const header = [
    `## SAST scan results`,
    ``,
    `**scanId:** \`${scanId}\``,
    `**repo:** \`${repoFullName}\``,
    `**branch:** \`${report.branch}\` · **commit:** \`${report.commitSha?.slice(0, 7) ?? ''}\``,
    `**severity counts:** HIGH=${report.summary.high}, MEDIUM=${report.summary.medium}, LOW=${report.summary.low} (total=${report.summary.totalVulnerabilities})`,
    ``,
    `### All findings (${sorted.length})`,
    ``,
  ].join('\n');

  let body = header;
  let included = 0;
  for (let i = 0; i < sorted.length; i++) {
    const block = formatFindingBlock(sorted[i], i) + '\n\n';
    if (body.length + block.length > GITHUB_COMMENT_MAX_CHARS) {
      const omitted = sorted.length - included;
      body += `\n\n---\n*${omitted} more finding(s) omitted: GitHub comment size limit (~65k chars). Full JSON is in S3 report for this scan.*\n`;
      break;
    }
    body += block;
    included++;
  }
  return body;
}

async function postPullRequestComment({ repoFullName, prNumber, body }) {
  const [owner, repo] = (repoFullName || '').split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFullName: ${repoFullName}`);
  if (!prNumber) throw new Error('Missing prNumber');
  if (!GITHUB_TOKEN) throw new Error('Missing GITHUB_TOKEN');

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'cs6620-sast-scanner',
    },
    body: JSON.stringify({ body }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub comment failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
}

async function emitMetrics(metricData) {
  try {
    await cw.send(new PutMetricDataCommand({
      Namespace: CW_NAMESPACE,
      MetricData: metricData,
    }));
  } catch (err) {
    console.error('CloudWatch PutMetricData failed:', err);
  }
}

async function updateScanStatus(repoName, scanId, updates) {
  const expressionParts = [];
  const names = {};
  const values = {};

  for (const [key, value] of Object.entries(updates)) {
    const attrName = `#${key}`;
    const attrValue = `:${key}`;
    expressionParts.push(`${attrName} = ${attrValue}`);
    names[attrName] = key;
    values[attrValue] = value;
  }

  await ddb.send(new UpdateCommand({
    TableName: DYNAMODB_TABLE,
    Key: { repoName, scanId },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

export const handler = async (event) => {
  for (const record of event.Records) {
    const job = JSON.parse(record.body);
    const { scanId, repoFullName, cloneUrl, branch, commitSha, prNumber } = job;
    const startTime = Date.now();
    const cloneDir = `/tmp/repo-${scanId}`;

    try {
      // Mark scan as in progress
      await updateScanStatus(repoFullName, scanId, {
        status: 'SCANNING',
        startedAt: new Date().toISOString(),
      });

      // Clone the repository (shallow clone for speed)
      const authUrl = GITHUB_TOKEN
        ? cloneUrl.replace('https://', `https://x-access-token:${GITHUB_TOKEN}@`)
        : cloneUrl;

      console.log(`Cloning ${repoFullName}@${branch} (${commitSha.slice(0, 7)})...`);
      execSync(
        `git clone --depth 1 --branch ${branch} "${authUrl}" "${cloneDir}"`,
        { timeout: 60000, stdio: 'pipe' }
      );

      // Run SAST scan on the cloned repo
      console.log(`Scanning ${cloneDir}...`);
      const results = scanDirectory(cloneDir);

      // Build report
      const allVulnerabilities = Object.values(results).flat();

      // Rewrite file paths to be relative to repo root
      for (const vulns of Object.values(results)) {
        for (const v of vulns) {
          v.file = v.file.replace(cloneDir + '/', '');
        }
      }

      const report = {
        scanId,
        repoFullName,
        branch,
        commitSha,
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        summary: {
          totalVulnerabilities: allVulnerabilities.length,
          high: allVulnerabilities.filter(v => v.severity === 'HIGH').length,
          medium: allVulnerabilities.filter(v => v.severity === 'MEDIUM').length,
          low: allVulnerabilities.filter(v => v.severity === 'LOW').length,
          filesWithIssues: Object.keys(results).length,
        },
        vulnerabilities: allVulnerabilities.map(v => ({
          ...v,
          file: v.file.replace(cloneDir + '/', ''),
        })),
      };

      // Upload full report to S3
      const s3Key = `${repoFullName}/${scanId}.json`;
      await s3.send(new PutObjectCommand({
        Bucket: S3_REPORTS_BUCKET,
        Key: s3Key,
        Body: JSON.stringify(report, null, 2),
        ContentType: 'application/json',
      }));

      // Update DynamoDB with results
      const durationMs = Date.now() - startTime;
      await updateScanStatus(repoFullName, scanId, {
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
        durationMs,
        s3ReportKey: s3Key,
        summary: report.summary,
      });

      // Emit CloudWatch metrics for completed scan
      // Emit both with and without dimensions — dashboard widgets query dimension-less metrics,
      // while per-repo dimensions allow filtering by repository.
      const timestamp = new Date();
      const metricsBase = [
        { MetricName: 'ScanCompleted', Value: 1, Unit: 'Count', Timestamp: timestamp },
        { MetricName: 'ScanDuration', Value: durationMs, Unit: 'Milliseconds', Timestamp: timestamp },
        { MetricName: 'VulnerabilitiesFound', Value: allVulnerabilities.length, Unit: 'Count', Timestamp: timestamp },
        { MetricName: 'HighSeverityFindings', Value: report.summary.high, Unit: 'Count', Timestamp: timestamp },
      ];
      const metricsWithDims = metricsBase.map(m => ({
        ...m,
        Dimensions: [{ Name: 'Repository', Value: repoFullName }],
      }));
      await emitMetrics([...metricsBase, ...metricsWithDims]);

      // Security alert: publish once when any HIGH severity findings exist.
      // Requirement: topic-based notification, message includes repo/scanId and findings summary (no S3 link).
      if (report.summary?.high > 0 && SNS_SECURITY_FINDINGS_TOPIC_ARN) {
        const topHighFindings = allVulnerabilities
          .filter(v => v.severity === 'HIGH')
          .sort((a, b) => a.line - b.line)
          .slice(0, 5)
          .map(v => ({
            id: v.id,
            name: v.name,
            file: v.file,
            line: v.line,
            evidence: v.evidence,
            message: v.message,
          }));

        const messageText = [
          `SAST HIGH findings`,
          `repoName: ${repoFullName}`,
          `scanId: ${scanId}`,
          `severityCounts: high=${report.summary.high}, medium=${report.summary.medium}, low=${report.summary.low}`,
          `totalVulnerabilities: ${report.summary.totalVulnerabilities}`,
          `filesWithIssues: ${report.summary.filesWithIssues}`,
          `topFindings (up to 5):`,
          ...topHighFindings.map((f, idx) =>
            `${idx + 1}. [${f.id}] ${f.name} @ ${f.file}:${f.line}\n   message: ${f.message}\n   evidence: ${f.evidence}`
          ),
        ].join('\n');

        try {
          await sns.send(new PublishCommand({
            TopicArn: SNS_SECURITY_FINDINGS_TOPIC_ARN,
            Subject: `SAST HIGH findings: ${repoFullName}`,
            Message: messageText,
          }));
        } catch (publishErr) {
          // Notification failure should not mark the scan as failed.
          console.error('SNS publish failed (HIGH findings):', publishErr);
        }
      }

      // Optional: PR comment write-back (only for pull_request-triggered scans).
      // Lists all findings (sorted by severity, file, line); GitHub caps ~65k chars — we truncate with a note if needed.
      if (prNumber && GITHUB_TOKEN) {
        const commentBody = buildFullPrCommentBody({
          scanId,
          repoFullName,
          report,
          allVulnerabilities,
        });

        try {
          await postPullRequestComment({
            repoFullName,
            prNumber,
            body: commentBody,
          });
        } catch (commentErr) {
          // Do not fail the scan if GitHub commenting fails.
          console.error('GitHub PR comment failed:', commentErr);
        }
      }

      console.log(`Scan ${scanId} completed: ${allVulnerabilities.length} vulnerabilities found in ${durationMs}ms`);

    } catch (error) {
      console.error(`Scan ${scanId} failed:`, error);
      const failDuration = Date.now() - startTime;
      await updateScanStatus(repoFullName, scanId, {
        status: 'FAILED',
        completedAt: new Date().toISOString(),
        error: error.message,
        durationMs: failDuration,
      });

      // Emit CloudWatch failure metric (with and without dimensions)
      const failTimestamp = new Date();
      await emitMetrics([
        { MetricName: 'ScanFailed', Value: 1, Unit: 'Count', Timestamp: failTimestamp },
        { MetricName: 'ScanFailed', Value: 1, Unit: 'Count', Timestamp: failTimestamp,
          Dimensions: [{ Name: 'Repository', Value: repoFullName }] },
      ]);

      // Re-throw so SQS retries and the message reaches the configured DLQ.
      throw error;
    } finally {
      // Clean up cloned repo
      if (fs.existsSync(cloneDir)) {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }
    }
  }
};
