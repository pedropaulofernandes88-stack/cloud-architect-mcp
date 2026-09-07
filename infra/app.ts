import * as cdk from 'aws-cdk-lib';

import { CloudArchitectMcpStack } from './cloud-architect-mcp-stack.js';

const app = new cdk.App();
new CloudArchitectMcpStack(app, 'CloudArchitectMcpStack', {
  description: 'MCP stateless para planos aprovados e provisionamento AWS durável.',
});
