import { type Session, type Message } from '../sessions/index.js';
import { parseResponse, extractPath, extractCommandInput } from '../parser/markdown.js';
import { buildAuditPrompt } from './prompt.js';
import { streamCompletion } from './api.js';
import { capToolOutput } from '../tools/output-store.js';
import { listDirectory, readFile } from '../tools/filesystem.js';
import { executeCommand, isAuditAllowed } from '../tools/command.js';
import { displayParsed, displayResult } from '../ui/display.js';
import { c } from '../ui/colors.js';
import { loadConfig } from '../config/index.js';

export interface AuditResult {
  passed: boolean;
  feedback: string;
}

export const runAudit = async (session: Session, doneSummary: string, verbose = true): Promise<AuditResult> => {
  if (verbose) console.log(c.magenta('\n  Running audit agent...\n'));

  const taskListText = session.taskList
    .map(t => `[${t.status === 'complete' ? 'x' : t.status === 'in-progress' ? '~' : ' '}] ${t.text}`)
    .join('\n') || '(no tasks)';

  const systemPrompt = buildAuditPrompt(session.originalPrompt, taskListText, doneSummary);
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Begin the audit.' },
  ];
  const config = loadConfig();
  let loops = 0;

  while (loops++ < 20) {
    const response = await streamCompletion(messages);
    const parsed = parseResponse(response);

    if (!parsed) {
      const passMatch = response.toLowerCase().includes('overall: pass');
      const failMatch = response.toLowerCase().includes('overall: fail');
      if (passMatch) return { passed: true, feedback: response };
      if (failMatch) return { passed: false, feedback: response };
      // Malformed response with no clear verdict - don't default to passed.
      // Give the model a chance to retry with a well-formed response.
      console.log(c.yellow('\n  Audit response format error, retrying...\n'));
      messages.push({ role: 'assistant', content: response });
      messages.push({
        role: 'user',
        content: 'ERROR: Your response was not in the correct format and did not contain a clear "Overall: PASS" or "Overall: FAIL" verdict. Please respond again using the exact # Agent Response format with a DONE tool choice and an unambiguous verdict.',
      });
      continue;
    }

    if (verbose) displayParsed(parsed);
    messages.push({ role: 'assistant', content: parsed.raw });

    let result: string;
    const cwd = session.workingDirectory;

    switch (parsed.toolChoice) {
      case 'LIST_DIRECTORY':
        result = await listDirectory(extractPath(parsed.toolInput), cwd);
        break;
      case 'READ_FILE':
        result = readFile(extractPath(parsed.toolInput), cwd);
        break;
      case 'COMMAND': {
        const cmd = extractCommandInput(parsed.toolInput);
        if (!isAuditAllowed(cmd)) {
          result = `ERROR: Command not allowed in audit mode: ${cmd}`;
        } else {
          result = await executeCommand(cmd, cwd);
        }
        break;
      }
      case 'DONE': {
        const feedback = parsed.toolInput || parsed.thoughts;
        const lower = feedback.toLowerCase();
        // Require an explicit PASS verdict (as instructed in buildAuditPrompt) rather than
        // merely the absence of the word "fail" - an ambiguous/malformed verdict must not
        // default to passed.
        const passed = lower.includes('overall: pass') && !lower.includes('overall: fail');
        return { passed, feedback };
      }
      default:
        result = `Tool ${parsed.toolChoice} not available in audit mode`;
    }

    if (verbose) displayResult(result);
    // Same cap as the main loop: the audit reads files and runs commands, and an
    // uncapped result here can overflow the window just as easily.
    messages.push({ role: 'user', content: `Tool result:\n${capToolOutput(parsed.toolChoice, result)}` });
  }

  // Ran out of iterations without ever reaching a clear verdict - fail closed rather
  // than silently rubber-stamping incomplete/inconclusive work as passed.
  return { passed: false, feedback: 'Audit could not reach a conclusive verdict after 20 iterations - treating as not verified.' };
};
