// Shared setup for e2e tests that drive the real dev.md CLI against a real LLM endpoint.
import { createTestContext, TestContext, ConfigOverrides } from '../utils.js';
import { E2E_LLM_ENDPOINT, E2E_LLM_MODEL, E2E_LLM_API_KEY } from './config.js';

// Real reasoning-model calls are slow and multi-step (main loop + audit loop each
// make several round trips), so these are far more generous than the mocked unit tests.
export const AGENT_COMMAND_TIMEOUT_SEC = 60;
export const AGENT_MAX_LOOPS = 25;
export const AGENT_MAX_RETRIES_AUTOMATED = 6;
export const AGENT_CLI_TIMEOUT_MS = 180000;

export const createAgentTestContext = (overrides: ConfigOverrides = {}): TestContext => createTestContext(0, {
  apiUrl: E2E_LLM_ENDPOINT,
  model: E2E_LLM_MODEL,
  apiKey: E2E_LLM_API_KEY,
  commandTimeout: AGENT_COMMAND_TIMEOUT_SEC,
  maxLoops: AGENT_MAX_LOOPS,
  maxRetriesAutomated: AGENT_MAX_RETRIES_AUTOMATED,
  ...overrides,
});

// Automated-mode runs print each executed tool in compact mode as a line like
// "  ⚡ <TOOL_NAME> <input>". Match that live execution marker (ANSI codes stripped)
// so assertions verify which tools a *real* model actually chose, independent of
// its paraphrased wording. The old "Tool: <NAME>" preview format is no longer
// emitted at runtime.
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
export const usedTool = (stdout: string, toolName: string): boolean => {
  const clean = stripAnsi(stdout);
  return new RegExp(`(^|\\s)⚡\\s+${toolName}(?:\\s|$)`).test(clean);
};

// The Command Guard suite pays for a real LLM classifier call on every COMMAND
// and the model can loop trying alternate ways to satisfy a blocked request, so
// it needs a far more generous CLI deadline than the other agent tests.
export const COMMAND_GUARD_CLI_TIMEOUT_MS = 420000;
