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

// Automated-mode runs default to verbose output, which prints a box titled
// "Tool: <NAME>" for every tool call the model makes. This lets assertions check
// which tools a *real* model actually chose, independent of its paraphrased wording.
export const usedTool = (stdout: string, toolName: string): boolean =>
  stdout.includes(`Tool: ${toolName}`);
