import { loadConfig } from '../config/index.js';
import { estimateTokens, type Message, type Session } from '../sessions/index.js';
import { COMPRESSION_PROMPT } from './prompt.js';
import { streamCompletion } from './api.js';

export const needsCompression = (messages: Message[]): boolean => {
  const config = loadConfig();
  return estimateTokens(messages) >= config.maxContextTokens;
};

export const compressContext = async (
  session: Session,
  systemPrompt: string
): Promise<{ messages: Message[]; tokensBefore: number; tokensAfter: number }> => {
  const tokensBefore = estimateTokens(session.history);

  const historyText = session.history
    .map(m => `[${m.role.toUpperCase()}]\n${m.content}`)
    .join('\n\n---\n\n');

  const compressionMessages: Message[] = [
    { role: 'system', content: COMPRESSION_PROMPT },
    { role: 'user', content: `## Conversation to Summarize\n\n${historyText}` },
  ];

  const summary = await streamCompletion(compressionMessages, { silent: true });

  const compressedMessages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `[CONTEXT SUMMARY]\n\n${summary}\n\n[ORIGINAL REQUEST]\n\n${session.originalPrompt}`,
    },
  ];

  const tokensAfter = estimateTokens(compressedMessages);

  session.compressions.push({
    timestamp: new Date().toISOString(),
    tokensBefore,
    tokensAfter,
  });

  return { messages: compressedMessages, tokensBefore, tokensAfter };
};
