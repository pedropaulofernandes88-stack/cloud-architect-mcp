import { createHash } from 'node:crypto';

import { DomainError, type Operation, type OperationUpdate, type Plan } from './contracts.js';

export function operationId(ownerId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${ownerId}\u0000${idempotencyKey}`).digest('hex');
  return `op-${digest.slice(0, 48)}`;
}

/** JSON canônico para que a assinatura de um plano não dependa da ordem das chaves. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function planDigest(
  plan: Pick<Plan, 'input' | 'region' | 'stackName' | 'template'>,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        input: plan.input,
        region: plan.region,
        stackName: plan.stackName,
        template: plan.template,
      }),
    )
    .digest('hex');
}

export function assertPlanIntegrity(plan: Plan): void {
  if (plan.digest !== planDigest(plan)) {
    throw new DomainError('CONFLICT', 'O template não corresponde ao digest do plano.');
  }
}

export function approve(plan: Plan | undefined, digest: string, by: string, at: string): Plan {
  if (!plan) throw new DomainError('NOT_FOUND', 'Plano não encontrado.');
  if (plan.digest !== digest)
    throw new DomainError('CONFLICT', 'O digest informado não corresponde ao plano.');
  assertPlanIntegrity(plan);
  if (Date.parse(plan.expiresAt) <= Date.parse(at))
    throw new DomainError('EXPIRED', 'O plano expirou.');
  if (plan.status === 'QUEUED')
    throw new DomainError('CONFLICT', 'O plano já possui uma operação.');
  if (plan.status === 'APPROVED') return plan;
  return { ...plan, status: 'APPROVED', approvedAt: at, approvedBy: by };
}

export function enqueue(
  plan: Plan | undefined,
  existingOperation: Operation | undefined,
  ownerId: string,
  planId: string,
  digest: string,
  idempotencyKey: string,
  at: string,
): { plan: Plan; operation: Operation; replay: boolean } {
  if (!plan) throw new DomainError('NOT_FOUND', 'Plano não encontrado.');
  if (plan.ownerId !== ownerId || plan.id !== planId)
    throw new DomainError('NOT_FOUND', 'Plano não encontrado.');
  if (existingOperation && existingOperation.ownerId !== ownerId)
    throw new DomainError('NOT_FOUND', 'Operação não encontrada.');
  const expectedOperationId = operationId(ownerId, idempotencyKey);

  if (existingOperation?.id === expectedOperationId) {
    if (existingOperation.planId !== planId || existingOperation.planDigest !== digest) {
      throw new DomainError(
        'CONFLICT',
        'A chave de idempotência já foi usada para outro plano ou digest.',
      );
    }
    return { plan, operation: existingOperation, replay: true };
  }
  if (plan.operationId || existingOperation) {
    throw new DomainError('CONFLICT', 'Um plano só pode gerar uma operação.');
  }
  if (plan.digest !== digest)
    throw new DomainError('CONFLICT', 'O digest informado não corresponde ao plano.');
  assertPlanIntegrity(plan);
  if (Date.parse(plan.expiresAt) <= Date.parse(at))
    throw new DomainError('EXPIRED', 'O plano expirou.');
  if (plan.status !== 'APPROVED')
    throw new DomainError('NOT_APPROVED', 'O plano precisa de aprovação administrativa.');

  const operation: Operation = {
    id: expectedOperationId,
    ownerId,
    planId,
    planDigest: digest,
    stackName: plan.stackName,
    createdAt: at,
    updatedAt: at,
    status: 'PENDING',
  };
  return {
    plan: { ...plan, status: 'QUEUED', operationId: operation.id },
    operation,
    replay: false,
  };
}

export function applyOperationUpdate(operation: Operation, update: OperationUpdate): Operation {
  if (operation.status === update.status) {
    return operation.status === 'SUCCEEDED' || operation.status === 'FAILED'
      ? operation
      : { ...operation, ...update };
  }
  if (operation.status === 'SUCCEEDED' || operation.status === 'FAILED') {
    throw new DomainError('CONFLICT', 'Uma operação terminal não pode ser alterada.');
  }
  const allowed =
    (operation.status === 'PENDING' &&
      (update.status === 'RUNNING' || update.status === 'FAILED')) ||
    (operation.status === 'RUNNING' &&
      (update.status === 'SUCCEEDED' || update.status === 'FAILED'));
  if (!allowed) throw new DomainError('CONFLICT', 'Transição de operação inválida.');
  return { ...operation, ...update };
}
