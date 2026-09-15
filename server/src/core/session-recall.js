import fs from 'fs';
import * as paths from './paths.js';

/**
 * Looking back into a conversation the model can no longer see.
 *
 * Compaction replaces older turns with a summary. Whatever the summary left out
 * is gone from the thread, and the usual answer — make compaction smarter —
 * requires deciding in advance what will matter, which is the thing nobody can
 * do. Letting the model look the detail up afterwards does not.
 *
 * **The premise had to be built first.** `CLAUDE.md` records this idea as
 * cheap because "`sessions/history.jsonl` still holds every turn". It does not:
 * `_compactHistory` calls `saveHistory`, which rewrites the file — both copies —
 * so the dropped turns were gone from disk as well. They are archived now,
 * before the rewrite, and this searches the archive and the live history
 * together.
 *
 * Searching is literal, for the same reason there is no embedding index here:
 * what you go back for is an exact thing — a filename, an error string, a
 * decision — and lexical matching wins outright on those. It is also
 * predictable, which matters when the model is the one issuing the query.
 */

/** Read a `.jsonl` of turns, tolerating a half-written last line. */
function readTurns(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn line loses itself, not the file */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Every turn this workspace has, archived ones first — oldest to newest. */
export function allTurns(workspace) {
  return [
    ...readTurns(paths.archivePath(workspace)),
    ...readTurns(paths.localSessionPath(workspace)),
  ];
}

/** Append turns compaction is about to drop. Never throws; never blocks it. */
export function archiveTurns(workspace, turns) {
  try {
    if (!Array.isArray(turns) || turns.length === 0) return 0;
    const file = paths.ensureParent(paths.archivePath(workspace));
    fs.appendFileSync(file, `${turns.map((t) => JSON.stringify(t)).join('\n')}\n`, 'utf8');
    return turns.length;
  } catch {
    return 0;
  }
}

/** One line of context either side of the hit, clipped. */
function excerpt(text, query, radius = 160) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return text.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + query.length + radius);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

/**
 * Find turns mentioning `query`.
 *
 * Newest first, because the thing you are looking for is usually the most
 * recent time it came up — and capped, because this result is going straight
 * back into a prompt that is already under pressure.
 *
 * @returns {{total: number, shown: Array<{when, role, excerpt, archived}>}}
 */
export function recall(workspace, query, { limit = 5 } = {}) {
  const needle = String(query || '').trim();
  if (!needle) return { total: 0, shown: [] };

  const archived = readTurns(paths.archivePath(workspace));
  const live = readTurns(paths.localSessionPath(workspace));
  const tagged = [
    ...archived.map((t) => ({ turn: t, archived: true })),
    ...live.map((t) => ({ turn: t, archived: false })),
  ];

  const hits = tagged.filter(({ turn }) => {
    const content = typeof turn?.content === 'string' ? turn.content : '';
    return content.toLowerCase().includes(needle.toLowerCase());
  });

  const shown = hits.slice(-limit).reverse().map(({ turn, archived: wasArchived }) => ({
    when: turn.timestamp ? new Date(turn.timestamp).toISOString() : null,
    role: turn.role || 'unknown',
    excerpt: excerpt(String(turn.content || ''), needle),
    archived: wasArchived,
  }));

  return { total: hits.length, shown };
}
