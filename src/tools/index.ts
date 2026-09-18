import { createRegistry, type ToolRegistry } from './registry.js';
import { buildDefaultRegistry } from './adapters.js';
import { runGuardedCommand } from './guard-tool.js';
import type { ToolInvocationContext } from './adapter.js';
import type { ToolName } from '../parser/markdown.js';

export { runGuardedCommand } from './guard-tool.js';
export type { GuardConfig } from './guard.js';
// Single source of truth for the per-run tool context (cwd + automated + guard
// config) lives in adapter.js; ToolContext is the engine-facing alias.
export type ToolContext = ToolInvocationContext;
export type { ToolInvocationContext } from './adapter.js';

// The default, file-backed registry. Governance (Phase 2) swaps this for a
// wrapped registry that authorizes/approves/audits before each execute().
let registry: ToolRegistry = buildDefaultRegistry();

/** The currently active tool registry. */
export const getRegistry = (): ToolRegistry => registry;

/** Replace the active registry (used to inject governance wrappers). */
export const setRegistry = (next: ToolRegistry): void => { registry = next; };

export type { ToolAdapter } from './adapter.js';

/**
 * Resolve a tool by name from the active registry and execute it. This is the
 * single choke-point the engine calls; governance wraps the registry so every
 * surface (CLI, remote, embedded) enforces the same policy.
 */
export const executeTool = async (tool: ToolName, input: string, ctx: ToolContext): Promise<string> => {
  const adapter = registry.get(tool);
  if (!adapter) return `Unknown tool: ${tool}`;
  return adapter.execute({ input, ctx });
};
