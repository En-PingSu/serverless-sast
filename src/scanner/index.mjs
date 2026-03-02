import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { scanDirectory, scanCode } from './scanner.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());
const s3 = new S3Client();

const { DYNAMODB_TABLE, S3_REPORTS_BUCKET, GITHUB_TOKEN } = process.env;

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
    const { scanId, repoFullName, cloneUrl, branch, commitSha } = job;
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

      console.log(`Scan ${scanId} completed: ${allVulnerabilities.length} vulnerabilities found in ${durationMs}ms`);

    } catch (error) {
      console.error(`Scan ${scanId} failed:`, error);
      await updateScanStatus(repoFullName, scanId, {
        status: 'FAILED',
        completedAt: new Date().toISOString(),
        error: error.message,
        durationMs: Date.now() - startTime,
      });
    } finally {
      // Clean up cloned repo
      if (fs.existsSync(cloneDir)) {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }
    }
  }
};
