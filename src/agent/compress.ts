import { loadConfig, resolveMaxContextTokens } from '../config/index.js';
import { estimateTokens, type Message, type Session } from '../sessions/index.js';
import { COMPRESSION_PROMPT } from './prompt.js';
import { streamCompletion, isContextOverflowError } from './api.js';

// Reserve 10K tokens for automatic compaction
const COMPACTION_RESERVE = 10000;

// estimateTokens is chars/4, which holds for prose and code but badly undershoots
// token-dense content: measured against a real tokenizer, JSON came out 1.55x
// higher than the estimate. When we have to guess, scale by this so the guess
// errs long rather than short. Only ever applied to un-measured text.
export const ESTIMATE_SAFETY_FACTOR = 1.6;

// What the server actually charged for a prompt we already sent, plus how many
// messages that covered. Lets us price the measured prefix exactly and guess
// only the messages appended since.
export interface ContextBaseline {
  promptTokens: number;
  messageCount: number;
}

const readBaseline = (session?: Session): ContextBaseline | undefined =>
  session?.lastPromptTokens && session.lastPromptMessages
    ? { promptTokens: session.lastPromptTokens, messageCount: session.lastPromptMessages }
    : undefined;

// Best available reading of how many tokens `messages` will really cost.
// Exact for the measured prefix, conservative for anything newer.
export const effectiveTokens = (messages: Message[], session?: Session): number => {
  const baseline = readBaseline(session);
  if (baseline && baseline.messageCount > 0 && baseline.messageCount <= messages.length) {
    const unmeasured = estimateTokens(messages.slice(baseline.messageCount));
    return baseline.promptTokens + Math.ceil(unmeasured * ESTIMATE_SAFETY_FACTOR);
  }
  // No usage reported by this server, or the history was replaced (compaction,
  // resume) so the baseline no longer lines up - guess the whole thing.
  return Math.ceil(estimateTokens(messages) * ESTIMATE_SAFETY_FACTOR);
};

// The prompt size at which compaction must fire. maxContextTokens is the server's
// *total* budget - prompt plus completion - so the reply we're about to request
// has to be subtracted alongside the compaction reserve.
export const getCompactionThreshold = async (): Promise<number> => {
  const config = loadConfig();
  const maxContextTokens = await resolveMaxContextTokens(config);
  return Math.max(1, maxContextTokens - COMPACTION_RESERVE - config.maxTokens);
};

export const needsCompression = async (messages: Message[], session?: Session): Promise<boolean> => {
  const threshold = await getCompactionThreshold();
  return effectiveTokens(messages, session) >= threshold;
};

// Index at which the most recent chat iteration begins - the assistant turn and
// tool results appended since the last prompt the server actually accepted.
// Returns undefined when there is no meaningful split (nothing appended since,
// or nothing left to summarise once the tail is carved off).
export const lastIterationStart = (session: Session): number | undefined => {
  const history = session.history;
  // Preferred: the server told us exactly how many messages it last accepted.
  let start = session.lastPromptMessages;

  if (start === undefined || start <= 0 || start >= history.length) {
    // No usage reported - fall back to the last assistant turn, which is where
    // the current iteration began.
    start = undefined;
    for (let i = history.length - 1; i > 0; i--) {
      if (history[i].role === 'assistant') { start = i; break; }
    }
  }

  if (start === undefined) return undefined;
  // Need a head worth compacting (system prompt plus at least one exchange) and
  // a non-empty tail to re-apply.
  if (start < 2 || start >= history.length) return undefined;
  return start;
};

// Summarising sends the whole history in one prompt, so at the compaction
// boundary that request is itself near the limit. Keep the head and tail and
// drop the middle if it won't fit - the summary is lossy by definition, and a
// request the server rejects would leave the loop with no way forward.
const fitForSummary = (historyText: string, budgetTokens: number): string => {
  const budgetChars = Math.max(1000, Math.floor((budgetTokens / ESTIMATE_SAFETY_FACTOR) * 4));
  if (historyText.length <= budgetChars) return historyText;
  const half = Math.floor(budgetChars / 2);
  const dropped = historyText.length - budgetChars;
  return (
    historyText.slice(0, half) +
    `\n\n---\n[${dropped} characters of mid-conversation detail omitted to fit the summarisation request]\n---\n\n` +
    historyText.slice(-half)
  );
};

export interface CompressOptions {
  // Keep messages from this index onward verbatim and summarise only what comes
  // before. Used to walk back one iteration after a context overflow so the
  // freshest turn survives compaction instead of being summarised away.
  preserveFrom?: number;
}

export const compressContext = async (
  session: Session,
  systemPrompt: string,
  options: CompressOptions = {}
): Promise<{ messages: Message[]; tokensBefore: number; tokensAfter: number }> => {
  const tokensBefore = estimateTokens(session.history);
  const config = loadConfig();
  const maxContextTokens = await resolveMaxContextTokens(config);

  const { preserveFrom } = options;
  const canPreserve = preserveFrom !== undefined && preserveFrom > 0 && preserveFrom < session.history.length;
  const head = canPreserve ? session.history.slice(0, preserveFrom) : session.history;
  const tail = canPreserve ? session.history.slice(preserveFrom) : [];

  const historyText = head
    .map(m => `[${m.role.toUpperCase()}]\n${m.content}`)
    .join('\n\n---\n\n');

  // Leave room for the compression system prompt and the summary itself.
  const summaryBudget = Math.max(1000, maxContextTokens - config.maxTokens - COMPACTION_RESERVE);

  // The summarisation request is itself bounded by maxContextTokens, so if that
  // number is wrong (pinned too high, or a model swapped behind the endpoint)
  // the very call meant to rescue the run would fail too. Shrink hard on the
  // server's authority and try again rather than leaving the loop with no exit.
  let budget = summaryBudget;
  let summary = '';
  const MAX_SHRINK_ATTEMPTS = 5;

  for (let attempt = 1; ; attempt++) {
    const compressionMessages: Message[] = [
      { role: 'system', content: COMPRESSION_PROMPT },
      { role: 'user', content: `## Conversation to Summarize\n\n${fitForSummary(historyText, budget)}` },
    ];
    try {
      summary = await streamCompletion(compressionMessages, { silent: true });
      break;
    } catch (e) {
      if (!isContextOverflowError(e) || attempt >= MAX_SHRINK_ATTEMPTS) throw e;
      budget = Math.max(500, Math.floor(budget / 4));
    }
  }

  const compressedMessages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `[CONTEXT SUMMARY]\n\n${summary}\n\n[ORIGINAL REQUEST]\n\n${session.originalPrompt}`,
    },
    // Re-applied verbatim: this is the iteration the server just rejected us on,
    // and it is the most relevant context the model has.
    ...tail,
  ];

  const tokensAfter = estimateTokens(compressedMessages);

  // The measured baseline described the pre-compaction history and is now
  // meaningless - clear it so the next check guesses rather than under-counts.
  session.lastPromptTokens = undefined;
  session.lastPromptMessages = undefined;

  session.compressions.push({
    timestamp: new Date().toISOString(),
    tokensBefore,
    tokensAfter,
  });

  return { messages: compressedMessages, tokensBefore, tokensAfter };
};
