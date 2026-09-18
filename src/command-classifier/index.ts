import { scoreCommand } from './trigger.js';
import { type ClassifyFn, buildStreamClassifyFn, type ClassifyOutcome } from './verdict.js';
import { createTtlCache, type ClassifierCache } from './cache.js';

export { scoreCommand } from './trigger.js';
export { parseClassifierVerdict, buildStreamClassifyFn } from './verdict.js';
export { createTtlCache } from './cache.js';
export type { ClassifyFn, ClassifyOutcome, Verdict } from './verdict.js';
export type { ClassifierCache, CacheVerdict, CacheEntry } from './cache.js';

export interface ClassifierConfig {
  // Master switch. When false the classifier never runs (but the denylist and
  // risk scoring still apply where wired in).
  enabled: boolean;
  // Risk score at/above which the LLM classifier is invoked at all. Benign
  // commands (risk 0) skip the classifier entirely.
  triggerThreshold: number;
  // Risk score at/above which the command is deterministically blocked
  // (the risk backstop) before the classifier is even consulted.
  riskThreshold: number;
  // How long a classification verdict stays cached, in milliseconds.
  cacheTtlMs: number;
}

export interface ClassifierDecision {
  blocked: boolean;
  risk: number;
  // 'risk-backstop'  -> blocked by the deterministic risk threshold
  // 'classifier'     -> blocked/judged by the LLM classifier (or failed closed)
  source: 'risk-backstop' | 'classifier';
  reason?: string;
}

export interface ClassifierDeps {
  classify: ClassifyFn;
  cache?: ClassifierCache;
}

/** The core orchestrator. Pipeline:
 *   1. score the command (heuristic risk)
 *   2. risk backstop: >= riskThreshold blocks deterministically
 *   3. below trigger: benign enough to auto-approve without an LLM call
 *   4. otherwise: consult the (cached) classifier; fail closed on error */
export const classifyToolCall = async (
  command: string,
  cwd: string,
  config: ClassifierConfig,
  deps: ClassifierDeps
): Promise<ClassifierDecision> => {
  const { risk } = scoreCommand(command);

  // Deterministic backstop: high-confidence catastrophic commands are blocked
  // before the classifier is even consulted (this also catches obfuscated
  // variants the denylist regexes miss).
  if (risk >= config.riskThreshold) {
    return {
      blocked: true,
      risk,
      source: 'risk-backstop',
      reason: `Deterministic risk score of ${risk} meets or exceeds the safety threshold of ${config.riskThreshold}.`,
    };
  }

  // Benign (below trigger): auto-approve WITHOUT consulting the classifier -
  // this is a cost optimization, and it means a benign command is never
  // blocked just because a classifier happened to say no.
  if (risk < config.triggerThreshold) {
    return { blocked: false, risk, source: 'classifier', reason: `Low risk score of ${risk}; safe to run.` };
  }

  // Otherwise consult the (cached) classifier and honour its verdict.
  let outcome: ClassifyOutcome;
  const cache = deps.cache;
  if (cache) {
    const key = `${cwd}\u0000${command}`;
    const hit = cache.get(key);
    if (hit) {
      outcome = { verdict: hit.verdict, reason: hit.reason };
    } else {
      outcome = await deps.classify(command, cwd);
      // Never cache a null verdict: doing so would fail the next identical
      // command open. Only cache usable ACCEPT/BLOCK verdicts.
      if (outcome.verdict !== null) cache.set(key, outcome.verdict, outcome.reason ?? '', config.cacheTtlMs);
    }
  } else {
    outcome = await deps.classify(command, cwd);
  }

  // Fail closed: the classifier was expected to run but produced no verdict.
  if (outcome.verdict === null) {
    return {
      blocked: true,
      risk,
      source: 'classifier',
      reason: outcome.reason ?? 'Safety classifier unavailable; blocking as a precaution.',
    };
  }
  if (outcome.verdict === 'BLOCK') {
    return {
      blocked: true,
      risk,
      source: 'classifier',
      reason: outcome.reason ?? 'Safety classifier judged this command unsafe.',
    };
  }
  return {
    blocked: false,
    risk,
    source: 'classifier',
    reason: 'Safety classifier accepted this command.',
  };
};

/** Message for a classifier / risk-backstop decline. Judgment-based: the agent
 * is expected to keep working and try a different tool or safer approach. Does
 * NOT start with ERROR so the loop keeps rolling instead of treating it as a
 * hard failure. */
export const declineMessage = (reason: string | undefined): string =>
  `[safety classifier declined] This command was declined: ${
    reason || 'the safety classifier judged it unsafe.'
  }. This is a judgment-based decline rather than a permanent block. ` +
  'The agent should keep working: try a different tool or a safer approach ' +
  '(avoid the risky operation, restrict it to within the working directory, or rework the command to reach the goal without the unsafe part). ' +
  'You may retry with a different command.';

/** Message for a deterministic denylist block. Permanent: explicitly tells the
 * agent not to retry and to stop and report the limitation. */
export const permanentBlockMessage = (reason: string | undefined): string =>
  `ERROR: Command permanently blocked by safety guard: ${reason || 'unsafe command'}. ` +
  `Do NOT retry this command or attempt an alternate path to the same file/action (e.g. a different absolute path, sudo, or searching the filesystem for it) - it will be blocked again every time. ` +
  `This is not a transient error. Stop pursuing this action and use DONE to report the limitation to the user.`;

/** Convenience factory for a classifier wired to the real streaming LLM call
 * with an in-memory TTL cache. */
export const createCommandClassifier = (
  config: ClassifierConfig,
  classify: ClassifyFn = buildStreamClassifyFn(),
  cache: ClassifierCache = createTtlCache()
): { classify: ClassifyFn; cache: ClassifierCache } => ({
  classify,
  cache,
});
