# CS6620 — SAST Scanner (AWS SAM)

Serverless pipeline: **GitHub webhook → API Gateway → SQS → container Lambda (SAST) → DynamoDB + S3**, with SNS email alerts and PR comment write-back on pull requests.

Course context and tool background: see [`cs6620/README.md`](cs6620/README.md).

---

## Prerequisites

- **AWS CLI** configured (Learner Lab or your own account)
- **AWS SAM CLI** (`sam`)
- **Docker** (must be running) — required for `sam build` because `ScannerFunction` uses a container image

---

## Deploy

### 1. Build

```bash
sam build
```

### 2. Prepare ECR + `samconfig.toml` (recommended)

**Why this is our recommended path:** on first deploy, we have repeatedly seen ECR-related failures such as:
`Error: Unable to upload artifact scannerfunction:latest referenced by ImageUri parameter of ScannerFunction resource.`
`error from registry: The repository with name '.../scannerfunction...repo' does not exist in the registry ...`

Root cause is not fully confirmed yet (possibly SAM managed-ECR behavior in this environment, or Learner Lab IAM restrictions).  
**So our approach is:** create ECR first, then deploy with a fully populated `samconfig.toml`.

1. Create ECR repository (once per account/region):
   ```bash
   aws ecr create-repository --region us-west-2 --repository-name sast-scanner-repo
   ```
   If it already exists, AWS returns `RepositoryAlreadyExistsException` (safe to continue).

2. Confirm repository URI:
   ```bash
   aws ecr describe-repositories --region us-west-2 --repository-names sast-scanner-repo --query "repositories[0].repositoryUri" --output text
   ```

3. Copy `samconfig.toml.example` to `samconfig.toml` and fill values:
   - `image_repositories` must map `ScannerFunction` to your ECR URI.
   - `parameter_overrides` must include both `GitHubWebhookSecret` and `GitHubToken`.
   - Do **not** enable `resolve_image_repos` when `image_repositories` is set.

4. Deploy:
   ```bash
   sam build && sam deploy
   ```

---

## GitHub Token

Generate a **Classic PAT** at:
`GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)`

Required scope: `repo` (full control of repositories)

This token is used for two things:
- Cloning the target repository during scanning
- Posting scan result comments on pull requests

---

## Post-deploy setup

### GitHub Webhook

1. Go to your target repo → **Settings → Webhooks → Add webhook**
2. Payload URL: use the `WebhookUrl` value from the SAM deploy output
3. Content type: `application/json`
4. Secret: same string you used for `GitHubWebhookSecret`
5. Events: select **Pull requests**

### SNS Email Subscription

To receive email alerts for HIGH severity findings and scan failures:

1. Go to **AWS Console → SNS → Topics → sast-security-findings**
2. Create subscription → Protocol: Email → enter your email address
3. Confirm the subscription via the email you receive

---

## Layout

| Path | Role |
|------|------|
| `template.yaml` | SAM template — all AWS resources defined here |
| `src/webhook-handler/` | Validates GitHub signature, enqueues scan jobs to SQS |
| `src/scanner/` | Container Lambda: clones repo, runs SAST, writes to DynamoDB + S3, sends SNS alert and PR comment |
| `src/dlq-notifier/` | Triggered by DLQ — sends SNS failure notification when a scan job exhausts all retries |
| `src/query-api/` | HTTP endpoints for scan metadata and reports |
| `cs6620/` | Course reference code (not deployed) |

---

## Teardown

**Goal:** Stop charges by removing the CloudFormation stack so Lambda, SQS, DynamoDB, SNS, API Gateway, and related resources are deleted together.

**Option A — SAM CLI**

```bash
sam delete
```

**Option B — AWS CLI** (replace stack name / region if yours differ)

```bash
aws cloudformation delete-stack --stack-name sast-scanner-stack --region us-west-2
aws cloudformation wait stack-delete-complete --stack-name sast-scanner-stack --region us-west-2
```

Confirm in the **CloudFormation** console that the stack is gone.

### If deletion fails or hangs — usually S3

Buckets `sast-reports-<ACCOUNT_ID>` and `sast-dashboard-<ACCOUNT_ID>` cannot be deleted while non-empty. Get your account ID: `aws sts get-caller-identity --query Account --output text`, then:

```bash
aws s3 rm s3://sast-reports-<ACCOUNT_ID> --recursive
aws s3 rm s3://sast-dashboard-<ACCOUNT_ID> --recursive
```

Retry `sam delete` or `delete-stack`.

### Optional — ECR

`ScannerFunction` uses a container image; after the stack is deleted, check **ECR** for leftover repositories for this project and remove images/repos you no longer need (avoid deleting others’ repos).

### Before redeploying

A stack in `ROLLBACK_COMPLETE` cannot be updated — delete it (as above) or deploy under a **new stack name**.

---

## Security

- `samconfig.toml` is listed in `.gitignore` — do not commit it
- Revoke and regenerate your GitHub token if it is ever exposed