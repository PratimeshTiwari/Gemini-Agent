import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import * as paths from '../../core/paths.js';
import { mergeLoopHistory } from '../transcript.js';
import { FOCUS_INPUT } from '../constants.js';

/**
 * Keep the plan that is about to be replaced.
 *
 * `artifacts/plan.md` is one file the agent overwrites, so asking for a second
 * plan destroyed the first — including one you were part-way through
 * reviewing. Copy, not move: the live path has to keep working for the editor
 * that may already have it open.
 */
function archivePlan(workspace, planPath) {
  try {
    if (!fs.existsSync(planPath)) return;
    const dir = paths.ensureDir(paths.planArchiveDir(workspace));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(planPath, path.join(dir, `${stamp}-${path.basename(planPath)}`));
  } catch {
    /* an archive that fails must not stop the plan being written */
  }
}

/**
 * The bridge AgentLoop calls back into while a turn runs.
 *
 * sendToPanel deliberately ignores response_stream: re-rendering the whole
 * transcript 50+ times a second is what used to tear the terminal, so streamed
 * text is left to the live region and the status line keeps cycling instead.
 */
// Tool-call row ids. These were Date.now(), which collides whenever the agent
// fans out several calls in one tick — the parallel ask_* path does exactly that.
// React then warns about duplicate keys on every render, and both rows share one
// entry in the expanded-log set, so opening one opens the other.
let toolCallSeq = 0;
const nextToolCallId = () => `tc_${Date.now().toString(36)}_${toolCallSeq++}`;

export function buildAgentCallbacks({
  agentLoop,
  isToolRunningRef,
  setActiveMenu,
  setActiveToolCalls,
  setDiffRequest,
  setFocus,
  setHistory,
  setInputAtEnd,
  setIsProcessing,
  setPlanReviewReady,
  setStatus,
  setWalkthroughReady,
  wsServer,
}) {
  return {
    sendToPanel: (msg) => {
      wsServer.broadcast('extension', msg);
      if (msg.type === 'agent_response') {
        // Append what the loop has gained; never replace. See mergeLoopHistory —
        // replacing dropped every UI-only message and took a real turn off the
        // screen with it, because <Static> counts what it has printed by index.
        setHistory((prev) => mergeLoopHistory(prev, agentLoop.conversationHistory));
        setIsProcessing(false);
        setActiveToolCalls([]);
      } else if (msg.type === 'ask_question') {
        setActiveMenu({ type: 'ask_question', payload: msg.payload });
        setFocus(FOCUS_INPUT);
      } else if (msg.type === 'request_command_approval') {
        setActiveMenu({ type: 'command_approval', payload: msg.payload });
        setFocus(FOCUS_INPUT);
      } else if (msg.type === 'status') {
        setStatus(msg.payload.message || 'Processing...');
        isToolRunningRef.current = false;
      } else if (msg.type === 'tool_call') {
        setStatus(`Running ${msg.payload.name}...`);
        isToolRunningRef.current = true;
        setActiveToolCalls(prev => [...prev, { id: nextToolCallId(), type: 'call', name: msg.payload.name, args: msg.payload.args }]);
      } else if (msg.type === 'tool_result') {
        setActiveToolCalls(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last) {
            last.result = msg.payload.result;
            last.success = msg.payload.success;
            
            // `write_to_file` and `TargetFile` used to be tested for here. Neither
            // exists: the tools are `create_file` and `edit_file`, and both take
            // `path`. A name that no tool answers to cannot fire, so the branch
            // was dead and made this read as if a third write tool existed.
            if (last.success && (last.name === 'create_file' || last.name === 'edit_file')) {
              const pathArg = last.args?.path;
              if (pathArg && (pathArg.endsWith('implementation_plan.md') || pathArg.endsWith('plan.md')) && agentLoop.mode === 'plan') {
                archivePlan(agentLoop.workspace, paths.artifactPath(agentLoop.workspace, path.basename(pathArg)));
                setPlanReviewReady(true);
              }
              if (pathArg && pathArg.endsWith('walkthrough.md')) {
                setWalkthroughReady(true);
              }
            }
          }
          return updated;
        });
      } else if (msg.type === 'response_stream') {
        // Intentionally do NOT update status here to prevent UI tearing and scroll glitches
        // caused by re-rendering the entire history component 50+ times per second.
        // This also allows the 'Thinking...' messages to continue cycling during generation!
      }
    },
    injectPrompt: (msg) => {
      const success = wsServer.broadcast('extension', {
        id: crypto.randomUUID(),
        type: 'inject_prompt',
        payload: msg,
        timestamp: Date.now(),
      });
      
      if (!success) {
        try {
          const startUrl = 'https://gemini.google.com/app';
          if (process.platform === 'darwin') exec(`open "${startUrl}"`);
          else if (process.platform === 'win32') exec(`start "" "${startUrl}"`);
          else exec(`xdg-open "${startUrl}"`);
        } catch (e) {}

        agentLoop.isProcessing = false;
        agentLoop.abortExtensionWork();
        setIsProcessing(false);

        // Take the turn back out before asking for it again.
        //
        // `handleUserMessage` pushes the user's message to `conversationHistory`
        // *before* it tries to send, so by the time we get here it is already
        // recorded — and telling someone to "submit your prompt again" then put
        // it in twice. The prompt is handed back to the input box instead, so
        // retyping is not needed at all.
        const dropped = agentLoop.conversationHistory
          .slice().reverse().find((t) => t.role === 'user');
        if (dropped) {
          const at = agentLoop.conversationHistory.lastIndexOf(dropped);
          if (at !== -1) {
            agentLoop.conversationHistory.splice(at, 1);
            // The session file is append-only, so the turn is already in it.
            // Rewriting keeps the two copies agreeing — otherwise `--continue`
            // resurrects a turn that was never sent.
            try { agentLoop.sessionStore?.saveHistory?.(agentLoop.conversationHistory); } catch { /* not worth failing the notice */ }
          }
          setInputAtEnd?.(dropped.content || '');
        }

        setHistory(prev => [
          ...prev,
          // `isLocal`, like every other UI-only message: it is not in
          // `conversationHistory`, and counting it as loop history shifts
          // `mergeLoopHistory` by one and costs a turn on screen.
          {
            role: 'assistant',
            isLocal: true,
            timestamp: Date.now(),
            content: '⚠️ **Gemini Extension Reconnecting…**\n\nOpened '
              + '`https://gemini.google.com/app` in your browser. Your prompt is back in '
              + 'the input box — press enter once the tab is up.',
          },
        ]);
      }
    },
    requestDiffApproval: (diff) => {
      setDiffRequest(diff);
      setIsProcessing(false);
    }
  };
}
