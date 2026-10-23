#!/bin/bash
set -euo pipefail

DEFAULT_URL=$(aws cloudformation describe-stacks --stack-name sast-scanner --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null)
API_URL="${API_URL:-${DEFAULT_URL:-https://eudvkuuq93.execute-api.us-east-1.amazonaws.com/prod}}"
SECRET="${WEBHOOK_SECRET:-test123}"
QUERY_API_TOKEN="${QUERY_API_TOKEN:?set QUERY_API_TOKEN to the QueryApiToken stack parameter}"
AUTH="Authorization: Bearer $QUERY_API_TOKEN"
CONCURRENCY="${1:-5}"
MAX_WAIT="${2:-180}"   # max seconds to wait for all scans to complete
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "=== Burst Test: $CONCURRENCY concurrent webhooks ==="
echo "API: $API_URL"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Fire all webhooks in parallel (each with a unique commit SHA so they're distinct scans)
echo "Step 1: Firing $CONCURRENCY webhooks simultaneously..."
BURST_TS=$(date +%s)
for i in $(seq 1 "$CONCURRENCY"); do
  BODY="{\"repository\":{\"full_name\":\"aanchan/cs6620\",\"clone_url\":\"https://github.com/aanchan/cs6620.git\"},\"ref\":\"refs/heads/main\",\"after\":\"burst-${BURST_TS}-${i}\",\"sender\":{\"login\":\"burst-tester\"}}"
  SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
  curl -s -X POST "$API_URL/webhook" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: push" \
    -H "X-Hub-Signature-256: $SIG" \
    -d "$BODY" > "$TMPDIR/response_$i.json" 2>/dev/null &
done
wait
echo "  All $CONCURRENCY webhooks sent"

# Collect scan IDs
SCAN_IDS=()
ACCEPTED=0
for i in $(seq 1 "$CONCURRENCY"); do
  SID=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('scanId',''))" < "$TMPDIR/response_$i.json" 2>/dev/null)
  if [ -n "$SID" ]; then
    SCAN_IDS+=("$SID")
    ACCEPTED=$((ACCEPTED + 1))
  fi
done

echo ""
if [ "$ACCEPTED" -eq "$CONCURRENCY" ]; then
  echo "PASS: $ACCEPTED/$CONCURRENCY webhooks accepted"
else
  echo "WARN: $ACCEPTED/$CONCURRENCY webhooks accepted"
fi

# Poll until all scans reach a terminal state (COMPLETED or FAILED)
echo ""
echo "Step 2: Polling for all scans to complete (max ${MAX_WAIT}s)..."
POLL_START=$(date +%s)
ELAPSED=0

while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  sleep 10
  ELAPSED=$(( $(date +%s) - POLL_START ))

  COMPLETED=0
  FAILED=0
  PENDING=0

  for SID in "${SCAN_IDS[@]}"; do
    S=$(curl -s -H "$AUTH" "$API_URL/scans/$SID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null)
    case "$S" in
      COMPLETED) COMPLETED=$((COMPLETED + 1)) ;;
      FAILED)    FAILED=$((FAILED + 1)) ;;
      *)         PENDING=$((PENDING + 1)) ;;
    esac
  done

  echo "  [${ELAPSED}s] completed=$COMPLETED  failed=$FAILED  pending=$PENDING"

  if [ "$PENDING" -eq 0 ]; then
    break
  fi
done

# Collect per-scan metrics
echo ""
echo "Step 3: Collecting scan metrics..."
TOTAL_DURATION=0
TOTAL_VULNS=0
SCAN_DETAILS=""

for SID in "${SCAN_IDS[@]}"; do
  DATA=$(curl -s -H "$AUTH" "$API_URL/scans/$SID")
  S=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null)
  D=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('durationMs',0))" 2>/dev/null)
  V=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('totalVulnerabilities',0))" 2>/dev/null)
  TOTAL_DURATION=$((TOTAL_DURATION + D))
  TOTAL_VULNS=$((TOTAL_VULNS + V))
  SCAN_DETAILS="${SCAN_DETAILS}  ${SID}: status=${S}  duration=${D}ms  vulns=${V}\n"
done

if [ "$ACCEPTED" -gt 0 ]; then
  AVG_DURATION=$((TOTAL_DURATION / ACCEPTED))
else
  AVG_DURATION=0
fi

# Check SQS DLQ depth
DLQ_DEPTH=$(aws sqs get-queue-attributes \
  --queue-url "$(aws sqs get-queue-url --queue-name sast-scan-jobs-dlq --query QueueUrl --output text 2>/dev/null)" \
  --attribute-names ApproximateNumberOfMessages \
  --query "Attributes.ApproximateNumberOfMessages" --output text 2>/dev/null || echo "N/A")

# Check CloudWatch (if metrics are being emitted)
CW_START=$(date -u -v-10M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null)
CW_END=$(date -u +%Y-%m-%dT%H:%M:%S)

CW_COMPLETED=$(aws cloudwatch get-metric-statistics \
  --namespace "SASTScanner" \
  --metric-name "ScanCompleted" \
  --start-time "$CW_START" --end-time "$CW_END" \
  --period 300 --statistics Sum \
  --query "Datapoints[0].Sum" --output text 2>/dev/null || echo "N/A")

# Calculate completion rate
TOTAL_TERMINAL=$((COMPLETED + FAILED))
if [ "$ACCEPTED" -gt 0 ]; then
  COMPLETION_RATE=$(python3 -c "print(f'{($COMPLETED/$ACCEPTED)*100:.1f}')" 2>/dev/null || echo "?")
  SUCCESS_RATE=$(python3 -c "print(f'{($COMPLETED/$ACCEPTED)*100:.1f}')" 2>/dev/null || echo "?")
else
  COMPLETION_RATE="0"
  SUCCESS_RATE="0"
fi

# Summary
echo ""
echo "==========================================="
echo "  Burst Test Results"
echo "==========================================="
echo "  Webhooks sent:       $CONCURRENCY"
echo "  Webhooks accepted:   $ACCEPTED"
echo "  Scans completed:     $COMPLETED"
echo "  Scans failed:        $FAILED"
echo "  Scans pending:       $PENDING"
echo "  Completion rate:     $COMPLETED/$ACCEPTED ($COMPLETION_RATE%)"
echo "  Avg scan duration:   ${AVG_DURATION}ms"
echo "  Total vulns found:   $TOTAL_VULNS"
echo "  DLQ depth:           $DLQ_DEPTH"
echo "  CloudWatch count:    $CW_COMPLETED"
echo "  Wall-clock time:     ${ELAPSED}s"
echo "  Timestamp:           $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "==========================================="
echo ""
echo "Per-scan breakdown:"
echo -e "$SCAN_DETAILS"

# Pass/fail verdict
if [ "$COMPLETED" -eq "$ACCEPTED" ] && [ "$ACCEPTED" -eq "$CONCURRENCY" ]; then
  echo "PASS: All $CONCURRENCY scans completed successfully"
elif [ "$PENDING" -gt 0 ]; then
  echo "FAIL: $PENDING scan(s) still pending after ${MAX_WAIT}s"
  exit 1
elif [ "$FAILED" -gt 0 ]; then
  echo "WARN: $FAILED/$ACCEPTED scan(s) failed"
else
  echo "WARN: $ACCEPTED/$CONCURRENCY webhooks accepted"
fi
