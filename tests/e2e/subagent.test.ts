// Real e2e test for the DELEGATE (subagent) tool: drives the actual dev.md CLI
// against the real LLM endpoint. Unlike tests/subagent.test.ts (scripted mock
// responses), this lets a real model decide how/when to use DELEGATE, and
// verifies the ground-truth outcome (file actually written to disk) rather than
// the model's exact wording.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCLI, TestContext } from '../utils.js';
import { createAgentTestContext, usedTool, AGENT_CLI_TIMEOUT_MS } from './agent-utils.js';

describe('E2E: Subagent (DELEGATE)', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createAgentTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('delegates a self-contained task to a subagent and gets the real result back', async () => {
    const result = await runCLI(
      ['-p', 'Delegate this exact task to a subagent: create a file named notes.txt containing exactly the text: Subagent test successful'],
      ctx,
      { timeout: AGENT_CLI_TIMEOUT_MS }
    );

    assert.strictEqual(result.exitCode, 0, `CLI should exit cleanly:\n${result.stdout}\n${result.stderr}`);
    assert.ok(usedTool(result.stdout, 'DELEGATE'), 'Agent should have used DELEGATE');

    const filePath = join(ctx.tempDir, 'notes.txt');
    assert.ok(existsSync(filePath), `notes.txt should exist on disk:\n${result.stdout}`);
    assert.ok(
      readFileSync(filePath, 'utf-8').includes('Subagent test successful'),
      `notes.txt should contain the requested text, got: ${readFileSync(filePath, 'utf-8')}`
    );

    assert.ok(result.stdout.includes('Delegating to'), 'Should show the subagent being delegated to');
  });
});
