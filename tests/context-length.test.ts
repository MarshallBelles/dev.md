import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  FALLBACK_MAX_CONTEXT_TOKENS,
  loadConfig,
  probeMaxModelLen,
  resetMaxContextCache,
  resolveMaxContextTokens,
} from '../dist/config/index.js';
import { needsCompression } from '../dist/agent/compress.js';
import { MockAPIServer } from './mock-server.js';
import { ConfigOverrides, createInProcessTestContext, getTestPort, InProcessTestContext } from './utils.js';

const TEST_PORT = getTestPort(70); // dedicated port range for this file

// A vLLM-shaped /v1/models body. `max_model_len` is a vLLM extension, not part of
// the OpenAI spec, which is exactly why resolution has to tolerate its absence.
const vllmModels = (id: string, maxModelLen: number, root = 'org/checkpoint') => ({
  object: 'list',
  data: [{ id, object: 'model', created: 0, owned_by: 'vllm', root, max_model_len: maxModelLen }],
});

// A spec-compliant body: the four required Model fields and nothing more.
const openAIModels = (id: string) => ({
  object: 'list',
  data: [{ id, object: 'model', created: 0, owned_by: 'openai' }],
});

describe('Context length resolution', () => {
  let server: MockAPIServer;
  let ctx: InProcessTestContext | null = null;

  before(async () => {
    server = new MockAPIServer(() => null);
    server.port = TEST_PORT;
    await server.start();
  });

  after(async () => { await server.stop(); });

  beforeEach(() => {
    server.reset();
    resetMaxContextCache();
  });

  afterEach(() => {
    ctx?.restoreEnv();
    ctx?.cleanup();
    ctx = null;
  });

  // Builds a config context and returns the config the real loader produces from it,
  // so these tests exercise the same path the CLI does.
  const configWith = (overrides: ConfigOverrides) => {
    ctx = createInProcessTestContext(TEST_PORT, overrides);
    return loadConfig();
  };

  describe('config takes precedence', () => {
    it('uses the pinned config value and never probes the server', async () => {
      server.modelsPayload = vllmModels('test-model', 131072);
      const config = configWith({ maxContextTokens: 40000 });

      assert.equal(await resolveMaxContextTokens(config), 40000);
      assert.equal(server.modelsRequestCount, 0, 'a pinned value should short-circuit the probe');
    });

    it('prefers the pinned value even when it disagrees with the server', async () => {
      server.modelsPayload = vllmModels('test-model', 131072);
      const config = configWith({ maxContextTokens: 200000 });

      assert.equal(await resolveMaxContextTokens(config), 200000);
    });
  });

  describe('server detection when config omits the value', () => {
    it('uses max_model_len published by the server', async () => {
      server.modelsPayload = vllmModels('test-model', 131072);
      const config = configWith({ maxContextTokens: undefined });

      assert.equal(config.maxContextTokens, undefined, 'test config should omit the key');
      assert.equal(await resolveMaxContextTokens(config), 131072);
      assert.equal(server.modelsRequestCount, 1);
    });

    it('matches the model by root when the id does not match', async () => {
      server.modelsPayload = vllmModels('served-alias', 65536, 'test-model');
      const config = configWith({ maxContextTokens: undefined });

      assert.equal(await resolveMaxContextTokens(config), 65536);
    });

    it('caches the probe result across repeated calls', async () => {
      server.modelsPayload = vllmModels('test-model', 131072);
      const config = configWith({ maxContextTokens: undefined });

      for (let i = 0; i < 5; i++) await resolveMaxContextTokens(config);
      assert.equal(server.modelsRequestCount, 1, 'probe should run once per endpoint+model');
    });

    it('collapses concurrent callers onto a single in-flight probe', async () => {
      server.modelsPayload = vllmModels('test-model', 131072);
      const config = configWith({ maxContextTokens: undefined });

      // Fired without awaiting in between, so all eight race the empty cache.
      const results = await Promise.all(
        Array.from({ length: 8 }, () => resolveMaxContextTokens(config))
      );

      assert.deepEqual(results, Array(8).fill(131072));
      assert.equal(server.modelsRequestCount, 1, 'concurrent callers should share one probe');
    });
  });

  describe('fallback', () => {
    it('falls back when the server omits max_model_len (spec-compliant body)', async () => {
      server.modelsPayload = openAIModels('test-model');
      const config = configWith({ maxContextTokens: undefined });

      assert.equal(await resolveMaxContextTokens(config), FALLBACK_MAX_CONTEXT_TOKENS);
    });

    it('falls back when the model is absent from the list', async () => {
      server.modelsPayload = vllmModels('some-other-model', 8192, 'other/root');
      const config = configWith({ maxContextTokens: undefined });

      assert.equal(await resolveMaxContextTokens(config), FALLBACK_MAX_CONTEXT_TOKENS);
    });

    it('falls back when the server has no /models route', async () => {
      server.modelsPayload = 'off';
      const config = configWith({ maxContextTokens: undefined });

      assert.equal(await resolveMaxContextTokens(config), FALLBACK_MAX_CONTEXT_TOKENS);
    });

    it('falls back without throwing when the endpoint is unreachable', async () => {
      ctx = createInProcessTestContext(getTestPort(71), { maxContextTokens: undefined });
      const config = loadConfig();

      assert.equal(await resolveMaxContextTokens(config), FALLBACK_MAX_CONTEXT_TOKENS);
    });

    it('caches the fallback so a dead probe is not retried every loop', async () => {
      server.modelsPayload = 'off';
      const config = configWith({ maxContextTokens: undefined });

      for (let i = 0; i < 5; i++) await resolveMaxContextTokens(config);
      assert.equal(server.modelsRequestCount, 1, 'a failed probe should still cache');
    });

    it('ignores a non-positive pinned value and detects instead', async () => {
      server.modelsPayload = vllmModels('test-model', 65536);
      const config = configWith({ maxContextTokens: 0 });

      assert.equal(await resolveMaxContextTokens(config), 65536);
    });
  });

  describe('probeMaxModelLen', () => {
    it('returns null rather than throwing on a malformed body', async () => {
      server.modelsPayload = { nonsense: true };
      const config = configWith({ maxContextTokens: undefined });

      assert.equal(await probeMaxModelLen(config), null);
    });

    it('rejects a non-numeric max_model_len', async () => {
      server.modelsPayload = {
        object: 'list',
        data: [{ id: 'test-model', object: 'model', max_model_len: 'lots' }],
      };
      const config = configWith({ maxContextTokens: undefined });

      assert.equal(await probeMaxModelLen(config), null);
    });
  });

  describe('compression threshold', () => {
    // The window is a total budget covering prompt AND completion, so the reply we
    // are about to request has to be reserved alongside the compaction headroom.
    // Before this was accounted for, a prompt could grow until prompt+output
    // overflowed the window and the server rejected the request with a 400.
    it('triggers early enough to leave room for the reply', async () => {
      const maxContextTokens = 50000;
      const maxTokens = 16000;
      const config = configWith({ maxContextTokens, maxTokens });

      // ~4 chars per token in the estimator, sized just past the threshold:
      // 50000 - 10000 compaction reserve - 16000 output = 24000 tokens.
      const messages = [{ role: 'user' as const, content: 'x'.repeat(24100 * 4) }];

      assert.equal(await needsCompression(messages), true);
      assert.equal(config.maxTokens, maxTokens);
    });

    it('does not trigger while the context is comfortably below the threshold', async () => {
      const config = configWith({ maxContextTokens: 50000, maxTokens: 16000 });
      const messages = [{ role: 'user' as const, content: 'x'.repeat(1000 * 4) }];

      assert.equal(await needsCompression(messages), false);
      assert.equal(config.maxContextTokens, 50000);
    });
  });
});
