import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recall, archiveTurns, allTurns } from '../../src/core/session-recall.js';

let ws;
const sessions = () => join(ws, '.agent', 'sessions');
const turn = (role, content, ts) => ({ role, content, timestamp: ts });

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'recall-'));
  mkdirSync(sessions(), { recursive: true });
});
after(() => { try { rmSync(ws, { recursive: true, force: true }); } catch {} });

const writeHistory = (turns) => writeFileSync(
  join(sessions(), 'history.jsonl'), turns.map((t) => JSON.stringify(t)).join('\n') + '\n',
);

describe('recall — looking back into what the model can no longer see', () => {
  test('nothing recorded finds nothing, and does not throw', () => {
    assert.deepEqual(recall(ws, 'anything'), { total: 0, shown: [] });
  });

  test('an empty query is not a search for everything', () => {
    writeHistory([turn('user', 'hello', 1)]);
    assert.equal(recall(ws, '').total, 0);
    assert.equal(recall(ws, '   ').total, 0);
  });

  test('finds a turn in the live history', () => {
    writeHistory([turn('user', 'the parser lives in src/lex.js', 1000)]);
    const r = recall(ws, 'src/lex.js');
    assert.equal(r.total, 1);
    assert.equal(r.shown[0].role, 'user');
    assert.match(r.shown[0].excerpt, /src\/lex\.js/);
    assert.equal(r.shown[0].archived, false);
  });

  /**
   * The point of the whole thing. Compaction rewrites `history.jsonl`, so
   * without the archive this turn would be unreachable — which is what
   * `CLAUDE.md` assumed was already handled.
   */
  test('finds a turn compaction dropped, and says it was archived', () => {
    archiveTurns(ws, [turn('user', 'we chose Postgres because of the JSONB queries', 500)]);
    writeHistory([turn('system', '[Context Summary of older turns] discussed the database', 900)]);

    const r = recall(ws, 'JSONB');
    assert.equal(r.total, 1);
    assert.equal(r.shown[0].archived, true, 'must be findable after compaction');
    assert.match(r.shown[0].excerpt, /Postgres/);
  });

  test('searches the archive and the live history as one', () => {
    archiveTurns(ws, [turn('user', 'deploy runs on Tuesdays', 100)]);
    writeHistory([turn('user', 'deploy failed again', 900)]);
    assert.equal(recall(ws, 'deploy').total, 2);
  });

  test('matching ignores case', () => {
    writeHistory([turn('agent', 'EADDRINUSE on port 7777', 1)]);
    assert.equal(recall(ws, 'eaddrinuse').total, 1);
  });

  test('newest first, and capped, because this goes back into a prompt', () => {
    writeHistory(Array.from({ length: 30 }, (_, i) => turn('user', `note ${i} about caching`, i)));
    const r = recall(ws, 'caching', { limit: 3 });
    assert.equal(r.total, 30, 'the count is honest even when the list is not');
    assert.equal(r.shown.length, 3);
    assert.match(r.shown[0].excerpt, /note 29/, 'most recent first');
    assert.match(r.shown[2].excerpt, /note 27/);
  });

  test('a long turn comes back as an excerpt around the hit, not whole', () => {
    writeHistory([turn('agent', `${'x'.repeat(4000)} NEEDLE ${'y'.repeat(4000)}`, 1)]);
    const r = recall(ws, 'NEEDLE');
    assert.ok(r.shown[0].excerpt.length < 600, `excerpt was ${r.shown[0].excerpt.length} chars`);
    assert.match(r.shown[0].excerpt, /NEEDLE/);
    assert.match(r.shown[0].excerpt, /…/, 'clipping is shown, not silent');
  });

  test('a torn line loses itself, not the rest of the file', () => {
    writeHistory([turn('user', 'first mention of widgets', 1)]);
    appendFileSync(join(sessions(), 'history.jsonl'), '{"role":"user","content":"tor\n');
    appendFileSync(join(sessions(), 'history.jsonl'), JSON.stringify(turn('user', 'second widgets', 2)) + '\n');
    assert.equal(recall(ws, 'widgets').total, 2);
  });

  test('turns with no content are skipped rather than crashing the search', () => {
    writeHistory([{ role: 'system', type: 'fs_event' }, turn('user', 'real content', 2)]);
    assert.equal(recall(ws, 'real').total, 1);
  });
});

describe('archiveTurns', () => {
  test('appends, so two compactions do not overwrite each other', () => {
    archiveTurns(ws, [turn('user', 'first', 1)]);
    archiveTurns(ws, [turn('user', 'second', 2)]);
    assert.equal(allTurns(ws).length, 2);
  });

  test('nothing to archive writes nothing', () => {
    assert.equal(archiveTurns(ws, []), 0);
    assert.equal(archiveTurns(ws, null), 0);
  });

  test('never throws — it must not be able to fail a compaction', () => {
    assert.doesNotThrow(() => archiveTurns('/proc/nope/nowhere', [turn('user', 'x', 1)]));
  });
});
