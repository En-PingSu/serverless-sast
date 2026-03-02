import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());
const s3 = new S3Client();

const { DYNAMODB_TABLE, S3_REPORTS_BUCKET } = process.env;

// Route handler: GET /scans
async function listScans(queryParams) {
  const repo = queryParams?.repo;
  const limit = parseInt(queryParams?.limit) || 20;

  if (repo) {
    // Query by repo name (uses partition key)
    const result = await ddb.send(new QueryCommand({
      TableName: DYNAMODB_TABLE,
      KeyConditionExpression: 'repoName = :repo',
      ExpressionAttributeValues: { ':repo': repo },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }));
    return { scans: result.Items, count: result.Count };
  }

  // Full table scan (acceptable at small scale)
  const result = await ddb.send(new ScanCommand({
    TableName: DYNAMODB_TABLE,
    Limit: limit,
  }));

  // Sort by createdAt descending
  const sorted = result.Items.sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || '')
  );

  return { scans: sorted, count: result.Count };
}

// Route handler: GET /scans/{scanId}
async function getScan(scanId) {
  // Use GSI to look up by scanId alone
  const result = await ddb.send(new QueryCommand({
    TableName: DYNAMODB_TABLE,
    IndexName: 'scanId-index',
    KeyConditionExpression: 'scanId = :scanId',
    ExpressionAttributeValues: { ':scanId': scanId },
  }));

  if (!result.Items || result.Items.length === 0) {
    return null;
  }
  return result.Items[0];
}

// Route handler: GET /scans/{scanId}/report
async function getReport(scanId) {
  const scan = await getScan(scanId);
  if (!scan || !scan.s3ReportKey) {
    return null;
  }

  // Generate pre-signed URL valid for 15 minutes
  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: S3_REPORTS_BUCKET,
    Key: scan.s3ReportKey,
  }), { expiresIn: 900 });

  return { reportUrl: url, scanId, repoName: scan.repoName };
}

// Route handler: GET /stats
async function getStats() {
  const result = await ddb.send(new ScanCommand({
    TableName: DYNAMODB_TABLE,
  }));

  const scans = result.Items || [];
  const completed = scans.filter(s => s.status === 'COMPLETED');

  // Aggregate stats
  let totalVulnerabilities = 0;
  let totalHigh = 0;
  let totalMedium = 0;
  let totalLow = 0;
  const repoSet = new Set();

  for (const scan of completed) {
    if (scan.summary) {
      totalVulnerabilities += scan.summary.totalVulnerabilities || 0;
      totalHigh += scan.summary.high || 0;
      totalMedium += scan.summary.medium || 0;
      totalLow += scan.summary.low || 0;
    }
    repoSet.add(scan.repoName);
  }

  return {
    totalScans: scans.length,
    completedScans: completed.length,
    failedScans: scans.filter(s => s.status === 'FAILED').length,
    queuedScans: scans.filter(s => s.status === 'QUEUED' || s.status === 'SCANNING').length,
    totalVulnerabilities,
    high: totalHigh,
    medium: totalMedium,
    low: totalLow,
    repositories: repoSet.size,
    recentScans: scans
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 5),
  };
}

export const handler = async (event) => {
  const path = event.rawPath || event.requestContext?.http?.path || '';
  const method = event.requestContext?.http?.method || 'GET';
  const queryParams = event.queryStringParameters || {};

  try {
    // Route: GET /stats
    if (path === '/stats') {
      const stats = await getStats();
      return respond(200, stats);
    }

    // Route: GET /scans/{scanId}/report
    const reportMatch = path.match(/^\/scans\/([^/]+)\/report$/);
    if (reportMatch) {
      const report = await getReport(reportMatch[1]);
      if (!report) return respond(404, { error: 'Report not found' });
      return respond(200, report);
    }

    // Route: GET /scans/{scanId}
    const scanMatch = path.match(/^\/scans\/([^/]+)$/);
    if (scanMatch) {
      const scan = await getScan(scanMatch[1]);
      if (!scan) return respond(404, { error: 'Scan not found' });
      return respond(200, scan);
    }

    // Route: GET /scans
    if (path === '/scans') {
      const result = await listScans(queryParams);
      return respond(200, result);
    }

    return respond(404, { error: 'Not found' });

  } catch (error) {
    console.error('Query API error:', error);
    return respond(500, { error: 'Internal server error', message: error.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
