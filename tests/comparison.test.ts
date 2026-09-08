import { describe, expect, it } from 'vitest';

import { comparePlans } from '../src/domain/comparison.js';
import type { Plan, Principal, Repository } from '../src/domain/contracts.js';
import { createPlan } from '../src/domain/planner.js';
import { planDigest } from '../src/domain/repository-rules.js';

const owner: Principal = { ownerId: 'owner-a', scopes: ['architecture:read'] };
const now = new Date('2026-09-07T12:00:00.000Z');

function makePlan(
  id: string,
  input: Plan['input'] = { name: 'dados', blueprint: 'storage', environment: 'dev' },
  region = 'sa-east-1',
): Plan {
  return createPlan(owner.ownerId, input, region, now, () => id);
}

function repository(...plans: Plan[]): Repository {
  const byKey = new Map(plans.map((plan) => [`${plan.ownerId}\u0000${plan.id}`, plan]));
  return {
    getPlan: async (ownerId, planId) => byKey.get(`${ownerId}\u0000${planId}`),
  } as Repository;
}

describe('comparePlans', () => {
  it('remove apenas identidade gerada e ainda mostra a nova identidade física', async () => {
    const left = makePlan('00000000-0000-4000-8000-000000000001');
    const right = makePlan('00000000-0000-4000-8000-000000000002');

    const result = await comparePlans(repository(left, right), owner, {
      leftPlanId: left.id,
      rightPlanId: right.id,
    });

    expect(result.sameDefinition).toBe(true);
    expect(result.changes.inputs).toEqual([]);
    expect(result.changes.definition).toEqual([]);
    expect(result.changes.physicalIdentity.stack.changed).toBe(true);
    expect(result.changes.physicalIdentity.createsDistinctStack).toBe(true);
    expect(result.changes.physicalIdentity.resources).toEqual([
      expect.objectContaining({ logicalId: 'StorageBucket', property: 'BucketName' }),
    ]);
  });

  it('mostra mudança real de blueprint e recursos', async () => {
    const left = makePlan('00000000-0000-4000-8000-000000000001');
    const right = makePlan('00000000-0000-4000-8000-000000000002', {
      name: 'dados',
      blueprint: 'event-backbone',
      environment: 'prod',
    });

    const result = await comparePlans(repository(left, right), owner, {
      leftPlanId: left.id,
      rightPlanId: right.id,
    });

    expect(result.sameDefinition).toBe(false);
    expect(result.changes.inputs).toEqual(
      expect.arrayContaining([
        { field: 'blueprint', before: 'storage', after: 'event-backbone' },
        { field: 'environment', before: 'dev', after: 'prod' },
      ]),
    );
    expect(result.changes.definition).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/template/Resources/DeadLetterQueue', kind: 'ADDED' }),
        expect.objectContaining({ path: '/template/Resources/StorageBucket', kind: 'REMOVED' }),
      ]),
    );
  });

  it('mostra região e não mascara referência customizada igual ao id do plano', async () => {
    const left = makePlan('00000000-0000-4000-8000-000000000001');
    const right = makePlan('00000000-0000-4000-8000-000000000002', undefined, 'us-east-1');
    (left.template as Record<string, unknown>).Metadata = { CustomPlanReference: left.id };
    (right.template as Record<string, unknown>).Metadata = { CustomPlanReference: right.id };
    left.digest = planDigest(left);
    right.digest = planDigest(right);

    const result = await comparePlans(repository(left, right), owner, {
      leftPlanId: left.id,
      rightPlanId: right.id,
    });

    expect(result.changes.inputs).toContainEqual({
      field: 'region',
      before: 'sa-east-1',
      after: 'us-east-1',
    });
    expect(result.changes.definition).toContainEqual({
      path: '/template/Metadata/CustomPlanReference',
      kind: 'CHANGED',
    });
    expect(result.before.integrity).toBe(true);
    expect(result.after.integrity).toBe(true);
  });

  it('mantém isolamento, exige read e sinaliza integridade sem mutar', async () => {
    const left = makePlan('00000000-0000-4000-8000-000000000001');
    const right = structuredClone(left);
    right.id = 'pln-00000000-0000-4000-8000-000000000002';
    (right.template as { Description: string }).Description = 'adulterado';

    await expect(
      comparePlans(
        repository(left, right),
        { ownerId: owner.ownerId, scopes: [] },
        { leftPlanId: left.id, rightPlanId: right.id },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      comparePlans(
        repository(left, right),
        { ...owner, ownerId: 'owner-b' },
        { leftPlanId: left.id, rightPlanId: right.id },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      comparePlans(repository(left, right), owner, { leftPlanId: left.id, rightPlanId: right.id }),
    ).resolves.toMatchObject({
      after: { integrity: false },
      warnings: [expect.stringContaining('digest')],
    });
  });

  it('trunca diferenças de forma determinística', async () => {
    const left = makePlan('00000000-0000-4000-8000-000000000001');
    const right = makePlan('00000000-0000-4000-8000-000000000002');
    const leftMetadata: Record<string, string> = {};
    const rightMetadata: Record<string, string> = {};
    for (let index = 0; index < 25; index += 1) {
      leftMetadata[`field-${String(index).padStart(2, '0')}`] = 'left';
      rightMetadata[`field-${String(index).padStart(2, '0')}`] = 'right';
    }
    (left.template as Record<string, unknown>).Metadata = leftMetadata;
    (right.template as Record<string, unknown>).Metadata = rightMetadata;
    left.digest = planDigest(left);
    right.digest = planDigest(right);

    const result = await comparePlans(repository(left, right), owner, {
      leftPlanId: left.id,
      rightPlanId: right.id,
    });

    expect(result.changes.definition).toHaveLength(20);
    expect(result.changes.definitionChangesTruncated).toBe(true);
    expect(result.changes.definition[0]).toEqual({
      path: '/template/Metadata/field-00',
      kind: 'CHANGED',
    });
  });

  it('rejeita template corrompido antes de recursão ou clone', async () => {
    const left = makePlan('00000000-0000-4000-8000-000000000001');
    const right = makePlan('00000000-0000-4000-8000-000000000002');
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    (right.template as Record<string, unknown>).Metadata = metadata;

    await expect(
      comparePlans(repository(left, right), owner, {
        leftPlanId: left.id,
        rightPlanId: right.id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
