import { loadConfig, resolveMaxContextTokens } from '../config/index.js';
import { type Message, estimateTokens } from '../sessions/index.js';
import { startSpinner, incrementTokens, stopSpinner, isSpinnerActive, setSpinnerText } from '../ui/spinner.js';

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface StreamOptions {
  silent?: boolean;
  onToken?: (token: string) => void;
  // Receives the server's real token accounting when it reports any. Only the
  // main agent loop should record this - audit/compression/subagent calls send
  // different message sets and would otherwise clobber the loop's baseline.
  onUsage?: (usage: CompletionUsage) => void;
}

// Recognises the server's "prompt is too long" rejection so the caller can
// compact and retry instead of burning retries re-sending the same oversized
// prompt. Wording differs between runtimes, so match on the shape of it.
export const isContextOverflowError = (err: unknown): boolean => {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg.includes('400')) return false;
  return (
    msg.includes('maximum context length') ||
    msg.includes('max_model_len') ||
    msg.includes('context window') ||
    msg.includes('reduce the length of the input') ||
    msg.includes('too many tokens')
  );
};

// estimateTokens is a rough chars/4 heuristic, not the server's real tokenizer - it can
// undershoot the real count. Reserve headroom so a small estimation error never pushes
// (real prompt tokens + max_tokens) over the model's hard context limit.
const TOKEN_ESTIMATE_SAFETY_MARGIN = 1000;

// Calculate max output tokens: normally config.maxTokens (a sane single-response
// budget), clamped down if the context window is close to full.
const calcMaxTokens = async (messages: Message[]): Promise<number> => {
  const config = loadConfig();
  const maxContextTokens = await resolveMaxContextTokens(config);
  const promptTokens = estimateTokens(messages);
  const remaining = maxContextTokens - promptTokens - TOKEN_ESTIMATE_SAFETY_MARGIN;
  return Math.max(1, Math.min(config.maxTokens, remaining));
};

const DEFAULT_REQUEST_TIMEOUT_SEC = 120;
const DEFAULT_MAX_API_RETRIES = 10;
const DEFAULT_RETRY_WINDOW_SEC = 300;

// Transient server-side conditions. Everything else in the 4xx range is a real
// rejection (bad request, auth, unknown model) and retrying just wastes the
// user's time - context overflow in particular is handled by the caller.
const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

// A thrown fetch means the request never got a reply: connection refused, DNS
// failure, TLS error, or our own timeout firing. All worth another try.
const isRetryableNetworkError = (e: unknown): boolean => {
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) return true;
  return e instanceof TypeError; // fetch throws TypeError for network failures
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Exponential with jitter, capped so late attempts stay responsive.
const backoffMs = (attempt: number): number => {
  const base = Math.min(30000, 1000 * 2 ** (attempt - 1));
  return Math.floor(base * (0.5 + Math.random() * 0.5));
};

export const streamCompletion = async (
  messages: Message[],
  options: StreamOptions = {}
): Promise<string> => {
  const config = loadConfig();
  const { silent = false, onToken, onUsage } = options;

  if (!silent) startSpinner();

  const body = {
    model: config.model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: true,
    max_tokens: await calcMaxTokens(messages),
    // Opt into the final usage chunk. Servers that don't support this ignore the
    // field, which is why every consumer treats usage as optional.
    stream_options: { include_usage: true },
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const timeoutMs = (config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_SEC) * 1000;
  const maxAttempts = Math.max(1, config.maxApiRetries ?? DEFAULT_MAX_API_RETRIES);
  const windowMs = (config.apiRetryWindow ?? DEFAULT_RETRY_WINDOW_SEC) * 1000;
  const startedAt = Date.now();

  let fullContent = '';
  let lastError: unknown;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Anything already streamed to the caller cannot be un-sent, so a failure
      // after the first token is not safely retryable - replaying would duplicate.
      let contentEmitted = false;
      fullContent = '';

      try {
        const response = await fetch(`${config.apiUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const err = await response.text();
          const error = new Error(`API Error ${response.status}: ${err}`);
          if (!isRetryableStatus(response.status)) throw error;
          lastError = error;
        } else {
          const reader = response.body?.getReader();
          if (!reader) throw new Error('No response body');

          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;

              try {
                const json = JSON.parse(data);
                // The usage chunk arrives last and carries no choices. Absent on
                // servers that don't implement stream_options.
                if (json.usage && typeof json.usage.prompt_tokens === 'number') {
                  onUsage?.(json.usage as CompletionUsage);
                }
                const content = json.choices?.[0]?.delta?.content;
                if (content) {
                  fullContent += content;
                  contentEmitted = true;
                  if (!silent) incrementTokens();
                  onToken?.(content);
                }
              } catch { /* ignore parse errors */ }
            }
          }

          if (!silent) stopSpinner(true);
          return fullContent;
        }
      } catch (e) {
        if (contentEmitted) throw e;                 // mid-stream: cannot replay
        if (!isRetryableNetworkError(e)) throw e;    // permanent: surface it now
        lastError = e;
      }

      // Out of attempts, or the next backoff would exceed the retry window.
      const delay = backoffMs(attempt);
      const elapsed = Date.now() - startedAt;
      if (attempt >= maxAttempts || elapsed + delay >= windowMs) break;

      const secs = Math.round(delay / 1000);
      if (!silent) {
        setSpinnerText(`Retrying in ${secs}s (attempt ${attempt + 1}/${maxAttempts})...`);
      }
      await sleep(delay);
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `API request to ${config.apiUrl} failed after ${maxAttempts} attempt(s): ${detail}. ` +
      `Check the endpoint is reachable, or run \`dev setup\` to reconfigure.`
    );
  } finally {
    // Guarantees the spinner never survives an error path. Previously a thrown
    // fetch skipped stopSpinner entirely, leaving "Thinking..." on screen
    // forever and stacking a second spinner on the next call.
    if (!silent && isSpinnerActive()) stopSpinner(false, 'API request failed');
  }
};
