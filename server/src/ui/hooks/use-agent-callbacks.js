import crypto from 'crypto';
import { exec } from 'child_process';
import { FOCUS_INPUT } from '../constants.js';

/**
 * The bridge AgentLoop calls back into while a turn runs.
 *
 * sendToPanel deliberately ignores response_stream: re-rendering the whole
 * transcript 50+ times a second is what used to tear the terminal, so streamed
 * text is left to the live region and the status line keeps cycling instead.
 */
export function buildAgentCallbacks({
  agentLoop,
  isToolRunningRef,
  setActiveMenu,
  setActiveToolCalls,
  setDiffRequest,
  setFocus,
  setHistory,
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
        setHistory([...agentLoop.conversationHistory]);
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
        setActiveToolCalls(prev => [...prev, { id: Date.now().toString(), type: 'call', name: msg.payload.name, args: msg.payload.args }]);
      } else if (msg.type === 'tool_result') {
        setActiveToolCalls(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last) {
            last.result = msg.payload.result;
            last.success = msg.payload.success;
            
            if (last.success && (last.name === 'create_file' || last.name === 'edit_file' || last.name === 'write_to_file')) {
              const pathArg = last.args?.path || last.args?.TargetFile;
              if (pathArg && (pathArg.endsWith('implementation_plan.md') || pathArg.endsWith('plan.md')) && agentLoop.mode === 'plan') {
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
        setIsProcessing(false);
        setHistory(prev => [
          ...prev, 
          { role: 'assistant', content: '⚠️ **Gemini Extension Reconnecting...**\n\nAutomatically launched `https://gemini.google.com/app` in your browser. Once the tab opens, please submit your prompt again.' }
        ]);
      }
    },
    requestDiffApproval: (diff) => {
      setDiffRequest(diff);
      setIsProcessing(false);
    }
  };
}
