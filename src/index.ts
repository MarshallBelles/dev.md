#!/usr/bin/env node
import { program } from 'commander';
import { loadConfig, openConfigInEditor, configExists, runFirstTimeSetup } from './config/index.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import {
  createSession, loadSession, getLastSessionForDir, listSessions, cleanOldSessions, saveSession
} from './sessions/index.js';
import { runAgentLoop } from './agent/loop.js';
import { displayWelcome, displaySessionInfo, setVerboseMode } from './ui/display.js';
import { c } from './ui/colors.js';
import { EnhancedInput } from './ui/input.js';
import { setThinking, toggleThinking, isThinkingEnabled } from './ui/thinking.js';
import { resolveCommand, COMMANDS } from './ui/commands.js';

const cwd = process.cwd();

const ensureConfig = async (): Promise<void> => {
  if (!configExists()) {
    await runFirstTimeSetup();
  }
};

program
  .name('dev')
  .description('AI agent for development tasks')
  .version(version);

program
  .option('-p, --prompt <text>', 'Run with a prompt in automated mode')
  .option('-v, --verbose', 'Show full tool outputs and audit details')
  .option('-q, --quiet', 'Compact output (less verbose)')
  .option('-t, --think', 'Enable thinking/reflection mode for deeper reasoning')
  .option('--resume', 'Resume the last session in this directory')
  .option('--session <uuid>', 'Resume a specific session by UUID')
  .action(async (opts) => {
    await ensureConfig();
    cleanOldSessions();
    // Quiet overrides verbose, automated defaults to verbose, interactive defaults to compact
    const verbose = opts.quiet ? false : (opts.verbose ?? !!opts.prompt);
    setVerboseMode(verbose);
    if (opts.think) setThinking(true);
    displayWelcome();

    let session;
    const automated = !!opts.prompt;

    if (opts.session) {
      session = loadSession(opts.session);
      if (!session) {
        console.log(c.red(`  Session not found: ${opts.session}\n`));
        process.exit(1);
      }
      displaySessionInfo(session.id, true);
    } else if (opts.resume) {
      session = getLastSessionForDir(cwd);
      if (!session) {
        console.log(c.red('  No previous session found in this directory\n'));
        process.exit(1);
      }
      displaySessionInfo(session.id, true);
    } else if (opts.prompt) {
      session = createSession(cwd, opts.prompt);
      displaySessionInfo(session.id);
    } else {
      session = createSession(cwd, '');
      displaySessionInfo(session.id);
      await interactiveMode(session);
      return;
    }

    if (opts.prompt && !opts.resume && !opts.session) {
      session.originalPrompt = opts.prompt;
      session.history.push({ role: 'user', content: opts.prompt });
      saveSession(session);
    }

    try {
      await runAgentLoop(session, { automated });
    } catch (e) {
      console.log(c.red(`\n  Error: ${(e as Error).message}\n`));
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Open config file in default editor')
  .action(() => {
    openConfigInEditor();
    console.log(c.dim('  Opening config in editor...\n'));
  });

program
  .command('setup')
  .description('Run the configuration setup wizard')
  .action(async () => {
    await runFirstTimeSetup();
  });

program
  .command('sessions')
  .description('List all sessions')
  .argument('[action]', 'Action: list')
  .action((action) => {
    if (action === 'list' || !action) {
      const sessions = listSessions();
      if (!sessions.length) {
        console.log(c.dim('  No sessions found\n'));
        return;
      }
      console.log(c.bold('\n  Sessions:\n'));
      for (const s of sessions.slice(0, 20)) {
        const date = new Date(s.updatedAt).toLocaleString();
        const prompt = s.originalPrompt.slice(0, 50) + (s.originalPrompt.length > 50 ? '...' : '');
        console.log(`  ${c.cyan(s.id.slice(0, 8))} ${c.dim(date)}`);
        console.log(`    ${prompt}\n`);
      }
    }
  });

async function interactiveMode(session: ReturnType<typeof createSession>) {
  const input = new EnhancedInput({ cwd });

  console.log(c.dim('  Type your request, or "exit" to quit'));
  input.showHelp();

  while (true) {
    const text = await input.getInput();
    if (!text) continue;

    // Slash commands (and the bare legacy forms: exit/quit/new/help/?).
    const command = resolveCommand(text);
    if (command) {
      if (command.name === 'exit') {
        console.log(c.dim('\n  Goodbye!\n'));
        input.close();
        break;
      }
      if (command.name === 'new') {
        session = createSession(cwd, '');
        displaySessionInfo(session.id);
        console.log(c.dim('  Started new session\n'));
        continue;
      }
      if (command.name === 'help') {
        input.showHelp();
        continue;
      }
      if (command.name === 'think') {
        toggleThinking();
        console.log(`  ${c.yellow('Thinking mode:')} ${isThinkingEnabled() ? c.green('ON') : c.red('OFF')}\n`);
        continue;
      }
      if (command.name === 'config') {
        openConfigInEditor();
        console.log(c.dim('  Opened config in your editor\n'));
        continue;
      }
      if (command.name === 'sessions') {
        // listSessions() returns every session; narrow to this directory.
        const all = listSessions().filter(s => s.workingDirectory === cwd);
        if (!all.length) console.log(c.dim('  No sessions yet\n'));
        else {
          console.log('');
          for (const s of all.slice(0, 10)) {
            console.log(`  ${c.dim(s.id.slice(0, 8))}  ${s.updatedAt.slice(0, 19).replace('T', ' ')}  ${c.dim((s.originalPrompt || '(no prompt)').slice(0, 50))}`);
          }
          console.log('');
        }
        continue;
      }
      if (command.name === 'status') {
        displaySessionInfo(session.id);
        console.log(`  ${c.dim('Tokens this session:')} ${session.totalTokens.toLocaleString()}`);
        console.log(`  ${c.dim('Compactions:')} ${session.compressions.length}`);
        console.log(`  ${c.dim('Thinking mode:')} ${isThinkingEnabled() ? 'ON' : 'OFF'}\n`);
        continue;
      }
    }

    // An unrecognised slash command is a typo, not a prompt - saying so beats
    // silently sending "/exti" to the model as a task.
    if (text.trim().startsWith('/')) {
      console.log(c.yellow(`  Unknown command: ${text.trim()}`));
      console.log(c.dim(`  Available: ${COMMANDS.map(cm => '/' + cm.name).join(', ')}\n`));
      continue;
    }

    if (!session.originalPrompt) session.originalPrompt = text;
    session.history.push({ role: 'user', content: text });
    saveSession(session);

    try {
      await runAgentLoop(session, { automated: false });
    } catch (e) {
      console.log(c.red(`\n  Error: ${(e as Error).message}\n`));
    }
    console.log(c.dim('\n  Continue chatting, "new" for new session, "exit" to quit.\n'));
  }
}

program.parse();
