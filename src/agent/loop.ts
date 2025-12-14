import { loadConfig } from '../config/index.js';
import { type Session, type Message, saveSession } from '../sessions/index.js';
import { parseResponse, type ParsedResponse } from '../parser/markdown.js';
import { executeTool, type ToolContext } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { streamCompletion } from './api.js';
import { needsCompression, compressContext } from './compress.js';
import { runAudit } from './audit.js';
import { displayParsed, displayResult, displayCompression, displayFinalAnswer, displayAuditStatus, displayToolExecution, isVerbose } from '../ui/display.js';
import { c } from '../ui/colors.js';
import { getTokenCount } from '../ui/spinner.js';
import { isThinkingEnabled, performThinking, displayThinking } from '../ui/thinking.js';

export interface LoopOptions {
  automated: boolean;
}

export const runAgentLoop = async (session: Session, options: LoopOptions): Promise<void> => {
  const config = loadConfig();
  const maxRetries = options.automated ? config.maxRetriesAutomated : config.maxRetries;
  const systemPrompt = buildSystemPrompt(options.automated, session.workingDirectory);
  const ctx: ToolContext = { cwd: session.workingDirectory, automated: options.automated };

  // Ensure system prompt is always first in history
  const hasSystemPrompt = session.history.length > 0 && session.history[0].role === 'system';
  if (!hasSystemPrompt) {
    session.history.unshift({ role: 'system', content: systemPrompt });
  }

  let loops = 0;
  let retries = 0;

  while (loops++ < config.maxLoops) {
    if (needsCompression(session.history)) {
      const { messages, tokensBefore, tokensAfter } = await compressContext(session, systemPrompt);
      session.history = messages;
      displayCompression(tokensBefore, tokensAfter);
      saveSession(session);
    }

    let response: string;
    try {
      response = await streamCompletion(session.history);
      session.totalTokens += getTokenCount();
    } catch (e) {
      console.log(c.red(`\n  API Error: ${(e as Error).message}\n`));
      if (++retries >= maxRetries) throw e;
      console.log(c.dim(`  Retrying (${retries}/${maxRetries})...\n`));
      continue;
    }

    const parsed = parseResponse(response);
    if (!parsed) {
      console.log(c.yellow('\n  Response format error, retrying...\n'));
      session.history.push({ role: 'assistant', content: response });
      session.history.push({ role: 'user', content: 'ERROR: Your response was not in the correct format. Please use the exact format specified with # Agent Response, ## Thoughts, ## Task List, ## Tool Choice, and ## Tool Input sections.' });
      saveSession(session);
      if (++retries >= maxRetries) throw new Error('Max retries exceeded on parse failures');
      continue;
    }

    retries = 0;
    session.history.push({ role: 'assistant', content: parsed.raw });
    session.taskList = parsed.taskList.map(t => ({ status: t.status, text: t.text }));
    displayParsed(parsed);
    saveSession(session);

    // Execute all tools in sequence
    const toolResults: string[] = [];
    let hitDone = false;
    let doneSummary = '';

    for (const tool of parsed.tools) {
      // Show tool execution in compact mode (verbose mode already showed all tools in displayParsed)
      if (!isVerbose()) {
        displayToolExecution(tool.toolChoice, tool.toolInput.split('\n')[0].slice(0, 40));
      }

      if (tool.toolChoice === 'DONE') {
        hitDone = true;
        doneSummary = tool.toolInput;
        break; // Don't execute anything after DONE
      }

      let result: string;
      try {
        result = await executeTool(tool.toolChoice, tool.toolInput, ctx);
      } catch (e) {
        result = `ERROR: ${(e as Error).message}`;
      }

      toolResults.push(`[${tool.toolChoice}]: ${result}`);
      displayResult(result, result.startsWith('ERROR'));

      // Stop on error to let model recover
      if (result.startsWith('ERROR')) {
        break;
      }
    }

    // Add combined tool results to history
    if (toolResults.length > 0) {
      const toolResultsContent = `Tool results:\n${toolResults.join('\n\n')}`;
      session.history.push({ role: 'user', content: toolResultsContent });
      saveSession(session);

      // Perform thinking step if enabled (and not hitting DONE)
      if (isThinkingEnabled() && !hitDone) {
        const context = `Original task: ${session.originalPrompt}\n\nCurrent progress: ${session.taskList.map(t => `[${t.status === 'complete' ? 'x' : t.status === 'in-progress' ? '~' : ' '}] ${t.text}`).join('\n')}`;
        const thinkingResult = await performThinking(context, toolResultsContent);

        if (thinkingResult.thinking) {
          displayThinking(thinkingResult.thinking);
          // Add thinking as assistant reflection in history
          session.history.push({
            role: 'assistant',
            content: `[Internal Reasoning]\n${thinkingResult.thinking}`
          });
          session.totalTokens += thinkingResult.tokens;
          saveSession(session);
        }
      }
    }

    // Handle DONE after executing preceding tools
    if (hitDone) {
      const audit = await runAudit(session, doneSummary, isVerbose());

      if (audit.passed) {
        if (isVerbose()) {
          console.log(c.success('\n  Audit PASSED - Task complete!\n'));
          displayResult(audit.feedback);
        } else {
          displayFinalAnswer(doneSummary);
          displayAuditStatus(true);
        }
        return;
      }

      if (isVerbose()) {
        console.log(c.yellow('\n  Audit FAILED - Continuing...\n'));
        displayResult(audit.feedback, true);
      } else {
        displayAuditStatus(false);
      }
      session.history.push({
        role: 'user',
        content: `AUDIT FAILED. Please address the following issues:\n\n${audit.feedback}`,
      });
      saveSession(session);
      continue;
    }
  }

  console.log(c.red(`\n  Max loops (${config.maxLoops}) reached. Stopping.\n`));
};

export const runSinglePrompt = async (session: Session, prompt: string): Promise<void> => {
  session.originalPrompt = prompt;
  session.history.push({ role: 'user', content: prompt });
  saveSession(session);
};
