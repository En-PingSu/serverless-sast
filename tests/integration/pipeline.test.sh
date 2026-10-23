#!/bin/bash
set -euo pipefail

DEFAULT_URL=$(aws cloudformation describe-stacks --stack-name sast-scanner --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null)
API_URL="${API_URL:-${DEFAULT_URL:-https://eudvkuuq93.execute-api.us-east-1.amazonaws.com/prod}}"
SECRET="${WEBHOOK_SECRET:-test123}"
QUERY_API_TOKEN="${QUERY_API_TOKEN:?set QUERY_API_TOKEN to the QueryApiToken stack parameter}"
AUTH="Authorization: Bearer $QUERY_API_TOKEN"

echo "=== Integration Test: Full Pipeline ==="
echo "API: $API_URL"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

PASS=0
FAIL=0

# Step 1: Send webhook
BODY='{"repository":{"full_name":"aanchan/cs6620","clone_url":"https://github.com/aanchan/cs6620.git"},"ref":"refs/heads/main","after":"abc1234","sender":{"login":"integration-test"}}'
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

echo "Step 1: Sending webhook..."
RESPONSE=$(curl -s -X POST "$API_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY")

SCAN_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['scanId'])" 2>/dev/null)
if [ -z "$SCAN_ID" ]; then
  echo "FAIL: No scanId in response: $RESPONSE"
  exit 1
fi
echo "PASS: Webhook accepted, scanId=$SCAN_ID"
PASS=$((PASS + 1))

# Step 2: Poll for completion (track timing)
echo ""
echo "Step 2: Polling for scan completion..."
STATUS="QUEUED"
POLL_START=$(date +%s)
for i in $(seq 1 24); do
  sleep 5
  SCAN_DATA=$(curl -s -H "$AUTH" "$API_URL/scans/$SCAN_ID")
  STATUS=$(echo "$SCAN_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null)
  echo "  [$((i * 5))s] Status: $STATUS"
  if [ "$STATUS" = "COMPLETED" ] || [ "$STATUS" = "FAILED" ]; then
    break
  fi
done
POLL_END=$(date +%s)
POLL_DURATION=$((POLL_END - POLL_START))

# Step 3: Verify completion
echo ""
if [ "$STATUS" = "COMPLETED" ]; then
  echo "PASS: Scan completed successfully (observed in ${POLL_DURATION}s)"
  PASS=$((PASS + 1))
else
  echo "FAIL: Scan status is $STATUS after ${POLL_DURATION}s (expected COMPLETED)"
  FAIL=$((FAIL + 1))
fi

# Step 4: Verify scan result data
SCAN_DATA=$(curl -s -H "$AUTH" "$API_URL/scans/$SCAN_ID")
TOTAL=$(echo "$SCAN_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('totalVulnerabilities',0))" 2>/dev/null)
HIGH=$(echo "$SCAN_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('high',0))" 2>/dev/null)
MEDIUM=$(echo "$SCAN_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('medium',0))" 2>/dev/null)
LOW=$(echo "$SCAN_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('low',0))" 2>/dev/null)
DURATION_MS=$(echo "$SCAN_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('durationMs',0))" 2>/dev/null)
S3_KEY=$(echo "$SCAN_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('s3ReportKey',''))" 2>/dev/null)

echo ""
echo "Step 3: Verifying scan results..."
echo "  Vulnerabilities: total=$TOTAL (HIGH=$HIGH, MEDIUM=$MEDIUM, LOW=$LOW)"
echo "  Scan duration:   ${DURATION_MS}ms"
echo "  S3 report key:   $S3_KEY"

if [ "$TOTAL" -gt 0 ] 2>/dev/null; then
  echo "PASS: Vulnerabilities detected"
  PASS=$((PASS + 1))
else
  echo "WARN: No vulnerabilities found (may be expected for this repo)"
fi

if [ -n "$S3_KEY" ] && [ "$S3_KEY" != "" ]; then
  echo "PASS: S3 report key present"
  PASS=$((PASS + 1))
else
  echo "FAIL: No S3 report key in scan record"
  FAIL=$((FAIL + 1))
fi

# Step 5: Verify API endpoints
echo ""
echo "Step 4: Verifying API endpoints..."

REPORT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$API_URL/scans/$SCAN_ID/report")
if [ "$REPORT_CODE" = "200" ]; then
  echo "PASS: GET /scans/{scanId}/report → 200"
  PASS=$((PASS + 1))
else
  echo "FAIL: GET /scans/{scanId}/report → $REPORT_CODE"
  FAIL=$((FAIL + 1))
fi

STATS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$API_URL/stats")
if [ "$STATS_CODE" = "200" ]; then
  echo "PASS: GET /stats → 200"
  PASS=$((PASS + 1))
else
  echo "FAIL: GET /stats → $STATS_CODE"
  FAIL=$((FAIL + 1))
fi

SCANS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$API_URL/scans")
if [ "$SCANS_CODE" = "200" ]; then
  echo "PASS: GET /scans → 200"
  PASS=$((PASS + 1))
else
  echo "FAIL: GET /scans → $SCANS_CODE"
  FAIL=$((FAIL + 1))
fi

# Step 6: Verify CloudWatch metrics (if available)
echo ""
echo "Step 5: Checking CloudWatch metrics..."
CW_START=$(date -u -v-10M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null)
CW_END=$(date -u +%Y-%m-%dT%H:%M:%S)

CW_COMPLETED=$(aws cloudwatch get-metric-statistics \
  --namespace "SASTScanner" \
  --metric-name "ScanCompleted" \
  --start-time "$CW_START" --end-time "$CW_END" \
  --period 300 --statistics Sum \
  --query "Datapoints[0].Sum" --output text 2>/dev/null || echo "N/A")

CW_DURATION=$(aws cloudwatch get-metric-statistics \
  --namespace "SASTScanner" \
  --metric-name "ScanDuration" \
  --start-time "$CW_START" --end-time "$CW_END" \
  --period 300 --statistics Average \
  --query "Datapoints[0].Average" --output text 2>/dev/null || echo "N/A")

if [ "$CW_COMPLETED" != "N/A" ] && [ "$CW_COMPLETED" != "None" ]; then
  echo "  CloudWatch ScanCompleted (last 10m): $CW_COMPLETED"
  echo "  CloudWatch ScanDuration avg:         ${CW_DURATION}ms"
  echo "PASS: CloudWatch metrics present"
  PASS=$((PASS + 1))
else
  echo "  SKIP: CloudWatch custom metrics not yet emitted (waiting on SAM template update)"
fi

# Summary
echo ""
echo "==========================================="
echo "  Integration Test Results"
echo "==========================================="
echo "  Passed:         $PASS"
echo "  Failed:         $FAIL"
echo "  Scan ID:        $SCAN_ID"
echo "  Scan duration:  ${DURATION_MS}ms"
echo "  Vulns found:    $TOTAL (H=$HIGH M=$MEDIUM L=$LOW)"
echo "  Poll time:      ${POLL_DURATION}s"
echo "  Timestamp:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "==========================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
