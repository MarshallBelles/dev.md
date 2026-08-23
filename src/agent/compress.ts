import { loadConfig, resolveMaxContextTokens } from '../config/index.js';
import { estimateTokens, type Message, type Session } from '../sessions/index.js';
import { COMPRESSION_PROMPT } from './prompt.js';
import { streamCompletion } from './api.js';

// Reserve 10K tokens for automatic compaction
const COMPACTION_RESERVE = 10000;

export const needsCompression = async (messages: Message[]): Promise<boolean> => {
  const config = loadConfig();
  const maxContextTokens = await resolveMaxContextTokens(config);
  // maxContextTokens is the server's *total* budget - prompt plus completion - so
  // the reply we're about to request has to be subtracted alongside the compaction
  // reserve. Omitting maxTokens here lets the prompt grow until prompt+output
  // overflows the window and the server rejects the request outright.
  const threshold = Math.max(1, maxContextTokens - COMPACTION_RESERVE - config.maxTokens);
  return estimateTokens(messages) >= threshold;
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
