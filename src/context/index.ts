import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

export interface ProjectContext {
  type: string;
  name: string;
  description: string;
  structure: string;
  customContext: string;
}

interface ProjectFile {
  file: string;
  type: string;
  getInfo: (content: string) => { name?: string; description?: string };
}

const PROJECT_FILES: ProjectFile[] = [
  {
    file: 'package.json',
    type: 'Node.js/TypeScript',
    getInfo: (content) => {
      try {
        const pkg = JSON.parse(content);
        return { name: pkg.name, description: pkg.description };
      } catch { return {}; }
    }
  },
  {
    file: 'Cargo.toml',
    type: 'Rust',
    getInfo: (content) => {
      const name = content.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
      const desc = content.match(/^description\s*=\s*"([^"]+)"/m)?.[1];
      return { name, description: desc };
    }
  },
  {
    file: 'go.mod',
    type: 'Go',
    getInfo: (content) => {
      const name = content.match(/^module\s+(\S+)/m)?.[1];
      return { name: name?.split('/').pop() };
    }
  },
  {
    file: 'pyproject.toml',
    type: 'Python',
    getInfo: (content) => {
      const name = content.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
      const desc = content.match(/^description\s*=\s*"([^"]+)"/m)?.[1];
      return { name, description: desc };
    }
  },
  {
    file: 'setup.py',
    type: 'Python',
    getInfo: (content) => {
      const name = content.match(/name\s*=\s*['"]([^'"]+)['"]/)?.[1];
      return { name };
    }
  },
  {
    file: 'requirements.txt',
    type: 'Python',
    getInfo: () => ({})
  },
  {
    file: 'pom.xml',
    type: 'Java/Maven',
    getInfo: (content) => {
      const name = content.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1];
      return { name };
    }
  },
  {
    file: 'build.gradle',
    type: 'Java/Gradle',
    getInfo: () => ({})
  },
  {
    file: 'composer.json',
    type: 'PHP',
    getInfo: (content) => {
      try {
        const pkg = JSON.parse(content);
        return { name: pkg.name, description: pkg.description };
      } catch { return {}; }
    }
  },
  {
    file: 'Gemfile',
    type: 'Ruby',
    getInfo: () => ({})
  },
  {
    file: 'mix.exs',
    type: 'Elixir',
    getInfo: (content) => {
      const name = content.match(/app:\s*:(\w+)/)?.[1];
      return { name };
    }
  },
  {
    file: 'deno.json',
    type: 'Deno',
    getInfo: (content) => {
      try {
        const cfg = JSON.parse(content);
        return { name: cfg.name };
      } catch { return {}; }
    }
  }
];

// Additional type hints from other files
const TYPE_HINTS: Record<string, string> = {
  'tsconfig.json': 'TypeScript',
  'jsconfig.json': 'JavaScript',
  '.eslintrc.js': 'JavaScript/TypeScript',
  'webpack.config.js': 'JavaScript/TypeScript (Webpack)',
  'vite.config.ts': 'TypeScript (Vite)',
  'next.config.js': 'Next.js',
  'nuxt.config.ts': 'Nuxt.js',
  'angular.json': 'Angular',
  'svelte.config.js': 'Svelte',
  'Dockerfile': 'Docker',
  'docker-compose.yml': 'Docker Compose',
  '.gitlab-ci.yml': 'GitLab CI',
  '.github/workflows': 'GitHub Actions',
};

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '__pycache__',
  'target', 'vendor', '.next', '.nuxt', 'coverage', '.cache',
  'venv', '.venv', 'env', '.env'
]);

const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.gitignore', '.npmignore',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'
]);

function getDirectoryTree(dir: string, maxDepth = 2, currentDepth = 0, prefix = ''): string[] {
  if (currentDepth > maxDepth) return [];

  const lines: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter(e => !IGNORE_DIRS.has(e.name) && !IGNORE_FILES.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        // Directories first, then files
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        const childLines = getDirectoryTree(
          join(dir, entry.name),
          maxDepth,
          currentDepth + 1,
          prefix + childPrefix
        );
        lines.push(...childLines);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  } catch {
    // Ignore permission errors
  }

  return lines;
}

function detectProjectType(cwd: string): { type: string; name: string; description: string } {
  let type = 'Unknown';
  let name = basename(cwd);
  let description = '';

  // Check main project files
  for (const pf of PROJECT_FILES) {
    const filePath = join(cwd, pf.file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const info = pf.getInfo(content);
        type = pf.type;
        if (info.name) name = info.name;
        if (info.description) description = info.description;
        break;
      } catch {
        type = pf.type;
      }
    }
  }

  // Check for type hints to refine the type
  for (const [file, hint] of Object.entries(TYPE_HINTS)) {
    if (existsSync(join(cwd, file))) {
      if (type === 'Node.js/TypeScript' && hint.includes('TypeScript')) {
        type = 'TypeScript/Node.js';
      } else if (type === 'Unknown') {
        type = hint;
      }
      break;
    }
  }

  return { type, name, description };
}

function loadCustomContext(cwd: string): string {
  // Check for custom context files in order of preference
  const contextFiles = [
    '.dev.md/context.md',
    '.dev.md/CONTEXT.md',
    'CONTEXT.md',
    '.context.md',
  ];

  for (const file of contextFiles) {
    const filePath = join(cwd, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8').trim();
        if (content) return content;
      } catch {
        // Ignore read errors
      }
    }
  }

  return '';
}

function getReadmeExcerpt(cwd: string, maxLines = 10): string {
  const readmeFiles = ['README.md', 'readme.md', 'README.txt', 'README'];

  for (const file of readmeFiles) {
    const filePath = join(cwd, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        // Skip title (# heading) and get first meaningful paragraph
        let startIdx = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line && !line.startsWith('#') && !line.startsWith('![')) {
            startIdx = i;
            break;
          }
        }

        // Get a few lines of content
        const excerpt = lines.slice(startIdx, startIdx + maxLines)
          .join('\n')
          .trim()
          .slice(0, 500);

        if (excerpt) return excerpt;
      } catch {
        // Ignore read errors
      }
    }
  }

  return '';
}

export function buildProjectContext(cwd: string): ProjectContext {
  const { type, name, description } = detectProjectType(cwd);
  const treeLines = getDirectoryTree(cwd, 2);
  const structure = treeLines.length > 0 ? treeLines.join('\n') : '(empty or inaccessible)';
  const customContext = loadCustomContext(cwd);

  // If no description from project file, try README
  const finalDescription = description || getReadmeExcerpt(cwd, 5);

  return {
    type,
    name,
    description: finalDescription,
    structure,
    customContext
  };
}

export function formatProjectContext(ctx: ProjectContext): string {
  const lines: string[] = [
    '## Project Context',
    '',
    `**Project:** ${ctx.name}`,
    `**Type:** ${ctx.type}`,
  ];

  if (ctx.description) {
    lines.push(`**Description:** ${ctx.description.split('\n')[0].slice(0, 200)}`);
  }

  lines.push('', '**Structure:**', '```', ctx.structure, '```');

  if (ctx.customContext) {
    lines.push('', '**Additional Context:**', ctx.customContext);
  }

  lines.push('', '---', '');

  return lines.join('\n');
}

export function getProjectContextString(cwd: string): string {
  const ctx = buildProjectContext(cwd);
  return formatProjectContext(ctx);
}
