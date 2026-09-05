/**
 * Turning tool results and markdown into terminal-shaped text.
 *
 * Kept out of App.jsx because none of it touches React: these are the functions
 * the transcript rows call while rendering, and they are worth testing directly.
 */

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal({
  tab: 2,
  width: 100,
  showSectionPrefix: false,
  tableOptions: {
    style: { head: ['cyan'] }
  }
}));

/** Collapse any value to a single line of at most `max` characters. */
export function oneLine(value, max = 60) {
  const text = String(typeof value === 'string' ? value : JSON.stringify(value ?? {}))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One-line description of a tool result, for the collapsed transcript row.
 * Falls back to a hard-clamped snippet for tools without a specific shape.
 */
export function summarizeResult(toolName, result) {
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + 's'}`;
  try {
    const r = result;
    switch (toolName) {
      case 'list_directory': {
        // { path, children, totalFiles, totalDirs }
        if (typeof r?.totalFiles === 'number' || typeof r?.totalDirs === 'number') {
          const parts = [];
          if (r.totalDirs) parts.push(plural(r.totalDirs, 'dir'));
          if (r.totalFiles) parts.push(plural(r.totalFiles, 'file'));
          if (parts.length) return parts.join(', ');
        }
        if (Array.isArray(r?.children)) return plural(r.children.length, 'entry', 'entries');
        break;
      }
      case 'read_file':
        // { path, totalLines, size, content }
        if (typeof r?.totalLines === 'number') {
          return `${plural(r.totalLines, 'line')}${r.size ? ` · ${r.size}` : ''}`;
        }
        break;
      case 'grep_search':
      case 'search_files': {
        // { pattern, matchCount, matches } | { query, count, files }
        const n = r?.matchCount ?? r?.count ?? (Array.isArray(r?.matches) ? r.matches.length : null)
          ?? (Array.isArray(r?.files) ? r.files.length : null) ?? (Array.isArray(r?.results) ? r.results.length : null);
        if (typeof n === 'number') return plural(n, 'match', 'matches');
        break;
      }
      case 'run_command':
      case 'run_background': {
        const out = String(typeof r === 'string' ? r : r?.stdout || r?.output || '').trim();
        if (out) return oneLine(out.split('\n')[0]);
        break;
      }
      case 'edit_file':
      case 'create_file': {
        // { diffId, filePath, hunkCount, status }
        if (r?.filePath) {
          const name = String(r.filePath).split('/').pop();
          return r.hunkCount ? `${plural(r.hunkCount, 'hunk')} in ${name}` : name;
        }
        break;
      }
      default:
        break;
    }
  } catch {
    /* fall through to the generic snippet */
  }
  // Generic fallback: compact, single line. clampForDisplay is not usable here —
  // it appends a newline marker, which would break the row.
  return oneLine(result);
}

/**
 * Clamp arbitrary tool output for terminal display.
 *
 * Ink can only redraw the dynamic region if it fits the viewport, so output is
 * capped by BOTH line count and total characters — long single lines wrap into
 * many rows and are the real cause of tearing.
 */
export function clampForDisplay(value, maxLines = 15, maxChars = 1200) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  if (typeof text !== 'string') return '';

  let clipped = false;
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join('\n');
    clipped = true;
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    clipped = true;
  }
  return clipped ? `${text}\n... [truncated]` : text;
}

export { marked };
