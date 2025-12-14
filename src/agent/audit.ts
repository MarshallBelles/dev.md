import { type Session, type Message } from '../sessions/index.js';
import { parseResponse, extractPath, extractCommandInput } from '../parser/markdown.js';
import { buildAuditPrompt } from './prompt.js';
import { streamCompletion } from './api.js';
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
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
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
      return { passed: true, feedback: response };
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
      case 'DONE':
        const feedback = parsed.toolInput || parsed.thoughts;
        const passed = !feedback.toLowerCase().includes('fail');
        return { passed, feedback };
      default:
        result = `Tool ${parsed.toolChoice} not available in audit mode`;
    }

    if (verbose) displayResult(result);
    messages.push({ role: 'user', content: `Tool result:\n${result}` });
  }

  return { passed: true, feedback: 'Audit completed (max iterations reached)' };
};
