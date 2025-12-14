import { loadConfig } from '../config/index.js';
import { type Message } from '../sessions/index.js';
import { startSpinner, incrementTokens, stopSpinner } from '../ui/spinner.js';

interface StreamOptions {
  silent?: boolean;
  onToken?: (token: string) => void;
}

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
