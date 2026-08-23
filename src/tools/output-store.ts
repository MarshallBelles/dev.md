import { loadConfig } from '../config/index.js';

// Tool results used to be appended to history at whatever size they happened to
// be, so a single READ_FILE or chatty COMMAND could add more tokens than the
// whole compaction reserve - blowing the context window between two compaction
// checks. Results are now capped, and the remainder is kept here so the model
// can page through it deliberately instead of losing it.

// Chars per token used when sizing a chunk. Deliberately pessimistic: measured
// against a real tokenizer, prose is ~4 chars/token but JSON is ~2.6, so 2.5
// keeps a chunk under its token budget even for the densest content.
const CONSERVATIVE_CHARS_PER_TOKEN = 2.5;

export const DEFAULT_MAX_TOOL_OUTPUT_TOKENS = 25000;

const getChunkChars = (): number => {
  const config = loadConfig();
  const tokens = config.maxToolOutputTokens ?? DEFAULT_MAX_TOOL_OUTPUT_TOKENS;
  return Math.max(1000, Math.floor(tokens * CONSERVATIVE_CHARS_PER_TOKEN));
};

interface StoredOutput {
  full: string;
  tool: string;
}

const store = new Map<string, StoredOutput>();
let counter = 0;

// Exposed for tests; also keeps a long interactive session from growing the
// store without bound.
export const resetOutputStore = (): void => { store.clear(); counter = 0; };

export const chunkCount = (length: number): number =>
  Math.max(1, Math.ceil(length / getChunkChars()));

const renderChunk = (id: string, entry: StoredOutput, chunk: number): string => {
  const size = getChunkChars();
  const total = chunkCount(entry.full.length);
  const clamped = Math.min(Math.max(1, chunk), total);
  const start = (clamped - 1) * size;
  const body = entry.full.slice(start, start + size);

  if (total === 1) return body;

  const header = `[OUTPUT CHUNK ${clamped} of ${total}] (characters ${start + 1}-${Math.min(start + size, entry.full.length)} of ${entry.full.length})`;
  const footer = clamped < total
    ? `\n\n[TRUNCATED] ${total - clamped} more chunk(s) available. To continue, use READ_MORE_OUTPUT with input:\n"${id}" ${clamped + 1}`
    : `\n\n[END OF OUTPUT] This was the final chunk.`;

  return `${header}\n${body}${footer}`;
};

// Caps a fresh tool result. Small results pass through untouched so the common
// case is unchanged; large ones are stored and the first chunk returned.
export const capToolOutput = (tool: string, result: string): string => {
  if (result.length <= getChunkChars()) return result;

  const id = `out_${(++counter).toString(36)}${Date.now().toString(36).slice(-4)}`;
  const entry: StoredOutput = { full: result, tool };
  store.set(id, entry);
  return renderChunk(id, entry, 1);
};

// Serves a stored chunk back to the model. Input is the quoted id, optionally
// followed by a chunk number (defaults to 2, the natural "give me the rest").
export const readMoreOutput = (input: string): string => {
  const idMatch = input.match(/"([^"]+)"|'([^']+)'|(\bout_[a-z0-9]+)/i);
  const id = idMatch ? (idMatch[1] || idMatch[2] || idMatch[3]) : '';
  if (!id) return 'ERROR: READ_MORE_OUTPUT requires a quoted output id, e.g. "out_1abc" 2';

  const entry = store.get(id);
  if (!entry) {
    return `ERROR: No stored output with id "${id}". Stored output is kept for the current run only - re-run the original tool to regenerate it.`;
  }

  const after = input.slice(idMatch!.index! + idMatch![0].length);
  const numMatch = after.match(/\d+/);
  const chunk = numMatch ? parseInt(numMatch[0], 10) : 2;

  return renderChunk(id, entry, chunk);
};
