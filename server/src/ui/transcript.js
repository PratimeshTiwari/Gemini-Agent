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

/** Dense list of everything ↑/↓ can land on, in screen order. */
export function collectFocusableItems(interactiveTurns, activeToolCalls) {
  const focusableItems = [];

  interactiveTurns.forEach(turn => {
    const hasActions = turn.steps.some(m => m.type === 'tool_call' || m.type === 'tool_result' || m.role === 'system' || (m.role === 'assistant' && m.content.includes('<think>')));
    if (hasActions) {
      focusableItems.push({ type: 'turn_actions', id: `turn_${turn.id}`, turnId: turn.id, turn });
    }
  });

  activeToolCalls.forEach((call, idx) => {
    focusableItems.push({ type: 'activeCall', sourceIdx: idx, id: call.id, call });
  });

  return focusableItems;
}

export function parseTurnActions(turn) {
  const actions = [];
  const finalMessages = [];

  for (let sIdx = 0; sIdx < turn.steps.length; sIdx++) {
    const msg = turn.steps[sIdx];

    if (msg.role === 'assistant' || msg.role === 'agent') {
      const thinkMatch = msg.content.match(/<think>([\s\S]*?)<\/think>/);
      let cleanContent = msg.content.replace(/<think>[\s\S]*?<\/think>/, '').trim();
      const imgMatch = cleanContent.match(/🖼️ Image attached: (.*?\.png|.*?\.jpg|.*?\.jpeg|.*?\.webp)/);

      if (imgMatch) {
        cleanContent = cleanContent.replace(imgMatch[0], '').trim();
        actions.push({
          type: 'image',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: imgMatch[1],
          msg
        });
      }

      if (thinkMatch) {
        actions.push({
          type: 'think',
          id: `turn_${turn.id}_act_${sIdx}`,
          content: thinkMatch[1].trim(),
          msg
        });
      }

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
