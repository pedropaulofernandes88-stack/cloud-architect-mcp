import { randomUUID } from 'node:crypto';

import { DomainError, type Principal, type Repository } from './contracts.js';
import { CATALOG, createPlan } from './planner.js';
import { applyInputSchema, architectureInputSchema, statusInputSchema } from './schemas.js';

export class ArchitectureService {
  constructor(
    private readonly repository: Repository,
    private readonly options: { region: string; now?: () => Date; id?: () => string },
  ) {}

  private requireScope(principal: Principal, scope: string): void {
    if (!principal.scopes.includes(scope))
      throw new DomainError('FORBIDDEN', `Escopo obrigatório: ${scope}.`);
  }

  catalog(principal: Principal) {
    this.requireScope(principal, 'architecture:read');
    return CATALOG;
  }

  async plan(principal: Principal, input: unknown) {
    this.requireScope(principal, 'architecture:plan');
    const parsed = architectureInputSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Entrada inválida.',
      );
    const plan = createPlan(
      principal.ownerId,
      parsed.data,
      this.options.region,
      (this.options.now ?? (() => new Date()))(),
      this.options.id ?? randomUUID,
    );
    await this.repository.putPlan(plan);
    return plan;
  }

  async apply(principal: Principal, input: unknown) {
    this.requireScope(principal, 'architecture:apply');
    const parsed = applyInputSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Entrada inválida.',
      );
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    return this.repository.enqueueOperation(
      principal.ownerId,
      parsed.data.planId,
      parsed.data.digest,
      parsed.data.idempotencyKey,
      now,
    );
  }

  async status(principal: Principal, input: unknown) {
    this.requireScope(principal, 'architecture:read');
    const parsed = statusInputSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Entrada inválida.',
      );
    const operation = await this.repository.getOperation(
      principal.ownerId,
      parsed.data.operationId,
    );
    if (!operation) throw new DomainError('NOT_FOUND', 'Operação não encontrada.');
    return operation;
  }
}
