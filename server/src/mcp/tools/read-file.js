/**
 * Tool: read_file
 *
 * Read file contents with optional line range.
 */

import { readFileSync, statSync, existsSync } from 'fs';
import { resolve, relative, extname } from 'path';

// Language detection by extension
const LANG_MAP = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.r': 'r',
  '.sql': 'sql',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.md': 'markdown',
  '.txt': 'plaintext',
  '.env': 'dotenv',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql', '.gql': 'graphql',
};

export async function readFile(args, context) {
  const { path: filePath, startLine, endLine } = args;
  const { workspace } = context;

  const absPath = filePath.startsWith('/') ? filePath : resolve(workspace, filePath);
  const relPath = relative(workspace, absPath);

  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${relPath}`);
  }

  const stat = statSync(absPath);
  if (stat.isDirectory()) {
    throw new Error(`${relPath} is a directory. Use list_directory instead.`);
  }

  // Size guard — don't read files larger than 1MB
  if (stat.size > 1024 * 1024) {
    throw new Error(`File too large (${formatBytes(stat.size)}). Use startLine/endLine to read a portion.`);
  }

  const content = readFileSync(absPath, 'utf-8');
  const allLines = content.split('\n');
  const totalLines = allLines.length;

  // Apply line range and 800-line pagination limit
  let rangeStart = startLine ? Math.max(1, startLine) : 1;
  let rangeEnd = endLine ? Math.min(totalLines, endLine) : totalLines;

  if (rangeStart > totalLines) {
    throw new Error(`Start line ${rangeStart} exceeds file length (${totalLines} lines)`);
  }

  // Enforce 800-line limit to protect context window
  if (rangeEnd - rangeStart + 1 > 800) {
    rangeEnd = rangeStart + 800 - 1;
  }

  const lines = allLines.slice(rangeStart - 1, rangeEnd);

  // Add line numbers
  let numberedContent = lines
    .map((line, i) => `${String(rangeStart + i).padStart(4)}: ${line}`)
    .join('\n');

  if (rangeEnd < totalLines) {
    numberedContent += `\n\n... [File truncated at line ${rangeEnd} of ${totalLines}. Call read_file with startLine=${rangeEnd + 1} to read more.]`;
  }

  const ext = extname(absPath).toLowerCase();
  const language = LANG_MAP[ext] || 'plaintext';

  return {
    path: relPath,
    language,
    totalLines,
    range: { start: rangeStart, end: rangeEnd },
    size: formatBytes(stat.size),
    content: numberedContent,
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
