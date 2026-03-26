#!/bin/bash
set -euo pipefail

DEFAULT_URL=$(aws cloudformation describe-stacks --stack-name sast-scanner --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null)
API_URL="${API_URL:-${DEFAULT_URL:-https://eudvkuuq93.execute-api.us-east-1.amazonaws.com/prod}}"
SECRET="${WEBHOOK_SECRET:-test123}"
PASS=0
FAIL=0

echo "=== Failure Tests ==="
echo "API: $API_URL"
echo ""

# Test 1: Invalid signature
echo "Test 1: Invalid signature → expect 401"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000" \
  -d '{"repository":{"full_name":"test/repo","clone_url":"https://github.com/test/repo.git"},"ref":"refs/heads/main","after":"abc","sender":{"login":"test"}}')
if [ "$CODE" = "401" ]; then
  echo "  PASS: Rejected with 401"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Got HTTP $CODE (expected 401)"
  FAIL=$((FAIL + 1))
fi

# Test 2: Missing signature header
echo ""
echo "Test 2: Missing signature header → expect 401"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -d '{"repository":{"full_name":"test/repo","clone_url":"https://github.com/test/repo.git"},"ref":"refs/heads/main","after":"abc","sender":{"login":"test"}}')
if [ "$CODE" = "401" ]; then
  echo "  PASS: Rejected with 401"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Got HTTP $CODE (expected 401)"
  FAIL=$((FAIL + 1))
fi

# Test 3: Bad repo URL (valid signature, clone will fail)
echo ""
echo "Test 3: Bad repo URL → expect FAILED status"
BAD_BODY='{"repository":{"full_name":"nonexistent/repo-does-not-exist-999","clone_url":"https://github.com/nonexistent/repo-does-not-exist-999.git"},"ref":"refs/heads/main","after":"bad123","sender":{"login":"failure-test"}}'
BAD_SIG="sha256=$(echo -n "$BAD_BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

RESP=$(curl -s -X POST "$API_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: $BAD_SIG" \
  -d "$BAD_BODY")

BAD_SCAN_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('scanId',''))" 2>/dev/null)
if [ -n "$BAD_SCAN_ID" ]; then
  echo "  Scan queued: $BAD_SCAN_ID"
  echo "  Waiting 30s for scanner to fail..."
  sleep 30
  BAD_STATUS=$(curl -s "$API_URL/scans/$BAD_SCAN_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null)
  BAD_ERROR=$(curl -s "$API_URL/scans/$BAD_SCAN_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','none')[:80])" 2>/dev/null)
  if [ "$BAD_STATUS" = "FAILED" ]; then
    echo "  PASS: Status is FAILED"
    echo "  Error: $BAD_ERROR"
    PASS=$((PASS + 1))
  else
    echo "  INFO: Status is $BAD_STATUS (may need more time for retries)"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  FAIL: Could not queue scan: $RESP"
  FAIL=$((FAIL + 1))
fi

# Test 4: Unsupported event type
echo ""
echo "Test 4: Unsupported event type → expect 200 with ignore message"
EVENT_BODY='{"action":"completed"}'
EVENT_SIG="sha256=$(echo -n "$EVENT_BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

RESP=$(curl -s -X POST "$API_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: release" \
  -H "X-Hub-Signature-256: $EVENT_SIG" \
  -d "$EVENT_BODY")

if echo "$RESP" | grep -q "Ignoring"; then
  echo "  PASS: Event ignored gracefully"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Unexpected response: $RESP"
  FAIL=$((FAIL + 1))
fi

# Summary
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
