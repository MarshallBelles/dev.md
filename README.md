# dev-md

A markdown-native AI agent that uses markdown formatting for tool calls. Works with any OpenAI-compatible API. Use it as a CLI, or embed and extend the same agent core in your own app.

## Use it as a library

dev-md ships a small, well-typed agent core you can embed directly in a Node.js app, or import from `dev-md/lib` when the package is installed as a dependency:

```js
import { createAgent } from 'dev-md/lib';

const agent = createAgent({
  config: {
    apiUrl: 'http://carrier.local:8007/v1', // any OpenAI-compatible endpoint
    apiKey: 'your-api-key',
    model: 'mars',
  },
});

// React to tool calls as they happen (optional)
agent.events.on('tool', ({ tool, input }) => console.log('chosen:', tool, input));

// Run a one-shot prompt and get back a structured result
const result = await agent.run({ prompt: 'Create a file hello.txt containing "Hello, world!"' });
console.log('status:', result.status);

// Or drive an interactive session and stop it when you're done
const session = createAgent({ config: { apiUrl: '...', model: 'mars' } });
await session.run({ prompt: 'Debug why the login endpoint returns 500' });
session.stop();
```

`createAgent` returns an `Agent` with `.run()` / `.resume(sessionId)`, an `EventEmitter` (`tool`, `message`, `error`, `done`, `step`, `token` events), an `AbortSignal` to cancel mid-flight, and a pluggable `sink` (console or a capture buffer). The full `AgentOptions` surface (`sink`, `store`, `answer`, `onToolCall`, `onDelegate`, `thinking`, `automated`, …) lives in `src/lib`. The same core also powers the `dev` CLI, so an embedded agent behaves exactly like the command-line version.

## Safety

Every command the agent runs is judged before it executes. dev-md keeps a tiny denylist for commands that would irreversibly tank a system (fork bombs, filesystem formatting, raw block-device writes, piping a downloaded script straight into a shell), and a cheap risk heuristic that hard-blocks anything carrying a very high-confidence catastrophic signal. Gray-area commands — `sudo`, `chmod`, `git push --force`, scoped `rm`/`mv`, credential access, and obfuscated variants of the above — are handed to an LLM **safety classifier**. The classifier reads the command and decides approve or decline; on a decline it tells the agent to try a different tool or approach (it never freezes the session waiting for a human), then the agent keeps working. The classifier can be turned off entirely with the CLI's `--yolo` flag, which disables the guard and auto-approves every command.

## Key Features

### Markdown Tool Format
The agent's responses use markdown structure for tool calls, parsed by the CLI:
```markdown
## Tool Choice
WRITE_FILE

## Tool Input
"src/index.js"

```js
console.log('hello');
```
```

### Available Tools
- `LIST_DIRECTORY` - List files (supports glob patterns)
- `READ_FILE` - Read file contents
- `WRITE_FILE` - Create/overwrite files
- `FIND_AND_REPLACE_IN_FILE` - Edit files with find/replace blocks
- `COMMAND` - Execute shell commands
- `ASK_USER` - Request user input (interactive mode only)
- `DONE` - Complete task and trigger audit

### Session Management
- Sessions persist to disk with full conversation history
- Resume previous sessions with `--resume` or `--session <uuid>`
- Sessions track task lists, token usage, and working directory

### Audit System
When the agent calls `DONE`, an audit agent verifies the work was completed correctly before marking the session complete. Failed audits return feedback to the main agent.

### Thinking Mode
Optional reflection step (`--think`) where the agent reasons about tool results before continuing. Helps with complex multi-step debugging tasks.

## Installation

```bash
npm install -g dev-md
```

## Setup

Run the setup wizard to configure your API endpoint:
```bash
dev setup
```

This writes a config file to a platform-specific location:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/dev-agent/config.json` |
| Linux | `~/.dev-agent/config.json` |
| Windows | `%APPDATA%\dev-agent\config.json` |

```json
{
  "apiUrl": "http://localhost:8000/v1",
  "apiKey": "your-api-key",
  "model": "gpt-4",
  "commandTimeout": 30,
  "maxRetries": 3,
  "maxLoops": 1000,
  "sessionRetentionDays": 30
}
```

Works with any OpenAI-compatible API (OpenAI, Anthropic via proxy, vLLM, ollama, etc).

### Context Length

`maxContextTokens` is optional and normally omitted. When it is absent, dev.md
resolves the context window in this order:

1. **The config value**, if you set one explicitly.
2. **`max_model_len` from `GET /v1/models`**, if the server publishes it. This is a
   vLLM extension — the OpenAI spec only requires a model to report
   `id`, `object`, `created`, and `owned_by`, so many servers won't have it.
3. **131072**, as a fallback.

Detection is best-effort and cached per endpoint+model for the life of the process;
an unreachable server or a missing `/models` route falls through to the fallback
rather than failing the run.

Set the value explicitly only when you need to override the server — for example to
cap memory use on a long-context model. Note that it is a **total** budget covering
prompt *and* completion, so setting it higher than the server's real limit will
cause requests to be rejected once a session grows.

## Usage

### Automated Mode
Run a single prompt non-interactively:
```bash
dev -p "Create a Node.js Express server with user routes"
```

### Interactive Mode
Start an interactive session:
```bash
dev
```

### Options
```
-p, --prompt <text>   Run with a prompt (automated mode)
-v, --verbose         Show full tool outputs and audit details
-q, --quiet           Compact output
-t, --think           Enable thinking/reflection mode
--resume              Resume last session in this directory
--session <uuid>      Resume a specific session
-y, --yolo            Disable the safety guard and auto-approve every command (trust mode)
```

By default the safety classifier is **on**: gray-area commands are judged by the LLM and the agent keeps working after a decline. Pass `-y`/`--yolo` to turn the guard off entirely (no classifier, denylist, or risk backstop) and auto-approve every command — only use this where you fully trust the environment.

### Session Commands
```bash
dev sessions list     # List all sessions
dev config            # Open config in editor
```

## License

MIT