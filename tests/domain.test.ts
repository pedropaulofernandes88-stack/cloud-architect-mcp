import { describe, expect, it } from 'vitest';

import { MemoryRepository } from '../src/adapters/memory.js';
import { DomainError, type Principal } from '../src/domain/contracts.js';
import { approve, applyOperationUpdate, operationId } from '../src/domain/repository-rules.js';
import { ArchitectureService } from '../src/domain/service.js';

const owner: Principal = {
  ownerId: 'alice',
  scopes: ['architecture:read', 'architecture:plan', 'architecture:apply'],
};
const fixedNow = new Date('2026-09-07T12:00:00.000Z');

function setup() {
  const repository = new MemoryRepository();
  let sequence = 0;
  const service = new ArchitectureService(repository, {
    region: 'sa-east-1',
    now: () => fixedNow,
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  });
  return { repository, service };
}

async function approvedStorage() {
  const { repository, service } = setup();
  const plan = await service.plan(owner, {
    name: 'dados-app',
    blueprint: 'storage',
    environment: 'dev',
  });
  await repository.approvePlan(
    owner.ownerId,
    plan.id,
    plan.digest,
    'admin',
    fixedNow.toISOString(),
  );
  return { repository, service, plan };
}

describe('ArchitectureService', () => {
  it('gera um plano restrito do catálogo, com digest e template seguro', async () => {
    const { service } = setup();
    const plan = await service.plan(owner, {
      name: 'dados-app',
      blueprint: 'storage',
      environment: 'prod',
    });

    expect(plan.id).toMatch(/^pln-/);
    expect(plan.stackName).toMatch(/^camcp-prod-dados-app-pln-/);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.expiresAt).toBe('2026-09-08T12:00:00.000Z');
    expect(plan.summary.join(' ')).toContain('Custos não são estimados');
    const resources = plan.template.Resources as Record<
      string,
      { Type: string; DeletionPolicy: string; Properties: Record<string, unknown> }
    >;
    const storageBucket = resources.StorageBucket;
    if (!storageBucket) throw new Error('StorageBucket ausente');
    expect(Object.keys(resources)).toEqual(['StorageBucket']);
    expect(storageBucket.Type).toBe('AWS::S3::Bucket');
    expect(storageBucket.DeletionPolicy).toBe('Retain');
    expect(storageBucket.Properties.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    });
    expect(storageBucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(storageBucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it('mantém nomes físicos no limite do provedor e tags no formato CloudFormation', async () => {
    const { service } = setup();
    const plan = await service.plan(owner, {
      name: 'abcdefghijklmnopqrst',
      blueprint: 'storage',
      environment: 'prod',
    });
    const resources = plan.template.Resources as Record<
      string,
      { Properties: { BucketName: string; Tags: unknown } }
    >;
    const storageBucket = resources.StorageBucket;
    if (!storageBucket) throw new Error('StorageBucket ausente');
    expect(storageBucket.Properties.BucketName).toMatch(
      /^camcp-abcdefghijklmnopqrst-[a-f0-9]{20}$/,
    );
    expect(storageBucket.Properties.BucketName.length).toBeLessThanOrEqual(63);
    expect(storageBucket.Properties.Tags).toEqual([{ Key: 'camcp:planId', Value: plan.id }]);
  });

  it('gera a espinha de eventos sem consumers, com DLQ, DynamoDB e retenção', async () => {
    const { service } = setup();
    const plan = await service.plan(owner, {
      name: 'eventos',
      blueprint: 'event-backbone',
      environment: 'staging',
    });
    const resources = plan.template.Resources as Record<
      string,
      { Type: string; DeletionPolicy: string; Properties: Record<string, unknown> }
    >;
    expect(Object.keys(resources).sort()).toEqual(['DeadLetterQueue', 'EventTable', 'MainQueue']);
    expect(resources.DeadLetterQueue).toMatchObject({
      Type: 'AWS::SQS::Queue',
      DeletionPolicy: 'Retain',
      Properties: { SqsManagedSseEnabled: true },
    });
    expect(resources.MainQueue).toMatchObject({
      Type: 'AWS::SQS::Queue',
      DeletionPolicy: 'Retain',
      Properties: { SqsManagedSseEnabled: true, RedrivePolicy: { maxReceiveCount: 5 } },
    });
    expect(resources.EventTable).toMatchObject({
      Type: 'AWS::DynamoDB::Table',
      DeletionPolicy: 'Retain',
      Properties: {
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: { SSEEnabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
    });
    expect(plan.summary.join(' ')).toContain('não há consumers');
  });

  it('valida rigorosamente o pedido e os scopes', async () => {
    const { service } = setup();
    await expect(
      service.plan(owner, { name: 'Nome-invalido', blueprint: 'storage', environment: 'dev' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.plan(owner, {
        name: 'valido',
        blueprint: 'storage',
        environment: 'dev',
        extra: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(() => service.catalog({ ownerId: 'alice', scopes: [] })).toThrowError(DomainError);
    await expect(
      service.plan(
        { ownerId: 'alice', scopes: ['architecture:read'] },
        { name: 'valido', blueprint: 'storage', environment: 'dev' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejeita template adulterado ao aprovar', async () => {
    const { repository, service } = setup();
    const plan = await service.plan(owner, {
      name: 'dados-app',
      blueprint: 'storage',
      environment: 'dev',
    });
    const tampered = structuredClone(plan);
    (tampered.template as { Description: string }).Description = 'alterado';

    expect(() => approve(tampered, plan.digest, 'admin', fixedNow.toISOString())).toThrowError(
      DomainError,
    );
    await expect(repository.putPlan(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('exige aprovação e isola os recursos por proprietário', async () => {
    const { repository, service } = setup();
    const plan = await service.plan(owner, {
      name: 'dados-app',
      blueprint: 'storage',
      environment: 'dev',
    });
    await expect(
      service.apply(owner, { planId: plan.id, digest: plan.digest, idempotencyKey: 'apply-1' }),
    ).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    await repository.approvePlan(
      owner.ownerId,
      plan.id,
      plan.digest,
      'admin',
      fixedNow.toISOString(),
    );
    await expect(
      service.apply(
        { ...owner, ownerId: 'bob' },
        { planId: plan.id, digest: plan.digest, idempotencyKey: 'apply-1' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('impede aplicação de plano expirado', async () => {
    const repository = new MemoryRepository();
    const service = new ArchitectureService(repository, {
      region: 'sa-east-1',
      now: () => new Date('2026-09-07T12:00:00.000Z'),
      id: () => '00000000-0000-4000-8000-000000000001',
    });
    const plan = await service.plan(owner, {
      name: 'dados-app',
      blueprint: 'storage',
      environment: 'dev',
    });
    await repository.approvePlan(
      owner.ownerId,
      plan.id,
      plan.digest,
      'admin',
      fixedNow.toISOString(),
    );
    const later = new ArchitectureService(repository, {
      region: 'sa-east-1',
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    await expect(
      later.apply(owner, { planId: plan.id, digest: plan.digest, idempotencyKey: 'late' }),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('é idempotente em concorrência e não aceita segunda chave para o mesmo plano', async () => {
    const { service, plan } = await approvedStorage();
    const input = { planId: plan.id, digest: plan.digest, idempotencyKey: 'same-request' };
    const results = await Promise.all(Array.from({ length: 8 }, () => service.apply(owner, input)));
    expect(new Set(results.map((operation) => operation.id))).toEqual(
      new Set([operationId(owner.ownerId, 'same-request')]),
    );
    await expect(
      service.apply(owner, { ...input, idempotencyKey: 'another-request' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('permite replay já iniciado após expiração e bloqueia chave reutilizada para outro plano', async () => {
    const { repository, service, plan } = await approvedStorage();
    const operation = await service.apply(owner, {
      planId: plan.id,
      digest: plan.digest,
      idempotencyKey: 'same',
    });
    const late = new ArchitectureService(repository, {
      region: 'sa-east-1',
      now: () => new Date('2026-09-09T12:00:00.000Z'),
    });
    await expect(
      late.apply(owner, { planId: plan.id, digest: plan.digest, idempotencyKey: 'same' }),
    ).resolves.toMatchObject({ id: operation.id });
    const another = await late.plan(owner, {
      name: 'outros',
      blueprint: 'storage',
      environment: 'dev',
    });
    await repository.approvePlan(
      owner.ownerId,
      another.id,
      another.digest,
      'admin',
      new Date('2026-09-09T12:00:00.000Z').toISOString(),
    );
    await expect(
      late.apply(owner, { planId: another.id, digest: another.digest, idempotencyKey: 'same' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('só permite transições de operação previstas e torna estados terminais imutáveis', async () => {
    const { repository, service, plan } = await approvedStorage();
    const operation = await service.apply(owner, {
      planId: plan.id,
      digest: plan.digest,
      idempotencyKey: 'run',
    });
    const running = applyOperationUpdate(operation, {
      status: 'RUNNING',
      updatedAt: '2026-09-07T12:01:00.000Z',
    });
    const succeeded = applyOperationUpdate(running, {
      status: 'SUCCEEDED',
      updatedAt: '2026-09-07T12:02:00.000Z',
    });
    expect(() =>
      applyOperationUpdate(succeeded, { status: 'RUNNING', updatedAt: '2026-09-07T12:03:00.000Z' }),
    ).toThrowError(DomainError);
    expect(() =>
      applyOperationUpdate(operation, {
        status: 'SUCCEEDED',
        updatedAt: '2026-09-07T12:01:00.000Z',
      }),
    ).toThrowError(DomainError);
    expect(
      applyOperationUpdate(running, {
        status: 'RUNNING',
        updatedAt: '2026-09-07T12:01:30.000Z',
        executionArn: 'arn:execution',
      }),
    ).toMatchObject({ executionArn: 'arn:execution' });
    await repository.updateOperation(owner.ownerId, operation.id, {
      status: 'RUNNING',
      updatedAt: '2026-09-07T12:01:00.000Z',
    });
    await repository.updateOperation(owner.ownerId, operation.id, {
      status: 'SUCCEEDED',
      updatedAt: '2026-09-07T12:02:00.000Z',
    });
    await expect(service.status(owner, { operationId: operation.id })).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
  });
});
