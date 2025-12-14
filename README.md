# dev-md

The name of the project is dev.md - this is because the agent parses markdown for tool calls.

**AI Agent CLI for Development Tasks**

A markdown-native AI agent that automates development tasks through an interactive interface.

![TypeScript](https://img.shields.io/badge/type-script-2c2c2c?style=flat-square)
![CLI](https://img.shields.io/badge/cli-seafoam?style=flat-square)
![Markdown](https://img.shields.io/badge/markdown-native?style=flat-square)

> ⚠️ **Security Note:** dev.md executes commands and modifies files based on AI model output. Only run it in directories you trust. API keys are stored in plain text at `~/.dev-md/config.json`.

## Overview

dev-md is a revolutionary AI-powered development assistant that operates entirely through markdown files. It's designed to help developers automate repetitive tasks, perform complex operations, and manage development workflows using natural language instructions within markdown documents.

The agent works by interpreting markdown files as both instructions and documentation, allowing for seamless integration between human-readable documentation and automated execution.

## Key Features

### Markdown-Native Interface
- All interactions happen through markdown files
- Natural language processing directly in markdown
- Documentation and automation coexist in the same files

### Multi-Tool Execution
- Parallel execution of multiple tools simultaneously
- Intelligent task orchestration based on dependencies
- Comprehensive tool integration system

### Interactive Sessions
- Persistent session management
- Real-time progress tracking
- Interactive feedback loops

### Advanced Capabilities
- Context-aware task execution
- Automated error recovery
- Progress visualization and reporting

## Architecture

### Core Components
- **Agent**: The main AI processing engine that interprets markdown instructions
- **Tools**: Extensible system for file operations, command execution, and more
- **Sessions**: State management for multi-step operations
- **Context**: Dynamic environment information sharing
- **Parser**: Markdown document analysis and instruction extraction

### Supported Tools
- File System Operations (read, write, list, modify)
- Command Execution (cross-platform shell commands)
- Interactive User Communication
- Task Management and Progress Tracking

## Installation

```bash
npm install -g dev-md
```

## Quick Start

1. Create a markdown file with your development task:
```md
# My Development Task

## Steps
1. Create a new project directory
2. Initialize git repository
3. Install dependencies
```

2. Run the agent:
```bash
dev-md my-task.md
```

## Usage Examples

### Basic Task Execution
Create a markdown file with your requirements:
```md
# Setup New Project

This will set up a new Node.js project with TypeScript support.

## Steps
1. Create project directory `my-app`
2. Initialize npm project
3. Install TypeScript and related packages
4. Create basic project structure
```

### Interactive Mode
Run in interactive mode to receive real-time updates:
```bash
dev-md my-task.md --interactive
```

### Session Management
Continue from previous session:
```bash
dev-md my-task.md --resume
```

## Configuration

### Environment Variables
- `DEV_MD_API_KEY` - API key for external services
- `DEV_MD_MODEL` - LLM model to use (default: gpt-4)
- `DEV_MD_LOG_LEVEL` - Logging verbosity level

### Configuration File
Create `.devmdrc` in your project root:
```json
{
  "model": "gpt-4",
  "logLevel": "info",
  "maxRetries": 3
}
```

## Development Workflow

### 1. Define Your Task
Write clear markdown instructions describing what you want to accomplish.

### 2. Execute with dev-md
Run the agent against your markdown file to begin automation.

### 3. Monitor Progress
Watch real-time updates and interact with the agent during execution.

### 4. Review Results
Examine the executed tasks and any generated documentation.

## Security Considerations

- **DANGER: This system has full system access capabilities** - It can read, write, and execute commands on your machine
- Only execute markdown files you completely trust
- Review task lists before execution
- Be cautious with file system operations
- Use appropriate environment variables for sensitive data
- Run in a sandboxed environment or VM for safety

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a pull request

## License

MIT License