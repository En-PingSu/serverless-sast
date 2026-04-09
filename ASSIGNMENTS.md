# Remaining Work - Member Assignments

## Current State (Built)

```
                         ┌─────────────────────────────────────────────┐
                         │            SCAN PIPELINE (BUILT)            │
                         │                                             │
  Developer ──► GitHub ──► Webhook ──► API Gateway ──► Lambda          │
                 Repo      Trigger         │         Webhook Handler   │
                                           │              │            │
                                           │              ▼            │
                                           │         SQS Queue ◄─► DLQ│
                                           │              │        │   │
                                           │              ▼        ▼   │
                                           │     Lambda Container  DLQ │
                                           │     (SAST Scanner)   Notifier
                                           │         │        │    → SNS│
                                           │         ▼        ▼        │
                                           │     DynamoDB    S3        │
                                           │     (metadata)  (reports) │
                                           └──────────┬───────────────-┘
                                                      │
                         ┌────────────────────────────-┤
                         │                             │
                         ▼                             ▼
                   Lambda Query API           GitHub PR Comment
                      (BUILT)                    (BUILT)
                   (programmatic access)    (developer feedback)
```

## Design Decision: No Frontend Dashboard

Per instructor feedback: developers don't push code and then stare at a dashboard.
They expect feedback directly on their PR — like GitHub Actions. The PR comment
write-back already delivers full scan results where developers actually look.

The Query API remains for programmatic access (e.g., scripts, CI checks).

## What's Left to Build

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌───────────────────────┐   ┌──────────────────────┐                   │
│  │      WENDI            │   │      WENDI            │                  │
│  │                       │   │                       │                  │
│  │  SNS Notifications    │   │  Robustness /         │                  │
│  │  ├─ Email subscription│   │  Security /           │                  │
│  │  │   to findings topic│   │  Scalability          │                  │
│  │  └─ Verify alerts     │   │  Analysis             │                  │
│  │    for HIGH findings  │   │  (documentation)      │                  │
│  │    and DLQ failures   │   │                       │                  │
│  └───────────────────────┘   └──────────────────────┘                   │
│                                                                         │
│  ┌───────────────────────┐   ┌──────────────────────┐                   │
│  │      YIYANG           │   │      YIYANG           │                  │
│  │                       │   │                       │                  │
│  │  CloudWatch           │   │  SAM Deployment       │                  │
│  │  ├─ Custom metrics    │   │  ├─ sam build/deploy  │                  │
│  │  │  (ScanCompleted,   │   │  ├─ sam delete        │                  │
│  │  │   ScanFailed,      │   │  │   (full teardown)  │                  │
│  │  │   ScanDuration)    │   │  ├─ GitHub webhook    │                  │
│  │  ├─ Alarms            │   │  │   configuration    │                  │
│  │  │  (failure rate,    │   │  ├─ Lambda concurrency│                  │
│  │  │   DLQ depth)       │   │  │   limits (Learner  │                  │
│  │  └─ Ops dashboard     │   │  │   Lab constraints) │                  │
│  │                       │   │  └─ Document limits   │                  │
│  └───────────────────────┘   └──────────────────────┘                   │
│                                                                         │
│  ┌───────────────────────┐   ┌──────────────────────┐                   │
│  │      NATE             │   │      NATE             │                  │
│  │                       │   │                       │                  │
│  │  Testing              │   │  End-to-End           │                  │
│  │  ├─ Unit tests        │   │  Validation           │                  │
│  │  │  (scanner.js with  │   │  ├─ Fire test webhook │                  │
│  │  │   known-vulnerable │   │  ├─ Verify SQS →      │                  │
│  │  │   code snippets)   │   │  │   Lambda → DynamoDB │                 │
│  │  ├─ Integration tests │   │  │   → S3 pipeline    │                  │
│  │  │  (fake webhook →   │   │  ├─ Burst test        │                  │
│  │  │   full pipeline)   │   │  │   (N concurrent    │                  │
│  │  └─ Failure tests     │   │  │    webhooks)       │                  │
│  │    (bad repo URL →    │   │  ├─ Failure/DLQ test  │                  │
│  │     DLQ catches it)   │   │  └─ Prove completion  │                  │
│  └───────────────────────┘   │    rate via CloudWatch│                  │
│                              └──────────────────────┘                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Summary Table

| Member   | Components                                          | Slides Topic                              |
|----------|-----------------------------------------------------|-------------------------------------------|
| **Wendi**  | SNS email subscriptions, verify alert delivery, analysis doc | Robustness/Security/Scalability analysis |
| **Yiyang** | CloudWatch (metrics, alarms, ops dashboard), SAM deploy/teardown, Lambda concurrency limits | Architecture & deployment, monitoring |
| **Nate**   | Unit tests, integration tests, failure tests, E2E validation, burst/load testing, prove completion rate | Testing strategy & pipeline validation |

## No Overlap Guarantee

- **Wendi** owns notifications + analysis documentation
- **Yiyang** owns all infrastructure/ops (deploy, monitor, configure, document limits)
- **Nate** owns all testing/validation (prove it works, prove it fails gracefully, prove the metrics)

## Key Questions to Address (from feedback)

1. **"99%+ scan completion rate"** — Must be backed by CloudWatch metrics from actual test runs, not just claimed
2. **"100% repos onboarded"** — Need to test with multiple repos and show evidence
3. **Failure handling** — Scan fails → DynamoDB FAILED → SQS retries 3x → DLQ → DLQ notifier → SNS alert (built, needs E2E proof)
4. **Lambda concurrency** — Learner Lab may limit concurrent Lambdas; document and test under load
5. **IaC teardown** — `sam delete` removes everything; demonstrate clean teardown
