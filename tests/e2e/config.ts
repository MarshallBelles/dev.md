// E2E test configuration for real LLM endpoint
export const E2E_LLM_ENDPOINT = process.env.E2E_API_URL || 'http://100.105.25.116:8007/v1';
export const E2E_LLM_MODEL = process.env.E2E_MODEL || 'mars';
export const E2E_LLM_API_KEY = process.env.E2E_API_KEY || '';
export const E2E_TIMEOUT = Number(process.env.E2E_TIMEOUT || 30000);
export const E2E_MAX_TOKENS = Number(process.env.E2E_MAX_TOKENS || 4096);

export function getE2ELLMConfig() {
  return {
    apiUrl: E2E_LLM_ENDPOINT,
    model: E2E_LLM_MODEL,
    apiKey: E2E_LLM_API_KEY,
    maxTokens: E2E_MAX_TOKENS,
  };
}
