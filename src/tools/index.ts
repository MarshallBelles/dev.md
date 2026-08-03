import { listDirectory, readFile, writeFile, findAndReplace } from './filesystem.js';
import { executeCommand, readBackgroundProcess, listBackgroundProcesses, killBackgroundProcess } from './command.js';
import { askUser, updateTaskList, done } from './interaction.js';
import { guardCommand } from './guard.js';
import { loadConfig } from '../config/index.js';
import { extractPath, extractCodeBlock, extractFindReplace, extractCommandInput, type ToolName } from '../parser/markdown.js';

export interface ToolContext {
  cwd: string;
  automated: boolean;
}

export const executeTool = async (tool: ToolName, input: string, ctx: ToolContext): Promise<string> => {
  const path = extractPath(input);

  switch (tool) {
    case 'LIST_DIRECTORY':
      return await listDirectory(path, ctx.cwd);

    case 'READ_FILE':
      return readFile(path, ctx.cwd);

    case 'WRITE_FILE': {
      const content = extractCodeBlock(input);
      if (!content) return 'ERROR: No code block found for WRITE_FILE';
      return writeFile(path, content, ctx.cwd);
    }

    case 'FIND_AND_REPLACE_IN_FILE': {
      const fr = extractFindReplace(input);
      if (!fr) return 'ERROR: Missing find/replace code blocks';
      return findAndReplace(path, fr.find, fr.replace, ctx.cwd);
    }

    case 'COMMAND': {
      const cmd = extractCommandInput(input);
      const config = loadConfig();
      const guard = await guardCommand(cmd, ctx.cwd, config);
      if (guard.blocked) {
        return `ERROR: Command permanently blocked by safety guard: ${guard.reason || 'unsafe command'}. ` +
          `Do NOT retry this command or attempt an alternate path to the same file/action (e.g. a different absolute path, sudo, or searching the filesystem for it) - it will be blocked again every time. ` +
          `This is not a transient error. Stop pursuing this action and use DONE to report the limitation to the user.`;
      }
      return await executeCommand(cmd, ctx.cwd);
    }

    case 'UPDATE_TASK_LIST':
      return updateTaskList();

    case 'ASK_USER':
      return await askUser(input, ctx.automated);

    case 'DONE':
      return done(input);

    case 'READ_BACKGROUND_PROCESS':
      return readBackgroundProcess(path || input.trim());

    case 'LIST_BACKGROUND_PROCESSES':
      return listBackgroundProcesses();

    case 'KILL_BACKGROUND_PROCESS':
      return killBackgroundProcess(path || input.trim());

    default:
      return `Unknown tool: ${tool}`;
  }
};
