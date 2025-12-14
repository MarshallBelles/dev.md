import { createServer, IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';

export interface MockResponse {
  thoughts: string;
  taskList: string[];
  toolChoice: string;
  toolInput: string;
}

export const formatAgentResponse = (r: MockResponse): string => {
  const tasks = r.taskList.map((t, i) => {
    const status = t.startsWith('[') ? '' : i === 0 ? '[~] ' : '[ ] ';
    return status + t;
  }).join('\n');
  return `# Agent Response

## Thoughts
${r.thoughts}

## Task List
${tasks}

## Tool Choice
${r.toolChoice}

## Tool Input
${r.toolInput}`;
};

export const streamSSE = (res: ServerResponse, content: string, delayMs = 5): Promise<void> => {
  return new Promise(resolve => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const tokens = content.split('');
    let i = 0;
    const send = () => {
      if (i < tokens.length) {
        const chunk = { choices: [{ delta: { content: tokens[i] } }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        i++;
        setTimeout(send, delayMs);
      } else {
        res.write('data: [DONE]\n\n');
        res.end();
        resolve();
      }
    };
    send();
  });
};

type ResponseGenerator = (messages: any[], requestNum: number) => MockResponse | string | null;

export class MockAPIServer extends EventEmitter {
  private server: ReturnType<typeof createServer> | null = null;
  private responseGenerator: ResponseGenerator;
  private requestCount = 0;
  public port = 18765;
  public requests: any[][] = [];

  constructor(generator: ResponseGenerator) {
    super();
    this.responseGenerator = generator;
  }

  setGenerator(gen: ResponseGenerator) {
    this.responseGenerator = gen;
    this.requestCount = 0;
    this.requests = [];
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', async () => {
            try {
              const parsed = JSON.parse(body);
              this.requests.push(parsed.messages);
              this.requestCount++;
              const response = this.responseGenerator(parsed.messages, this.requestCount);
              if (response === null) {
                res.writeHead(500);
                res.end('No response configured');
                return;
              }
              const content = typeof response === 'string' ? response : formatAgentResponse(response);
              await streamSSE(res, content, 1);
              this.emit('request', parsed.messages, this.requestCount);
            } catch (e) {
              res.writeHead(400);
              res.end(String(e));
            }
          });
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      this.server.listen(this.port, () => resolve());
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise(resolve => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  reset() {
    this.requestCount = 0;
    this.requests = [];
  }
}

export const createScriptedServer = (responses: (MockResponse | string)[]): MockAPIServer => {
  let idx = 0;
  return new MockAPIServer(() => {
    if (idx >= responses.length) return responses[responses.length - 1];
    return responses[idx++];
  });
};

export const doneResponse = (summary: string): MockResponse => ({
  thoughts: 'Task completed successfully.',
  taskList: ['[x] Complete task'],
  toolChoice: 'DONE',
  toolInput: summary,
});

export const auditPassResponse = (): string => `Based on my review:

| Check | Status | Notes |
|-------|--------|-------|
| Task completed | PASS | All requirements met |

Overall: PASS
Feedback: Work completed successfully.`;
