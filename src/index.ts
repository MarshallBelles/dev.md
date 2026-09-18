#!/usr/bin/env node
import { program } from 'commander';
import { createRequire } from 'module';
import { loadConfig, runFirstTimeSetup, configExists, openConfigInEditor } from './config/index.js';
import { listSessions, getLastSessionForDir, cleanOldSessions } from './sessions/index.js';
import { createAgent } from './lib/index.js';
import { displayWelcome, displaySessionInfo } from './ui/display.js';
import { c } from './ui/colors.js';
import { EnhancedInput } from './ui/input.js';
import { resolveCommand, COMMANDS } from './ui/commands.js';

const require = createRequire(import.meta.url);
const version = require('../package.json').version;

const cwd = process.cwd();

const ensureConfig = async (): Promise<void> => {
  if (!configExists()) {
    await runFirstTimeSetup();
  }
};

const printResult = (result: Awaited<ReturnType<ReturnType<typeof createAgent>['run']>>): number => {
  if (result.type === 'error') {
    console.log(c.red(`\n  Error: ${result.error.message}\n`));
    return 1;
  }
  if (result.type === 'aborted') {
    console.log(c.yellow('\n  Aborted.\n'));
  }
  // done / maxLoopsReached / idle are surfaced by the engine itself.
  return 0;
};

// Prints the session id when a run begins, mirroring the former displaySessionInfo.
const announceSession = (agent: ReturnType<typeof createAgent>) => {
  agent.events.once('start', ({ sessionId }: { sessionId: string }) => {
    displaySessionInfo(sessionId);
  });
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
  .option('-y, --yolo', 'Disable the command guard: turn off the safety classifier and auto-approve every command (trust mode)')
  .action(async (opts) => {
    await ensureConfig();
    cleanOldSessions();

    // The safety classifier is ON by default: gray-area commands are judged by
    // the LLM and the agent keeps working after a decline. The classifier can be
    // disabled in the config file (commandClassifierEnabled: false); --yolo opts
    // all the way out and turns the whole guard off (auto-approve every command).
    const config = opts.yolo ? { ...loadConfig(), commandGuardEnabled: false } : loadConfig();
    const verbose = opts.quiet ? false : (opts.verbose ?? !!opts.prompt);

    // Interactive mode: no prompt/resume/session -> drive the agent through a REPL.
    if (!opts.prompt && !opts.resume && !opts.session) {
      const agent = createAgent({ config, verbose, thinking: opts.think, cwd });
      announceSession(agent);
      await agent.run(); // warmup: create the session (no model run until input)
      displayWelcome();
      await interactiveLoop(agent, config, verbose, opts.think);
      return;
    }

    const agent = createAgent({ config, verbose, thinking: opts.think, cwd });
    announceSession(agent);

    let result;
    if (opts.session) {
      result = await agent.resume(opts.session);
    } else if (opts.resume) {
      const last = getLastSessionForDir(cwd);
      if (!last) {
        console.log(c.red('  No previous session found in this directory\n'));
        process.exit(1);
      }
      result = await agent.resume(last.id);
    } else {
      result = await agent.run({ prompt: opts.prompt, automated: true });
    }
    process.exit(printResult(result));
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

// Interactive REPL. The agent is driven through createAgent: the first run()
// warms up (creates the session without running), then each user turn is fed
// via inject() and re-run. 'new' and 'think' recreate the agent so new settings
// take effect while keeping the current conversation.
async function interactiveLoop(initialAgent: ReturnType<typeof createAgent>, config: ReturnType<typeof loadConfig>, verbose: boolean, initialThinking: boolean | undefined) {
  let thinking = initialThinking ?? false;
  let { cwd: cwdLocal } = initialAgent;

  const makeAgent = () => createAgent({ config, verbose, thinking, cwd: cwdLocal });

  let agent = initialAgent;
  announceSession(agent);

  const input = new EnhancedInput({ cwd: cwdLocal });
  input.showHelp();
  console.log(c.dim('  Type your request, or "exit" to quit'));

  while (true) {
    const text = await input.getInput();
    if (!text) continue;

    const command = resolveCommand(text);
    if (command) {
      if (command.name === 'exit') {
        agent.stop();
        console.log(c.dim('\n  Goodbye!\n'));
        input.close();
        break;
      }
      if (command.name === 'new') {
        agent = makeAgent();
        await agent.run();
        continue;
      }
      if (command.name === 'help') {
        input.showHelp();
        continue;
      }
      if (command.name === 'think') {
        thinking = !thinking;
        agent = makeAgent();
        await agent.run();
        console.log(`  ${c.yellow('Thinking mode:')} ${thinking ? c.green('ON') : c.red('OFF')}\n`);
        continue;
      }
      if (command.name === 'config') {
        openConfigInEditor();
        console.log(c.dim('  Opened config in your editor\n'));
        continue;
      }
      if (command.name === 'sessions') {
        const all = listSessions().filter(s => s.workingDirectory === cwdLocal);
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
        console.log(c.dim(`  Session: ${agent.sessionId}\n`));
        console.log(`  ${c.dim('Thinking mode:')} ${thinking ? c.green('ON') : c.red('OFF')}\n`);
        continue;
      }
    }

    if (text.trim().startsWith('/')) {
      console.log(c.yellow(`  Unknown command: ${text.trim()}`));
      console.log(c.dim(`  Available: ${COMMANDS.map(cm => '/' + cm.name).join(', ')}\n`));
      continue;
    }

    agent.inject('user', text);
    await agent.run();
    console.log(c.dim('\n  Continue chatting, "new" for new session, "exit" to quit.\n'));
  }
}

program.parse();
