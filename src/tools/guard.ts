import { resolve, sep } from 'path';
import { homedir } from 'os';

// Re-exported for backward compatibility: the unit tests import
// parseClassifierVerdict from dist/tools/guard.js, and the classifier now lives
// in the separate command-classifier module.
export { parseClassifierVerdict } from '../command-classifier/verdict.js';

import { classifyToolCall, buildStreamClassifyFn, createTtlCache, scoreCommand } from '../command-classifier/index.js';

export interface GuardResult {
  blocked: boolean;
  reason?: string;
  // What produced the block, so the caller can decide whether it is a permanent
  // stop (denylist) or a judgment-based decline the agent can work around
  // (classifier / risk-backstop).
  source?: 'denylist' | 'classifier' | 'risk-backstop';
  // The heuristic risk score (0-100) behind the block, when available.
  risk?: number;
}

// The denylist is deliberately NARROW: only commands that would obviously and
// irreversibly tank a system, with no legitimate use and no safe alternative
// (fork bomb, filesystem formatting, raw block-device writes, piping a remote
// download straight into a shell). It is explicitly NOT a safety net - anything
// subtler or ambiguous (sudo, chmod, git push --force, scoped rm, obfuscated
// variants) is left to the LLM classifier, which reads the command and judges
// its actual effect. Keeping the denylist small avoids a false sense of
// coverage while every gray-area command still gets judged.

// Commands whose arguments are worth resolving to check they stay within cwd.
const DESTRUCTIVE_COMMANDS = new Set(['rm', 'rmdir', 'truncate']);

// Crude but effective tokenizer: splits on whitespace while keeping simple
// single/double-quoted spans intact. Not a full shell parser.
const tokenize = (command: string): string[] => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];

const findAbsolutePathOutsideCwd = (command: string, cwd: string): string | null => {
  const cwdResolved = resolve(cwd);
  for (const raw of tokenize(command)) {
    const tok = raw.replace(/^["']|["']$/g, '');
    if (!tok.startsWith('/') && !tok.startsWith('~')) continue;
    const expanded = tok.startsWith('~') ? resolve(homedir(), tok.slice(1).replace(/^\//, '')) : tok;
    const resolved = resolve(expanded);
    if (resolved !== cwdResolved && !resolved.startsWith(cwdResolved + sep)) {
      return resolved;
    }
  }
  return null;
};

// Only genuinely catastrophic, no-regret commands are hard-blocked here.
const DENYLIST_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork bomb pattern.' },
  { pattern: /(\b|\s)(mkfs|wipefs|mkswap)\b/i, reason: 'Filesystem formatting commands are not allowed.' },
  { pattern: /\bdd\s[^\n]*\bof=\/dev\//i, reason: 'Raw writes to a block device are not allowed.' },
  { pattern: />\s*\/dev\/(disk|sd|nvme|hd|rdisk)/i, reason: 'Direct writes to a disk device are not allowed.' },
  { pattern: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b[i]?/i, reason: 'Piping a remote download directly into a shell is not allowed.' },
];

export const checkCommandDenylist = (command: string, cwd: string): GuardResult => {
  for (const { pattern, reason } of DENYLIST_PATTERNS) {
    if (pattern.test(command)) return { blocked: true, reason };
  }
  return { blocked: false };
};

export interface GuardConfig {
  commandGuardEnabled: boolean;
  // Backward-compatible alias for commandClassifierEnabled.
  commandGuardLLM?: boolean;
  commandClassifierEnabled?: boolean;
  commandClassifierTriggerScore?: number;
  riskThreshold?: number;
  commandClassifierCacheTtlMs?: number;
  commandClassifierTools?: string[];
}

export const classifierEnabled = (config: GuardConfig): boolean =>
  Boolean(config.commandClassifierEnabled || config.commandGuardLLM);

export const guardCommand = async (command: string, cwd: string, config: GuardConfig): Promise<GuardResult> => {
  if (!config.commandGuardEnabled) return { blocked: false };

  // The denylist is the hard block for obviously catastrophic commands;
  // everything gray-area is left for the classifier to judge.
  const denylistResult = checkCommandDenylist(command, cwd);
  if (denylistResult.blocked) return { ...denylistResult, source: 'denylist' };

  const riskThreshold = config.riskThreshold ?? 75;
  const { risk } = scoreCommand(command);

  // Deterministic risk backstop: a cheap heuristic floor that applies whether
  // or not the LLM classifier is enabled. It catches high-confidence
  // catastrophic commands (including obfuscated variants the denylist missed)
  // when there is no classifier to judge them, so removing the old denylist
  // entries for gray-area commands does not open a safety hole.
  if (risk >= riskThreshold) {
    return {
      blocked: true,
      risk,
      source: 'risk-backstop',
      reason: `Deterministic risk score of ${risk} meets or exceeds the safety threshold of ${riskThreshold}.`,
    };
  }

  // Classifier off: no LLM judge, so moderate/gray-area commands are allowed.
  const tools = config.commandClassifierTools ?? ['COMMAND'];
  if (!classifierEnabled(config) || !tools.includes('COMMAND')) return { blocked: false };

  // Classifier on: judge the moderate-risk commands the backstop didn't catch.
  const decision = await classifyToolCall(
    command,
    cwd,
    {
      enabled: true,
      triggerThreshold: config.commandClassifierTriggerScore ?? 25,
      riskThreshold,
      cacheTtlMs: config.commandClassifierCacheTtlMs ?? 30000,
    },
    { classify: buildStreamClassifyFn(), cache: createTtlCache() }
  );

  return {
    blocked: decision.blocked,
    reason: decision.reason,
    source: decision.source,
  };
};
