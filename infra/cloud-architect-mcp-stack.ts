import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

const SYNTH_ISSUER = 'https://example.invalid/camcp-issuer';
const SYNTH_AUDIENCE = 'camcp-local-synth';

export class CloudArchitectMcpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Values example.invalid are synthesis-only. Deploy with -c jwtIssuer=… -c jwtAudience=… .
    const issuer = this.node.tryGetContext('jwtIssuer') ?? SYNTH_ISSUER;
    const audience = this.node.tryGetContext('jwtAudience') ?? SYNTH_AUDIENCE;
    if (issuer === SYNTH_ISSUER || audience === SYNTH_AUDIENCE) {
      cdk.Annotations.of(this).addWarning(
        'JWT issuer/audience usam placeholders de synth; informe -c jwtIssuer e -c jwtAudience antes do deploy.',
      );
    }

    const table = new dynamodb.Table(this, 'Operations', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const failureQueue = new sqs.Queue(this, 'DispatcherFailureQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    const executionRole = new iam.Role(this, 'CloudFormationExecutionRole', {
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      description: 'Permite apenas os recursos criados pelos blueprints CamCP.',
    });
    const partition = cdk.Aws.PARTITION;
    const account = cdk.Aws.ACCOUNT_ID;
    const region = cdk.Aws.REGION;
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:CreateBucket',
          's3:DeleteBucket',
          's3:GetBucket*',
          's3:ListBucket',
          's3:PutBucket*',
          's3:PutEncryptionConfiguration',
          's3:PutLifecycleConfiguration',
          's3:PutBucketTagging',
        ],
        resources: [`arn:${partition}:s3:::camcp-*`],
      }),
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'sqs:CreateQueue',
          'sqs:DeleteQueue',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:ListQueueTags',
          'sqs:SetQueueAttributes',
          'sqs:TagQueue',
          'sqs:UntagQueue',
        ],
        resources: [`arn:${partition}:sqs:${region}:${account}:camcp-*`],
      }),
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:CreateTable',
          'dynamodb:DeleteTable',
          'dynamodb:DescribeTable',
          'dynamodb:DescribeContinuousBackups',
          'dynamodb:DescribeTimeToLive',
          'dynamodb:ListTagsOfResource',
          'dynamodb:TagResource',
          'dynamodb:UntagResource',
          'dynamodb:UpdateContinuousBackups',
          'dynamodb:UpdateTable',
          'dynamodb:UpdateTimeToLive',
        ],
        resources: [`arn:${partition}:dynamodb:${region}:${account}:table/camcp-*`],
      }),
    );

    const worker = this.lambda('Worker', 'worker', {
      TABLE_NAME: table.tableName,
      EXECUTION_ROLE_ARN: executionRole.roleArn,
    });
    worker.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [table.tableArn] }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['OWNER#*'] } },
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:CreateStack', 'cloudformation:DescribeStacks'],
        resources: [
          this.formatArn({
            service: 'cloudformation',
            resource: 'stack',
            resourceName: 'camcp-*/*',
          }),
        ],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [executionRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
      }),
    );

    const stateMachineLogGroup = new logs.LogGroup(this, 'WorkflowLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const stateMachine = new sfn.CfnStateMachine(this, 'ProvisionWorkflow', {
      roleArn: this.workflowRole(worker).roleArn,
      stateMachineType: 'STANDARD',
      loggingConfiguration: {
        destinations: [
          { cloudWatchLogsLogGroup: { logGroupArn: stateMachineLogGroup.logGroupArn } },
        ],
        level: 'ERROR',
        includeExecutionData: false,
      },
      definitionString: cdk.Fn.sub(JSON.stringify(workflowDefinition(worker.functionArn)), {
        WorkerArn: worker.functionArn,
      }),
    });

    const dispatcher = this.lambda('Dispatcher', 'dispatcher', {
      STATE_MACHINE_ARN: stateMachine.attrArn,
    });
    dispatcher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [stateMachine.attrArn],
      }),
    );
    failureQueue.grantSendMessages(dispatcher);
    failureQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [failureQueue.queueArn],
      }),
    );
    new lambda.CfnEventSourceMapping(this, 'OperationOutbox', {
      functionName: dispatcher.functionName,
      eventSourceArn: table.tableStreamArn,
      startingPosition: 'TRIM_HORIZON',
      batchSize: 10,
      bisectBatchOnFunctionError: true,
      maximumRetryAttempts: 3,
      functionResponseTypes: ['ReportBatchItemFailures'],
      destinationConfig: { onFailure: { destination: failureQueue.queueArn } },
      filterCriteria: {
        filters: [
          {
            pattern: JSON.stringify({
              eventName: ['INSERT'],
              dynamodb: { NewImage: { kind: { S: ['operation'] }, status: { S: ['PENDING'] } } },
            }),
          },
        ],
      },
    });
    table.grantStreamRead(dispatcher);

    const gateway = this.lambda('Gateway', 'lambda', {
      TABLE_NAME: table.tableName,
      EXPECTED_ISSUER: issuer,
    });
    // The MCP process only creates plans or transactionally enqueues operations.
    gateway.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [table.tableArn] }),
    );
    gateway.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['OWNER#*'] } },
      }),
    );
    gateway.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['OWNER#*'] },
          'ForAnyValue:StringEquals': { 'dynamodb:EnclosingOperation': ['TransactWriteItems'] },
        },
      }),
    );
    gateway.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:ConditionCheckItem'],
        resources: [table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['APPROVAL#*'] },
          'ForAnyValue:StringEquals': { 'dynamodb:EnclosingOperation': ['TransactWriteItems'] },
        },
      }),
    );

    const api = new apigwv2.HttpApi(this, 'Api', { createDefaultStage: true });
    const authorizer = new HttpJwtAuthorizer('JwtAuthorizer', issuer, { jwtAudience: [audience] });
    const integration = new HttpLambdaIntegration('McpIntegration', gateway);
    // Do not add route authorizationScopes: HTTP API interprets multiple scopes as OR;
    // service-level checks enforce the distinct scope required by each MCP tool.
    api.addRoutes({ path: '/mcp', methods: [apigwv2.HttpMethod.POST], integration, authorizer });
    api.addRoutes({ path: '/health', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({ path: '/', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({
      path: '/.well-known/oauth-protected-resource/mcp',
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    new cloudwatch.Alarm(this, 'DispatcherDlqAlarm', {
      metric: failureQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
    });
    new cloudwatch.Alarm(this, 'WorkerErrorAlarm', {
      metric: worker.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
    });

    new cdk.CfnOutput(this, 'McpEndpoint', { value: `${api.apiEndpoint}/mcp` });
    new cdk.CfnOutput(this, 'OperationsTableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'ProvisionWorkflowArn', { value: stateMachine.attrArn });
    new cdk.CfnOutput(this, 'DispatcherFailureQueueUrl', { value: failureQueue.queueUrl });
    new cdk.CfnOutput(this, 'ApprovalsIamNote', {
      value:
        'A aprovação é executada pela CLI administrativa com IAM da tabela; a Lambda MCP não recebe dynamodb:UpdateItem.',
    });
    new cdk.CfnOutput(this, 'DispatcherRecoveryNote', {
      value:
        'Mensagens de stream que excederem retries ficam em DispatcherFailureQueue; reexecute o evento somente após investigar a operação.',
    });
  }

  private lambda(
    id: string,
    assetName: string,
    environment: Record<string, string>,
  ): lambda.Function {
    return new lambda.Function(this, id, {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(process.cwd(), 'dist', assetName)),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      tracing: lambda.Tracing.PASS_THROUGH,
      environment,
    });
  }

  private workflowRole(worker: lambda.IFunction): iam.Role {
    const role = new iam.Role(this, 'WorkflowRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [worker.functionArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogDelivery',
          'logs:GetLogDelivery',
          'logs:UpdateLogDelivery',
          'logs:DeleteLogDelivery',
          'logs:ListLogDeliveries',
          'logs:PutResourcePolicy',
          'logs:DescribeResourcePolicies',
          'logs:DescribeLogGroups',
        ],
        resources: ['*'],
      }),
    );
    return role;
  }
}

function workflowDefinition(workerArn: string) {
  const invoke = (action: string, next: string) => ({
    Type: 'Task',
    Resource: 'arn:aws:states:::lambda:invoke',
    Parameters: {
      FunctionName: '${WorkerArn}',
      Payload: { action, 'ownerId.$': '$.ownerId', 'operationId.$': '$.operationId' },
    },
    ResultSelector: { 'status.$': '$.Payload.status' },
    ResultPath: '$.operation',
    Next: next,
    Retry: [
      {
        ErrorEquals: [
          'Lambda.ServiceException',
          'Lambda.AWSLambdaException',
          'Lambda.SdkClientException',
        ],
        IntervalSeconds: 2,
        MaxAttempts: 3,
        BackoffRate: 2,
      },
    ],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.failure', Next: 'PersistFailure' }],
  });
  return {
    Comment: 'Provisiona uma operação CamCP em passos curtos e duráveis.',
    StartAt: 'Start',
    TimeoutSeconds: 3600,
    States: {
      Start: invoke('start', 'Check'),
      Wait: { Type: 'Wait', Seconds: 15, Next: 'Poll' },
      Poll: invoke('poll', 'Check'),
      Check: {
        Type: 'Choice',
        Choices: [
          { Variable: '$.operation.status', StringEquals: 'SUCCEEDED', Next: 'Succeeded' },
          { Variable: '$.operation.status', StringEquals: 'FAILED', Next: 'Failed' },
        ],
        Default: 'Wait',
      },
      PersistFailure: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke',
        Parameters: {
          FunctionName: '${WorkerArn}',
          Payload: {
            action: 'fail',
            'ownerId.$': '$.ownerId',
            'operationId.$': '$.operationId',
            message: 'Workflow falhou ou excedeu o prazo.',
          },
        },
        Next: 'Failed',
      },
      Succeeded: { Type: 'Succeed' },
      Failed: { Type: 'Fail', Error: 'ProvisioningFailed' },
    },
  };
}
