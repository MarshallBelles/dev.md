// Shared harness for e2e tests that drive the REAL governed microservice over
// HTTP (or in-process) against the REAL local LLM endpoint.
//
// NOTE on routing: the agent's network call (streamCompletion) resolves its
// endpoint via loadConfig() (the on-disk config under HOME), NOT via the inline
// config passed to the engine. So to point real runs at the configured endpoint
// we redirect HOME/APPDATA/XDG_CONFIG_HOME to a throwaway config dir whose
// config.json apiUrl is E2E_LLM_ENDPOINT. This mirrors the existing
// createInProcessTestContext convention used by the other real-LLM e2e tests.
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createGovernedServer } from '../../dist/rpc/server.js';
import { GovernanceEngine, type ServerOptions } from '../../dist/rpc/engine.js';
import { GovernanceClient } from '../../dist/rpc/client.js';
import { type RpcEvent, type RpcResult } from '../../dist/rpc/protocol.js';

// Real LLM endpoint reachable at carrier.local:8007 (override with E2E_API_URL).
export const E2E_LLM_ENDPOINT: string = process.env.E2E_API_URL || 'http://carrier.local:8007/v1';
// Model served by that endpoint (override with E2E_MODEL).
export const E2E_MODEL: string = process.env.E2E_MODEL || 'mars';

// Hermetic inline config so server-driven runs talk to the real LLM without any
// config file being required by the agent loop's control surface. The actual
// network endpoint is wired via the HOME redirection installed by
// startGovernedServer/startGovernedEngine (whose config.json apiUrl = E2E_LLM_ENDPOINT).
export const realLlmConfig = (): Record<string, unknown> => ({
  apiUrl: E2E_LLM_ENDPOINT,
  model: E2E_MODEL,
  apiKey: '',
  maxTokens: 4096,
  maxContextTokens: 131072,
  // Test baseline mirrors the pre-classifier default (OFF). The Command Guard
  // suite re-enables the classifier to exercise the LLM-judgement path.
  commandClassifierEnabled: false,
});

// Fresh temp working directory (mkdir -p), returned for callers to pass as run cwd.
export const makeTempCwd = (): string => {
  const cwd = `/tmp/dev-md-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(cwd, { recursive: true });
  return cwd;
};

// Isolated config dir + HOME redirection so loadConfig() (used by the agent's
// real network calls) reads our endpoint instead of the machine's on-disk config.
class ConfigScope {
  #baseDir: string;
  #prev: Record<string, string | undefined>;

  constructor(apiUrl: string, model: string) {
    this.#baseDir = join(tmpdir(), `dev-md-e2e-cfg-${randomUUID()}`);
    const cfgDir = join(this.#baseDir, 'Library', 'Application Support', 'dev-agent');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({ apiUrl, model, apiKey: '', maxTokens: 4096, maxContextTokens: 131072, commandClassifierEnabled: false })
    );
    this.#prev = {
      HOME: process.env.HOME,
      APPDATA: process.env.APPDATA,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.HOME = this.#baseDir;
    process.env.APPDATA = this.#baseDir;
    process.env.XDG_CONFIG_HOME = this.#baseDir;
  }

  restore(): void {
    for (const key of ['HOME', 'APPDATA', 'XDG_CONFIG_HOME'] as const) {
      if (this.#prev[key] === undefined) delete process.env[key];
      else process.env[key] = this.#prev[key];
    }
    rmSync(this.#baseDir, { recursive: true, force: true });
  }
}

// Start a REAL governed HTTP server on an ephemeral port, redirecting HOME so
// real-LLM runs route to E2E_LLM_ENDPOINT. Each run() uses realLlmConfig()
// unless the caller passes config in the run params.
export const startGovernedServer = async (
  options?: ServerOptions
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const scope = new ConfigScope(E2E_LLM_ENDPOINT, E2E_MODEL);
  const server: HttpServer = createGovernedServer(options);
  const { port } = await new Promise<AddressInfo>((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr);
      } else {
        reject(new Error('no port assigned to governed server'));
      }
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((res) => {
        scope.restore();
        server.close(() => res());
      }),
  };
};

// Start an IN-PROCESS GovernanceEngine (no HTTP) using the default tool registry,
// with HOME redirected so real-LLM runs route to E2E_LLM_ENDPOINT.
export const startGovernedEngine = async (
  options?: ServerOptions
): Promise<{ engine: GovernanceEngine; close: () => void }> => {
  const scope = new ConfigScope(E2E_LLM_ENDPOINT, E2E_MODEL);
  const engine = new GovernanceEngine(options);
  return {
    engine,
    close: () => {
      scope.restore();
    },
  };
};

// Run a prompt through a GovernanceClient; streams events and resolves to the
// final result object. Passes realLlmConfig() as the run config unless the
// caller supplies their own.
export const clientRun = async (
  client: GovernanceClient,
  prompt: string,
  cwd: string,
  actor?: { id: string; scopes?: string[]; tenantId?: string },
  config?: Record<string, unknown>
): Promise<{ events: RpcEvent[]; result: any }> => {
  const events: RpcEvent[] = [];
  const onEvent = (e: RpcEvent) => {
    events.push(e);
  };
  const final = await client.run(
    {
      prompt,
      cwd,
      actor: actor ?? { id: 'e2e' },
      config: config ?? realLlmConfig(),
    },
    onEvent
  );
  return { events, result: (final as RpcResult).result as any };
};

// One governed tool call through a GovernanceClient; resolves to the raw result
// object (the governed tool actually executed over the wire).
export const clientTool = async (
  client: GovernanceClient,
  toolName: string,
  input: string,
  cwd: string
): Promise<any> => {
  const final = await client.tool(
    { runId: `e2e-${randomUUID()}`, toolName, input, cwd },
    () => undefined
  );
  return (final as RpcResult).result as any;
};

// Build a well-formed WRITE_FILE input: a quoted path followed by a fenced code
// block containing the file content (mirrors the adapter's extractPath /
// extractCodeBlock contract).
export const writeFileInput = (path: string, content: string): string =>
  `"${path}"\n\n\`\`\`\n${content}\n\`\`\``;
