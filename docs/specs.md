# dev.md Specification

> A markdown-native AI agent CLI for development tasks

## Overview

dev.md is a Node.js CLI tool that interfaces with OpenAI-compatible API endpoints to provide an AI agent capable of performing development tasks. The agent communicates through a structured markdown response format, which is parsed to extract tool calls and execute them.

---

## Core Concepts

### Markdown Response Format

The agent is instructed to format responses as follows:

```markdown
# Agent Response

## Thoughts
[Agent's observations and reasoning about the current state]

## Task List
[~] In-progress task
[x] Completed task
[ ] Pending task

## Tool Choice
TOOL_NAME

## Tool Input
[Tool-specific parameters - format varies by tool]
```

### Parsing Strategy

1. **Stream to completion** - Buffer the full response while displaying a token counter
2. **Find last occurrence** - Locate the final `# Agent Response` header (thinking models may output multiple drafts)
3. **Parse only the final template** - Extract Thoughts, Task List, Tool Choice, and Tool Input
4. **Store minimal history** - Only the parsed template is added to conversation history, not reasoning/thinking content

---

## CLI Interface

### Commands

```bash
# Interactive mode
dev

# Automated mode (single prompt)
dev -p "Your prompt here"

# Resume last session in current directory
dev --resume

# Use specific session (for automation tools like n8n)
dev --session <uuid>

# List sessions
dev sessions list

# Open config in default editor
dev config
```

### Flags

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | Run in automated mode with given prompt |
| `--resume` | Resume the last session used in current directory |
| `--session <uuid>` | Use/resume a specific session by UUID |

### Behavioral Differences: Interactive vs Automated (`-p`)

| Behavior | Interactive | Automated (`-p`) |
|----------|-------------|------------------|
| ASK_USER tool | Enabled | Disabled |
| Max retries on parse/tool error | 3 | 10 |

---

## Tools

### Available Tools

| Tool | Description | Input Format |
|------|-------------|--------------|
| `LIST_DIRECTORY` | List files/directories, supports globs | Path or glob pattern |
| `READ_FILE` | Read file contents | File path |
| `WRITE_FILE` | Create/overwrite a file | Path + code block |
| `FIND_AND_REPLACE_IN_FILE` | Find and replace text in a file | Path + find block + replace block |
| `COMMAND` | Execute shell command | Raw text or code block |
| `UPDATE_TASK_LIST` | Signal task list update (no input required) | Optional/empty |
| `ASK_USER` | Ask the user a question (interactive only) | Question text |
| `DONE` | Signal completion, triggers audit | Summary text |
| `READ_BACKGROUND_PROCESS` | Read output from backgrounded process | Process ID |
| `LIST_BACKGROUND_PROCESSES` | List all background processes | None |
| `KILL_BACKGROUND_PROCESS` | Terminate a background process | Process ID |

### Tool Input Formats

#### LIST_DIRECTORY
```markdown
## Tool Input
"C:\path\to\directory"
```
Or with glob:
```markdown
## Tool Input
"src/**/*.ts"
```
Returns a tree view of matching files.

#### READ_FILE
```markdown
## Tool Input
"C:\path\to\file.ts"
```

#### WRITE_FILE
```markdown
## Tool Input
"C:\path\to\file.ts"

```ts
// file contents here
```
```

#### FIND_AND_REPLACE_IN_FILE
```markdown
## Tool Input
"C:\path\to\file.ts"

```find
const oldValue =
```

```replace
const newValue =
```
```

#### COMMAND
Raw format (everything below `## Tool Input` is the command):
```markdown
## Tool Input
npm install commander
```

Or with code block:
```markdown
## Tool Input
```bash
npm install commander && npm run build
```
```

#### ASK_USER
```markdown
## Tool Input
What authentication method would you prefer: JWT or session-based?
```

#### DONE
```markdown
## Tool Input
Completed refactoring the auth module:
- Migrated from sessions to JWT
- Added refresh token support
- Updated all route handlers
- All tests passing
```

#### READ_BACKGROUND_PROCESS
```markdown
## Tool Input
proc_abc123
```

#### KILL_BACKGROUND_PROCESS
```markdown
## Tool Input
proc_abc123
```

---

## Agent Loop

```
┌─────────────────────────────────────────────────────────────┐
│                      USER PROMPT                            │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   AGENT RESPONSE                            │
│  - Stream response, display token counter                   │
│  - On completion, parse final # Agent Response block        │
│  - Display: Thoughts → Tool → Result                        │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   TOOL EXECUTION                            │
│  - Execute selected tool with parsed input                  │
│  - Capture result or error                                  │
└─────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
        ┌───────────┐                ┌─────────────┐
        │  Success  │                │    Error    │
        └───────────┘                └─────────────┘
              │                             │
              │                             ▼
              │                  ┌────────────────────┐
              │                  │ Retry (max 3 or 10)│
              │                  │ with error context │
              │                  └────────────────────┘
              │                             │
              ▼                             │
┌─────────────────────────────────────────────────────────────┐
│                TOOL = DONE?                                 │
└─────────────────────────────────────────────────────────────┘
              │
       ┌──────┴──────┐
       │ No          │ Yes
       ▼             ▼
   [Continue]   ┌─────────────────────────────────────────────┐
       │        │              AUDIT AGENT                    │
       │        │  - Independent review                       │
       │        │  - Read-only tools available                │
       │        │  - Compare work vs original prompt          │
       │        │  - Check task list completion               │
       │        └─────────────────────────────────────────────┘
       │                          │
       │               ┌──────────┴──────────┐
       │               │ Pass               │ Fail
       │               ▼                     ▼
       │        ┌────────────┐      ┌────────────────┐
       │        │ SESSION    │      │ Return feedback│
       │        │ COMPLETE   │      │ to worker agent│
       │        └────────────┘      └────────────────┘
       │                                    │
       └────────────────────────────────────┘
```

### Loop Constraints

- **Max loops**: 1000 (prevents infinite execution)
- **Command timeout**: Configurable (default 30s), commands exceeding timeout are backgrounded
- **Parse/tool error retries**: 3 (interactive) / 10 (automated)

---

## Context Compression

When conversation history approaches the configured `maxContextTokens` limit, automatic compression is triggered to prevent context overflow while preserving essential information.

### Trigger Condition

Before each API call, estimate total tokens:
- If `estimatedTokens >= maxContextTokens`, trigger compression
- Default `maxContextTokens`: 131072

### Compression Process

```
┌─────────────────────────────────────────────────────────────┐
│              CONTEXT LIMIT REACHED                          │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│              SUMMARIZATION REQUEST                          │
│  Send current history to model with summarization prompt    │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│              COMPRESSED HISTORY                             │
│  Replace history with:                                      │
│  1. System prompt (unchanged)                               │
│  2. Summary message (new)                                   │
│  3. Original user prompt (preserved)                        │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│              CONTINUE LOOP                                  │
│  Agent continues with compressed context                    │
└─────────────────────────────────────────────────────────────┘
```

### Summarization Prompt

```markdown
You are a context compression assistant. Your task is to create a comprehensive summary of the conversation and work completed so far. This summary will replace the full conversation history to free up context space.

## Requirements

Create a summary that captures:

### 1. Original Request
What did the user originally ask for? Preserve exact requirements and acceptance criteria.

### 2. Work Completed
- Files created or modified (with paths)
- Key code changes made
- Commands executed and their outcomes
- Decisions made and rationale

### 3. Current State
- What is the current task list status?
- What was the agent working on when compression triggered?
- Are there any pending operations or errors to address?

### 4. Critical Context
- Important file contents or structures discovered
- Dependencies or constraints identified
- Any blockers or issues encountered

### 5. Next Steps
What should the agent do next to continue the work?

## Format

Structure your summary as a clear, dense narrative. Prioritize information needed to continue the work effectively. Omit pleasantries, redundant information, and failed attempts that don't inform future work.

## Conversation to Summarize

<conversation>
{full_history}
</conversation>
```

### Post-Compression History Structure

```json
{
  "messages": [
    {
      "role": "system",
      "content": "[original system prompt]"
    },
    {
      "role": "user",
      "content": "[CONTEXT SUMMARY]\n\n{compression_summary}\n\n[ORIGINAL REQUEST]\n\n{original_user_prompt}"
    }
  ]
}
```

### Token Estimation

Use a simple heuristic for estimation (avoid external tokenizer dependency):
- Approximate 4 characters per token (English text average)
- Or integrate `tiktoken` / `gpt-tokenizer` for accuracy if needed

### Session Tracking

When compression occurs:
- Log compression event with timestamp
- Store both pre-compression token count and post-compression count
- Increment `compressionCount` in session metadata

```json
{
  "compressions": [
    {
      "timestamp": "2025-01-15T11:30:00Z",
      "tokensBefore": 128000,
      "tokensAfter": 8500
    }
  ]
}
```

---

## Audit Agent

The audit agent is invoked when the worker agent uses the `DONE` tool.

### Purpose
Independently verify that the work completed matches the original request.

### Context Provided
- Original user prompt
- Final task list state
- DONE summary provided by worker agent

### Available Tools (Read-Only)
- `READ_FILE` - Verify file contents
- `LIST_DIRECTORY` - Check file structure
- `COMMAND` (restricted subset):
  - `cat`, `head`, `tail`
  - `ls`, `dir`, `tree`
  - `git status`, `git diff`, `git log`
  - `npm test`, `npm run build` (verification commands)

### Response Format
For simple tasks: Prose feedback
For complex tasks: Structured pass/fail table

```markdown
| Check | Status | Notes |
|-------|--------|-------|
| File created | PASS | src/auth.ts exists |
| JWT implemented | PASS | Using jsonwebtoken |
| Tests passing | FAIL | 2 tests failing in auth.spec.ts |

Overall: FAIL
Feedback: Tests are failing. Please fix the failing tests in auth.spec.ts before completing.
```

### Audit Outcome
- **PASS**: Session marked complete
- **FAIL**: Feedback returned to worker agent as tool result, loop continues

---

## Background Processes

When a `COMMAND` exceeds the configured timeout:

1. Process is backgrounded automatically
2. Unique process ID assigned (e.g., `proc_abc123`)
3. Agent notified: "Command backgrounded as proc_abc123"
4. Agent can use:
   - `READ_BACKGROUND_PROCESS` - Check output/status
   - `LIST_BACKGROUND_PROCESSES` - See all running
   - `KILL_BACKGROUND_PROCESS` - Terminate if needed

---

## Configuration

### Location
- **Windows**: `%APPDATA%\dev-agent\config.json`
- **macOS**: `~/Library/Application Support/dev-agent/config.json`
- **Linux**: `~/.dev-agent/config.json`

### Default Configuration
```json
{
  "apiUrl": "http://localhost:8005/v1",
  "apiKey": "",
  "model": "devstral-small-2507",
  "maxContextTokens": 131072,
  "commandTimeout": 30,
  "maxRetries": 3,
  "maxRetriesAutomated": 10,
  "maxLoops": 1000,
  "sessionRetentionDays": 30
}
```

### Config Command
```bash
dev config
```
Opens config.json in the system default editor.

---

## Session Management

### Storage Location
Same directory as config:
- **Windows**: `%APPDATA%\dev-agent\sessions\`
- **macOS**: `~/Library/Application Support/dev-agent/sessions\`
- **Linux**: `~/.dev-agent\sessions\`

### Session Format
Individual JSON files per session: `<uuid>.json`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "createdAt": "2025-01-15T10:30:00Z",
  "updatedAt": "2025-01-15T11:45:00Z",
  "workingDirectory": "C:\\Users\\Belle\\projects\\my-app",
  "originalPrompt": "Add JWT authentication",
  "taskList": [
    { "status": "complete", "text": "Install jsonwebtoken" },
    { "status": "complete", "text": "Create auth middleware" },
    { "status": "in-progress", "text": "Add refresh tokens" }
  ],
  "history": [
    {
      "role": "user",
      "content": "Add JWT authentication"
    },
    {
      "role": "assistant",
      "content": "# Agent Response\n\n## Thoughts\n..."
    }
  ],
  "totalTokens": 15420
}
```

### Directory-Session Tracking
Track last used session per directory for `--resume`:
- Store in `sessions/directory-map.json`

### Retention
- Sessions older than 30 days automatically cleaned up on CLI start

---

## Terminal UX

### Streaming Display
While response is streaming:
```
⠋ Thinking... [1,247 tokens]
```
Spinner animation with live token count.

### Response Display
After parsing, display sequentially:

```
┌─ Thoughts ────────────────────────────────────────────────┐
│ The user wants to add authentication. I'll start by      │
│ examining the current project structure to understand    │
│ where auth logic should live.                            │
└───────────────────────────────────────────────────────────┘

┌─ Task List ───────────────────────────────────────────────┐
│ [~] Examine project structure                            │
│ [ ] Install dependencies                                 │
│ [ ] Create auth middleware                               │
└───────────────────────────────────────────────────────────┘

┌─ Tool: LIST_DIRECTORY ────────────────────────────────────┐
│ "src/**/*.ts"                                            │
└───────────────────────────────────────────────────────────┘

┌─ Result ──────────────────────────────────────────────────┐
│ src/                                                     │
│ ├── index.ts                                             │
│ ├── routes/                                              │
│ │   ├── users.ts                                         │
│ │   └── posts.ts                                         │
│ └── middleware/                                          │
│     └── logger.ts                                        │
└───────────────────────────────────────────────────────────┘
```

### Colors (via chalk or similar)
- **Thoughts**: Dim/gray text
- **Task List**: Cyan header, status-colored items
- **Tool name**: Bold yellow
- **Results**: Default/white
- **Errors**: Red
- **Success**: Green

---

## Security Considerations

### Prompt Injection
- **Mitigation**: Comprehensive session logging for post-hoc detection
- **Design**: Clear system prompt boundaries with XML-tagged user content
- **Reality**: Cannot fully prevent during execution; logging enables investigation

### Exfiltration
- **Accepted Risk**: Agent has network access; sandboxed environment assumed
- **Mitigation**: Run in Docker container with network restrictions if needed

### Infinite Loops
- **Mitigation**: Max 1000 loop iterations hard limit

### Command Execution
- **Full shell access**: By design (sandboxed environment assumed)
- **Timeout protection**: Commands backgrounded after timeout
- **Logging**: All commands logged for audit trail

### Recommended Deployment
Run dev.md inside a Docker container or VM sandbox where:
- File system access is isolated to project directory
- Network access can be restricted if needed
- Damage from any malicious action is contained

---

## Project Structure

```
dev.md/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── agent/
│   │   ├── loop.ts           # Main agent loop
│   │   ├── prompt.ts         # System prompts
│   │   ├── audit.ts          # Audit agent
│   │   └── compress.ts       # Context compression
│   ├── parser/
│   │   └── markdown.ts       # Response parsing
│   ├── tools/
│   │   ├── index.ts          # Tool registry
│   │   ├── filesystem.ts     # LIST_DIRECTORY, READ_FILE, WRITE_FILE, FIND_AND_REPLACE
│   │   ├── command.ts        # COMMAND, background process management
│   │   └── interaction.ts    # ASK_USER, UPDATE_TASK_LIST, DONE
│   ├── ui/
│   │   ├── spinner.ts        # Streaming animation
│   │   ├── display.ts        # Response formatting
│   │   └── colors.ts         # Color definitions
│   ├── config/
│   │   └── index.ts          # Config management
│   └── sessions/
│       └── index.ts          # Session CRUD
├── docs/
│   └── specs.md              # This document
├── package.json
├── tsconfig.json
└── README.md
```

### Design Principle
**Logic-dense, minimal code**: Prefer concise implementations that accomplish goals in as few lines as possible while maintaining readability.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `commander` | CLI framework |
| `node-fetch` | HTTP client for API calls |
| `chalk` | Terminal colors |
| `ora` | Spinner animations |
| `glob` | File pattern matching |
| `uuid` | Session ID generation |

---

## API Integration

### OpenAI-Compatible Endpoint
```typescript
POST {apiUrl}/chat/completions
{
  "model": "devstral-small-2507",
  "messages": [...],
  "stream": true
}
```

### Streaming
- Use Server-Sent Events (SSE) streaming
- Accumulate tokens while displaying counter
- Parse on stream completion

---

## Future Considerations

(Not in initial scope, but worth noting)

- [ ] Multiple model profiles (switch between local/cloud)
- [ ] Plugin system for custom tools
- [ ] Web UI dashboard for session browsing
- [ ] Team/shared session support
- [ ] Cost tracking per session
