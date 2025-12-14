import * as readline from 'readline';
import { c } from '../ui/colors.js';

export const askUser = async (question: string, automated: boolean): Promise<string> => {
  if (automated) return 'ERROR: ASK_USER is disabled in automated mode (-p)';
  console.log('\n' + c.cyan('Agent is asking:') + '\n' + c.white(question) + '\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(c.dim('Your response: '), answer => {
      rl.close();
      resolve(answer || '(no response)');
    });
  });
};

export const updateTaskList = (): string => 'Task list updated';

export const done = (summary: string): string => summary || 'No summary provided';
