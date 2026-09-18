import {
  allow,
  deny,
  makeAuditRecord,
  makeUsageRecord,
  type AuditRecord,
  type ObservableMiddleware,
  type PolicyDecision,
  type PolicyMiddleware,
  type ToolInvocationContext,
  type ToolInvocationResult,
  type UsageRecord,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Authorization                                                        */
/* ------------------------------------------------------------------ */

export interface AuthorizationConfig {
  /** Scopes a tool may use. Empty => permissive (everything allowed). */
  allowedScopes?: string[];
  /** Actor ids or scopes that are always denied. */
  deniedScopes?: string[];
}

export class AuthorizationMiddleware implements PolicyMiddleware {
  readonly name = 'authorization';
  #allowed: Set<string>;
  #denied: Set<string>;
  constructor(config: AuthorizationConfig = {}) {
    this.#allowed = new Set(config.allowedScopes ?? []);
    this.#denied = new Set(config.deniedScopes ?? []);
  }
  decide(ctx: ToolInvocationContext): PolicyDecision {
    if (this.#denied.has(ctx.actor.id) || (ctx.actor.scopes ?? []).some((s) => this.#denied.has(s))) {
      return deny('actor is denied access');
    }
    if (this.#allowed.size === 0) return allow();
    const allowed = ctx.capabilities.some((c) => this.#allowed.has(c));
    return allowed
      ? allow()
      : deny(`actor lacks an allowed scope for tool ${ctx.toolName} (capabilities: ${ctx.capabilities.join(', ')})`);
  }
}

/* ------------------------------------------------------------------ */
/* Approval                                                             */
/* ------------------------------------------------------------------ */

export interface ApprovalConfig {
  /** Tool names that require explicit human approval before executing. */
  requireApprovalFor?: string[];
  /** Returns whether the human approved the pending invocation. */
  approver: (ctx: ToolInvocationContext) => Promise<boolean> | boolean;
}

export class ApprovalMiddleware implements PolicyMiddleware {
  readonly name = 'approval';
  #require: Set<string>;
  #approved: Set<string>;
  #approver: ApprovalConfig['approver'];
  #approverCalls = 0;
  constructor(config: ApprovalConfig) {
    this.#require = new Set(config.requireApprovalFor ?? []);
    this.#approver = config.approver;
    this.#approved = new Set();
  }
  /** Times the underlying approver was consulted (test hook). */
  get approverCalls(): number { return this.#approverCalls; }
  async decide(ctx: ToolInvocationContext): Promise<PolicyDecision> {
    if (!this.#require.has(ctx.toolName)) return allow();
    const key = `${ctx.runId}:${ctx.toolName}`;
    if (this.#approved.has(key)) return allow();
    this.#approverCalls++;
    const granted = await this.#approver(ctx);
    if (!granted) return deny(`approval required for ${ctx.toolName} and was not granted`);
    this.#approved.add(key);
    return allow();
  }
}

/* ------------------------------------------------------------------ */
/* Audit                                                                */
/* ------------------------------------------------------------------ */

export interface AuditConfig {
  onRecord: (record: AuditRecord) => void | Promise<void>;
}

export class AuditMiddleware implements ObservableMiddleware {
  readonly name = 'audit';
  #sink: AuditConfig['onRecord'];
  #lastCtx: ToolInvocationContext | null = null;
  constructor(config: AuditConfig) { this.#sink = config.onRecord; }
  decide(ctx: ToolInvocationContext): PolicyDecision { this.#lastCtx = ctx; return allow(); }
  async observe(result: ToolInvocationResult): Promise<void> {
    const ctx = this.#lastCtx;
    if (!ctx) return;
    await this.#sink(makeAuditRecord({
      runId: ctx.runId,
      actorId: ctx.actor.id,
      tenantId: ctx.actor.tenantId,
      toolName: result.toolName,
      decision: result.errored ? 'deny' : 'allow',
      errored: result.errored,
      durationMs: result.durationMs,
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Usage                                                                */
/* ------------------------------------------------------------------ */

export interface UsageConfig {
  onRecord: (record: UsageRecord) => void | Promise<void>;
}

export class UsageMiddleware implements ObservableMiddleware {
  readonly name = 'usage';
  #sink: UsageConfig['onRecord'];
  #lastCtx: ToolInvocationContext | null = null;
  constructor(config: UsageConfig) { this.#sink = config.onRecord; }
  decide(ctx: ToolInvocationContext): PolicyDecision { this.#lastCtx = ctx; return allow(); }
  observe(result: ToolInvocationResult): void {
    const ctx = this.#lastCtx;
    if (!ctx) return;
    this.#sink(makeUsageRecord({
      runId: ctx.runId,
      actorId: ctx.actor.id,
      tenantId: ctx.actor.tenantId,
      toolName: result.toolName,
      tokens: result.tokens,
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Cost                                                                 */
/* ------------------------------------------------------------------ */

export interface CostConfig {
  onRecord: (record: UsageRecord) => void | Promise<void>;
  /** Price charged per input+output token (dollars). */
  pricePerToken?: number;
}

export class CostMiddleware implements ObservableMiddleware {
  readonly name = 'cost';
  #sink: CostConfig['onRecord'];
  #price: number;
  #lastCtx: ToolInvocationContext | null = null;
  constructor(config: CostConfig) {
    this.#sink = config.onRecord;
    this.#price = config.pricePerToken ?? 0;
  }
  decide(ctx: ToolInvocationContext): PolicyDecision { this.#lastCtx = ctx; return allow(); }
  observe(result: ToolInvocationResult): void {
    const ctx = this.#lastCtx;
    if (!ctx) return;
    const total = result.tokens?.total ?? 0;
    this.#sink(makeUsageRecord({
      runId: ctx.runId,
      actorId: ctx.actor.id,
      tenantId: ctx.actor.tenantId,
      toolName: result.toolName,
      tokens: result.tokens,
      cost: total * this.#price,
    }));
  }
}
