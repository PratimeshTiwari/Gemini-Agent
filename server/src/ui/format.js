/**
 * Turning tool results and markdown into terminal-shaped text.
 *
 * Kept out of App.jsx because none of it touches React: these are the functions
 * the transcript rows call while rendering, and they are worth testing directly.
 */

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

/**
 * `tab` indents lists *and* code blocks, and the two wanted different things.
 *
 * It was 2, and a drag-select over a fenced block took those two spaces with
 * it — so every code block had to be re-indented by hand after pasting it
 * anywhere. There is no clickable copy button here and there cannot be: that
 * needs mouse tracking, which suppresses drag-select and would take away the
 * thing being fixed. So it went to 0.
 *
 * **That flattened every nested list**, reported from use with the Gemini tab
 * and the CLI side by side: `marked` parsed the nesting correctly and
 * `marked-terminal` drew all of it at one level, because `tab` is what it
 * indents children by. Two levels of bullets is how Gemini writes anything
 * structured, so this was the more expensive half.
 *
 * It is back to 2, and the code blocks stay copy-clean, because they no longer
 * reach `marked` at all — `renderMarkdown` lifts fenced blocks out first and
 * `renderBlock` draws them, un-indented, with a dim rule marking the edges.
 * Fixing the second bug is what made the first fix unnecessary.
 */
marked.use(markedTerminal({
  tab: 2,
  width: 100,
  showSectionPrefix: false,
  tableOptions: {
    style: { head: ['cyan'] }
  }
}));

/**
 * Lists are drawn from the token tree, not from `marked-terminal`'s.
 *
 * Its list renderer is line-based: `listitem` prefixes every item with a `* `
 * marker, and `list` then rewrites those markers a line at a time — replacing
 * each one with `n. ` when the list is ordered. Nested lists are rendered
 * first, so by the time the outer list scans, its body already holds the
 * child's finished, indented lines, and `isPointedLine` matches those too
 * (`^(?:indent)*(?:\*|\d+\.)`). The parent therefore numbers its children as
 * if they were its own items, and keeps counting:
 *
 *     1. Install the deps        1. Install the deps
 *       * with npm         -->     * with npm
 *       2. with pnpm               * with pnpm
 *     3. Run it                  2. Run it
 *
 * Both wrong columns come from one counter. It only bites when the *outer*
 * list is ordered — the unordered path leaves an already-marked line alone —
 * which is why "numbered list with sub-points", the shape Gemini reaches for
 * whenever it explains steps, was the one that came out wrong.
 *
 * A token walk cannot have the bug: an item's children are rendered into that
 * item's body and never re-scanned by its parent. The indent is the item's own
 * content column, the same rule the content scripts use when they scrape a
 * list back out of the page — `- ` is two, `1. ` is three, `10. ` is four.
 */
marked.use({
  renderer: {
    list(token) {
      let n = Number(token.start || 1);
      const lines = token.items.map((item) => {
        const marker = token.ordered ? `${n++}. ` : '* ';
        const tick = item.task ? (item.checked ? '[X] ' : '[ ] ') : '';
        const body = this.parser
          .parse(item.tokens, !!item.loose)
          // A loose item's first child is a block and opens with its own
          // newline, which would otherwise land straight after the marker.
          .replace(/^\s+/, '')
          .trimEnd()
          // Continuation lines — a nested list, a second paragraph, a fenced
          // block — sit under the text, not under the marker.
          .replace(/\n(?=[^\n])/g, `\n${' '.repeat(marker.length + tick.length)}`);
        return `${marker}${tick}${body}`;
      });
      // Leading newline so the list separates from the text above it; the
      // trailing pair is the blank line every block element ends with here.
      return `\n${lines.join('\n')}\n\n`;
    },
  },
});

/**
 * A fenced block: its indentation, its language, then the body.
 *
 * The indent is captured and the closing fence must match it, because a fence
 * inside a list item is indented to that item's content column — "1. Run
 * this:" followed by the block is a shape the model writes constantly. Anchored
 * at column 0 this missed all of them, so they reached `marked` as ordinary
 * code and came out without the rules that mark a block's edges, and `ctrl+y`
 * could not see them at all. An unindented fence captures an empty group and
 * behaves exactly as before.
 */
const FENCE = /^([ \t]*)```([^\n`]*)\n([\s\S]*?)^\1```[ \t]*$/gm;

/** Give back the lines of a lifted block without the indent that held it. */
const dedent = (code, indent) => (indent
  ? code.replace(new RegExp(`^${indent}`, 'gm'), '')
  : code);

/**
 * The fenced code blocks in a reply, in the order they appear.
 *
 * Exported because `ctrl+y` copies the last one, and reaching into a rendered
 * string to find it again would mean parsing the rules back out of prose that
 * may legitimately contain them.
 *
 * @returns {Array<{lang: string, code: string}>}
 */
export function extractCodeBlocks(content) {
  const out = [];
  for (const m of String(content || '').matchAll(FENCE)) {
    out.push({ lang: (m[2] || '').trim(), code: dedent(m[3], m[1]).replace(/\n$/, '') });
  }
  return out;
}

/** Dim, so the rules read as furniture rather than as part of the code. */
const DIM = '\x1b[2m';
const RESET = '\x1b[22m';

/**
 * A block, bounded by rules that a drag does not pick up.
 *
 * The rule is as wide as the block's own longest line, capped at 60: it can
 * never be wider than the code beside it, so it cannot wrap a frame that the
 * code itself fits in. Widening it to the terminal would need the width passed
 * down through every caller, to draw a line nobody needs longer.
 */
function renderBlock(lang, code) {
  const lines = code.split('\n');
  const width = Math.min(60, Math.max(8, ...lines.map((l) => l.length)));
  const label = lang ? `\u2500 ${lang} ` : '';
  const top = label + '\u2500'.repeat(Math.max(2, width - label.length));
  const bottom = '\u2500'.repeat(width);
  return `${DIM}${top}${RESET}\n${code}\n${DIM}${bottom}${RESET}`;
}

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

/**
 * The state of the GitHub token, as one short chip.
 *
 * "Is my token still good?" is the question the dashboard could not answer.
 * A lapsed personal access token and a revoked one both surface as the same
 * 401, and by then the poller has already stopped — so the useful moment to
 * say something is while the token still works and the expiry date is known.
 *
 * @param {string|null} expiry - ISO date GitHub reported, or null for no expiry
 * @param {boolean} rejected - the token has already been refused
 * @returns {{ label: string, tone: 'green'|'yellow'|'red' }}
 */
export function formatTokenExpiry(expiry, rejected = false, now = Date.now()) {
  if (rejected) return { label: 'token rejected', tone: 'red' };
  if (!expiry) return { label: 'token ok', tone: 'green' };

  const when = expiry instanceof Date ? expiry.getTime() : new Date(expiry).getTime();
  if (Number.isNaN(when)) return { label: 'token ok', tone: 'green' };

  const days = Math.floor((when - now) / 86400000);
  if (days < 0) return { label: 'token expired', tone: 'red' };
  if (days === 0) return { label: 'token expires today', tone: 'red' };
  // A week is the point where it becomes something to do rather than something
  // to know; before that, "ok" is the whole answer and the date is noise.
  if (days <= 7) return { label: `token expires in ${days}d`, tone: 'yellow' };
  return { label: 'token ok', tone: 'green' };
}

/**
 * A poll timestamp as something a person reads at a glance.
 *
 * The dashboard was printing the raw ISO string, which is both unreadable and
 * wide enough to collide with the status text beside it.
 */
export function formatPollTime(value, now = Date.now()) {
  if (!value) return 'never';
  const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(then)) return String(value);

  const secondsAgo = Math.max(0, Math.round((now - then) / 1000));
  if (secondsAgo < 10) return 'just now';
  if (secondsAgo < 90) return `${secondsAgo}s ago`;
  if (secondsAgo < 3600) return `${Math.round(secondsAgo / 60)}m ago`;
  return new Date(then).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * A shell result as a terminal block rather than a JSON dump.
 *
 * `run_command` returns `{exitCode, stdout, stderr, command, cwd}`, and the
 * expanded row used to print that object verbatim — escaped newlines, quoted
 * keys and all, so a page of output arrived as one unreadable line. What the
 * user wants to see is what they would have seen in a shell.
 *
 * @returns {string|null} null when this is not a shell result, so the caller
 *   can fall back to the generic renderer.
 */
export function formatCommandResult(result, maxLines = 20) {
  if (!result || typeof result !== 'object') return null;
  const isShellResult = typeof result.exitCode === 'number'
    && ('stdout' in result || 'stderr' in result);
  if (!isShellResult) return null;

  const lines = [];
  if (result.command) lines.push(`$ ${result.command}`);

  const body = [result.stdout, result.stderr].filter((p) => p && p.trim()).join('\n').trimEnd();
  if (body) {
    lines.push(clampForDisplay(body, maxLines, maxLines * 200));
  } else if (!result.timedOut) {
    lines.push('(no output)');
  }

  if (result.timedOut) {
    lines.push('⏱ timed out');
  } else if (result.exitCode !== 0) {
    // The exit code is the whole point of showing this expanded, and it is the
    // easiest thing to lose in a wall of output.
    lines.push(`✗ exit ${result.exitCode}`);
  }

  return lines.join('\n');
}

/**
 * Markdown for a transcript row, memoised by source text.
 *
 * `marked.parse` is not cheap and a turn re-renders whenever anything in the
 * live frame ticks, so parsing the same reply on every frame showed up as
 * tearing. The cache is bounded and keyed on the raw content — the same string
 * always produces the same rendering.
 *
 * The two regexes run before marked because `marked-terminal` mangles inline
 * bold inside list items, so bold is pre-baked as raw SGR (see CLAUDE.md).
 */
const RENDER_CACHE = new Map();
const RENDER_CACHE_MAX = 200;

export function renderMarkdown(content) {
  const source = content || '';
  const hit = RENDER_CACHE.get(source);
  if (hit !== undefined) return hit;

  let out;
  try {
    /**
     * Fenced blocks are lifted out before marked sees them, and put back after.
     *
     * Rendering each segment separately instead would break anything spanning a
     * block — a list with code in an item stops being one list. A sentinel on
     * its own line survives as a paragraph, so marked still parses one document
     * and the block still gets drawn by `renderBlock` rather than by
     * `marked-terminal`, which has no way to mark an edge.
     *
     * The token is deliberately plain: marked escapes and rewrites punctuation,
     * and a sentinel that does not come back out is a code block deleted.
     */
    const blocks = [];
    const stashed = source.replace(FENCE, (_m, indent, lang, code) => {
      blocks.push(renderBlock((lang || '').trim(), dedent(code, indent).replace(/\n$/, '')));
      // The sentinel drops the indent, so the restored block sits flush left
      // even inside a list item. Carrying the indent would put it back only on
      // the block's *first* line — the restored text is several lines and the
      // sentinel is one — and indenting all of them is the thing this file
      // decided against at the top: a drag-select takes the leading spaces
      // with it, and there is no copy button to fall back on. Flush left also
      // closes the list, which costs nothing: the item after it carries its
      // own `start`, so the numbering continues.
      return `x0codeblock${blocks.length - 1}x0`;
    });

    out = marked
      .parse(stashed
        .replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[22m')
        .replace(/^###\s+(.*$)/gm, '\x1b[1;32m$1\x1b[0m'))
      .trim()
      // Every block here ends in a blank line and the list renderer opens with
      // one, so a list after a paragraph is separated twice. Safe to collapse
      // at this point and not after: the fenced blocks, the one place a run of
      // blank lines is content, are still standing in as sentinels.
      .replace(/\n{3,}/g, '\n\n');

    out = out.replace(/x0codeblock(\d+)x0/g, (m, i) => blocks[Number(i)] ?? m);
  } catch {
    out = source;
  }

  // Oldest-first eviction: Map preserves insertion order, so the first key is
  // the least recently added.
  if (RENDER_CACHE.size >= RENDER_CACHE_MAX) {
    RENDER_CACHE.delete(RENDER_CACHE.keys().next().value);
  }
  RENDER_CACHE.set(source, out);
  return out;
}


/**
 * Lay text out as a full-width block, for the user's own message.
 *
 * Ink's `backgroundColor` paints the *characters*, not the line, so a
 * background applied to ordinary text stops where the words stop — a ragged
 * highlight rather than the bar Claude Code draws. Getting a bar means wrapping
 * and padding here rather than letting Ink wrap, because only the side doing
 * the wrapping can pad each resulting line.
 *
 * Padded to `width - 1`, not `width`. Filling the final column leaves the
 * cursor in a deferred-wrap state that some terminals resolve by moving to the
 * next line — which would insert a blank row per line of the block, and rows
 * that appear without being budgeted are how the live frame outgrows the
 * viewport.
 *
 * Long words are broken rather than allowed to overhang: a path or a URL wider
 * than the terminal would otherwise push past the padding and break the bar on
 * exactly the messages most likely to contain one.
 *
 * @param {string} text
 * @param {number} width - the terminal's column count
 * @param {number} [indent] - columns the caller draws before the text
 * @returns {string[]} one padded line per rendered row
 */
export function blockLines(text, width, indent = 0) {
  const inner = Math.max(8, (Number(width) || 80) - 1 - indent);
  const out = [];

  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph === '') { out.push(''.padEnd(inner)); continue; }
    let line = '';
    for (const word of paragraph.split(' ')) {
      let w = word;
      // A single word longer than the line gets broken, not overhung.
      while (w.length > inner) {
        if (line) { out.push(line.padEnd(inner)); line = ''; }
        out.push(w.slice(0, inner));
        w = w.slice(inner);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= inner) line += ` ${w}`;
      else { out.push(line.padEnd(inner)); line = w; }
    }
    out.push(line.padEnd(inner));
  }
  return out;
}

/**
 * The agent's reply, bounded while the turn is still in the live frame.
 *
 * **This row was unbounded, and it is the one rule this directory has.** A
 * live turn lives in Ink's repainted frame, and a frame taller than the
 * viewport makes Ink write `ESC[2J ESC[3J` and repaint on *every* render —
 * which destroys the terminal's scrollback and the user's selection. `shown`
 * above carefully caps the action rows at `liveBudget`; the reply underneath
 * then rendered in full regardless.
 *
 * Reported as "it gave me much more output but I received only a portion of
 * it", with a screenshot of a reply cut mid-sentence and blank space below.
 * The text was never lost — `history.jsonl` had all 5,090 characters and
 * `renderMarkdown` returns all of them — but at ~85 rendered rows in a
 * ~30-row terminal, the frame blew past the viewport and what survived the
 * repaint was its top.
 *
 * Clamped only while live. The committed copy goes to `<Static>`, is written
 * once and never repainted, and is the one the user actually reads — so it
 * stays whole, and the rest of the reply appears there a moment later.
 */
export function liveMessageText(text, budget) {
  const max = Math.max(3, (Number(budget) || 12) - 2);
  const lines = String(text ?? '').split('\n');
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join('\n')}\n… +${lines.length - max} more lines`;
}
