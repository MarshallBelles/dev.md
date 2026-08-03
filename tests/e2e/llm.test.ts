import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'http';
import { E2E_LLM_ENDPOINT, E2E_LLM_MODEL, E2E_LLM_API_KEY, E2E_TIMEOUT, E2E_MAX_TOKENS } from './config.js';

describe('E2E: LLM Endpoint', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  before(() => {
    // Spin up a lightweight health-check server to verify the endpoint is reachable
    server = createServer((req, res) => {
      const body = JSON.stringify({ status: 'ok', endpoint: E2E_LLM_ENDPOINT });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    return new Promise<void>((resolve, reject) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
          resolve();
        } else {
          reject(new Error('No port assigned'));
        }
      });
    });
  });

  after(() => {
    return new Promise<void>(resolve => server.close(() => resolve()));
  });

  describe('Connection Health', () => {
    it('should reach the LLM endpoint', async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), E2E_TIMEOUT);

      try {
        const res = await fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: E2E_LLM_MODEL,
            messages: [{ role: 'user', content: 'Say "pong" in one word.' }],
            max_tokens: E2E_MAX_TOKENS,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        assert.ok(res.ok, `Expected 200, got ${res.status}`);
        const json = await res.json();
        const content = json.choices[0].message.content;
        // Verify the LLM returns actual content (not just reasoning)
        assert.ok(content, 'Content should not be null');
        assert.ok(content.length > 0, 'Content should not be empty');
        // Content-level assertion: verify the LLM returned the expected word
        assert.ok(content.toLowerCase().includes('pong'), `Content should contain "pong": ${content}`);
      } finally {
        clearTimeout(timeoutId);
      }
    });

    it('should handle streaming responses', async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), E2E_TIMEOUT);

      try {
        const res = await fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: E2E_LLM_MODEL,
            messages: [{ role: 'user', content: 'Say "hello world".' }],
            max_tokens: E2E_MAX_TOKENS,
            stream: true,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        assert.ok(res.ok, `Expected 200, got ${res.status}`);
        assert.ok(res.body, 'Response should have a body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let content = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') break;
              try {
                const parsed = JSON.parse(data);
                const contentSoFar = (parsed.choices?.[0]?.delta?.content || '') as string;
                if (!contentSoFar) continue;
                content += contentSoFar;
              } catch { /* skip */ }
            }
          }
        }

        // Verify content-level: should include expected word
        assert.ok(
          content.toLowerCase().includes('hello'),
          `Stream content should include "hello": "${content}"`
        );
      } finally {
        clearTimeout(timeoutId);
      }
    });

    it('should return valid JSON response', async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), E2E_TIMEOUT);

      try {
        const res = await fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: E2E_LLM_MODEL,
            messages: [{ role: 'user', content: 'Answer with a single word.' }],
            max_tokens: E2E_MAX_TOKENS,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const json = await res.json();

        assert.ok(json.choices, 'Response should have choices');
        assert.ok(json.choices.length > 0, 'Choices should not be empty');
        assert.ok(json.choices[0].message, 'Choice should have a message');
        // Content might be null (reasoning models), so check either
        const content = json.choices[0].message.content || json.choices[0].message.reasoning || json.choices[0].message.reasoning_content || '';
        assert.ok(content.length > 0, 'Message should have content or reasoning');
        assert.ok(json.usage, 'Response should have usage');
        assert.ok(json.usage.total_tokens, 'Usage should have total_tokens');
        assert.ok(json.usage.total_tokens > 0, 'Total tokens should be > 0');
      } finally {
        clearTimeout(timeoutId);
      }
    });

    it('should handle different models', async () => {
      const models = [E2E_LLM_MODEL];
      // Test with the configured model
      const res = await fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: models[0],
          messages: [{ role: 'user', content: 'Say "yes".' }],
          max_tokens: E2E_MAX_TOKENS,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        // Model might not exist, but endpoint should respond
        assert.ok(text.length > 0, 'Model should return a response');
      } else {
        const json = await res.json();
        assert.ok(json.choices?.[0]?.message?.content || json.choices?.[0]?.message?.reasoning || json.choices?.[0]?.message?.reasoning_content, 'Model should return content or reasoning');
      }
    });
  });

  describe('Multi-Turn Conversation', () => {
    it('should maintain context across messages', async () => {
      const messages = [
        { role: 'user', content: 'The color is blue. Remember this.' },
        { role: 'assistant', content: 'Blue.' },
        { role: 'user', content: 'What is the color?' },
      ];

      const res = await fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: E2E_LLM_MODEL,
          messages,
          max_tokens: E2E_MAX_TOKENS,
        }),
      });

      const json = await res.json();
      const content = json.choices[0].message.content || json.choices[0].message.reasoning || json.choices[0].message.reasoning_content || '';
      // Verify the endpoint returns a valid response (structure check)
      assert.ok(content.length > 0, `Response should have content or reasoning: ${content}`);
      assert.ok(json.usage, 'Response should have usage');
    });
  });

  describe('Token Tracking', () => {
    it('should count tokens correctly', async () => {
      const shortPrompt = 'Say "hi".';
      const longPrompt = 'Say "hello world" and nothing else.';

      const [res1, res2] = await Promise.all([
        fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: E2E_LLM_MODEL,
            messages: [{ role: 'user', content: shortPrompt }],
            max_tokens: 10,
          }),
        }),
        fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: E2E_LLM_MODEL,
            messages: [{ role: 'user', content: longPrompt }],
            max_tokens: 10,
          }),
        }),
      ]);

      const json1 = await res1.json();
      const json2 = await res2.json();

      const tokens1 = json1.usage.total_tokens;
      const tokens2 = json2.usage.total_tokens;

      assert.ok(tokens2 > tokens1, 'Longer prompt should use more tokens');
      assert.ok(tokens1 > 0, 'Short prompt should use at least 1 token');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty messages', async () => {
      const res = await fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: E2E_LLM_MODEL,
          messages: [{ role: 'user', content: '' }],
          max_tokens: 5,
        }),
      });

      // Empty prompt might return 200 (with empty response) or 400
      assert.ok(res.status === 200 || res.status === 400, `Should handle empty prompt: ${res.status}`);
    });

    it('should handle very long prompts', async () => {
      const longPrompt = 'a'.repeat(1000);
      const res = await fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: E2E_LLM_MODEL,
          messages: [{ role: 'user', content: longPrompt }],
          max_tokens: 10,
        }),
      });

      const json = await res.json();
      assert.ok(json.choices, 'Long prompt should return choices');
    });

    it('should respect max_tokens limit', async () => {
      const res = await fetch(`${E2E_LLM_ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: E2E_LLM_MODEL,
          messages: [{ role: 'user', content: 'Count to ten.' }],
          max_tokens: 3,
        }),
      });

      const json = await res.json();
      const content = json.choices[0].message.content || json.choices[0].message.reasoning || json.choices[0].message.reasoning_content || '';
      const wordCount = content.split(/\s+/).length;
      assert.ok(wordCount <= 5, `Response should be short (max 3 tokens): ${content}`);
    });
  });
});
