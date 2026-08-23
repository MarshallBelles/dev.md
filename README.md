# dev-md

A CLI agent that uses markdown formatting for tool calls. Works with any OpenAI-compatible API.

> ⚠️ **Security Note:** dev.md executes commands and modifies files based on AI model output. Only run it in directories you trust. Config stored at `~/.dev-md/config.json`.

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
```

### Session Commands
```bash
dev sessions list     # List all sessions
dev config            # Open config in editor
```

## Security Considerations

- **Full system access**: The agent can read, write, and execute commands on your machine
- Only run in directories you trust
- Review the agent's task list before it executes
- API keys are stored in plain text in `~/.dev-md/config.json`
- Consider running in a container or VM for untrusted tasks

## License

MIT