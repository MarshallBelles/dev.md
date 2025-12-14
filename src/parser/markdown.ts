export type ToolName =
  | 'LIST_DIRECTORY' | 'READ_FILE' | 'WRITE_FILE' | 'FIND_AND_REPLACE_IN_FILE'
  | 'COMMAND' | 'UPDATE_TASK_LIST' | 'ASK_USER' | 'DONE'
  | 'READ_BACKGROUND_PROCESS' | 'LIST_BACKGROUND_PROCESSES' | 'KILL_BACKGROUND_PROCESS';

export interface TaskItem { status: 'pending' | 'in-progress' | 'complete'; text: string }

export interface ToolCall {
  toolChoice: ToolName;
  toolInput: string;
}

export interface ParsedResponse {
  thoughts: string;
  taskList: TaskItem[];
  tools: ToolCall[];
  raw: string;
  // Convenience accessors for single-tool compatibility
  toolChoice: ToolName;
  toolInput: string;
}

const TOOL_NAMES: ToolName[] = [
  'LIST_DIRECTORY', 'READ_FILE', 'WRITE_FILE', 'FIND_AND_REPLACE_IN_FILE',
  'COMMAND', 'UPDATE_TASK_LIST', 'ASK_USER', 'DONE',
  'READ_BACKGROUND_PROCESS', 'LIST_BACKGROUND_PROCESSES', 'KILL_BACKGROUND_PROCESS',
];

export const parseResponse = (fullResponse: string): ParsedResponse | null => {
  const marker = '# Agent Response';
  const lastIdx = fullResponse.lastIndexOf(marker);
  if (lastIdx === -1) return null;

  const section = fullResponse.slice(lastIdx);
  const lines = section.split('\n');

  let thoughts = '';
  let taskList: TaskItem[] = [];
  let tools: ToolCall[] = [];
  let currentSection = '';
  let currentTool: ToolName | null = null;
  let currentInput = '';

  // Track code fence state to ignore ## headers inside code blocks
  let inCodeBlock = false;
  let fenceChar = '';
  let fenceLen = 0;

  const finishCurrentTool = () => {
    if (currentTool) {
      tools.push({ toolChoice: currentTool, toolInput: currentInput.trim() });
      currentTool = null;
      currentInput = '';
    }
  };

  for (const line of lines) {
    // Track code fence state (``` or ~~~, 3+ chars)
    // Only match fences that are JUST backticks/tildes (no language tag = potential closing)
    const fenceMatch = line.match(/^([`~]{3,})/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        // Opening fence
        inCodeBlock = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
      } else {
        // Potential closing fence - must be same char, at least same length, and ONLY fence chars (no language tag)
        // Use GREATER than fenceLen to handle nested blocks - inner blocks use same length, outer uses more
        // For proper nesting: outer uses 4+, inner uses 3. Closing outer needs 4+.
        const isClosingFence = fenceMatch[1][0] === fenceChar &&
                               fenceMatch[1].length >= fenceLen &&
                               line.trim().match(/^[`~]+$/);
        if (isClosingFence) {
          inCodeBlock = false;
          fenceLen = 0; // Reset so next fence can be opening
        }
      }
    }

    // Recognize headers - with special handling for ## Tool Choice in toolInput sections
    // When collecting toolInput (which may contain nested code blocks), recognize ## Tool Choice
    // as a section boundary even if fence tracking thinks we're in a code block, because
    // the model wouldn't output "## Tool Choice" as literal content inside tool input.
    const isToolChoiceHeader = line.startsWith('## Tool Choice');
    const isToolInputHeader = line.startsWith('## Tool Input');
    const shouldRecognizeHeader = !inCodeBlock || (currentSection === 'toolInput' && (isToolChoiceHeader || isToolInputHeader));

    if (shouldRecognizeHeader) {
      if (line.startsWith('## Thoughts')) {
        finishCurrentTool();
        currentSection = 'thoughts';
        inCodeBlock = false; // Reset fence state
        continue;
      }
      if (line.startsWith('## Task List')) {
        finishCurrentTool();
        currentSection = 'taskList';
        inCodeBlock = false;
        continue;
      }
      if (isToolChoiceHeader) {
        finishCurrentTool();
        currentSection = 'toolChoice';
        inCodeBlock = false;
        continue;
      }
      if (isToolInputHeader) {
        currentSection = 'toolInput';
        inCodeBlock = false;
        continue;
      }
    }

    switch (currentSection) {
      case 'thoughts':
        thoughts += (thoughts ? '\n' : '') + line;
        break;
      case 'taskList':
        const match = line.match(/^\[([x~\s])\]\s*(.+)$/i);
        if (match) {
          const status = match[1] === 'x' ? 'complete' : match[1] === '~' ? 'in-progress' : 'pending';
          taskList.push({ status, text: match[2].trim() });
        }
        break;
      case 'toolChoice':
        if (!currentTool) {
          const trimmed = line.trim().toUpperCase();
          if (TOOL_NAMES.includes(trimmed as ToolName)) {
            currentTool = trimmed as ToolName;
          }
        }
        break;
      case 'toolInput':
        currentInput += (currentInput ? '\n' : '') + line;
        break;
    }
  }

  finishCurrentTool();

  if (tools.length === 0) return null;

  return {
    thoughts: thoughts.trim(),
    taskList,
    tools,
    raw: section,
    // Single-tool compatibility (first tool)
    toolChoice: tools[0].toolChoice,
    toolInput: tools[0].toolInput,
  };
};

export const extractPath = (input: string): string => {
  const match = input.match(/^"([^"]+)"|^([^\n]+)/);
  return (match?.[1] || match?.[2] || '').trim();
};

export const extractCodeBlock = (input: string, lang?: string): string | null => {
  // Find opening fence: 3+ backticks or tildes, optional language
  const fencePattern = lang
    ? new RegExp('^([`~]{3,})' + lang + '?\\s*$', 'im')
    : /^([`~]{3,})\w*\s*$/im;

  const fenceMatch = input.match(fencePattern);
  if (!fenceMatch) return null;

  const fenceChar = fenceMatch[1][0];  // ` or ~
  const startIdx = fenceMatch.index! + fenceMatch[0].length + 1; // +1 for newline
  const remaining = input.slice(startIdx);

  // Find the LAST closing fence (3+ of same char on its own line)
  // This handles nested code blocks - we want the outermost closing fence
  const closePattern = new RegExp(`^${fenceChar}{3,}\\s*$`, 'gm');
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;

  while ((match = closePattern.exec(remaining)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) return null;

  return remaining.slice(0, lastMatch.index).trimEnd();
};

export const extractFindReplace = (input: string): { find: string; replace: string } | null => {
  const findMatch = input.match(/```find\n([\s\S]*?)```/i);
  const replaceMatch = input.match(/```replace\n([\s\S]*?)```/i);
  if (!findMatch || !replaceMatch) return null;
  return { find: findMatch[1].trimEnd(), replace: replaceMatch[1].trimEnd() };
};

export const extractCommandInput = (input: string): string => {
  const codeBlock = extractCodeBlock(input);
  return codeBlock !== null ? codeBlock : input;
};
