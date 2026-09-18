import { loadConfig } from '../config/index.js';
import { type Session, saveSession } from '../sessions/index.js';
import { type ToolContext } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { runLoopTurn, type LoopTurnOptions, type LoopTurnResult } from './loop-core.js';
import { runSubagent } from '../subagent/index.js';
import { isVerbose } from '../ui/display.js';
import { resolveConfig } from '../config/index.js';
import type { EventEmitter } from 'node:events';
import type { InlineConfig, ToolCallHook } from '../lib/types.js';

export interface LibraryHooks {
  // Inline config override merged over defaults (no config file read).
  config?: InlineConfig;
  events?: EventEmitter;
  sink?: (message: string) => void;
  onToolCall?: ToolCallHook;
  onDelegate?: (label: string, task: string) => Promise<string>;
  signal?: AbortSignal;
  thinking?: boolean;
  verbose?: boolean;
}

export interface LoopOptions {
  automated: boolean;
}

export const runAgentLoop = async (
  session: Session,
  options: LoopOptions,
  hooks: LibraryHooks = {}
): Promise<LoopTurnResult> => {
  // Library runs use the supplied inline config; the CLI keeps using the
  // file-backed config so existing behaviour is unchanged.
  const config = hooks.config ? resolveConfig(hooks.config) : loadConfig();
  const maxRetries = options.automated ? config.maxRetriesAutomated : config.maxRetries;
  const systemPrompt = buildSystemPrompt(options.automated, session.workingDirectory);
  // Resolve the command-guard/classifier config once per run and put it on the
  // tool context so every tool (including enterprise custom tools) routes
  // command execution through the same classifier without re-reading config.
  const guard = {
    commandGuardEnabled: config.commandGuardEnabled,
    commandClassifierEnabled: config.commandClassifierEnabled,
    commandGuardLLM: config.commandGuardLLM,
    commandClassifierTriggerScore: config.commandClassifierTriggerScore,
    riskThreshold: config.riskThreshold,
    commandClassifierCacheTtlMs: config.commandClassifierCacheTtlMs,
    commandClassifierTools: config.commandClassifierTools,
  };
  const ctx: ToolContext = { cwd: session.workingDirectory, automated: options.automated, guard };
  const verbose = hooks.verbose ?? options.automated;

  return runLoopTurn({
    session,
    systemPrompt,
    ctx,
    maxLoops: config.maxLoops,
    maxRetries,
    auditVerbose: verbose,
    onDelegate: hooks.onDelegate ?? ((label, task) => runSubagent(label, task, ctx, 0)),
    config: hooks.config,
    events: hooks.events,
    sink: hooks.sink,
    onToolCall: hooks.onToolCall,
    signal: hooks.signal,
    thinking: hooks.thinking,
  });
};

export const runSinglePrompt = async (session: Session, prompt: string): Promise<void> => {
  session.originalPrompt = prompt;
  session.history.push({ role: 'user', content: prompt });
  saveSession(session);
};
