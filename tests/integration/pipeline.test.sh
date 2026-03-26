#!/bin/bash
set -euo pipefail

DEFAULT_URL=$(aws cloudformation describe-stacks --stack-name sast-scanner --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null)
API_URL="${API_URL:-${DEFAULT_URL:-https://eudvkuuq93.execute-api.us-east-1.amazonaws.com/prod}}"
SECRET="${WEBHOOK_SECRET:-test123}"

echo "=== Integration Test: Full Pipeline ==="
echo "API: $API_URL"
echo ""

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

# Step 2: Poll for completion
echo ""
echo "Step 2: Polling for scan completion..."
STATUS="QUEUED"
for i in $(seq 1 18); do
  sleep 5
  STATUS=$(curl -s "$API_URL/scans/$SCAN_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null)
  echo "  [$((i * 5))s] Status: $STATUS"
  if [ "$STATUS" = "COMPLETED" ] || [ "$STATUS" = "FAILED" ]; then
    break
  fi
done

# Step 3: Verify completion
echo ""
if [ "$STATUS" = "COMPLETED" ]; then
  echo "PASS: Scan completed successfully"
else
  echo "FAIL: Scan status is $STATUS (expected COMPLETED)"
  exit 1
fi

# Step 4: Verify vulnerabilities found
TOTAL=$(curl -s "$API_URL/scans/$SCAN_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('totalVulnerabilities',0))" 2>/dev/null)
echo "  Vulnerabilities found: $TOTAL"
if [ "$TOTAL" -gt 0 ] 2>/dev/null; then
  echo "PASS: Vulnerabilities detected"
else
  echo "WARN: No vulnerabilities found (may be expected for this repo)"
fi

# Step 5: Verify report endpoint
echo ""
echo "Step 3: Verifying API endpoints..."
REPORT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/scans/$SCAN_ID/report")
if [ "$REPORT_CODE" = "200" ]; then
  echo "PASS: GET /scans/{scanId}/report returns 200"
else
  echo "FAIL: Report endpoint returned $REPORT_CODE"
fi

# Step 6: Verify stats endpoint
STATS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/stats")
if [ "$STATS_CODE" = "200" ]; then
  echo "PASS: GET /stats returns 200"
else
  echo "FAIL: Stats endpoint returned $STATS_CODE"
fi

# Step 7: Verify scans list
SCANS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/scans")
if [ "$SCANS_CODE" = "200" ]; then
  echo "PASS: GET /scans returns 200"
else
  echo "FAIL: Scans endpoint returned $SCANS_CODE"
fi

echo ""
echo "=== Integration test complete ==="
