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
export function groupTurns(history) {
  const turns = [];
  let currentTurn = null;
  let turnId = 0;
  history.forEach((msg, i) => {
    msg._globalIdx = i;
    if (msg.role === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { id: turnId++, userMsg: msg, steps: [], startTime: msg.timestamp || Date.now(), endTime: msg.timestamp || Date.now() };
    } else if (currentTurn) {
      currentTurn.steps.push(msg);
      currentTurn.endTime = msg.timestamp || currentTurn.endTime;
    } else {
      currentTurn = { id: turnId++, userMsg: null, steps: [msg], startTime: msg.timestamp || Date.now(), endTime: msg.timestamp || Date.now() };
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
