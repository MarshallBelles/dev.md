/**
 * Capability tags describing what a tool can do. Governance (Authorization /
 * Approval middleware) and surfaces filter tools by these tags, so a single
 * source of truth here drives every downstream decision.
 */
export type ToolCapability =
  | 'read'       // inspect files/directories
  | 'write'      // create/modify/delete files and dirs
  | 'execute'    // run shell commands
  | 'search'     // search the filesystem
  | 'delegate'   // spawn a bounded subagent
  | 'interactive' // ask the human for input
  | 'process'    // manage background processes
  | 'control';    // drive the loop (task list, done)

export interface ToolMetadata {
  /** Stable machine name, e.g. 'WRITE_FILE'. Matches ToolName. */
  name: string;
  /** Human label, e.g. 'Write File'. */
  label: string;
  /** One-line description shown by surfaces / help. */
  description: string;
  /** Capability tags; empty means "unknown" and must be explicit-allow gated. */
  capabilities: ToolCapability[];
  /** True if this tool mutates the filesystem or process state. */
  mutates: boolean;
  /** Optional short hint about the expected raw input. */
  inputHint?: string;
}

/** Per-run context a tool adapter needs. Kept structural so the library's
 * ToolContext (index.ts) and ToolInvocation share the same shape. */
export interface ToolInvocationContext {
  cwd: string;
  automated: boolean;
  /** Resolved command-guard/classifier config for this run, when the engine
   * supplies one. Tools route command execution through the classifier via this. */
  guard?: import('./guard.js').GuardConfig;
}

/** A request to run an adapter. Kept small and transport-friendly. */
export interface ToolInvocation {
  /** Raw tool input exactly as the model emitted it. */
  input: string;
  /** Per-run context the adapter needs. */
  ctx: ToolInvocationContext;
}

/**
 * A tool adapter is the unit every surface and governance layer talks to. The
 * engine resolves a tool by name from a registry and calls execute(); governance
 * wraps the call, and remote surfaces call the same interface over the wire.
 */
export interface ToolAdapter {
  readonly metadata: ToolMetadata;
  /**
   * Opt this tool into the command classifier. When true, the tool is subject
   * to command classification: its command executions should be run through
   * runGuardedCommand (the resolved classifier config is provided on the
   * invocation context as `guard`). It is a declarative flag that both marks
   * the tool as guarded for surfaces/governance and signals the author to route
   * command execution through the guard. The built-in COMMAND tool always runs
   * through the guard; custom tools set this to participate too.
   */
  classify?: boolean;
  execute(invocation: ToolInvocation): Promise<string>;
}

/** Whether an adapter declares a given capability. */
export const hasCapability = (
  adapter: Pick<ToolAdapter, 'metadata'>,
  capability: ToolCapability,
): boolean => adapter.metadata.capabilities.includes(capability);

/** Names of adapters that expose a capability (empty-result safe). */
export const toolsWithCapability = (
  adapters: Iterable<Pick<ToolAdapter, 'metadata'>>,
  capability: ToolCapability,
): string[] => [...adapters].filter(a => hasCapability(a, capability)).map(a => a.metadata.name);
