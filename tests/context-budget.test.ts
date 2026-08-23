import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  ESTIMATE_SAFETY_FACTOR,
  compressContext,
  effectiveTokens,
  getCompactionThreshold,
  lastIterationStart,
  needsCompression,
} from '../dist/agent/compress.js';
import { isContextOverflowError } from '../dist/agent/api.js';
import { capToolOutput, readMoreOutput, resetOutputStore } from '../dist/tools/output-store.js';
import { resetMaxContextCache } from '../dist/config/index.js';
import { MockAPIServer } from './mock-server.js';
import { ConfigOverrides, createInProcessTestContext, getTestPort, InProcessTestContext } from './utils.js';

const TEST_PORT = getTestPort(72); // dedicated port range for this file

const msg = (chars: number) => ({ role: 'user' as const, content: 'x'.repeat(chars) });

// A session carrying the server's real accounting for the first N messages.
const sessionWithBaseline = (promptTokens: number, messageCount: number) =>
  ({ lastPromptTokens: promptTokens, lastPromptMessages: messageCount }) as never;

describe('Context budget', () => {
  let server: MockAPIServer;
  let ctx: InProcessTestContext | null = null;

  before(async () => {
    server = new MockAPIServer(() => null);
    server.port = TEST_PORT;
    await server.start();
  });
  after(async () => { await server.stop(); });

  beforeEach(() => { server.reset(); resetMaxContextCache(); resetOutputStore(); });
  afterEach(() => { ctx?.restoreEnv(); ctx?.cleanup(); ctx = null; });

  const configWith = (o: ConfigOverrides) => { ctx = createInProcessTestContext(TEST_PORT, o); };

  describe('threshold follows the detected context length', () => {
    it('derives the threshold from the server-detected max_model_len', async () => {
      server.modelsPayload = {
        object: 'list',
        data: [{ id: 'test-model', object: 'model', max_model_len: 131072 }],
      };
      configWith({ maxContextTokens: undefined, maxTokens: 4096 });

      // detected 131072 - 10000 reserve - 4096 reply
      assert.equal(await getCompactionThreshold(), 116976);
    });

    it('tracks a different detected window', async () => {
      server.modelsPayload = {
        object: 'list',
        data: [{ id: 'test-model', object: 'model', max_model_len: 32768 }],
      };
      configWith({ maxContextTokens: undefined, maxTokens: 2048 });

      assert.equal(await getCompactionThreshold(), 32768 - 10000 - 2048);
    });

    it('leaves at least the 10k reserve plus the reply budget', async () => {
      const maxContextTokens = 131072, maxTokens = 4096;
      configWith({ maxContextTokens, maxTokens });

      const headroom = maxContextTokens - (await getCompactionThreshold());
      assert.ok(headroom >= 10000, `headroom ${headroom} should cover the reserve`);
      assert.equal(headroom, 10000 + maxTokens);
    });
  });

  describe('scenario A: server reports usage', () => {
    it('prices the measured prefix exactly, guessing only what came after', async () => {
      configWith({ maxContextTokens: 131072, maxTokens: 4096 });

      // Server said the first 3 messages really cost 100000 tokens. The estimator
      // would have guessed far lower for the same text; the real figure must win.
      const messages = [msg(40), msg(40), msg(40), msg(4000)];
      const session = sessionWithBaseline(100000, 3);

      const expected = 100000 + Math.ceil(1000 * ESTIMATE_SAFETY_FACTOR);
      assert.equal(effectiveTokens(messages, session), expected);
    });

    it('compacts when the real count says so even though chars/4 says it fits', async () => {
      configWith({ maxContextTokens: 131072, maxTokens: 4096 });

      // Tiny text, but the server charged 120000 tokens for it - JSON-dense
      // content behaves exactly like this. The estimate alone would not compact.
      const messages = [msg(400)];
      const session = sessionWithBaseline(120000, 1);

      assert.equal(await needsCompression(messages), false, 'estimate alone would not fire');
      assert.equal(await needsCompression(messages, session), true, 'real count must fire');
    });
  });

  describe('scenario B: server reports no usage', () => {
    it('falls back to the estimate scaled by the safety factor', async () => {
      configWith({ maxContextTokens: 131072, maxTokens: 4096 });

      const messages = [msg(40000)]; // 10000 est tokens
      assert.equal(effectiveTokens(messages, undefined), Math.ceil(10000 * ESTIMATE_SAFETY_FACTOR));
    });

    it('the scaled guess covers the measured JSON worst case (1.55x)', async () => {
      assert.ok(ESTIMATE_SAFETY_FACTOR >= 1.56,
        'factor must cover the densest content measured against a real tokenizer');
    });

    it('compacts before a JSON-dense history overflows the window', async () => {
      configWith({ maxContextTokens: 131072, maxTokens: 4096 });

      // The exact case proven to be rejected by the real server: 115976 est
      // tokens of JSON, which really costs ~127k. Old code sent it; now it compacts.
      const messages = [msg(115976 * 4)];
      assert.equal(await needsCompression(messages), true);
    });

    it('ignores a baseline that no longer lines up with the history', async () => {
      configWith({ maxContextTokens: 131072, maxTokens: 4096 });

      // Baseline claims 5 messages but history was replaced by compaction.
      const messages = [msg(4000)];
      const stale = sessionWithBaseline(120000, 5);
      assert.equal(effectiveTokens(messages, stale), Math.ceil(1000 * ESTIMATE_SAFETY_FACTOR));
    });
  });

  describe('walk back one iteration, compact, replay', () => {
    const buildSession = (history: unknown[], lastPromptMessages?: number) => ({
      id: 't', createdAt: '', updatedAt: '', workingDirectory: '/tmp',
      originalPrompt: 'do the thing', taskList: [], history,
      totalTokens: 0, compressions: [],
      lastPromptTokens: lastPromptMessages ? 1000 : undefined,
      lastPromptMessages,
    }) as never;

    it('splits at the last server-accepted prompt when usage is known', () => {
      const history = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'turn 1' },
        { role: 'user', content: 'tool result 1' },
        { role: 'assistant', content: 'turn 2' },   // <- iteration that overflowed
        { role: 'user', content: 'tool result 2' },
      ];
      // Server last accepted 4 messages; everything after is the current iteration.
      assert.equal(lastIterationStart(buildSession(history, 4)), 4);
    });

    it('falls back to the last assistant turn when usage is unavailable', () => {
      const history = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'turn 1' },
        { role: 'user', content: 'tool result 1' },
        { role: 'assistant', content: 'turn 2' },
        { role: 'user', content: 'tool result 2' },
      ];
      assert.equal(lastIterationStart(buildSession(history)), 4);
    });

    it('declines to split when there is nothing worth compacting behind it', () => {
      const history = [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'turn 1' },
      ];
      assert.equal(lastIterationStart(buildSession(history)), undefined);
    });

    it('replays the preserved iteration verbatim after compaction', async () => {
      configWith({ maxContextTokens: 131072, maxTokens: 4096 });
      server.setGenerator(() => 'SUMMARY OF EARLIER WORK');

      const history = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'old turn' },
        { role: 'user', content: 'old tool result' },
        { role: 'assistant', content: 'FRESH TURN' },
        { role: 'user', content: 'FRESH TOOL RESULT' },
      ];
      const session = buildSession(history, 4);

      const { messages } = await compressContext(session, 'sys', { preserveFrom: lastIterationStart(session) });

      // system + summary + the two preserved messages
      assert.equal(messages.length, 4);
      assert.equal(messages[0].role, 'system');
      assert.match(messages[1].content, /CONTEXT SUMMARY/);
      assert.equal(messages[2].content, 'FRESH TURN', 'fresh turn must survive verbatim');
      assert.equal(messages[3].content, 'FRESH TOOL RESULT', 'fresh tool result must survive verbatim');
      assert.ok(!messages[1].content.includes('FRESH TURN'),
        'the preserved tail must not also be summarised into the digest');
    });

    it('compacts everything when no iteration is preserved', async () => {
      configWith({ maxContextTokens: 131072, maxTokens: 4096 });
      server.setGenerator(() => 'SUMMARY OF EVERYTHING');

      const history = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'turn' },
        { role: 'user', content: 'result' },
      ];
      const session = buildSession(history, 4);

      const { messages } = await compressContext(session, 'sys');
      assert.equal(messages.length, 2, 'full compaction keeps only system + summary');
    });
  });

  describe('overflow detection', () => {
    it('recognises the real vLLM rejection', () => {
      const real = new Error("API Error 400: {\"error\":{\"message\":\"This model's maximum context length is 131072 tokens. However, you requested 4096 output tokens and your prompt contains at least 126977 input tokens\"}}");
      assert.equal(isContextOverflowError(real), true);
    });

    it('does not mistake unrelated failures for overflow', () => {
      assert.equal(isContextOverflowError(new Error('API Error 500: internal error')), false);
      assert.equal(isContextOverflowError(new Error('API Error 401: unauthorized')), false);
      assert.equal(isContextOverflowError(new Error('socket hang up')), false);
    });
  });

  describe('tool output capping and continuation', () => {
    it('leaves ordinary results untouched', async () => {
      configWith({ maxToolOutputTokens: 25000 });
      const small = 'file contents\n'.repeat(10);
      assert.equal(capToolOutput('READ_FILE', small), small);
    });

    it('chunks a result that would blow the reserve, and offers continuation', async () => {
      configWith({ maxToolOutputTokens: 25000 });
      const huge = 'A'.repeat(200000);
      const first = capToolOutput('READ_FILE', huge);

      assert.ok(first.length < huge.length, 'must be shorter than the original');
      assert.match(first, /OUTPUT CHUNK 1 of \d+/);
      assert.match(first, /READ_MORE_OUTPUT/);
      assert.match(first, /"out_[a-z0-9]+"/);
    });

    it('serves the next chunk on request', async () => {
      configWith({ maxToolOutputTokens: 25000 });
      const huge = 'A'.repeat(100000) + 'TAIL_MARKER';
      const first = capToolOutput('COMMAND', huge);
      const id = first.match(/"(out_[a-z0-9]+)"/)![1];

      const second = readMoreOutput(`"${id}" 2`);
      assert.match(second, /OUTPUT CHUNK 2 of/);
      assert.notEqual(second, first);
    });

    it('reaches the end of a long output and says so', async () => {
      configWith({ maxToolOutputTokens: 25000 });
      const huge = 'A'.repeat(100000) + 'TAIL_MARKER';
      const first = capToolOutput('COMMAND', huge);
      const id = first.match(/"(out_[a-z0-9]+)"/)![1];
      const total = parseInt(first.match(/OUTPUT CHUNK 1 of (\d+)/)![1], 10);

      const last = readMoreOutput(`"${id}" ${total}`);
      assert.match(last, /END OF OUTPUT/);
      assert.ok(last.includes('TAIL_MARKER'), 'final chunk should contain the tail');
    });

    it('each chunk stays within its token budget even for dense content', async () => {
      const maxToolOutputTokens = 25000;
      configWith({ maxToolOutputTokens });
      const huge = JSON.stringify({ k: 'v'.repeat(200000) });
      const first = capToolOutput('READ_FILE', huge);

      // 2.5 chars/token is the pessimistic ratio; a chunk must stay under budget
      // even if every character were that dense.
      assert.ok(first.length / 2.5 <= maxToolOutputTokens * 1.05,
        `chunk of ${first.length} chars could exceed ${maxToolOutputTokens} tokens`);
    });

    it('reports a clear error for an unknown id', async () => {
      configWith({ maxToolOutputTokens: 25000 });
      assert.match(readMoreOutput('"out_nope" 2'), /ERROR: No stored output/);
    });

    it('reports a clear error when no id is given', async () => {
      configWith({ maxToolOutputTokens: 25000 });
      assert.match(readMoreOutput('give me more'), /ERROR: READ_MORE_OUTPUT requires/);
    });
  });
});
