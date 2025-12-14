const TOOL_NAMES = [
    'LIST_DIRECTORY', 'READ_FILE', 'WRITE_FILE', 'FIND_AND_REPLACE_IN_FILE',
    'COMMAND', 'UPDATE_TASK_LIST', 'ASK_USER', 'DONE',
    'READ_BACKGROUND_PROCESS', 'LIST_BACKGROUND_PROCESSES', 'KILL_BACKGROUND_PROCESS',
];
export const parseResponse = (fullResponse) => {
    const marker = '# Agent Response';
    const lastIdx = fullResponse.lastIndexOf(marker);
    if (lastIdx === -1)
        return null;
    const section = fullResponse.slice(lastIdx);
    const lines = section.split('\n');
    let thoughts = '';
    let taskList = [];
    let tools = [];
    let currentSection = '';
    let currentTool = null;
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
        const fenceMatch = line.match(/^([`~]{3,})/);
        if (fenceMatch) {
            if (!inCodeBlock) {
                inCodeBlock = true;
                fenceChar = fenceMatch[1][0];
                fenceLen = fenceMatch[1].length;
            }
            else if (fenceMatch[1][0] === fenceChar && fenceMatch[1].length >= fenceLen && line.trim().match(/^[`~]+$/)) {
                inCodeBlock = false;
            }
        }
        // Only recognize headers when NOT inside a code block
        if (!inCodeBlock) {
            if (line.startsWith('## Thoughts')) {
                finishCurrentTool();
                currentSection = 'thoughts';
                continue;
            }
            if (line.startsWith('## Task List')) {
                finishCurrentTool();
                currentSection = 'taskList';
                continue;
            }
            if (line.startsWith('## Tool Choice')) {
                finishCurrentTool();
                currentSection = 'toolChoice';
                continue;
            }
            if (line.startsWith('## Tool Input')) {
                currentSection = 'toolInput';
                continue;
            }
            if (line.startsWith('## ')) {
                finishCurrentTool();
                currentSection = '';
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
                    if (TOOL_NAMES.includes(trimmed)) {
                        currentTool = trimmed;
                    }
                }
                break;
            case 'toolInput':
                currentInput += (currentInput ? '\n' : '') + line;
                break;
        }
    }
    finishCurrentTool();
    if (tools.length === 0)
        return null;
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
export const extractPath = (input) => {
    const match = input.match(/^"([^"]+)"|^([^\n]+)/);
    return (match?.[1] || match?.[2] || '').trim();
};
export const extractCodeBlock = (input, lang) => {
    // Find opening fence: 3+ backticks or tildes, optional language
    const fencePattern = lang
        ? new RegExp('^([`~]{3,})' + lang + '?\\s*$', 'im')
        : /^([`~]{3,})\w*\s*$/im;
    const fenceMatch = input.match(fencePattern);
    if (!fenceMatch)
        return null;
    const fenceChar = fenceMatch[1][0]; // ` or ~
    const startIdx = fenceMatch.index + fenceMatch[0].length + 1; // +1 for newline
    const remaining = input.slice(startIdx);
    // Find the LAST closing fence (3+ of same char on its own line)
    // This handles nested code blocks - we want the outermost closing fence
    const closePattern = new RegExp(`^${fenceChar}{3,}\\s*$`, 'gm');
    let lastMatch = null;
    let match;
    while ((match = closePattern.exec(remaining)) !== null) {
        lastMatch = match;
    }
    if (!lastMatch)
        return null;
    return remaining.slice(0, lastMatch.index).trimEnd();
};
export const extractFindReplace = (input) => {
    const findMatch = input.match(/```find\n([\s\S]*?)```/i);
    const replaceMatch = input.match(/```replace\n([\s\S]*?)```/i);
    if (!findMatch || !replaceMatch)
        return null;
    return { find: findMatch[1].trimEnd(), replace: replaceMatch[1].trimEnd() };
};
export const extractCommandInput = (input) => {
    const codeBlock = extractCodeBlock(input);
    return codeBlock !== null ? codeBlock : input;
};
