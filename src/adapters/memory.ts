import type {
  HistoryPage,
  HistoryQuery,
  Operation,
  OperationUpdate,
  Plan,
  Repository,
} from '../domain/contracts.js';
import { approve, applyOperationUpdate, enqueue, operationId } from '../domain/repository-rules.js';
import { DomainError } from '../domain/contracts.js';

/** Repositório de desenvolvimento; cada chamada permanece atômica no event loop. */
export class MemoryRepository implements Repository {
  private readonly plans = new Map<string, Plan>();
  private readonly operations = new Map<string, Operation>();

  private planKey(ownerId: string, planId: string): string {
    return `${ownerId}\u0000${planId}`;
  }

  private operationKey(ownerId: string, operationIdValue: string): string {
    return `${ownerId}\u0000${operationIdValue}`;
  }

  async putPlan(plan: Plan): Promise<void> {
    const key = this.planKey(plan.ownerId, plan.id);
    if (this.plans.has(key))
      throw new DomainError('CONFLICT', 'Um plano com este identificador já existe.');
    this.plans.set(key, structuredClone(plan));
  }

  async getPlan(ownerId: string, planId: string): Promise<Plan | undefined> {
    const plan = this.plans.get(this.planKey(ownerId, planId));
    return plan && structuredClone(plan);
  }

  async listPlans(ownerId: string, query: HistoryQuery): Promise<HistoryPage<Plan>> {
    return this.history(
      [...this.plans.values()].filter((plan) => plan.ownerId === ownerId),
      query,
    );
  }

  async listOperations(ownerId: string, query: HistoryQuery): Promise<HistoryPage<Operation>> {
    return this.history(
      [...this.operations.values()].filter((operation) => operation.ownerId === ownerId),
      query,
    );
  }

  async approvePlan(
    ownerId: string,
    planId: string,
    digest: string,
    approvedBy: string,
    at: string,
  ): Promise<Plan> {
    const key = this.planKey(ownerId, planId);
    const result = approve(this.plans.get(key), digest, approvedBy, at);
    this.plans.set(key, result);
    return structuredClone(result);
  }

  async enqueueOperation(
    ownerId: string,
    planId: string,
    digest: string,
    idempotencyKey: string,
    at: string,
  ): Promise<Operation> {
    const planKey = this.planKey(ownerId, planId);
    const plan = this.plans.get(planKey);
    const byIdempotencyKey = this.operations.get(
      this.operationKey(ownerId, operationId(ownerId, idempotencyKey)),
    );
    const existing =
      byIdempotencyKey ??
      (plan?.operationId
        ? this.operations.get(this.operationKey(ownerId, plan.operationId))
        : undefined);
    const result = enqueue(plan, existing, ownerId, planId, digest, idempotencyKey, at);
    if (!result.replay) {
      this.plans.set(planKey, result.plan);
      this.operations.set(this.operationKey(ownerId, result.operation.id), result.operation);
    }
    return structuredClone(result.operation);
  }

  async getOperation(ownerId: string, operationIdValue: string): Promise<Operation | undefined> {
    const operation = this.operations.get(this.operationKey(ownerId, operationIdValue));
    return operation && structuredClone(operation);
  }

  async updateOperation(
    ownerId: string,
    operationIdValue: string,
    update: OperationUpdate,
  ): Promise<void> {
    const key = this.operationKey(ownerId, operationIdValue);
    const operation = this.operations.get(key);
    if (!operation) throw new DomainError('NOT_FOUND', 'Operação não encontrada.');
    this.operations.set(key, applyOperationUpdate(operation, update));
  }

  private history<T extends { id: string; createdAt: string }>(
    records: T[],
    query: HistoryQuery,
  ): HistoryPage<T> {
    const ordered = records
      .map((record) => ({ record, position: historyPosition(record) }))
      .filter(({ position }) => !query.before || position < query.before)
      .sort((left, right) => right.position.localeCompare(left.position));
    const page = ordered.slice(0, query.limit + 1);
    const hasNext = page.length > query.limit;
    const items = page.slice(0, query.limit).map(({ record }) => structuredClone(record));
    const last = page[Math.min(query.limit, page.length) - 1];
    return {
      items,
      ...(hasNext && last ? { nextPosition: last.position } : {}),
    };
  }
}

function historyPosition(record: { id: string; createdAt: string }): string {
  return `${record.createdAt}#${record.id}`;
}
