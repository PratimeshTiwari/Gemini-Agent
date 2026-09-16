/**
 * Tool: grep_search
 *
 * Content search across the codebase. Uses ripgrep if available,
 * falls back to recursive Node.js fs scan.
 */

import { execFile } from 'child_process';
import { AGENT_DIR } from '../../core/paths.js';
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
/**
 * Search the codebase.
 *
 * Three things here are for large repositories specifically, and each replaces
 * a browser round-trip with a cheaper one.
 *
 * **Several patterns in one call.** The model already knows that "rate limit"
 * might be spelled `throttle`, `quota` or `bucket` in this codebase — it just
 * had to spend one whole turn per guess to find out, and a turn here means a
 * prompt typed into a chat tab and a reply scraped back.
 *
 * **Context lines.** A bare matching line often cannot be told from a false
 * positive without reading the file, so the model read the file. Two lines
 * either side usually settles it.
 *
 * **Grouped by file.** Fifty flat rows repeat the path fifty times, and every
 * one of those characters is retyped into the browser on the next turn.
 * Grouping states each path once and makes "this is all in one module" visible
 * at a glance, which is the thing a flat list hides.
 */
export async function grepSearch(args, context) {
  const { pattern, isRegex = false, includes = [], maxResults = 50, contextLines = 0 } = args;
  const { workspace } = context;

  const patterns = (Array.isArray(pattern) ? pattern : [pattern])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);

  if (patterns.length === 0) {
    throw new Error('Search pattern cannot be empty');
  }

  // Context is capped rather than rejected: a model asking for 200 lines of
  // context wants the file, and should be told to read it instead of being
  // handed the file one match at a time.
  const context_ = Math.max(0, Math.min(5, Number(contextLines) || 0));
  const limit = Math.max(1, Math.min(500, Number(maxResults) || 50));
  const opts = { isRegex, includes, maxResults: limit, contextLines: context_ };

  // One more than asked for, so `groupByFile` can tell "exactly fifty matches"
  // from "fifty and we stopped counting". Without the spare, ripgrep caps at
  // the limit and there is no surplus left to notice.
  const probe = { ...opts, maxResults: limit + 1 };

  let matches;
  try {
    matches = await ripgrepSearch(patterns, workspace, probe);
  } catch {
    // ripgrep not available, fall back
    matches = await nodeSearch(patterns, workspace, probe);
  }
  return groupByFile(patterns, matches, limit);
}

/**
 * Flat matches to one entry per file.
 *
 * Files are ordered by how many times they matched: on a large repo the module
 * that owns a concept is usually the one that mentions it most, and putting it
 * first means the model reads the right file before it runs out of budget.
 */
function groupByFile(patterns, matches, limit) {
  const truncated = matches.length > limit;
  const kept = matches.slice(0, limit);

  const byPath = new Map();
  for (const match of kept) {
    if (!byPath.has(match.path)) byPath.set(match.path, []);
    byPath.get(match.path).push({
      line: match.lineNumber,
      text: match.content,
      ...(match.before?.length ? { before: match.before } : {}),
      ...(match.after?.length ? { after: match.after } : {}),
    });
  }

  const files = [...byPath.entries()]
    .map(([path, lines]) => ({ path, matches: lines }))
    .sort((a, b) => b.matches.length - a.matches.length || a.path.localeCompare(b.path));

  return {
    // `pattern` stays singular for one term so existing callers and the UI's
    // result summary read the same as they did.
    ...(patterns.length === 1 ? { pattern: patterns[0] } : { patterns }),
    matchCount: kept.length,
    fileCount: files.length,
    ...(truncated ? { truncated: true, note: `Stopped at ${limit} matches. Narrow with \`includes\`, or search a more specific term.` } : {}),
    files,
  };
}

async function ripgrepSearch(patterns, workspace, { isRegex, includes, maxResults, contextLines }) {
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
  if (contextLines > 0) {
    args.push('--context', String(contextLines));
  }

  for (const glob of includes) {
    args.push('--glob', glob);
  }
  // `-e` per pattern: ripgrep ORs them in one pass over the tree, which is the
  // whole point — three greps over a large repo is three tree walks.
  for (const p of patterns) {
    args.push('-e', p);
  }

  args.push(workspace);

  const { stdout } = await execFileAsync('rg', args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15000,
  });

  // Context lines arrive as their own records, before and after the match they
  // belong to, so they are buffered and attached rather than listed.
  const matches = [];
  let pendingBefore = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    if (parsed.type === 'context') {
      const text = parsed.data.lines.text.trimEnd();
      const last = matches[matches.length - 1];
      // A context record follows the match it trails, and precedes the one it
      // leads. Whether this one is "after" depends on how close it is.
      if (last && parsed.data.line_number === last.lineNumber + last.after.length + 1) {
        last.after.push(text);
      } else {
        pendingBefore.push(text);
        if (pendingBefore.length > contextLines) pendingBefore.shift();
      }
      continue;
    }

    if (parsed.type === 'match') {
      const data = parsed.data;
      matches.push({
        path: relative(workspace, data.path.text),
        lineNumber: data.line_number,
        content: data.lines.text.trimEnd(),
        before: pendingBefore,
        after: [],
      });
      pendingBefore = [];
    }
  }

  return matches;
}

async function nodeSearch(patterns, workspace, { isRegex, includes, maxResults, contextLines }) {
  // One regex per pattern, or a plain substring test — same semantics as the
  // ripgrep path, so which one ran is invisible in the result.
  const tests = patterns.map((p) => (isRegex
    ? { regex: new RegExp(p, 'm') }
    : { literal: p }));
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
        if (['node_modules', '.git', AGENT_DIR, 'dist', 'build', '.next'].includes(entry.name)) {
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
          const found = tests.some((t) => (t.regex ? t.regex.test(line) : line.includes(t.literal)));

          if (found) {
            matches.push({
              path: relPath,
              lineNumber: i + 1,
              content: line.trimEnd(),
              before: contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i).map((l) => l.trimEnd()) : [],
              after: contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines).map((l) => l.trimEnd()) : [],
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(workspace);
  return matches;
}
