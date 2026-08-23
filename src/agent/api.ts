import { loadConfig, resolveMaxContextTokens } from '../config/index.js';
import { type Message, estimateTokens } from '../sessions/index.js';
import { startSpinner, incrementTokens, stopSpinner } from '../ui/spinner.js';

interface StreamOptions {
  silent?: boolean;
  onToken?: (token: string) => void;
}

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

export const streamCompletion = async (
  messages: Message[],
  options: StreamOptions = {}
): Promise<string> => {
  const config = loadConfig();
  const { silent = false, onToken } = options;

  if (!silent) startSpinner();

  const body = {
    model: config.model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: true,
    max_tokens: await calcMaxTokens(messages),
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const response = await fetch(`${config.apiUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    if (!silent) stopSpinner(false, `API Error: ${response.status}`);
    throw new Error(`API Error ${response.status}: ${err}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullContent = '';
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
        const content = json.choices?.[0]?.delta?.content;
        if (content) {
          fullContent += content;
          if (!silent) incrementTokens();
          onToken?.(content);
        }
      } catch { /* ignore parse errors */ }
    }
  }

  if (!silent) stopSpinner(true);
  return fullContent;
};
