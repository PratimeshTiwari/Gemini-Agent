/**
 * Turning a pending diff into something the approval prompt can draw.
 *
 * The approval box used to show a file path and a hunk count, which is not
 * enough to approve on: you either trusted it blindly or rejected and asked to
 * see the change. These build the same unified diff the engine produced, capped
 * so a large edit cannot push the prompt itself off screen.
 *
 * Hunk lines arrive in unified-diff form — '+added', '-removed', ' context' —
 * exactly as `core/diff-engine.js` stores them.
 */

/** @returns {{hunks: number, added: number, removed: number}} */
export function summarizeDiff(hunks = []) {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk?.lines ?? []) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { hunks: hunks.length, added, removed };
}

const rowFor = (line) => {
  if (line.startsWith('+')) return { type: 'add', text: line };
  if (line.startsWith('-')) return { type: 'del', text: line };
  return { type: 'ctx', text: line };
};

/**
 * Flatten hunks into display rows, truncated to `maxLines`.
 *
 * Context lines are the first thing dropped when a hunk is too long: they are
 * there for orientation, and the +/- lines are what is being approved.
 *
 * @returns {Array<{type: 'header'|'add'|'del'|'ctx'|'more', text: string}>}
 */
export function previewRows(hunks = [], { maxLines = 16 } = {}) {
  const rows = [];
  let shown = 0;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (shown >= maxLines) {
      rows.push({ type: 'more', text: `… ${hunks.length - i} more hunk${hunks.length - i === 1 ? '' : 's'}` });
      break;
    }

    rows.push({
      type: 'header',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });

    const lines = hunk?.lines ?? [];
    const budget = maxLines - shown;
    let body = lines.map(rowFor);
    if (body.length > budget) {
      // Keep the changes, drop the orientation.
      const changes = body.filter((row) => row.type !== 'ctx');
      body = (changes.length <= budget ? changes : changes.slice(0, budget));
      const dropped = lines.length - body.length;
      rows.push(...body);
      shown += body.length;
      if (dropped > 0) rows.push({ type: 'more', text: `… ${dropped} more line${dropped === 1 ? '' : 's'}` });
    } else {
      rows.push(...body);
      shown += body.length;
    }
  }

  return rows;
}
