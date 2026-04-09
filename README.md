# SAST Security Scanner

## Team Members

- En-Ping Su
- Wendi Zhong
- Yiyang Wang

## Architecture

```
GitHub PR/Push → API Gateway → Webhook Handler Lambda → SQS Queue → Scanner Lambda (container)
                                                                          │
                                          ┌───────────────────────────────-┤
                                          │              │                │
                                          ▼              ▼                ▼
                                      DynamoDB          S3           GitHub PR
                                     (metadata)     (reports)       Comment
                                                                   (findings)
                                          │
                                          ▼
                               SQS DLQ → DLQ Notifier → SNS Alert
```

**Feedback loop**: Scan results are posted directly as PR comments on GitHub — developers
get feedback where they already work, not on a separate dashboard.

**Failure path**: Failed scans retry 3x via SQS, then land in the DLQ. The DLQ notifier
Lambda sends an SNS alert with failure details.

**Observability**: CloudWatch custom metrics (`ScanCompleted`, `ScanFailed`, `ScanDuration`,
`VulnerabilitiesFound`, `HighSeverityFindings`) + alarms + ops dashboard.

**AWS Services (7)**: Lambda, SQS, DynamoDB, S3, API Gateway, CloudWatch, SNS

## Deployment

### Prerequisites

- AWS CLI configured with valid credentials
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) installed
- Docker running (required for building the scanner Lambda container image)
- Node.js 20.x
- A GitHub personal access token with `Contents: Read-only` permission (only needed for scanning private repos)

### Generate a Webhook Secret

Pick a random string to use as your GitHub webhook secret:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Save this value, you'll need it for both AWS deployment and GitHub webhook configuration.

### Build & Deploy

```bash
sam build
sam deploy --guided   # first time (prompts for parameters)
sam deploy            # subsequent deployments
```

You will be prompted for:

| Parameter             | Description                                      |
|-----------------------|--------------------------------------------------|
| `GitHubWebhookSecret` | The random secret you generated above            |
| `GitHubToken`          | GitHub personal access token (optional, only for private repos) |

### Retrieve Stack Outputs

After deployment, get the API URLs and resource names:

```bash
sam list stack-outputs --stack-name <your-stack-name>
```

Key outputs:

| Output             | Description                          |
|--------------------|--------------------------------------|
| `ApiUrl`           | Base URL for the query API           |
| `WebhookUrl`       | URL to configure in GitHub webhooks  |
| `ReportsBucket`    | S3 bucket storing scan reports       |
| `ScansTable`       | DynamoDB table for scan metadata     |
| `OpsDashboardUrl`  | CloudWatch ops dashboard             |

### Teardown

All infrastructure is defined in `template.yaml` (SAM/CloudFormation). Full cleanup:

```bash
sam delete
```

---

## Testing

### Configure the GitHub Webhook

1. Go to your GitHub repo → **Settings → Webhooks → Add webhook**
2. **Payload URL**: paste the `WebhookUrl` from stack outputs
3. **Content type**: `application/json`
4. **Secret**: the same `GitHubWebhookSecret` you used during deployment
5. **Events**: select "Pushes" and "Pull requests"
6. Click **Add webhook**

### Test Scripts

```bash
# Unit tests (scanner logic with known-vulnerable code)
node --test tests/unit/scanner.test.mjs

# Integration test (webhook → full pipeline → DynamoDB + S3)
bash tests/integration/pipeline.test.sh

# Failure test (bad repo → SQS retries → DLQ → SNS alert)
bash tests/failure/failure.test.sh

# Load/burst test (N concurrent webhooks)
bash tests/load/burst.test.sh
```

### Verify the Pipeline

```bash
# Check webhook handler logs
aws logs tail /aws/lambda/sast-webhook-handler --since 5m

# Check scanner logs
aws logs tail /aws/lambda/sast-scanner --since 5m

# Check DynamoDB for scan results
aws dynamodb scan --table-name sast-scans

# Check the API endpoint
curl <ApiUrl>/scans
```

### Note: Lambda Concurrency

AWS Learner Labs may limit the number of concurrent Lambda functions.
Keep this in mind when running burst/load tests with many simultaneous PRs.
