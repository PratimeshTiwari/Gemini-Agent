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

export function parseTurnActions(turn) {
  const actions = [];
  const finalMessages = [];

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
        actions.push({
          type: 'image',
          id: `turn_${turn.id}_act_${sIdx}_image`,
          content: imgMatch[1],
          msg
        });
      }

      thoughts.forEach((content, i) => {
        actions.push({
          type: 'think',
          id: `turn_${turn.id}_act_${sIdx}_think_${i}`,
          content,
          msg,
        });
      });

      if (cleanContent) {
        finalMessages.push({
          type: 'text',
          content: cleanContent,
          msg
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
      actions.push({
        type: 'tool',
        id: `turn_${turn.id}_act_${sIdx}`,
        toolName: msg.toolName || msg.name,
        args: msg.args,
        result,
        success,
        msg
      });
    } else if (msg.type === 'tool_result') {
      actions.push({
        type: 'tool_result',
        id: `turn_${turn.id}_act_${sIdx}`,
        result: msg.result,
        success: msg.success,
        msg
      });
    } else if (msg.role === 'system') {
      if (msg.type === 'command_output') {
        actions.push({
          type: 'command_output',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: msg.content,
          msg
        });
      } else {
        actions.push({
          type: 'system',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: msg.content,
          msg
        });
      }
    }
  }

  return { actions, finalMessages };
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
  // How much of the loop's history is already on screen. Counted by excluding
  // the local messages rather than by tracking an index, because a counter has
  // to be reset in every place history is cleared and missing one brings this
  // straight back.
  const alreadyShown = shownHistory.reduce((n, m) => (m.isLocal ? n : n + 1), 0);

  if (loopHistory.length <= alreadyShown) return shownHistory;
  return [...shownHistory, ...loopHistory.slice(alreadyShown)];
}
