import { listDirectory, readFile, writeFile, findAndReplace } from './filesystem.js';
import { readBackgroundProcess, listBackgroundProcesses, killBackgroundProcess } from './command.js';
import { askUser, updateTaskList, done } from './interaction.js';
import { readMoreOutput } from './output-store.js';
import { loadConfig } from '../config/index.js';
import { extractPath, extractCodeBlock, extractFindReplace, extractCommandInput } from '../parser/markdown.js';
import type { ToolAdapter, ToolCapability } from './adapter.js';
import { createRegistry, type ToolRegistry } from './registry.js';
import { runGuardedCommand } from './guard-tool.js';

// Each adapter is a thin, faithful wrapper around the existing tool
// implementation so behaviour is unchanged. The capability tags on metadata are
// the single source of truth that surfaces and governance (Authorization/
// Approval middleware) filter on. DELEGATE is intentionally excluded here: it is
// driven by onDelegate in the agent loop and never reaches executeTool.

export const readFileAdapter: ToolAdapter = {
  metadata: { name: 'READ_FILE', label: 'Read File', description: 'Read the contents of a file', capabilities: ['read'], mutates: false, inputHint: 'quoted relative or absolute path' },
  execute: async ({ input, ctx }) => readFile(extractPath(input), ctx.cwd),
};

export const listDirectoryAdapter: ToolAdapter = {
  metadata: { name: 'LIST_DIRECTORY', label: 'List Directory', description: 'List the contents of a directory or glob', capabilities: ['read', 'search'], mutates: false, inputHint: 'quoted path or glob' },
  execute: async ({ input, ctx }) => listDirectory(extractPath(input), ctx.cwd),
};

export const writeFileAdapter: ToolAdapter = {
  metadata: { name: 'WRITE_FILE', label: 'Write File', description: 'Create or overwrite a file with content', capabilities: ['write'], mutates: true, inputHint: 'quoted path followed by a fenced code block with the content' },
  execute: async ({ input, ctx }) => {
    const content = extractCodeBlock(input);
    if (!content) return 'ERROR: No code block found for WRITE_FILE';
    return writeFile(extractPath(input), content, ctx.cwd);
  },
};

export const findAndReplaceAdapter: ToolAdapter = {
  metadata: { name: 'FIND_AND_REPLACE_IN_FILE', label: 'Find And Replace In File', description: 'Find and replace text in a file', capabilities: ['write'], mutates: true, inputHint: 'quoted path followed by find/replace fenced code blocks' },
  execute: async ({ input, ctx }) => {
    const fr = extractFindReplace(input);
    if (!fr) return 'ERROR: Missing find/replace code blocks';
    return findAndReplace(extractPath(input), fr.find, fr.replace, ctx.cwd);
  },
};

export const commandAdapter: ToolAdapter = {
  metadata: { name: 'COMMAND', label: 'Run Command', description: 'Execute a shell command', capabilities: ['execute'], mutates: true, inputHint: 'the command string or a fenced code block' },
  // The built-in COMMAND tool always runs through the command guard. The
  // classifier config comes from the invocation context when the engine
  // supplies it (library/config-driven runs), otherwise it falls back to the
  // file-backed config used by the CLI.
  execute: async ({ input, ctx }) => {
    const cmd = extractCommandInput(input);
    return runGuardedCommand(cmd, ctx.cwd, ctx.guard ?? loadConfig());
  },
};

export const updateTaskListAdapter: ToolAdapter = {
  metadata: { name: 'UPDATE_TASK_LIST', label: 'Update Task List', description: 'Update the displayed task list', capabilities: ['control'], mutates: false },
  execute: async () => updateTaskList(),
};

export const askUserAdapter: ToolAdapter = {
  metadata: { name: 'ASK_USER', label: 'Ask User', description: 'Ask the human a question', capabilities: ['interactive'], mutates: false },
  execute: async ({ input, ctx }) => askUser(input, ctx.automated),
};

export const doneAdapter: ToolAdapter = {
  metadata: { name: 'DONE', label: 'Done', description: 'Mark the task complete', capabilities: ['control'], mutates: false },
  execute: async ({ input }) => done(input),
};

export const readBackgroundProcessAdapter: ToolAdapter = {
  metadata: { name: 'READ_BACKGROUND_PROCESS', label: 'Read Background Process', description: 'Read the output of a background process', capabilities: ['process', 'read'], mutates: false, inputHint: 'quoted process id' },
  execute: async ({ input }) => readBackgroundProcess(extractPath(input) || input.trim()),
};

export const listBackgroundProcessesAdapter: ToolAdapter = {
  metadata: { name: 'LIST_BACKGROUND_PROCESSES', label: 'List Background Processes', description: 'List running and completed background processes', capabilities: ['process', 'read'], mutates: false },
  execute: async () => listBackgroundProcesses(),
};

export const killBackgroundProcessAdapter: ToolAdapter = {
  metadata: { name: 'KILL_BACKGROUND_PROCESS', label: 'Kill Background Process', description: 'Kill a background process by id', capabilities: ['process'], mutates: true, inputHint: 'quoted process id' },
  execute: async ({ input }) => killBackgroundProcess(extractPath(input) || input.trim()),
};

export const readMoreOutputAdapter: ToolAdapter = {
  metadata: { name: 'READ_MORE_OUTPUT', label: 'Read More Output', description: 'Page through a previously truncated tool output', capabilities: ['read'], mutates: false, inputHint: 'quoted output id, optionally followed by a chunk number' },
  execute: async ({ input }) => readMoreOutput(input),
};

/** Build a registry pre-loaded with every built-in tool (12 total; DELEGATE is excluded). */
export const buildDefaultRegistry = (): ToolRegistry => {
  const registry = createRegistry();
  registry
    .register(readFileAdapter)
    .register(listDirectoryAdapter)
    .register(writeFileAdapter)
    .register(findAndReplaceAdapter)
    .register(commandAdapter)
    .register(updateTaskListAdapter)
    .register(askUserAdapter)
    .register(doneAdapter)
    .register(readBackgroundProcessAdapter)
    .register(listBackgroundProcessesAdapter)
    .register(killBackgroundProcessAdapter)
    .register(readMoreOutputAdapter);
  return registry;
};
