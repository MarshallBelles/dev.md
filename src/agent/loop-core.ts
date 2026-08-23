import { loadConfig } from '../config/index.js';
import { type Session, saveSession } from '../sessions/index.js';
import { parseResponse, extractDelegateInput } from '../parser/markdown.js';
import { executeTool, type ToolContext } from '../tools/index.js';
import { streamCompletion } from './api.js';
import { needsCompression, compressContext } from './compress.js';
import { runAudit } from './audit.js';
import { displayParsed, displayResult, displayCompression, displayFinalAnswer, displayAuditStatus, displayToolExecution, isVerbose } from '../ui/display.js';
import { c } from '../ui/colors.js';
import { getTokenCount } from '../ui/spinner.js';
import { isThinkingEnabled, performThinking, displayThinking } from '../ui/thinking.js';

export interface LoopTurnOptions {
  session: Session;
  systemPrompt: string;
  ctx: ToolContext;
  maxLoops: number;
  maxRetries: number;
  // Presence of this callback is what makes DELEGATE usable in this activation -
  // absence produces a clear ERROR tool result rather than a silently unavailable
  // tool. A subagent gets this too (bounded by depth), so it can itself delegate
  // a sub-task to a fresh helper.
  onDelegate?: (label: string, task: string) => Promise<string>;
  auditVerbose?: boolean;
}

export type LoopTurnResult =
  | { type: 'done'; summary: string; auditPassed: boolean }
  | { type: 'maxLoopsReached' };

export const runLoopTurn = async (options: LoopTurnOptions): Promise<LoopTurnResult> => {
  const { session, systemPrompt, ctx, maxLoops, maxRetries } = options;
  const config = loadConfig();
  const auditVerbose = options.auditVerbose ?? isVerbose();

  const hasSystemPrompt = session.history.length > 0 && session.history[0].role === 'system';
  if (!hasSystemPrompt) {
    session.history.unshift({ role: 'system', content: systemPrompt });
  }

  let loops = 0;
  let retries = 0;
  // Detects the model repeating the exact same tool call over and over with no
  // progress - a real failure mode observed under long/complex context, where a
  // struggling model re-issues an identical action instead of moving forward.
  const recentToolSignatures: string[] = [];
  const MAX_IDENTICAL_REPEATS = 3;

  while (loops++ < maxLoops) {
    if (await needsCompression(session.history)) {
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

    const hasDone = parsed.tools.some(t => t.toolChoice === 'DONE');
    const signature = parsed.tools.map(t => `${t.toolChoice}:${t.toolInput}`).join('|');
    recentToolSignatures.push(signature);
    if (recentToolSignatures.length > MAX_IDENTICAL_REPEATS) recentToolSignatures.shift();
    const isStuckRepeating = !hasDone &&
      recentToolSignatures.length === MAX_IDENTICAL_REPEATS &&
      recentToolSignatures.every(s => s === signature);

    if (isStuckRepeating) {
      console.log(c.yellow(`\n  Detected the same action repeated ${MAX_IDENTICAL_REPEATS}x with no progress, interrupting...\n`));
      session.history.push({
        role: 'user',
        content: `WARNING: You have called the exact same tool with the exact same input ${MAX_IDENTICAL_REPEATS} times in a row with no progress. Do not repeat this action again. Either take a genuinely different next step, or if you cannot proceed, use DONE to report the blocker to the user.`,
      });
      recentToolSignatures.length = 0;
      saveSession(session);
      continue;
    }

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

      if (tool.toolChoice === 'DELEGATE') {
        if (!options.onDelegate) {
          result = 'ERROR: DELEGATE is not available in this context.';
        } else {
          const parsedInput = extractDelegateInput(tool.toolInput);
          if (!parsedInput) {
            result = 'ERROR: DELEGATE requires a quoted label and a fenced task body.';
          } else {
            result = await options.onDelegate(parsedInput.label, parsedInput.task);
          }
        }
      } else {
        try {
          result = await executeTool(tool.toolChoice, tool.toolInput, ctx);
        } catch (e) {
          result = `ERROR: ${(e as Error).message}`;
        }
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
          // Add thinking as context for the next response (as user message to avoid consecutive assistant messages)
          session.history.push({
            role: 'user',
            content: `[Your reasoning from thinking step]:\n${thinkingResult.thinking}\n\nNow continue with your next action based on this analysis.`
          });
          session.totalTokens += thinkingResult.tokens;
          saveSession(session);
        }
      }
    }

    // Handle DONE after executing preceding tools
    if (hitDone) {
      const audit = await runAudit(session, doneSummary, auditVerbose);

      if (audit.passed) {
        if (auditVerbose) {
          console.log(c.success('\n  Audit PASSED - Task complete!\n'));
          displayResult(audit.feedback);
        } else {
          displayFinalAnswer(doneSummary);
          displayAuditStatus(true);
        }
        return { type: 'done', summary: doneSummary, auditPassed: true };
      }

      if (auditVerbose) {
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

  console.log(c.red(`\n  Max loops (${maxLoops}) reached. Stopping.\n`));
  return { type: 'maxLoopsReached' };
};
