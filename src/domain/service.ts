import { randomUUID } from 'node:crypto';

import {
  DomainError,
  type Plan,
  type PlanValidation,
  type Principal,
  type Repository,
} from './contracts.js';
import { CATALOG, createPlan } from './planner.js';
import { planDigest } from './repository-rules.js';
import { listPlans, listOperations } from './history.js';
import { comparePlans } from './comparison.js';
import {
  applyInputSchema,
  architectureInputSchema,
  getPlanInputSchema,
  statusInputSchema,
} from './schemas.js';

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

  listPlans(principal: Principal, input: unknown) {
    return listPlans(this.repository, principal, input);
  }

  listOperations(principal: Principal, input: unknown) {
    return listOperations(this.repository, principal, input);
  }

  comparePlans(principal: Principal, input: unknown) {
    return comparePlans(this.repository, principal, input);
  }

  async getPlan(principal: Principal, input: unknown): Promise<Plan> {
    this.requireScope(principal, 'architecture:read');
    const parsed = getPlanInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Entrada inválida.',
      );
    }
    const plan = await this.repository.getPlan(principal.ownerId, parsed.data.planId);
    if (!plan) throw new DomainError('NOT_FOUND', 'Plano não encontrado.');
    return plan;
  }

  async validatePlan(principal: Principal, input: unknown): Promise<PlanValidation> {
    const plan = await this.getPlan(principal, input);
    const now = (this.options.now ?? (() => new Date()))();
    const expiry = Date.parse(plan.expiresAt);
    const checks = {
      integrity: plan.digest === planDigest(plan),
      notExpired: Number.isFinite(expiry) && expiry > now.getTime(),
      approved:
        (plan.status === 'APPROVED' || plan.status === 'QUEUED') &&
        typeof plan.approvedAt === 'string' &&
        plan.approvedAt.length > 0 &&
        typeof plan.approvedBy === 'string' &&
        plan.approvedBy.length > 0,
      notQueued: plan.status !== 'QUEUED',
    };
    const reasons: string[] = [];
    if (!checks.integrity) reasons.push('O digest não corresponde ao conteúdo do plano.');
    if (!checks.notExpired) reasons.push('O plano expirou.');
    if (!checks.approved) reasons.push('O plano não possui aprovação administrativa registrada.');
    if (!checks.notQueued) reasons.push('O plano já possui uma operação enfileirada.');
    return {
      planId: plan.id,
      digest: plan.digest,
      status: plan.status,
      readyToApply: reasons.length === 0,
      checks,
      reasons,
      ...(plan.operationId ? { operationId: plan.operationId } : {}),
    };
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
