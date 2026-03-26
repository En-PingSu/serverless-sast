#!/bin/bash
set -euo pipefail

API_URL="${API_URL:-https://eudvkuuq93.execute-api.us-east-1.amazonaws.com/prod}"
SECRET="${WEBHOOK_SECRET:-test123}"
CONCURRENCY="${1:-5}"
TMPDIR=$(mktemp -d)

echo "=== Burst Test: $CONCURRENCY concurrent webhooks ==="
echo "API: $API_URL"
echo ""

BODY='{"repository":{"full_name":"aanchan/cs6620","clone_url":"https://github.com/aanchan/cs6620.git"},"ref":"refs/heads/main","after":"burst-'$(date +%s)'","sender":{"login":"burst-tester"}}'
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

# Fire all webhooks in parallel
echo "Step 1: Firing $CONCURRENCY webhooks simultaneously..."
for i in $(seq 1 "$CONCURRENCY"); do
  curl -s -X POST "$API_URL/webhook" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: push" \
    -H "X-Hub-Signature-256: $SIG" \
    -d "$BODY" > "$TMPDIR/response_$i.json" 2>/dev/null &
done
wait
echo "  All $CONCURRENCY webhooks sent"

# Count accepted responses
ACCEPTED=0
for i in $(seq 1 "$CONCURRENCY"); do
  if grep -q "scanId" "$TMPDIR/response_$i.json" 2>/dev/null; then
    ACCEPTED=$((ACCEPTED + 1))
  fi
done

echo ""
if [ "$ACCEPTED" -eq "$CONCURRENCY" ]; then
  echo "PASS: $ACCEPTED/$CONCURRENCY webhooks accepted"
else
  echo "WARN: $ACCEPTED/$CONCURRENCY webhooks accepted"
fi

# Wait and check processing
echo ""
echo "Step 2: Waiting 60s for SQS processing..."
sleep 60

TOTAL_SCANS=$(curl -s "$API_URL/scans?limit=50" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null)
echo "  Total scans in system: $TOTAL_SCANS"

# Check stats
STATS=$(curl -s "$API_URL/stats")
COMPLETED=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('completedScans',0))" 2>/dev/null)
QUEUED=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('queuedScans',0))" 2>/dev/null)
FAILED=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('failedScans',0))" 2>/dev/null)
echo "  Completed: $COMPLETED, Queued/Scanning: $QUEUED, Failed: $FAILED"

# Cleanup
rm -rf "$TMPDIR"

echo ""
echo "=== Burst test complete ==="
