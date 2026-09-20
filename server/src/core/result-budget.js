/**
 * A shared ceiling for the tool results of one prompt.
 *
 * `buildToolResultBatch` embeds every result in the next prompt and capped
 * nothing. The per-tool caps that exist do not compose: `run_command` allows
 * **50 KB each**, and `_executeToolCalls` runs calls in parallel, so five
 * commands is 250 KB typed into a browser composer by a content script — in the
 * project whose entire prompt strategy exists to avoid large payloads, because
 * a large repeated payload is what trips Gemini's repetition and A/B filters.
 *
 * The ceiling belongs at the batch, not as another per-tool number. One call
 * cannot know what the others are about to return.
 *
 * **Divided fairly, never first-come.** The obvious implementation spends the
 * budget in order and truncates whatever is left, so one enormous `run_command`
 * at position 0 starves four small reads that would each have fitted. This is
 * max-min fair allocation: everyone gets an equal share, anyone who wants less
 * than their share takes what they need and releases the rest, and the
 * remainder is split again among those still asking. It repeats until nothing
 * more is released, which is at most one pass per result.
 *
 * Nothing here truncates anything. It answers "how many characters may each
 * result have", and the caller decides what to do with the answer — which is
 * what makes it testable without a filesystem.
 */

/**
 * Characters allowed per result, in the order given.
 *
 * @param {number[]} sizes - the length of each result
 * @param {number} budget - total characters available to all of them
 * @returns {number[]} one allowance per result; `>= sizes[i]` means untouched
 */
export function allocate(sizes, budget) {
  const n = sizes.length;
  if (!n) return [];
  if (!(budget > 0)) return sizes.map(() => 0);

  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) return [...sizes];

  const allowance = new Array(n).fill(0);
  const open = sizes.map((_, i) => i);
  let left = budget;

  while (open.length) {
    const share = Math.floor(left / open.length);
    // Everyone still asking wants more than an equal share, so an equal share
    // is the answer and there is nothing further to redistribute.
    if (share === 0 || open.every((i) => sizes[i] >= share)) {
      for (const i of open) allowance[i] = share;
      break;
    }
    const fitting = open.filter((i) => sizes[i] < share);
    for (const i of fitting) {
      allowance[i] = sizes[i];
      left -= sizes[i];
    }
    const still = open.filter((i) => sizes[i] >= share);
    open.length = 0;
    open.push(...still);
  }

  return allowance;
}

/**
 * Keep the head **and** the tail of an over-long result.
 *
 * Head-only is the intuitive cut and the wrong one: a failing command's whole
 * value is in the last few lines, and truncating from the end throws away the
 * reason it failed. A model handed the first 40 lines of a stack trace will
 * confidently diagnose the wrong thing.
 *
 * Lines rather than characters, because a result cut mid-token reads as
 * corruption rather than as an excerpt.
 *
 * @param {string} text
 * @param {number} allowance - characters this result may occupy
 * @param {string} [note] - appended to the marker, e.g. where the full copy is
 */
export function headAndTail(text, allowance, note = '') {
  if (typeof text !== 'string' || text.length <= allowance) return text;

  const marker = (cut) => `\n… ${cut.toLocaleString()} characters cut${note ? `; ${note}` : ''} …\n`;
  const room = allowance - marker(text.length).length;
  // Not enough room to say anything useful: say only that it was cut. A marker
  // longer than the excerpt it introduces is worse than no excerpt.
  if (room <= 0) return marker(text.length).trim();

  // Two thirds head, one third tail. The head says what was being done; the
  // tail says how it ended, and the end is the part that is usually the answer.
  const headRoom = Math.floor(room * 0.66);
  const tailRoom = room - headRoom;

  const lines = text.split('\n');
  const head = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > headRoom) break;
    head.push(line);
    used += line.length + 1;
  }

  const tail = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (used + lines[i].length + 1 > tailRoom) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }

  /**
   * A line longer than the allowance is still content.
   *
   * Cutting on line boundaries reads better, and it returns **nothing at all**
   * when no whole line fits — one 53,000-character line and a 16,000-character
   * allowance produced a 36-character marker and no text. Minified JavaScript,
   * a single-line JSON blob and a long log line all look like that, and the
   * first one of those cost a real turn: a `read_file` came back as a marker,
   * and the model gave up on the file rather than paging it.
   *
   * The tests used many short lines, so they never saw it. Characters are the
   * fallback because an ugly excerpt beats no excerpt.
   */
  if (!head.length && !tail.length) {
    const cut = text.length - room;
    return `${text.slice(0, headRoom)}${marker(cut)}${text.slice(-tailRoom)}`;
  }

  const cut = text.length - head.join('\n').length - tail.join('\n').length;
  return `${head.join('\n')}${marker(cut)}${tail.join('\n')}`;
}

/**
 * How many spooled results to keep.
 *
 * They exist so the model can `read_file` what a cut removed, and it only ever
 * wants the current turn's. Keeping a few more covers a model that comes back
 * to one a round or two later; keeping them forever turns `.agent/tmp/` into a
 * directory that grows once per over-budget batch, for the life of a workspace.
 *
 * Same reasoning as `backup-pruner.js`, and the same shape: decide here, delete
 * in the caller, so the decision is testable without a filesystem.
 */
export const KEEP_SPOOLS = 20;

/** The prefix that marks a file in `.agent/tmp/` as one of ours. */
const SPOOL_NAME = /^([a-z_]+)-([0-9a-z]+)-[0-9a-f]{6}\.txt$/;

/**
 * Which spooled result files are surplus.
 *
 * Ordered by the base-36 timestamp in the name rather than by mtime, which a
 * checkout or a copy rewrites — the lesson `backup-pruner` already encodes.
 * Anything that is not ours is left alone: `.agent/tmp/` also holds clipboard
 * images, and a pruner that deletes files it does not recognise is a pruner
 * nobody can safely add a file beside.
 *
 * @param {string[]} fileNames
 * @param {{keep?: number}} [options]
 * @returns {string[]} names safe to delete, oldest first
 */
export function planSpoolPruning(fileNames = [], { keep = KEEP_SPOOLS } = {}) {
  const ours = [];
  for (const name of fileNames) {
    const m = SPOOL_NAME.exec(name);
    if (!m) continue;
    ours.push({ name, stamp: parseInt(m[2], 36) });
  }
  if (ours.length <= keep) return [];
  ours.sort((a, b) => b.stamp - a.stamp);
  return ours.slice(keep).map((e) => e.name).reverse();
}
