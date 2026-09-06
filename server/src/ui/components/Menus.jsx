import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { Clickable } from './Clickable.jsx';
import { QuestionPrompt } from './QuestionPrompt.jsx';
import { summarizeDiff, previewRows } from '../diff-preview.js';
import { FOCUS_INPUT } from '../constants.js';

/**
 * Every modal the agent can raise: questions, command approval, plan review,
 * and the /mode, /model, /config and /github pickers.
 *
 * All of them answer through SelectInput rather than raw keypresses — an
 * approval that could be triggered by a stray 'y' in typed text is how edits
 * used to get applied without anyone agreeing to them.
 */
export function Menus({
  activeMenu,
  setActiveMenu,
  agentLoop,
  handleSubmit,
  mode,
  setActiveTab,
  setFocus,
  setHistory,
}) {
  return (
    <>
        {activeMenu?.type === 'ask_question' && (
          <QuestionPrompt
            payload={activeMenu.payload}
            onAnswer={(entries) => {
              setActiveMenu(null);
              agentLoop.answerQuestion(entries);
              const summary = entries.length === 1
                ? `You answered: ${entries[0].answer}`
                : entries.map((e, i) => `${i + 1}. ${e.answer}`).join('  ');
              setHistory(prev => [...prev, { role: 'system', content: `[System: ${summary}]` }]);
              setFocus(FOCUS_INPUT);
            }}
            onCancel={() => {
              setActiveMenu(null);
              agentLoop.cancelQuestion();
              setHistory(prev => [...prev, { role: 'system', content: '[System: You dismissed the question. The agent will proceed on its own assumption.]' }]);
              setFocus(FOCUS_INPUT);
            }}
          />
        )}

        {activeMenu?.type === 'command_approval' && (
          <Box flexDirection="column" borderStyle="single" borderColor={activeMenu.payload.riskLevel === 'critical' ? 'red' : 'yellow'} padding={1}>
            <Text bold color={activeMenu.payload.riskLevel === 'critical' ? 'red' : 'yellow'}>
              ⚠️ Command Execution Request ({activeMenu.payload.riskLevel.toUpperCase()})
            </Text>
            <Text>Command: <Text bold>{activeMenu.payload.command}</Text></Text>
            <Text>Directory: {activeMenu.payload.cwd}</Text>
            <Text>Reason: {activeMenu.payload.riskReason}</Text>
            <SelectInput
              items={[
                { label: 'Allow Command Once', value: 'allow_once' },
                { label: 'Allow Always (Add to Allowlist)', value: 'allow_always' },
                { label: 'Reject Command', value: 'reject' },
                { label: 'Reject Always (Add to Blocklist)', value: 'reject_always' }
              ]}
              onSelect={(item) => {
                setActiveMenu(null);
                agentLoop.answerCommandApproval(item.value, activeMenu.payload.command);
                
                let statusMsg = '';
                if (item.value === 'allow_once') statusMsg = 'allowed once';
                if (item.value === 'allow_always') statusMsg = 'allowed always (added to allowlist)';
                if (item.value === 'reject') statusMsg = 'rejected';
                if (item.value === 'reject_always') statusMsg = 'rejected always (added to blocklist)';
                
                setHistory(prev => [...prev, { role: 'system', content: `[System: You ${statusMsg} the command: ${activeMenu.payload.command}]` }]);
                setFocus(FOCUS_INPUT);
              }}
            />
          </Box>
        )}

        {activeMenu?.type === 'plan_review' && (
          <Box flexDirection="column" borderStyle="single" borderColor="magenta" padding={1}>
            <Text bold color="magenta">📝 Implementation Plan Ready for Review</Text>
            <Text>The agent has created an implementation_plan.md artifact.</Text>
            <SelectInput
              items={[
                { label: 'Proceed with Implementation Plan', value: 'accept' },
                { label: 'Reject', value: 'reject' },
                { label: 'Provide Custom Feedback (Chat)', value: 'custom' }
              ]}
              onSelect={(item) => {
                setActiveMenu(null);
                if (item.value === 'accept') {
                  handleSubmit('I have reviewed the implementation plan and approve it. Please proceed with the execution phase.');
                } else if (item.value === 'reject') {
                  handleSubmit('I reject the implementation plan. Please wait for my feedback.');
                } else {
                  setFocus(FOCUS_INPUT);
                }
              }}
            />
          </Box>
        )}

        {activeMenu?.type === 'mode' && (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
            <Text bold color="cyan">Select Agent Topology Mode:</Text>
            <SelectInput
              items={[
                { label: `Single (Gemini only)${agentLoop.topology === 'single' ? '  ← (Current)' : ''}`, value: 'single' },
                { label: `Duo (Gemini + Reviewer)${agentLoop.topology === 'duo' ? '  ← (Current)' : ''}`, value: 'duo' },
                { label: `Swarm (Gemini + Reasoner + Reviewer)${agentLoop.topology === 'swarm' ? '  ← (Current)' : ''}`, value: 'swarm' }
              ]}
              onSelect={async (item) => {
                setActiveMenu(null);
                await agentLoop.handleSlashCommand('mode', [item.value]);
                setHistory([...agentLoop.conversationHistory]);
                setFocus(FOCUS_INPUT);
              }}
            />
          </Box>
        )}

        {activeMenu?.type === 'model' && (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
            <Text bold color="cyan">Select Model Tier:</Text>
            <Text dimColor>  Tip: Also switch the model in your Gemini browser tab</Text>
            <SelectInput
              items={[
                { label: `⚡ Flash (Fast, minimal reasoning)${agentLoop.modelConfig?.modelTier === 'flash' ? '  ← (Current)' : ''}`, value: 'flash' },
                { label: `🧠 Flash Thinking (Moderate reasoning)${agentLoop.modelConfig?.modelTier === 'flash-thinking' ? '  ← (Current)' : ''}`, value: 'flash-thinking' },
                { label: `🔬 Pro (Deep principal-engineer reasoning)${agentLoop.modelConfig?.modelTier === 'pro' ? '  ← (Current)' : ''}`, value: 'pro' }
              ]}
              onSelect={async (item) => {
                setActiveMenu(null);
                await agentLoop.handleSlashCommand('model', [item.value]);
                setHistory([...agentLoop.conversationHistory]);
                setFocus(FOCUS_INPUT);
              }}
            />
          </Box>
        )}

        {activeMenu?.type === 'reasoning' && (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
            <Text bold color="cyan">🧭 Reasoning level</Text>
            <Text dimColor>How much planning Pro does before it touches anything.</Text>
            <Text dimColor>{'   '}Ignored on the Flash tiers.</Text>
            <SelectInput
              items={[
                { label: `🏃 Brief — investigate, implement, verify${agentLoop.modelConfig?.reasoningLevel === 'brief' ? '  ← (Current)' : ''}`, value: 'brief' },
                { label: `🪜 Standard — decompose into a checklist first${(agentLoop.modelConfig?.reasoningLevel || 'standard') === 'standard' ? '  ← (Current)' : ''}`, value: 'standard' },
                { label: `🔭 Deep — enumerate approaches, then self-review${agentLoop.modelConfig?.reasoningLevel === 'deep' ? '  ← (Current)' : ''}`, value: 'deep' },
              ]}
              onSelect={async (item) => {
                setActiveMenu(null);
                const result = await agentLoop.handleSlashCommand('reasoning', [item.value]);
                setHistory(prev => [...prev, { role: 'system', content: result.message }]);
                setFocus(FOCUS_INPUT);
              }}
            />
          </Box>
        )}

        {activeMenu?.type === 'config_role' && (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
            <Text bold color="cyan">Select Role to Configure:</Text>
            <SelectInput
              items={[
                { label: 'View Current Config', value: 'view' },
                { label: 'Main Agent', value: 'main' },
                { label: 'Reviewer Subagent', value: 'reviewer' },
                { label: 'Reasoner Subagent', value: 'reasoner' }
              ]}
              onSelect={async (item) => {
                if (item.value === 'view') {
                  setActiveMenu(null);
                  await agentLoop.handleSlashCommand('config', []);
                  setHistory([...agentLoop.conversationHistory]);
                  setFocus(FOCUS_INPUT);
                } else {
                  setActiveMenu({ type: 'config_model', role: item.value });
                }
              }}
            />
          </Box>
        )}

        {activeMenu?.type === 'config_model' && (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
            <Text bold color="cyan">Select Model for {activeMenu.role}:</Text>
            <SelectInput
              items={[
                { label: 'Google Gemini', value: 'gemini' },
                { label: 'ChatGPT', value: 'chatgpt' },
                { label: 'Claude', value: 'claude' }
              ]}
              onSelect={async (item) => {
                const role = activeMenu.role;
                setActiveMenu(null);
                await agentLoop.handleSlashCommand('config', [role, item.value]);
                setHistory([...agentLoop.conversationHistory]);
                setFocus(FOCUS_INPUT);
              }}
            />
          </Box>
        )}

        {activeMenu?.type === 'github' && (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
            <Text bold color="cyan">📋 GitHub Integration Menu</Text>
            <SelectInput
              items={[
                { label: 'Refresh PR Activity Now', value: 'refresh' },
                { label: `CI Failure Watch [Currently: ${agentLoop.githubHandler?.config?.enableCIWatch ? 'ON' : 'OFF'}]`, value: 'ci-watch' },
                { label: 'Clear Poller State & Rescan', value: 'clear-state' },
                { label: 'Open PR Dashboard (Ctrl+O)', value: 'dashboard' },
                { label: 'Remove/Update GitHub Token', value: 'remove-token' },
              ]}
              onSelect={(item) => {
                setActiveMenu(null);
                if (item.value === 'dashboard') {
                  setActiveTab('github');
                  setFocus(FOCUS_INPUT);
                } else if (item.value === 'ci-watch') {
                  const current = agentLoop.githubHandler?.config?.enableCIWatch;
                  handleSubmit(`/github ci-watch ${current ? 'off' : 'on'}`);
                } else if (item.value === 'remove-token') {
                  handleSubmit('/github remove-token');
                } else {
                  handleSubmit(`/github ${item.value}`);
                }
              }}
            />
          </Box>
        )}
    </>
  );
}

/**
 * Pending edit approval.
 *
 * Its own SelectInput for the same reason as the rest: an approval that a stray
 * 'y' in typed text could trigger is how edits used to get applied without
 * anyone agreeing to them.
 *
 * It shows the actual change, not just a hunk count — approving an edit you
 * cannot see is not approval. The preview is capped so a large edit cannot push
 * the buttons off screen.
 */
export function DiffApproval({
  diffRequest,
  handleDiffResponse,
  setFocus,
}) {
  if (!diffRequest) return null;

  const hunks = diffRequest.hunks ?? [];
  const { added, removed } = summarizeDiff(hunks);
  const rows = previewRows(hunks, { maxLines: 16 });
  const critical = diffRequest.riskLevel === 'critical';

  const colorFor = { add: 'green', del: 'red', header: 'cyan' };

  return (
    <Box
      borderStyle="round"
      borderColor={critical ? 'red' : 'yellow'}
      paddingX={1}
      flexDirection="column"
      width="100%"
      flexShrink={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={critical ? 'red' : 'yellow'} wrap="truncate-start">
          {diffRequest.isNewFile ? 'Create' : 'Edit'} {diffRequest.filePath}
        </Text>
        <Text>
          <Text color="green">+{added}</Text>
          <Text dimColor> / </Text>
          <Text color="red">-{removed}</Text>
        </Text>
      </Box>

      {diffRequest.riskReason ? (
        <Text dimColor wrap="wrap">{diffRequest.riskReason}</Text>
      ) : null}

      {rows.length > 0 && (
        <Box flexDirection="column" marginY={1}>
          {rows.map((row, i) => (
            <Text
              key={i}
              wrap="truncate"
              dimColor={row.type === 'ctx' || row.type === 'more'}
              color={colorFor[row.type]}
            >
              {row.text}
            </Text>
          ))}
        </Box>
      )}

      <SelectInput
        items={[
          { label: `Approve — write ${hunks.length === 1 ? 'it' : 'all of it'} to disk`, value: 'accept' },
          { label: 'Reject — discard the change', value: 'reject' },
        ]}
        onSelect={(item) => {
          handleDiffResponse(item.value);
          setFocus(FOCUS_INPUT);
        }}
      />
    </Box>
  );
}
