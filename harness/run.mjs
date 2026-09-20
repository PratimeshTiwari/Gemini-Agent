/**
 * Run every scenario against the real CLI under a pty, and say what broke.
 *
 * Not part of `npm test`: each scenario starts a real process and takes tens
 * of seconds, and Ink needs a TTY. `npm run harness` when you have touched
 * the turn loop or anything in `ui/`.
 *
 * It waits on **observed output**, never a clock. An earlier driver slept a
 * fixed number of seconds between steps, so the enter that approves a diff
 * could land before the prompt existed — identical code then measured 1 full
 * clear on one run and 89 on the next, and three conclusions drawn from those
 * numbers were noise.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];
let port = 8900 + Math.floor(Math.random() * 90);
const results = [];

for (const s of SCENARIOS) {
  if (only && !s.name.includes(only)) continue;
  const ws = mkdtempSync(join(tmpdir(), 'harness-'));
  const args = [join(here, 'drive.py'), String(s.rows ?? 30), String(s.cols ?? 100),
    String(port++), JSON.stringify(s.steps), ws, JSON.stringify(s.replies),
    String(s.delayMs ?? 300),
    // What the browser's picker is offering. Omitted unless a scenario says,
    // and both readers of it are silent without one.
    ...(s.models ? [JSON.stringify(s.models)] : [])];

  let out = '';
  try { out = execFileSync('python3', ['-u', ...args], { encoding: 'utf8', timeout: 180000 }); }
  catch (e) { out = `${e.stdout || ''}\nDRIVER FAILED: ${e.message}`; }

  const transcript = existsSync(join(ws, 'out.txt')) ? readFileSync(join(ws, 'out.txt'), 'utf8') : '';
  const plain = transcript.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b/g, '');
  const clears = (transcript.match(/\x1b\[2J/g) || []).length;

  const problems = [];
  for (const e of s.expect ?? []) if (!plain.includes(e)) problems.push(`missing ${JSON.stringify(e)}`);
  for (const a of s.absent ?? []) if (plain.includes(a)) problems.push(`unexpected ${JSON.stringify(a)}`);
  /*
   * `order` asserts that one string is drawn above another, which substring
   * checks cannot say on their own — and drawing order is the whole of phase
   * 4.1. Compared on the *last* occurrence of each, because the live frame
   * repaints the same rows many times and only the committed copy is final.
   * A missing string is reported as missing rather than silently ordering.
   */
  for (const [above, below] of s.order ?? []) {
    const a = plain.lastIndexOf(above);
    const b = plain.lastIndexOf(below);
    if (a < 0 || b < 0) problems.push(`cannot order ${JSON.stringify(a < 0 ? above : below)}: never drawn`);
    else if (a > b) problems.push(`${JSON.stringify(above)} drawn below ${JSON.stringify(below)}`);
  }
  /*
   * `counts` asserts how many times a string was *written*, which neither
   * `expect` nor `absent` can say. The transcript duplicating is exactly a
   * counting bug: every row was present, just drawn more than once.
   */
  for (const [needle, want] of Object.entries(s.counts ?? {})) {
    const got = plain.split(needle).length - 1;
    if (got !== want) problems.push(`${JSON.stringify(needle)} drawn ${got}x, expected ${want}x`);
  }
  /*
   * `blankAbove` asserts how many blank rows sit directly above a row, which
   * is the only way to state "these two do not read as one run-on row" — the
   * prompt bar is a full-width inverted block, and a reply butted against it
   * was reported from use.
   *
   * Computed from its own CRLF-normalised copy rather than `plain`: the pty
   * writes `\r\n`, and the first version of this check looked for `\n\n` and
   * so matched nothing at all, passing while measuring nothing. The *last*
   * occurrence is the committed one, for the same reason `order` uses it.
   */
  const rows = transcript.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b/g, '')
    .replace(/\r\n/g, '\n').split('\n');
  const blankRun = (needle, step, label) => {
    const at = rows.map((l, n) => (l.startsWith(needle) ? n : -1)).filter((n) => n >= 0).pop();
    if (at === undefined) return `${label}: ${JSON.stringify(needle)} never drawn`;
    let got = 0;
    for (let n = at + step; n >= 0 && n < rows.length && rows[n].trim() === ''; n += step) got++;
    return got;
  };
  for (const [needle, want] of s.blankAbove ?? []) {
    const got = blankRun(needle, -1, 'blankAbove');
    if (typeof got === 'string') problems.push(got);
    else if (got !== want) problems.push(`${JSON.stringify(needle)} has ${got} blank rows above it, expected ${want}`);
  }
  /*
   * `blankBelow` is the same question the other way up, and it is needed
   * because the two cannot see the same things. A <Static> row is written as
   * its own chunk and the live frame is redrawn between chunks, so what sits
   * above a row in the stream is the last live repaint rather than the
   * previous committed row. `blankAbove` therefore pins a row's own leading
   * margin and cannot see the *preceding* row's trailing one — which is
   * exactly where a second owner of the same gap shows up.
   */
  for (const [needle, want] of s.blankBelow ?? []) {
    const got = blankRun(needle, 1, 'blankBelow');
    if (typeof got === 'string') problems.push(got);
    else if (got !== want) problems.push(`${JSON.stringify(needle)} has ${got} blank rows below it, expected ${want}`);
  }
  if (clears > (s.maxClears ?? 0)) problems.push(`${clears} full clears (max ${s.maxClears ?? 0})`);
  if (s.wrote && !existsSync(join(ws, s.wrote))) problems.push(`${s.wrote} was not written`);
  if (s.didNotWrite && existsSync(join(ws, s.didNotWrite))) problems.push(`${s.didNotWrite} WAS written`);

  results.push({ name: s.name, ok: problems.length === 0, problems, bytes: transcript.length, clears });
  rmSync(ws, { recursive: true, force: true });
  process.stdout.write(problems.length === 0 ? '.' : 'F');
}

console.log('\n');
for (const r of results) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`);
  console.log(`        ${String(r.bytes).padStart(7)} bytes · ${r.clears} clears`);
  for (const p of r.problems) console.log(`        ↳ ${p}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
