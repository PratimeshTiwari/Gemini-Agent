/**
 * Shaping conversation history into what the transcript draws.
 *
 * A "turn" is one user message and everything the agent did in response; an
 * "action" is one row inside it. Pure functions, so the row rendering can be
 * reasoned about — and tested — without a terminal.
 */

/**
 * Group flat history into turns. Messages are tagged with their index in the
 * flat list on the way through, which callers rely on to address them.
 */
/**
 * Timestamps are read, never invented.
 *
 * This used to fall back to `Date.now()` for a message that carried no
 * timestamp — and `groupTurns` runs on every render, so the fallback moved. A
 * turn opened by an unstamped user message therefore had a start time that
 * crept forward while its end time, taken from a real step, stayed where it
 * was: "Worked for" counted backwards, further from zero the longer the turn
 * sat on screen. A turn that genuinely cannot be timed now says so by leaving
 * these null, which the renderer can act on; a plausible wrong number is worse
 * than a missing one, and is why this went unnoticed.
 */
export function groupTurns(history) {
  const turns = [];
  let currentTurn = null;
  let turnId = 0;
  history.forEach((msg, i) => {
    msg._globalIdx = i;
    if (msg.role === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { id: turnId++, userMsg: msg, steps: [], startTime: msg.timestamp ?? null, endTime: msg.timestamp ?? null };
    } else if (currentTurn) {
      currentTurn.steps.push(msg);
      if (typeof msg.timestamp === 'number') {
        // A turn whose opening message was never stamped still knows when it
        // ran, from the first step that was.
        if (currentTurn.startTime === null) currentTurn.startTime = msg.timestamp;
        currentTurn.endTime = msg.timestamp;
      }
    } else {
      currentTurn = { id: turnId++, userMsg: null, steps: [msg], startTime: msg.timestamp ?? null, endTime: msg.timestamp ?? null };
    }
  });
  if (currentTurn) turns.push(currentTurn);
  return turns;
}

/**
 * The path out of a watcher message, or null.
 *
 * The watcher writes prose (`[System Event] File x/y.js was modified
 * externally by the user.`) and carries no structured field, so the path has
 * to come back out of the sentence. Anchored on both sides rather than
 * greedily, because a path can contain the word `was`.
 *
 * Returns null rather than guessing when the sentence is not that shape,
 * and the row then says how many changed without naming them — which is the
 * honest answer and still shorter than three lines of prose.
 */
export function parseFsEventPath(content) {
  const m = /^\[System Event\] File (.+?) was \w+ externally/.exec(String(content || ''));
  return m ? m[1] : null;
}

/**
 * What a write to the agent's own artifacts actually means.
 *
 * `edit_file` on `.agent/artifacts/task.md` is not a file edit in the sense
 * the user cares about — it is the agent ticking a box, and the system prompt
 * tells it to do that on every turn. Drawn as `⏺ edit_file`, it is
 * indistinguishable from an edit to their source, which is alarming directly
 * after "don't implement anything": two `edit_file` rows appeared on a turn
 * that was explicitly read-only, and both were the checklist.
 *
 * Only `.agent/artifacts/` counts, matched on the path rather than the file
 * name. A bare `task.md` is the user's own file at the workspace root —
 * `isAgentArtifact` resolves it and refuses it the approval exemption, so the
 * transcript must not claim it as the agent's either.
 *
 * @returns {{verb: string, detail: string} | null}
 */
export function describeArtifactWrite(toolName, args) {
  const path = String(args?.path || '');
  if (!/(^|\/)\.agent\/artifacts\//.test(path)) return null;
  const file = path.split('/').pop() || path;

  if (toolName === 'create_file') {
    const items = (String(args.content || '').match(/^\s*[-*]\s*\[[ xX]\]/gm) || []).length;
    if (file === 'task.md' && items > 0) {
      return { verb: 'task list written', detail: `${items} item${items === 1 ? '' : 's'}` };
    }
    return { verb: `${file} written`, detail: '' };
  }

  if (toolName !== 'edit_file') return null;

  // A tick is a line that was `[ ]` and is now `[x]`. Checking both halves is
  // what separates "ticked an item" from "reworded one".
  const ticked = [];
  for (const edit of Array.isArray(args?.edits) ? args.edits : []) {
    const was = /^\s*[-*]\s*\[ \]/m.test(String(edit?.oldText || ''));
    const now = /^\s*[-*]\s*\[[xX]\]\s*(.+)$/m.exec(String(edit?.newText || ''));
    if (was && now) ticked.push(now[1].trim());
  }
  if (ticked.length === 1) return { verb: 'task done', detail: ticked[0] };
  if (ticked.length > 1) return { verb: `${ticked.length} tasks done`, detail: ticked.join(' · ') };
  return { verb: `${file} updated`, detail: '' };
}

export function parseTurnActions(turn) {
  /**
   * One list, in the order the things happened.
   *
   * There used to be two — `actions` and `finalMessages` — and
   * `TranscriptTurn` drew all of the first and then all of the second. So the
   * order on screen was "tools and system rows, then prose", whichever way
   * round they actually occurred. Mostly invisible, because local output and
   * the model's reply are both prose and kept their relative order inside one
   * bucket; visible the moment a file changed on disk *after* the reply, and
   * inherited by every voice added later.
   *
   * `actions` and `finalMessages` are now derived views over this, so they
   * cannot drift from it, and the renderer can stop using them one at a time.
   */
  const items = [];
  const pushAction = (item) => { items.push(item); return item; };
  /** Which step produced the last file event, so a run can be told from a pair. */
  let lastFsStep = -2;

  for (let sIdx = 0; sIdx < turn.steps.length; sIdx++) {
    const msg = turn.steps[sIdx];

    if (msg.role === 'assistant' || msg.role === 'agent') {
      // `<thought>`, not `<think>`. Every tier's prompt asks for `<thought>` —
      // it is the one thing allowed to precede a tool call — and this matched
      // `<think>`, a tag nothing ever asks for. So the model's reasoning was
      // never recognised as reasoning: it went straight into the transcript as
      // raw `<thought>…</thought>`, which is most of what "the output comes out
      // messy with symbols" was.
      //
      // Both spellings, and all of them: a pro turn routinely emits several,
      // and a non-global replace left every block after the first in the prose.
      const THOUGHT = /<(think|thought)>([\s\S]*?)<\/\1>/gi;
      const thoughts = [...msg.content.matchAll(THOUGHT)].map((m) => m[2].trim()).filter(Boolean);
      let cleanContent = msg.content.replace(THOUGHT, '').trim();
      // An unclosed block — the reply was cut off mid-thought — would otherwise
      // leave a bare opening tag and swallow the rest of the message.
      cleanContent = cleanContent.replace(/<(think|thought)>[\s\S]*$/i, '').trim();
      // The trailing "(128KB)" that /image writes has to be part of the match,
      // not left behind: the whole match is what gets cut out of the prose.
      const imgMatch = cleanContent.match(
        /🖼️ Image attached: (.*?\.(?:png|jpe?g|webp))(?:\s*\(\s*\d+\s*KB\s*\))?/i,
      );

      if (imgMatch) {
        cleanContent = cleanContent.replace(imgMatch[0], '').trim();
        pushAction({
          type: 'image',
          id: `turn_${turn.id}_act_${sIdx}_image`,
          content: imgMatch[1],
          msg
        });
      }

      thoughts.forEach((content, i) => {
        pushAction({
          type: 'think',
          id: `turn_${turn.id}_act_${sIdx}_think_${i}`,
          content,
          msg,
        });
      });

      if (cleanContent) {
        // `text` is prose — the model's, or the CLI's when `isLocal` is set.
        // It sits in `items` at the point it was produced, which is the whole
        // reason this list exists.
        items.push({
          type: 'text',
          id: `turn_${turn.id}_act_${sIdx}_text`,
          content: cleanContent,
          msg,
        });
      }
    } else if (msg.type === 'tool_call') {
      const nextMsg = turn.steps[sIdx + 1];
      let result = null;
      let success = null;
      if (nextMsg && nextMsg.type === 'tool_result') {
        result = nextMsg.result;
        success = nextMsg.success;
        sIdx++; // Group tool_result with tool_call into one action
      }
      pushAction({
        type: 'tool',
        id: `turn_${turn.id}_act_${sIdx}`,
        toolName: msg.toolName || msg.name,
        args: msg.args,
        result,
        success,
        msg
      });
    } else if (msg.type === 'tool_result') {
      pushAction({
        type: 'tool_result',
        id: `turn_${turn.id}_act_${sIdx}`,
        result: msg.result,
        success: msg.success,
        msg
      });
    } else if (msg.type === 'fs_event') {
      /**
       * A file moving on disk is not work the agent did.
       *
       * These arrive from `watcher/file-watcher.js` as `role: 'system'`, and
       * the generic system branch below turned each one into an action — so
       * `Worked for 8.1s · 3 actions` on a turn where the agent ran nothing
       * meant "three files changed under us". It also spent three rows of the
       * live budget saying one thing three times.
       *
       * Folded into the previous one when they are adjacent, which they
       * almost always are: a save in an editor touches several files inside a
       * few milliseconds. Adjacent in `steps`, not within a time window — the
       * ordering is what makes them one event, and a window would need a
       * clock in a pure function.
       */
      const prev = items[items.length - 1];
      const path = msg.path || parseFsEventPath(msg.content);
      // Adjacent in `steps`, which is not the same as adjacent in `actions`:
      // a reply between two runs goes to `finalMessages` and leaves no gap
      // here, so folding on the last *action* silently merged runs that were
      // minutes apart. The step index is the only thing that knows.
      if (prev && prev.type === 'fs_event' && lastFsStep === sIdx - 1) {
        if (path && !prev.paths.includes(path)) prev.paths.push(path);
      } else {
        pushAction({
          type: 'fs_event',
          id: `turn_${turn.id}_act_${sIdx}_fs`,
          paths: path ? [path] : [],
          msg,
        });
      }
      lastFsStep = sIdx;
    } else if (msg.role === 'system') {
      if (msg.type === 'command_output') {
        pushAction({
          type: 'command_output',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: msg.content,
          msg
        });
      } else {
        pushAction({
          type: 'system',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: msg.content,
          msg
        });
      }
    }
  }

  // Derived, never accumulated in parallel: two lists that are supposed to
  // agree are two lists that will one day not.
  const actions = items.filter((i) => i.type !== 'text');
  const finalMessages = items.filter((i) => i.type === 'text');
  return { items, actions, finalMessages };
}

/**
 * Fold the agent loop's history into what is already on screen.
 *
 * The transcript must be **append-only**. `<Static>` commits each item to the
 * terminal once and tracks how many it has written by index, so an array that
 * gets shorter — or whose front shifts — makes Ink skip exactly as many items
 * as it lost, permanently. They are not redrawn later; they are simply never
 * drawn.
 *
 * That is what replacing the array with `agentLoop.conversationHistory` did.
 * The loop's history holds only what the model was actually sent, while the
 * screen also carries UI-only messages — a slash command's reply, the "starting
 * a new chat" marker, the extension-reconnect notice. Every replace dropped
 * those, the array got shorter by that many, and the next real turn silently
 * never appeared. The reported symptom was "I sent a prompt and got no
 * response": the reply had arrived, been parsed and been written to
 * `history.jsonl` — it just never reached the screen.
 *
 * Local messages are therefore the thing to preserve, and `isLocal` is what
 * marks them.
 *
 * @param {Array} shownHistory   what the transcript currently holds
 * @param {Array} loopHistory    `agentLoop.conversationHistory`
 * @returns {Array} `shownHistory` itself when there is nothing new, so React
 *                  can skip the render
 */
export function mergeLoopHistory(shownHistory, loopHistory) {
  /**
   * How far into the loop's history the screen has already been drawn.
   *
   * **This was a count, and a count is not an index.** It excluded `isLocal`
   * messages and used the remainder to `slice()` the loop's history, which is
   * only correct if what is on screen mirrors the loop one-for-one, in order.
   * Two things break that, and both are ordinary:
   *
   *  - `watcher/file-watcher.js` appends `[System Event] File X changed` turns
   *    whenever anything on disk moves, so the loop gains turns the screen
   *    never asked for — including *before the session's first prompt*.
   *  - the prompt is echoed to the screen optimistically, so it is on screen
   *    before the loop has it at all.
   *
   * Measured under the pty harness with a file watcher that had been busy:
   * screen held 1 message, the loop held 16 — `[system ×12, user, agent,
   * system, system]`. Slicing from index 1 appended eleven system events and
   * a second copy of the user's own prompt, and the alignment was wrong from
   * there on. The reported symptom was an empty transcript after a turn that
   * had plainly worked.
   *
   * So the position is recorded on the rows themselves. A pointer cannot drift
   * from what it points at, and it needs no resetting when history is cleared
   * because it is cleared along with the rows.
   */
  let consumed = 0;
  for (const m of shownHistory) {
    if (Number.isInteger(m.__loopIndex)) consumed = Math.max(consumed, m.__loopIndex + 1);
  }

  if (loopHistory.length <= consumed) return shownHistory;

  // The optimistic echo and the loop's own copy of the prompt are the same
  // message. Reconciled by claiming the echo rather than appending beside it,
  // and only ever once — asking the same question twice is a thing people do,
  // and it must produce two rows, not one.
  const out = shownHistory.map((m) => ({ ...m }));
  const appended = [];

  for (let i = consumed; i < loopHistory.length; i += 1) {
    const turn = loopHistory[i];
    if (turn.role === 'user') {
      const echo = out.find((m) => m.__echo === true
        && !Number.isInteger(m.__loopIndex)
        && m.content === turn.content);
      if (echo) {
        echo.__loopIndex = i;
        continue;
      }
    }
    appended.push({ ...turn, __loopIndex: i });
  }

  if (appended.length === 0 && out.every((m, i) => m === shownHistory[i])) return shownHistory;
  return [...out, ...appended];
}
