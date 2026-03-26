# SAST Security Scanner

## Team Members

- En-Ping Su
- Wendi Zhong
- Yiyang Wang

## Deployment

### Prerequisites

- AWS CLI configured with valid credentials
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) installed
- Docker running (required for building the scanner Lambda container image)
- Node.js 20.x
- A GitHub personal access token with `repo` scope

### Generate a Webhook Secret

Pick a random string to use as your GitHub webhook secret:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Save this value, you'll need it for both AWS deployment and GitHub webhook configuration.

### Build

```bash
sam build
```

### Deploy

For your first deployment, use guided mode:

```bash
sam deploy --guided
```

You will be prompted for:

| Parameter             | Description                                      |
|-----------------------|--------------------------------------------------|
| `GitHubWebhookSecret` | The random secret you generated above            |
| `GitHubToken`          | Your GitHub personal access token                |

For subsequent deployments:

```bash
sam deploy
```

### Retrieve Stack Outputs

After deployment, get the API URLs and resource names:

```bash
sam list stack-outputs --stack-name <your-stack-name>
```

Key outputs:

| Output          | Description                          |
|-----------------|--------------------------------------|
| `ApiUrl`        | Base URL for the query API           |
| `WebhookUrl`    | URL to configure in GitHub webhooks  |
| `DashboardUrl`  | Frontend dashboard URL               |
| `ReportsBucket` | S3 bucket storing scan reports       |
| `ScansTable`    | DynamoDB table for scan metadata     |

---

## Testing the SAST Scanner Pipeline

### Step 1 — Get Your API URL

In Windows, Powershell
```powershell
sam list stack-outputs --stack-name cs6620
```

Copy the `WebhookUrl` from the output.

### Step 2 — Configure the GitHub Webhook

1. Go to your GitHub repo → **Settings → Webhooks → Add webhook**
2. **Payload URL**: paste the `WebhookUrl`
3. **Content type**: `application/json`
4. **Secret**: the same `GitHubWebhookSecret` you used during deployment
5. **Events**: select "Just the push event"
6. Click **Add webhook**

### Step 3 — Trigger a Test Push

Make any small change in the repo and push it:

```powershell
git commit --allow-empty -m "test scan trigger"
git push
```

### Step 4 — Verify the Pipeline (Optional)

Check each stage to confirm it worked:

```powershell
# Check webhook handler logs
aws logs tail /aws/lambda/sast-webhook-handler --follow

# Check scanner logs
aws logs tail /aws/lambda/sast-scanner --follow

# Check SQS queue (should be 0 if message was processed)
aws sqs get-queue-attributes --queue-url <SQS_QUEUE_URL> --attribute-names ApproximateNumberOfMessages

# Check DynamoDB for scan results
aws dynamodb scan --table-name sast-scans

# Check the API endpoint
curl <ApiUrl>/scans
