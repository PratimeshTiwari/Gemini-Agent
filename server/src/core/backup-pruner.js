/**
 * Keeping `.agent/backups/` from growing without limit.
 *
 * Every approved edit drops a `<name>.<epoch-ms>.bak` beside the last one, and
 * nothing ever removed them — a long-lived workspace accumulates one per edit,
 * forever. These are a manual safety net only: `DiffEngine.undo()` restores
 * from the diff it still holds in memory, so pruning old copies cannot break
 * it. What matters is keeping the most recent few of each file.
 */

/** How many backups to keep per source file. */
export const KEEP_PER_FILE = 5;

const BACKUP_NAME = /^(.*)\.(\d{10,})\.bak$/;

/**
 * Which of these backup file names are surplus.
 *
 * Grouped by the file they came from, newest first by the timestamp in the
 * name — not by mtime, which a checkout or a copy rewrites.
 *
 * @param {string[]} fileNames - names in one backup directory
 * @param {{keep?: number}} [options]
 * @returns {string[]} names safe to delete, oldest first
 */
export function planBackupPruning(fileNames = [], { keep = KEEP_PER_FILE } = {}) {
  const groups = new Map();

  for (const name of fileNames) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue; // not ours: leave it alone
    const [, source, stamp] = match;
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push({ name, stamp: Number(stamp) });
  }

  const doomed = [];
  for (const entries of groups.values()) {
    if (entries.length <= keep) continue;
    entries.sort((a, b) => b.stamp - a.stamp); // newest first
    doomed.push(...entries.slice(keep).map((entry) => entry.name));
  }

  return doomed;
}
