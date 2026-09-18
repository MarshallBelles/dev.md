import { describe, it } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { homedir } from 'os';
import { scoreCommand } from '../dist/command-classifier/trigger.js';
import { createTtlCache } from '../dist/command-classifier/cache.js';
import { classifyToolCall, declineMessage, permanentBlockMessage, type ClassifierConfig } from '../dist/command-classifier/index.js';
import type { ClassifyOutcome } from '../dist/command-classifier/verdict.js';

const cwd = join(homedir(), 'projects', 'demo');

const baseConfig: ClassifierConfig = {
  enabled: true,
  triggerThreshold: 25,
  riskThreshold: 75,
  cacheTtlMs: 30_000,
};

const outcome = (verdict: 'ACCEPT' | 'BLOCK' | null, reason = ''): ClassifyOutcome => ({ verdict, reason });

describe('Command classifier - risk scoring', () => {
  it('scores genuinely benign commands at 0', () => {
    for (const cmd of ['ls -la', 'cat package.json', 'echo hello', 'git status', 'npm test', 'node test.js', 'grep -r TODO src']) {
      assert.strictEqual(scoreCommand(cmd).risk, 0, `Expected 0 for "${cmd}"`);
    }
  });

  it('scores gray-area commands high enough to trigger a classifier judgement', () => {
    assert.ok(scoreCommand('sudo apt install foo').risk >= 25);
    assert.ok(scoreCommand('chmod 755 build').risk >= 25);
    assert.ok(scoreCommand('git push --force origin main').risk >= 25);
    assert.ok(scoreCommand('cat ~/.ssh/id_rsa').risk >= 25);
  });

  it('scores obfuscated / plain-sight commands high (backstop range)', () => {
    assert.strictEqual(scoreCommand('base64 -d | bash').risk, 90);
    assert.strictEqual(scoreCommand('perl -e "print \`whoami\`"').risk, 50);
    assert.ok(scoreCommand('rm -rf /Users/self-test-task').risk >= 75);
  });

  it('caps catastrophic scores at 100', () => {
    assert.strictEqual(scoreCommand(':(){ :|:& };:').risk, 100);
  });
});

describe('Command classifier - decision orchestrator', () => {
  it('auto-approves a benign command even if the classifier would block it', async () => {
    // scoreCommand gives 'ls' risk 0, which is below the trigger - the
    // classifier is never consulted.
    const decision = await classifyToolCall('ls -la', cwd, baseConfig, {
      classify: async () => outcome('BLOCK'),
    });
    assert.strictEqual(decision.blocked, false);
  });

  it('blocks via the deterministic risk backstop before the classifier runs', async () => {
    const classify = async () => outcome('ACCEPT'); // would accept anything
    const decision = await classifyToolCall('rm -rf /Users/self-test-task', cwd, baseConfig, { classify });
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.source, 'risk-backstop');
    assert.ok(decision.reason?.includes('risk score'));
  });

  it('declines via the classifier when a scored command is judged unsafe', async () => {
    const decision = await classifyToolCall('cat ~/.ssh/id_rsa', cwd, baseConfig, {
      classify: async () => outcome('BLOCK', 'reads a private key'),
    });
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.source, 'classifier');
    assert.ok(decision.reason?.includes('private key'));
  });

  it('accepts via the classifier when a scored command is judged safe', async () => {
    const decision = await classifyToolCall('sudo apt update', cwd, baseConfig, {
      classify: async () => outcome('ACCEPT', 'only refreshes package indexes'),
    });
    assert.strictEqual(decision.blocked, false);
    assert.strictEqual(decision.source, 'classifier');
  });

  it('fails closed when the classifier produces no verdict', async () => {
    const decision = await classifyToolCall('sudo apt install foo', cwd, baseConfig, {
      classify: async () => outcome(null),
    });
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.source, 'classifier');
  });
});

describe('Command classifier - cache', () => {
  it('does not re-invoke the classifier for a cached verdict', async () => {
    let calls = 0;
    const classify = async (): Promise<ClassifyOutcome> => {
      calls++;
      return outcome(calls === 1 ? 'BLOCK' : 'ACCEPT');
    };
    const cache = createTtlCache();
    const first = await classifyToolCall('chmod 755 build', cwd, baseConfig, { classify, cache });
    const second = await classifyToolCall('chmod 755 build', cwd, baseConfig, { classify, cache });
    assert.strictEqual(calls, 1, 'classifier should run once then serve from cache');
    assert.strictEqual(first.blocked, true);
    assert.strictEqual(second.blocked, true, 'second call served from cache (BLOCK)');
    assert.strictEqual(cache.get(`${cwd}\u0000chmod 755 build`)?.verdict, 'BLOCK', 'cached verdict is BLOCK');
  });

  it('does not cache a null (unavailable) verdict so it can retry', async () => {
    let calls = 0;
    const classify = async (): Promise<ClassifyOutcome> => {
      calls++;
      return outcome(null);
    };
    const cache = createTtlCache();
    const first = await classifyToolCall('chmod 755 build', cwd, baseConfig, { classify, cache });
    const second = await classifyToolCall('chmod 755 build', cwd, baseConfig, { classify, cache });
    assert.strictEqual(calls, 2, 'null verdict must not be cached');
    assert.strictEqual(first.blocked, true);
    assert.strictEqual(second.blocked, true);
  });
});

describe('Command classifier - messages', () => {
  it('decline message signals a judgment the agent can work around', () => {
    const msg = declineMessage('this would read a private key');
    assert.ok(msg.toLowerCase().includes('decline'));
    assert.ok(/different (tool|approach)|retry/i.test(msg));
    assert.ok(!msg.startsWith('ERROR'), 'a decline must not be styled as a hard failure');
  });

  it('permanent block message tells the agent to stop and not retry', () => {
    const msg = permanentBlockMessage('fork bomb');
    assert.strictEqual(msg.slice(0, 6), 'ERROR:');
    assert.ok(/do not retry|stop pursuing/i.test(msg));
  });
});
