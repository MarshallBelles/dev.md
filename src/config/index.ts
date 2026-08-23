import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import * as readline from 'readline';

export interface Config {
  apiUrl: string;
  apiKey: string;
  model: string;
  // Optional on purpose: when absent, the context length is detected from the
  // server instead. See resolveMaxContextTokens for the resolution order.
  maxContextTokens?: number;
  commandTimeout: number;
  maxRetries: number;
  maxRetriesAutomated: number;
  maxLoops: number;
  sessionRetentionDays: number;
  maxTokens: number;
  commandGuardEnabled: boolean;
  commandGuardLLM: boolean;
  maxDelegateDepth: number;
  subagentMaxLoops: number;
  // Cap on a single tool result before it is chunked into the output store.
  // Prevents one large READ_FILE/COMMAND from consuming the compaction reserve.
  maxToolOutputTokens?: number;
  // Per-attempt API request timeout, in seconds. Without one, an endpoint that
  // accepts the connection but never responds hangs the agent forever.
  requestTimeout?: number;
  // How many times to retry a failed/timed-out API request, and the total wall
  // clock budget for those retries in seconds.
  maxApiRetries?: number;
  apiRetryWindow?: number;
}

// Used only when the config pins no value AND the server publishes no context
// length. The OpenAI spec does not require a model to advertise its context
// window - the Model object is only required to carry id/object/created/owned_by -
// so this fallback is load-bearing for any server that doesn't extend the schema.
export const FALLBACK_MAX_CONTEXT_TOKENS = 131072;

// How long to wait on the /models probe before giving up and using the fallback.
// Detection is a nicety; it must never stall the agent loop.
const MODEL_PROBE_TIMEOUT_MS = 5000;

// maxContextTokens is deliberately omitted - a fresh config is written without it
// so the context length is detected from the server rather than pinned at a guess.
const DEFAULTS: Config = {
  apiUrl: 'http://localhost:8005/v1',
  apiKey: '',
  model: 'devstral-small-2507',
  commandTimeout: 30,
  maxRetries: 3,
  maxRetriesAutomated: 10,
  maxLoops: 1000,
  sessionRetentionDays: 30,
  maxTokens: 4096,
  // Deterministic denylist for the COMMAND tool - cheap, always on by default.
  commandGuardEnabled: true,
  // Optional LLM second-opinion classifier for commands the denylist doesn't already
  // block - off by default since it adds a real API call per COMMAND invocation.
  commandGuardLLM: false,
  // Caps nested DELEGATE recursion (a subagent delegating to its own subagent,
  // and so on) - a couple of levels is fine, unbounded nesting is not.
  maxDelegateDepth: 4,
  // Loop budget granted to a subagent - smaller than the top-level default so
  // one bad delegation can't consume the whole run.
  subagentMaxLoops: 15,
  // Roughly a quarter of a 131K window - big enough that ordinary file reads and
  // command output are never chunked, small enough that one result cannot eat
  // the headroom compaction relies on.
  maxToolOutputTokens: 25000,
  requestTimeout: 120,
  maxApiRetries: 10,
  apiRetryWindow: 300,
};

export const getConfigDir = (): string => {
  const p = platform();
  if (p === 'win32') return join(process.env.APPDATA || homedir(), 'dev-agent');
  if (p === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dev-agent');
  return join(homedir(), '.dev-agent');
};

export const getConfigPath = (): string => join(getConfigDir(), 'config.json');
export const getSessionsDir = (): string => join(getConfigDir(), 'sessions');
export const configExists = (): boolean => existsSync(getConfigPath());

export const ensureDirs = (): void => {
  const configDir = getConfigDir();
  const sessionsDir = getSessionsDir();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
};

export const loadConfig = (): Config => {
  ensureDirs();
  const path = getConfigPath();
  if (!existsSync(path)) {
    // Deliberately does NOT write the file. Creating it here would make
    // configExists() true on the first incidental read, so first-time setup
    // would never run again and the user would be silently left pointing at the
    // default localhost endpoint - which then fails as an opaque API error.
    return { ...DEFAULTS };
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf-8')) };
  } catch {
    return { ...DEFAULTS };
  }
};

// Asks the endpoint what context length it serves. `max_model_len` is a vLLM
// extension to the OpenAI Model object, not part of the spec, so a null return
// here is an ordinary outcome rather than an error - callers fall back.
export const probeMaxModelLen = async (config: Config): Promise<number | null> => {
  try {
    const headers: Record<string, string> = {};
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const res = await fetch(`${config.apiUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const json = await res.json() as { data?: unknown };
    const models = Array.isArray(json?.data) ? json.data as Record<string, unknown>[] : [];
    // vLLM reports the served alias as `id` and the underlying checkpoint as
    // `root`; either may be what the user put in `model`.
    const match = models.find(m => m?.id === config.model || m?.root === config.model);

    const len = match?.max_model_len;
    return typeof len === 'number' && Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    // Unreachable host, non-JSON body, missing /models route, timeout - all
    // non-fatal. Detection is best-effort by design.
    return null;
  }
};

// Cached per endpoint+model so the probe costs one request per process. The promise
// is cached rather than the value so concurrent callers - the agent loop and any
// subagents share this module - join one in-flight probe instead of racing to
// issue their own. A failed probe caches its fallback too, so a server without
// /models isn't re-polled on every loop iteration.
const maxContextCache = new Map<string, Promise<number>>();

// Exposed for tests, which need each case to start from a cold cache.
export const resetMaxContextCache = (): void => { maxContextCache.clear(); };

// Resolution order: explicit config value, then server-published max_model_len,
// then FALLBACK_MAX_CONTEXT_TOKENS.
export const resolveMaxContextTokens = (config: Config = loadConfig()): Promise<number> => {
  const pinned = config.maxContextTokens;
  if (typeof pinned === 'number' && Number.isFinite(pinned) && pinned > 0) {
    return Promise.resolve(pinned);
  }

  const key = `${config.apiUrl}|${config.model}`;
  const cached = maxContextCache.get(key);
  if (cached) return cached;

  const pending = probeMaxModelLen(config)
    .then(probed => probed ?? FALLBACK_MAX_CONTEXT_TOKENS);
  maxContextCache.set(key, pending);
  return pending;
};

export const saveConfig = (config: Config): void => {
  ensureDirs();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
};

export const openConfigInEditor = (): void => {
  ensureDirs();
  const path = getConfigPath();
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(DEFAULTS, null, 2));
  const p = platform();
  const cmd = p === 'win32' ? 'notepad' : p === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [path], { detached: true, stdio: 'ignore' }).unref();
};

const ask = (rl: readline.Interface, question: string, defaultVal?: string): Promise<string> => {
  const prompt = defaultVal ? `${question} (${defaultVal}): ` : `${question}: `;
  return new Promise(resolve => {
    rl.question(prompt, answer => resolve(answer.trim() || defaultVal || ''));
  });
};

export const runFirstTimeSetup = async (): Promise<Config> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  Welcome to dev.md!\n');
  console.log('  First-time setup - configure your AI endpoint.\n');

  const apiUrl = await ask(rl, '  API URL', DEFAULTS.apiUrl);
  const apiKey = await ask(rl, '  API Key (leave blank if none)');
  const model = await ask(rl, '  Model name', DEFAULTS.model);

  // Ask the server before asking the user - most OpenAI-compatible runtimes that
  // publish max_model_len make this question unnecessary.
  const probed = await probeMaxModelLen({ ...DEFAULTS, apiUrl, apiKey, model });
  if (probed) console.log(`\n  Detected context length from server: ${probed} tokens`);

  const autoValue = probed ?? FALLBACK_MAX_CONTEXT_TOKENS;
  const maxContextStr = await ask(rl, `  Max context tokens (blank to auto-detect, currently ${autoValue})`);
  const maxContextTokens = parseInt(maxContextStr, 10);

  rl.close();

  const config: Config = {
    ...DEFAULTS,
    apiUrl,
    apiKey,
    model,
    // Only pin a value the user actually typed. Leaving the key out keeps
    // detection live, so swapping the model behind this endpoint just works.
    ...(Number.isFinite(maxContextTokens) && maxContextTokens > 0 ? { maxContextTokens } : {}),
  };
  ensureDirs();
  saveConfig(config);

  console.log(`\n  Config saved to: ${getConfigPath()}`);
  console.log('  Run `dev config` anytime to edit.\n');

  return config;
};
