import type { EventEmitter } from 'node:events';
import type { Session } from '../sessions/index.js';

/**
 * Inline configuration for a library/instance run. Every field is optional;
 * provided values are merged over the built-in defaults. When supplied, no
 * config file is read or written - the agent is fully hermetic with respect to
 * configuration, which is what lets an embedded host point the engine at its own
 * endpoint without touching ~/.dev-md or the process environment.
 */
export interface InlineConfig {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  maxContextTokens?: number;
  commandTimeout?: number;
  maxRetries?: number;
  maxRetriesAutomated?: number;
  maxLoops?: number;
  sessionRetentionDays?: number;
  maxTokens?: number;
  commandGuardEnabled?: boolean;
  commandGuardLLM?: boolean;
  maxDelegateDepth?: number;
  subagentMaxLoops?: number;
  maxToolOutputTokens?: number;
  requestTimeout?: number;
  maxApiRetries?: number;
  apiRetryWindow?: number;
}

/**
 * Output sink. When a host supplies one, high-level status messages are routed
 * through it instead of straight to console.log. Kept deliberately tiny so it is
 * trivial to redirect into a UI panel, a log aggregator, or a no-op.
 */
export interface Sink {
  log?(message: string): void;
}

/** Description of a tool call as the agent is about to act on it. */
export interface ToolCallInfo {
  tool: string;
  input: string;
  turn: number;
}

/**
 * Outcome a host can return from {@link ToolCallHook}:
 *  - `veto: true`        -> skip execution (the result is reported back to the model)
 *  - `rewrite: string`   -> replace the raw tool input before execution
 * Both may be combined. Returning undefined/{} runs the tool unchanged.
 */
export interface ToolCallResult {
  veto?: boolean;
  rewrite?: string;
}

export type ToolCallHook = (info: ToolCallInfo) => ToolCallResult | void | Promise<ToolCallResult | void>;

/** Answers an ASK_USER question raised by the agent (Phase 3). */
export type Answerer = (question: string) => Promise<string>;

/** Persistable session container an embedded host can supply. */
export interface SessionStore {
  create(workingDirectory: string, originalPrompt: string): Session;
  load(id: string): Session | null;
  save(session: Session): void;
  listForDir(workingDirectory: string): Session[];
  lastForDir(workingDirectory: string): Session | null;
  cleanOld(): void;
}

/**
 * Typed event map the agent emits through its {@link Agent.events} emitter.
 * Event names are strings (for host flexibility) but the payload shapes are
 * fixed so hosts can switch on them.
 */
export interface AgentEventMap {
  start: { sessionId: string; cwd: string };
  model: { messagesLength: number };
  token: { token: string };
  usage: { promptTokens: number; completionTokens: number; total: number };
  parse: { thoughts: string; toolCount: number };
  tool: { tool: string; input: string; turn: number; result: string };
  delegate: { label: string; result: string };
  compress: { tokensBefore: number; tokensAfter: number };
  save: { sessionId: string };
  done: { summary: string; auditPassed: boolean };
  maxLoopsReached: { maxLoops: number };
  stop: { reason?: string };
  error: { error: Error };
}

export type RunResult =
  | { type: 'done'; summary: string; auditPassed: boolean }
  | { type: 'maxLoopsReached'; maxLoops: number }
  | { type: 'aborted' }
  | { type: 'idle' }
  | { type: 'error'; error: Error };

export interface AgentOptions {
  /** Inline config overrides merged over the built-in defaults. */
  config?: InlineConfig;
  /** Optional output sink; defaults to console.log. */
  sink?: Sink;
  /** Optional event emitter; one is created if omitted. */
  events?: EventEmitter;
  /** Invoked before every tool executes (veto/rewrite). */
  onToolCall?: ToolCallHook;
  /** Override the default subagent delegate used by DELEGATE. */
  onDelegate?: (label: string, task: string) => Promise<string>;
  /** Human-in-the-loop answerer for ASK_USER (Phase 3). */
  answer?: Answerer;
  /** Cancel a running run. */
  signal?: AbortSignal;
  /** Session store; defaults to the file-backed store. */
  store?: SessionStore;
  /** Working directory for the run (defaults to process.cwd()). */
  cwd?: string;
  /** Resume an existing session by id on the first run() instead of creating a
   *  new one. Useful when a host recreates an agent (e.g. to apply a new
   *  thinking setting) while keeping the current conversation. */
  resume?: string;
  /** Enable thinking/reflection mode. */
  thinking?: boolean;
  /** Verbose output (default: automated runs are verbose). */
  verbose?: boolean;
  /** Run without interactive ASK_USER. */
  automated?: boolean;
}

export interface RunInput {
  prompt?: string;
  sessionId?: string;
  automated?: boolean;
}

export interface Agent {
  readonly sessionId: string;
  readonly cwd: string;
  readonly events: EventEmitter;
  readonly sink: Sink;
  getConfig(): InlineConfig;
  run(input?: RunInput): Promise<RunResult>;
  resume(sessionId: string): Promise<RunResult>;
  inject(role: 'user' | 'system' | 'assistant', content: string): void;
  stop(): void;
  isStopped(): boolean;
}
