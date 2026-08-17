/**
 * Tool: grep_search
 *
 * Content search across the codebase. Uses ripgrep if available,
 * falls back to recursive Node.js fs scan.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, relative, extname } from 'path';

const execFileAsync = promisify(execFile);

// Binary file extensions to skip in fallback mode
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.mp3', '.mp4', '.avi', '.mkv', '.mov',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.pyc', '.class', '.wasm',
]);

/**
 * Try ripgrep first, fall back to Node.js scan.
 */
export async function grepSearch(args, context) {
  const { pattern, isRegex = false, includes = [], maxResults = 50 } = args;
  const { workspace } = context;

  if (!pattern || pattern.trim().length === 0) {
    throw new Error('Search pattern cannot be empty');
  }

  try {
    return await ripgrepSearch(pattern, workspace, { isRegex, includes, maxResults });
  } catch {
    // ripgrep not available, fall back
    return await nodeSearch(pattern, workspace, { isRegex, includes, maxResults });
  }
}

async function ripgrepSearch(pattern, workspace, { isRegex, includes, maxResults }) {
  const args = [
    '--json',
    '--max-count', String(maxResults),
    '--no-heading',
    '--line-number',
    '--color', 'never',
  ];

  if (!isRegex) {
    args.push('--fixed-strings');
  }

  // Add include patterns
  for (const glob of includes) {
    args.push('--glob', glob);
  }

  args.push(pattern, workspace);

  const { stdout } = await execFileAsync('rg', args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15000,
  });

  const matches = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'match') {
        const data = parsed.data;
        matches.push({
          path: relative(workspace, data.path.text),
          lineNumber: data.line_number,
          content: data.lines.text.trimEnd(),
          submatches: data.submatches?.map(s => ({
            match: s.match.text,
            start: s.start,
            end: s.end,
          })),
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    pattern,
    matchCount: matches.length,
    matches: matches.slice(0, maxResults),
  };
}

async function nodeSearch(pattern, workspace, { isRegex, includes, maxResults }) {
  const regex = isRegex ? new RegExp(pattern, 'gm') : null;
  const matches = [];

  function walk(dir) {
    if (matches.length >= maxResults) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) return;

      const fullPath = resolve(dir, entry.name);
      const relPath = relative(workspace, fullPath);

      // Skip common non-searchable dirs
      if (entry.isDirectory()) {
        if (['node_modules', '.git', '.gemini-agent', 'dist', 'build', '.next'].includes(entry.name)) {
          continue;
        }
        walk(fullPath);
        continue;
      }

      // Skip binary files
      if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

      // Apply include filters
      if (includes.length > 0) {
        const matchesInclude = includes.some(glob => {
          const ext = glob.replace('*', '');
          return entry.name.endsWith(ext);
        });
        if (!matchesInclude) continue;
      }

      // Read and search
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;

          const line = lines[i];
          let found = false;

          if (regex) {
            regex.lastIndex = 0;
            found = regex.test(line);
          } else {
            found = line.includes(pattern);
          }

          if (found) {
            matches.push({
              path: relPath,
              lineNumber: i + 1,
              content: line.trimEnd(),
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(workspace);

  return {
    pattern,
    matchCount: matches.length,
    matches,
  };
}
