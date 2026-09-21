/**
 * The Problems panel, attached to the edit that may have caused it.
 *
 * `get_diagnostics` has existed, been named in the per-turn anchor on every
 * single turn, and been called **zero times** in 41 sessions. That is not a
 * memory problem — the model is told it exists more often than it is told
 * almost anything else. It is that a tool answers a question the model has to
 * think to ask, and "did my edit just break something?" is a question it does
 * not think to ask precisely when it matters.
 *
 * Cursor's answer is the one worth copying, and it is not a tool: after an edit
 * it passes the file through the linter and puts the result in the **edit's own
 * tool result**, so the model never has to remember. Lint feedback is described
 * as extremely high signal for an agent, which is exactly why it must not
 * depend on recall.
 *
 * **The timing is the hard part, and getting it wrong is worse than nothing.**
 * The companion debounces `onDidChangeDiagnostics` by 1,500ms — deliberately,
 * because it fires continuously while a project indexes — so reading the file
 * the instant an edit lands returns the state *before* the edit. Reporting that
 * as "no new problems" is a confident lie about the one thing this exists to
 * check.
 *
 * So it waits for evidence rather than for a duration: it polls until the
 * file's own `timestamp` passes the moment the edit landed, and gives up
 * quickly. Silence is the honest answer to "I could not tell", and silence is
 * what an absent companion costs — the whole thing is skipped when the file
 * does not exist, so a user without the extension pays nothing at all.
 */
import fs from 'fs';
import path from 'path';
import { diagnosticsPath } from './paths.js';

/** Long enough for a 1,500ms debounce to fire, short enough not to be felt. */
const FRESH_TIMEOUT_MS = 2600;
const POLL_MS = 200;

/**
 * Hints are not findings.
 *
 * A real Problems panel on this repo is mostly `'req' is declared but its value
 * is never read` — true, harmless, and seven of them in one file. Feeding that
 * back after every edit trains the model to ignore the block, and then the one
 * time it says `error` it is ignored too.
 */
const REPORTABLE = new Set(['error', 'warning']);

/** `./a/b.js`, `/root/a/b.js` and `a/b.js` are the same file. */
const normalise = (p) => String(p || '').trim().replace(/^\.\//, '').replace(/^\/+/, '');

function sameFile(a, b) {
  const x = normalise(a);
  const y = normalise(b);
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x);
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Problems for one file, once the panel has caught up with the edit.
 *
 * @param {string} workspace
 * @param {string} relPath - the path the model edited
 * @param {number} editedAt - Date.now() as the edit was applied
 * @param {{timeoutMs?: number, sleep?: (ms: number) => Promise<void>}} [opts]
 * @returns {Promise<string|null>} a block to append to the tool result, or null
 *   when there is nothing trustworthy to say
 */
export async function diagnosticsAfterEdit(workspace, relPath, editedAt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? FRESH_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const file = diagnosticsPath(workspace);
  // No companion, no cost. Checked first so the common case is one stat call.
  if (!fs.existsSync(file)) return null;

  const deadline = Date.now() + timeoutMs;
  let state = read(file);
  while (Date.now() < deadline && (!state || !(Number(state.timestamp) > editedAt))) {
    await sleep(POLL_MS);
    state = read(file);
  }

  // Still behind the edit. The panel may simply be slow, and "no problems"
  // would be a claim about a file it has not looked at yet.
  if (!state || !(Number(state.timestamp) > editedAt)) return null;

  const mine = (state.problems || [])
    .filter((p) => p && REPORTABLE.has(String(p.severity).toLowerCase()))
    .filter((p) => sameFile(p.file, relPath));

  if (mine.length === 0) {
    return `<diagnostics path="${relPath}">No errors or warnings after this edit.</diagnostics>`;
  }

  const lines = mine.slice(0, 20).map((p) => {
    const where = p.line != null ? `:${p.line}${p.column != null ? `:${p.column}` : ''}` : '';
    return `${String(p.severity).toLowerCase()} ${relPath}${where} — ${p.message}`
      + (p.source ? ` (${p.source})` : '');
  });
  const more = mine.length > lines.length ? `\n… ${mine.length - lines.length} more` : '';

  return `<diagnostics path="${relPath}">\n${lines.join('\n')}${more}\n</diagnostics>`;
}

export { sameFile as _sameFile, REPORTABLE as _REPORTABLE, normalise as _normalise };
