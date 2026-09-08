export type Blueprint = 'storage' | 'event-backbone';
export type Environment = 'dev' | 'staging' | 'prod';
export interface ArchitectureInput {
  name: string;
  blueprint: Blueprint;
  environment: Environment;
}
export interface Principal {
  ownerId: string;
  scopes: readonly string[];
}
export interface Plan {
  id: string;
  ownerId: string;
  digest: string;
  createdAt: string;
  expiresAt: string;
  input: ArchitectureInput;
  region: string;
  stackName: string;
  template: Record<string, unknown>;
  summary: string[];
  status: 'PLANNED' | 'APPROVED' | 'QUEUED';
  approvedAt?: string;
  approvedBy?: string;
  operationId?: string;
}
export interface PlanValidation {
  planId: string;
  digest: string;
  status: Plan['status'];
  readyToApply: boolean;
  checks: {
    integrity: boolean;
    notExpired: boolean;
    approved: boolean;
    notQueued: boolean;
  };
  reasons: string[];
  operationId?: string;
}
export type OperationStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_ATTENTION';
export interface Operation {
  id: string;
  ownerId: string;
  planId: string;
  planDigest: string;
  stackName: string;
  createdAt: string;
  updatedAt: string;
  status: OperationStatus;
  stackId?: string;
  message?: string;
  outputs?: Record<string, string>;
}
export type OperationUpdate = Partial<Pick<Operation, 'stackId' | 'message' | 'outputs'>> & {
  status: OperationStatus;
  updatedAt: string;
};
/** Cursor position is internal; the service binds public cursors to owner and entity kind. */
export interface HistoryQuery {
  limit: number;
  before?: string;
}
export interface HistoryPage<T> {
  items: T[];
  nextPosition?: string;
}
export interface Repository {
  putPlan(plan: Plan): Promise<void>;
  getPlan(ownerId: string, planId: string): Promise<Plan | undefined>;
  listPlans(ownerId: string, query: HistoryQuery): Promise<HistoryPage<Plan>>;
  listOperations(ownerId: string, query: HistoryQuery): Promise<HistoryPage<Operation>>;
  approvePlan(
    ownerId: string,
    planId: string,
    digest: string,
    approvedBy: string,
    at: string,
  ): Promise<Plan>;
  /** Atomic claim: bind one operation to an approved plan; replay returns the same operation. */
  enqueueOperation(
    ownerId: string,
    planId: string,
    digest: string,
    idempotencyKey: string,
    at: string,
  ): Promise<Operation>;
  getOperation(ownerId: string, operationId: string): Promise<Operation | undefined>;
  /** Terminal states are immutable; retrying the same terminal state is harmless. */
  updateOperation(ownerId: string, operationId: string, update: OperationUpdate): Promise<void>;
}
export type ErrorCode =
  'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'EXPIRED' | 'NOT_APPROVED';
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
