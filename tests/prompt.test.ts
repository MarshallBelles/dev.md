import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildSystemPrompt, buildSubagentPrompt } from '../dist/agent/prompt.js';

describe('Prompt Construction', () => {
  describe('buildSystemPrompt (top-level agent)', () => {
    it('documents the DELEGATE tool', () => {
      const prompt = buildSystemPrompt(true, process.cwd());
      assert.ok(prompt.includes('| DELEGATE |'), 'Top-level prompt should document DELEGATE');
      assert.ok(prompt.includes('## DELEGATE FORMAT'), 'Top-level prompt should include the DELEGATE format section');
    });

    it('no longer documents the retired team/workflow tools', () => {
      const prompt = buildSystemPrompt(true, process.cwd());
      assert.ok(!prompt.includes('RUN_WORKFLOW'));
      assert.ok(!prompt.includes('SEND_MESSAGE'));
    });
  });

  describe('buildSubagentPrompt', () => {
    it('documents the DELEGATE tool (a subagent may itself delegate a sub-task)', () => {
      const prompt = buildSubagentPrompt(true, process.cwd());
      assert.ok(prompt.includes('| DELEGATE |'), 'Subagent prompt should document DELEGATE');
    });

    it('frames the subagent as focused on a single task, reporting back via DONE', () => {
      const prompt = buildSubagentPrompt(true, process.cwd());
      assert.ok(prompt.includes('focused, specific task'));
      assert.ok(prompt.includes('DONE'));
    });

    it('no longer documents the retired team/workflow tools', () => {
      const prompt = buildSubagentPrompt(true, process.cwd());
      assert.ok(!prompt.includes('RUN_WORKFLOW'));
      assert.ok(!prompt.includes('SEND_MESSAGE'));
    });
  });
});
