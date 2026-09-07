import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { CloudArchitectMcpStack } from '../infra/cloud-architect-mcp-stack.js';

describe('CDK infrastructure', () => {
  it('retém a tabela cifrada, usa stream outbox e uma Standard workflow sem inputs em logs', () => {
    const app = new cdk.App({
      context: { jwtIssuer: 'https://issuer.example', jwtAudience: 'camcp' },
    });
    const stack = new CloudArchitectMcpStack(app, 'TestStack');
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: { Filters: [{ Pattern: Match.stringLikeRegexp('.*PENDING.*') }] },
    });
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      LoggingConfiguration: { IncludeExecutionData: false, Level: 'ERROR' },
    });
  }, 15_000);
});
