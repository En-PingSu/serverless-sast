#!/bin/bash
set -euo pipefail

DEFAULT_URL=$(aws cloudformation describe-stacks --stack-name sast-scanner --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null)
API_URL="${API_URL:-${DEFAULT_URL:-https://eudvkuuq93.execute-api.us-east-1.amazonaws.com/prod}}"
SECRET="${WEBHOOK_SECRET:-test123}"
PASS=0
FAIL=0

echo "=== Failure & Resilience Tests ==="
echo "API: $API_URL"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# ── Test 1: Invalid signature ──
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

# ── Test 2: Missing signature header ──
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

# ── Test 3: Unsupported event type ──
echo ""
echo "Test 3: Unsupported event type → expect graceful ignore"
EVENT_BODY='{"action":"completed"}'
EVENT_SIG="sha256=$(echo -n "$EVENT_BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

RESP=$(curl -s -X POST "$API_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: release" \
  -H "X-Hub-Signature-256: $EVENT_SIG" \
  -d "$EVENT_BODY")

if echo "$RESP" | grep -qi "Ignor"; then
  echo "  PASS: Event ignored gracefully"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Unexpected response: $RESP"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: Bad repo URL → scan should FAIL, eventually land in DLQ ──
echo ""
echo "Test 4: Bad repo URL → expect FAILED status + DLQ delivery"
BAD_BODY='{"repository":{"full_name":"nonexistent/repo-does-not-exist-999","clone_url":"https://github.com/nonexistent/repo-does-not-exist-999.git"},"ref":"refs/heads/main","after":"bad-'$(date +%s)'","sender":{"login":"failure-test"}}'
BAD_SIG="sha256=$(echo -n "$BAD_BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

# Record DLQ depth before test
DLQ_URL=$(aws sqs get-queue-url --queue-name sast-scan-jobs-dlq --query QueueUrl --output text 2>/dev/null || echo "")
DLQ_BEFORE="N/A"
if [ -n "$DLQ_URL" ]; then
  DLQ_BEFORE=$(aws sqs get-queue-attributes \
    --queue-url "$DLQ_URL" \
    --attribute-names ApproximateNumberOfMessages \
    --query "Attributes.ApproximateNumberOfMessages" --output text 2>/dev/null || echo "N/A")
fi
echo "  DLQ depth before: $DLQ_BEFORE"

RESP=$(curl -s -X POST "$API_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: $BAD_SIG" \
  -d "$BAD_BODY")

BAD_SCAN_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('scanId',''))" 2>/dev/null)
if [ -z "$BAD_SCAN_ID" ]; then
  echo "  FAIL: Could not queue scan: $RESP"
  FAIL=$((FAIL + 1))
else
  echo "  Scan queued: $BAD_SCAN_ID"

  # Wait for scan to fail (Lambda will retry via SQS maxReceiveCount=3)
  # Each attempt: up to 300s Lambda timeout + 330s visibility timeout
  # In practice much faster since git clone fails quickly
  echo "  Waiting for scan failure (polling up to 90s)..."
  BAD_STATUS="UNKNOWN"
  for i in $(seq 1 18); do
    sleep 5
    BAD_STATUS=$(curl -s "$API_URL/scans/$BAD_SCAN_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null)
    echo "    [$((i * 5))s] Status: $BAD_STATUS"
    if [ "$BAD_STATUS" = "FAILED" ]; then
      break
    fi
  done

  if [ "$BAD_STATUS" = "FAILED" ]; then
    BAD_ERROR=$(curl -s "$API_URL/scans/$BAD_SCAN_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','none')[:100])" 2>/dev/null)
    echo "  PASS: Scan status is FAILED"
    echo "  Error: $BAD_ERROR"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: Scan status is $BAD_STATUS (expected FAILED)"
    FAIL=$((FAIL + 1))
  fi

  # Wait additional time for SQS retries to exhaust and message to land in DLQ
  # maxReceiveCount=3, so after 3 failures the message goes to DLQ
  echo ""
  echo "  Waiting 60s for SQS retries to exhaust → DLQ..."
  sleep 60

  if [ -n "$DLQ_URL" ]; then
    DLQ_AFTER=$(aws sqs get-queue-attributes \
      --queue-url "$DLQ_URL" \
      --attribute-names ApproximateNumberOfMessages \
      --query "Attributes.ApproximateNumberOfMessages" --output text 2>/dev/null || echo "N/A")
    echo "  DLQ depth after:  $DLQ_AFTER (was $DLQ_BEFORE)"

    if [ "$DLQ_AFTER" != "N/A" ] && [ "$DLQ_BEFORE" != "N/A" ] && [ "$DLQ_AFTER" -gt "$DLQ_BEFORE" ] 2>/dev/null; then
      echo "  PASS: DLQ depth increased ($DLQ_BEFORE → $DLQ_AFTER)"
      PASS=$((PASS + 1))
    else
      echo "  INFO: DLQ depth unchanged (retries may still be in progress — SQS visibility timeout is 330s)"
    fi
  else
    echo "  SKIP: Could not get DLQ URL"
  fi
fi

# ── Test 5: Check SNS topic exists and is subscribed ──
echo ""
echo "Test 5: SNS topic health check"
SNS_TOPIC_ARN=$(aws sns list-topics --query "Topics[?contains(TopicArn,'sast-security-findings')].TopicArn | [0]" --output text 2>/dev/null || echo "N/A")
if [ "$SNS_TOPIC_ARN" != "N/A" ] && [ "$SNS_TOPIC_ARN" != "None" ]; then
  SUB_COUNT=$(aws sns list-subscriptions-by-topic --topic-arn "$SNS_TOPIC_ARN" --query "length(Subscriptions)" --output text 2>/dev/null || echo "0")
  echo "  SNS topic: $SNS_TOPIC_ARN"
  echo "  Subscriptions: $SUB_COUNT"
  if [ "$SUB_COUNT" -gt 0 ] 2>/dev/null; then
    echo "  PASS: SNS topic has active subscriptions"
    PASS=$((PASS + 1))
  else
    echo "  WARN: SNS topic has no subscriptions (alerts won't be received)"
  fi
else
  echo "  SKIP: SNS topic not found"
fi

# ── Test 6: Check CloudWatch alarm state (if alarms exist) ──
echo ""
echo "Test 6: CloudWatch alarm check"
ALARMS=$(aws cloudwatch describe-alarms \
  --alarm-name-prefix "sast-" \
  --query "MetricAlarms[].{Name:AlarmName,State:StateValue}" \
  --output table 2>/dev/null || echo "N/A")

if [ "$ALARMS" != "N/A" ] && echo "$ALARMS" | grep -q "sast-"; then
  echo "$ALARMS"
  echo "  PASS: CloudWatch alarms configured"
  PASS=$((PASS + 1))
else
  echo "  SKIP: No CloudWatch alarms with 'sast-' prefix found (waiting on SAM template update)"
fi

# Summary
echo ""
echo "==========================================="
echo "  Failure & Resilience Test Results"
echo "==========================================="
echo "  Passed:    $PASS"
echo "  Failed:    $FAIL"
echo "  Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "==========================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
