import { randomUUID } from 'node:crypto';

import type { ArchitectureInput, Plan } from './contracts.js';
import { planDigest } from './repository-rules.js';

export const CATALOG = [
  {
    id: 'storage',
    title: 'Armazenamento privado',
    description: 'Bucket S3 privado, criptografado, versionado e retido.',
  },
  {
    id: 'event-backbone',
    title: 'Base de eventos',
    description: 'Fila principal, DLQ e tabela DynamoDB sem consumidores.',
  },
] as const;

function resourceTags(planId: string): Array<{ Key: string; Value: string }> {
  return [{ Key: 'camcp:planId', Value: planId }];
}

function storageTemplate(planId: string, physicalName: string): Record<string, unknown> {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'CamCP: armazenamento privado versionado.',
    Resources: {
      StorageBucket: {
        Type: 'AWS::S3::Bucket',
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: {
          BucketName: physicalName,
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
            ],
          },
          VersioningConfiguration: { Status: 'Enabled' },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          Tags: resourceTags(planId),
        },
      },
    },
    Outputs: {
      BucketName: { Value: { Ref: 'StorageBucket' } },
      BucketArn: { Value: { 'Fn::GetAtt': ['StorageBucket', 'Arn'] } },
    },
  };
}

function eventBackboneTemplate(planId: string, physicalName: string): Record<string, unknown> {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'CamCP: base de eventos com fila, DLQ e tabela.',
    Resources: {
      DeadLetterQueue: {
        Type: 'AWS::SQS::Queue',
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: {
          QueueName: `${physicalName}-dlq`,
          SqsManagedSseEnabled: true,
          Tags: resourceTags(planId),
        },
      },
      MainQueue: {
        Type: 'AWS::SQS::Queue',
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: {
          QueueName: `${physicalName}-main`,
          SqsManagedSseEnabled: true,
          RedrivePolicy: {
            deadLetterTargetArn: { 'Fn::GetAtt': ['DeadLetterQueue', 'Arn'] },
            maxReceiveCount: 5,
          },
          Tags: resourceTags(planId),
        },
      },
      EventTable: {
        Type: 'AWS::DynamoDB::Table',
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: {
          TableName: `${physicalName}-events`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
          SSESpecification: { SSEEnabled: true },
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          Tags: resourceTags(planId),
        },
      },
    },
    Outputs: {
      MainQueueUrl: { Value: { Ref: 'MainQueue' } },
      DeadLetterQueueUrl: { Value: { Ref: 'DeadLetterQueue' } },
      EventTableName: { Value: { Ref: 'EventTable' } },
    },
  };
}

export function createPlan(
  ownerId: string,
  input: ArchitectureInput,
  region: string,
  now: Date,
  nextId: () => string = randomUUID,
): Plan {
  const id = `pln-${nextId()}`;
  // S3 limita nomes a 63 caracteres. O trecho final continua ligando o recurso ao plano,
  // sem deixar que um slug no limite faça o template falhar em CloudFormation.
  const physicalName = `camcp-${input.name}-${id.replaceAll('-', '').slice(-20)}`;
  const stackName = `camcp-${input.environment}-${input.name}-${id}`;
  const template =
    input.blueprint === 'storage'
      ? storageTemplate(id, physicalName)
      : eventBackboneTemplate(id, physicalName);
  const summary =
    input.blueprint === 'storage'
      ? [
          'Cria um bucket S3 privado, criptografado com AES256 e versionado.',
          'A retenção evita exclusão automática de dados.',
          'Custos não são estimados; não há consumers criados.',
        ]
      : [
          'Cria fila SQS principal e DLQ, ambas com criptografia gerenciada.',
          'Cria tabela DynamoDB sob demanda, criptografada e com PITR.',
          'Custos não são estimados; não há consumers criados.',
        ];
  const createdAt = now.toISOString();
  const plan: Plan = {
    id,
    ownerId,
    digest: '',
    createdAt,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    input,
    region,
    stackName,
    template,
    summary,
    status: 'PLANNED',
  };
  return { ...plan, digest: planDigest(plan) };
}
