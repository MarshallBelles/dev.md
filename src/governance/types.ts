/** The actor on behalf of whom a tool runs (a user, tenant, or service account). */
export interface Actor {
  id: string;
  /** Free-form scopes used by authorization, e.g. ['read','write','execute']. */
  scopes?: string[];
  /** Optional tenant for multi-tenant deployments. */
  tenantId?: string;
}

/** What a middleware sees about a pending tool execution. */
export interface ToolInvocationContext {
  toolName: string;
  label: string;
  capabilities: string[];
  mutates: boolean;
  rawInput: string;
  cwd: string;
  automated: boolean;
  actor: Actor;
  /** Correlation id threaded through the whole run. */
  runId: string;
}

/** A middleware's decision for a pending invocation.
 *  - allow : proceed
 *  - deny  : refuse, with a reason (fail closed on policy miss)
 *  - approve: allow pending a human approval workflow
 *  - error : internal failure - callers treat as blocked (fail closed) */
export type PolicyDecision =
  | { status: 'allow' }
  | { status: 'deny'; reason: string }
  | { status: 'approve'; reason?: string }
  | { status: 'error'; reason: string };

/** A middleware that decides whether a pending execution may proceed. Kept pure:
 *  no side effects in decide() so it can be reasoned about and unit tested. */
export interface PolicyMiddleware {
  /** Stable name, surfaced in audit logs and debugging. */
  readonly name: string;
  decide(ctx: ToolInvocationContext): Promise<PolicyDecision> | PolicyDecision;
}

/** A middleware that additionally observes completed executions (audit/usage/cost). */
export interface ObservableMiddleware extends PolicyMiddleware {
  observe?(result: ToolInvocationResult): void | Promise<void>;
}

/** The outcome a middleware sees after a tool has executed. */
export interface ToolInvocationResult {
  toolName: string;
  outcome: string;
  errored: boolean;
  durationMs: number;
  tokens?: { promptTokens: number; completionTokens: number; total: number };
  cost?: number;
}

/** A recorded audit entry (consumed by the audit log / SIEM export). */
export interface AuditRecord {
  runId: string;
  actorId: string;
  tenantId?: string;
  toolName: string;
  decision: 'allow' | 'deny' | 'approve';
  reason?: string;
  timestamp: string;
  durationMs: number;
  errored: boolean;
}

/** A single usage/cost sample (cost governance + metrics). */
export interface UsageRecord {
  runId: string;
  actorId: string;
  tenantId?: string;
  toolName: string;
  tokens?: { promptTokens: number; completionTokens: number; total: number };
  cost?: number;
  timestamp: string;
}

// ----- decision factories + guards (pure, unit-testable) -----

export const allow = (): PolicyDecision => ({ status: 'allow' });
export const deny = (reason: string): PolicyDecision => ({ status: 'deny', reason });
export const approve = (reason?: string): PolicyDecision => (reason ? { status: 'approve', reason } : { status: 'approve' });
export const failError = (reason: string): PolicyDecision => ({ status: 'error', reason });

export const isDenial = (d: PolicyDecision): boolean => d.status === 'deny';
export const isBlocked = (d: PolicyDecision): boolean => d.status === 'deny' || d.status === 'error';
export const needsApproval = (d: PolicyDecision): boolean => d.status === 'approve';

export const makeAuditRecord = (p: Partial<AuditRecord> & Pick<AuditRecord, 'runId' | 'actorId' | 'toolName'>): AuditRecord => ({
  runId: p.runId,
  actorId: p.actorId,
  tenantId: p.tenantId,
  toolName: p.toolName,
  decision: p.decision ?? 'allow',
  reason: p.reason,
  timestamp: p.timestamp ?? new Date().toISOString(),
  durationMs: p.durationMs ?? 0,
  errored: p.errored ?? false,
});

export const makeUsageRecord = (p: Partial<UsageRecord> & Pick<UsageRecord, 'runId' | 'actorId' | 'toolName'>): UsageRecord => ({
  runId: p.runId,
  actorId: p.actorId,
  tenantId: p.tenantId,
  toolName: p.toolName,
  tokens: p.tokens,
  cost: p.cost,
  timestamp: p.timestamp ?? new Date().toISOString(),
});
