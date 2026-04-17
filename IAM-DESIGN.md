# IAM Design

This document describes the intended IAM role design for the SAST scanner. It is not implemented in the current deployment due to Learner Lab constraints — all Lambda functions currently use the pre-configured `LabRole`. This document records what a production-ready configuration should look like.

---

## Current State

All four Lambda functions are assigned `LabRole`:

```yaml
Role: !Sub 'arn:aws:iam::${AWS::AccountId}:role/LabRole'
```

The `Policies` blocks defined alongside each function in `template.yaml` are dead code — SAM ignores `Policies` when `Role` is explicitly set. The actual permissions come entirely from `LabRole`, which is broader than any of the functions require.

---

## Design Principles

**1. One role per function**
Each Lambda function gets its own execution role. If one function is compromised, it cannot affect the others. Roles also serve as documentation — you can understand what a function does by reading its role.

**2. Follow the data flow**
Permissions should reflect the direction each function operates in:

| Function | Direction | Operations |
|----------|-----------|------------|
| WebhookHandler | Write only | Enqueue to SQS, write initial record to DynamoDB |
| Scanner | Process only | Update DynamoDB, write to S3, publish to SNS, emit CloudWatch metrics |
| QueryApi | Read only | Read DynamoDB, read S3 (for pre-signed URLs) |
| DLQNotifier | Notify only | Read DynamoDB (fetch error details), publish to SNS |

Data flows in one direction. The query API can never write to DynamoDB. The webhook handler can never read S3.

**3. Lock down at the resource level**
Restrict not just the action but also the specific resource ARN. This limits the blast radius of any injection attack to a single table or bucket, not the entire account.

---

## Proposed Role Definitions

### WebhookHandlerRole

```yaml
WebhookHandlerRole:
  Type: AWS::IAM::Role
  Properties:
    RoleName: sast-webhook-handler-role
    AssumeRolePolicyDocument:
      Version: '2012-10-17'
      Statement:
        - Effect: Allow
          Principal:
            Service: lambda.amazonaws.com
          Action: sts:AssumeRole
    ManagedPolicyArns:
      - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    Policies:
      - PolicyName: sast-webhook-handler-policy
        PolicyDocument:
          Version: '2012-10-17'
          Statement:
            - Effect: Allow
              Action: sqs:SendMessage
              Resource: !GetAtt ScanJobQueue.Arn
            - Effect: Allow
              Action: dynamodb:PutItem
              Resource: !GetAtt ScansTable.Arn
```

### ScannerRole

```yaml
ScannerRole:
  Type: AWS::IAM::Role
  Properties:
    RoleName: sast-scanner-role
    AssumeRolePolicyDocument:
      Version: '2012-10-17'
      Statement:
        - Effect: Allow
          Principal:
            Service: lambda.amazonaws.com
          Action: sts:AssumeRole
    ManagedPolicyArns:
      - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    Policies:
      - PolicyName: sast-scanner-policy
        PolicyDocument:
          Version: '2012-10-17'
          Statement:
            - Effect: Allow
              Action: dynamodb:UpdateItem
              Resource: !GetAtt ScansTable.Arn
            - Effect: Allow
              Action: s3:PutObject
              Resource: !Sub '${ReportsBucket.Arn}/*'
            - Effect: Allow
              Action: sns:Publish
              Resource: !Ref SastSecurityFindingsTopic
            - Effect: Allow
              Action: cloudwatch:PutMetricData
              Resource: '*'
              Condition:
                StringEquals:
                  cloudwatch:namespace: SASTScanner
            - Effect: Allow
              Action:
                - sqs:ReceiveMessage
                - sqs:DeleteMessage
                - sqs:GetQueueAttributes
              Resource: !GetAtt ScanJobQueue.Arn
```

### QueryApiRole

```yaml
QueryApiRole:
  Type: AWS::IAM::Role
  Properties:
    RoleName: sast-query-api-role
    AssumeRolePolicyDocument:
      Version: '2012-10-17'
      Statement:
        - Effect: Allow
          Principal:
            Service: lambda.amazonaws.com
          Action: sts:AssumeRole
    ManagedPolicyArns:
      - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    Policies:
      - PolicyName: sast-query-api-policy
        PolicyDocument:
          Version: '2012-10-17'
          Statement:
            - Effect: Allow
              Action:
                - dynamodb:GetItem
                - dynamodb:Query
                - dynamodb:Scan
              Resource:
                - !GetAtt ScansTable.Arn
                - !Sub '${ScansTable.Arn}/index/*'
            - Effect: Allow
              Action: s3:GetObject
              Resource: !Sub '${ReportsBucket.Arn}/*'
```

### DLQNotifierRole

```yaml
DLQNotifierRole:
  Type: AWS::IAM::Role
  Properties:
    RoleName: sast-dlq-notifier-role
    AssumeRolePolicyDocument:
      Version: '2012-10-17'
      Statement:
        - Effect: Allow
          Principal:
            Service: lambda.amazonaws.com
          Action: sts:AssumeRole
    ManagedPolicyArns:
      - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    Policies:
      - PolicyName: sast-dlq-notifier-policy
        PolicyDocument:
          Version: '2012-10-17'
          Statement:
            - Effect: Allow
              Action: dynamodb:GetItem
              Resource: !GetAtt ScansTable.Arn
            - Effect: Allow
              Action: sns:Publish
              Resource: !Ref SastSecurityFindingsTopic
            - Effect: Allow
              Action:
                - sqs:ReceiveMessage
                - sqs:DeleteMessage
                - sqs:GetQueueAttributes
              Resource: !GetAtt ScanJobDLQ.Arn
```

---

## Why This Is Not Implemented

Learner Lab accounts do not allow `iam:CreateRole` or `iam:PutRolePolicy`. Attempting to deploy these role definitions would fail with an access denied error. The existing `LabRole` is used as a workaround for the duration of this course project.
