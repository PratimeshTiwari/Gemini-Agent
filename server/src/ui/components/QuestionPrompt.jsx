import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { normalizeQuestionSet, FREEFORM_VALUE } from '../question.js';

/**
 * The agent's `ask_question` prompt.
 *
 * Four things the old picker lacked and the agent loop needed: a way to answer
 * something the model didn't think of, a way to decline (the loop blocks on
 * `pendingQuestionResolve`, so "no answer" used to mean "hang"), the
 * description of whatever option is under the cursor, and more than one
 * question per prompt — three questions used to cost three round trips through
 * the browser tab.
 *
 * InputBar hides itself whenever a menu is up, so this owns the keyboard while
 * it is mounted and there is no second useInput competing for the same keys.
 */
export function QuestionPrompt({ payload, onAnswer, onCancel }) {
  const questions = normalizeQuestionSet(payload);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState([]);
  const current = questions[step];
  // With no usable options there is nothing to pick, so go straight to typing.
  const [typing, setTyping] = useState(current.options.length === 0);
  const [draft, setDraft] = useState('');
  const [highlighted, setHighlighted] = useState(null);

  useInput((input, key) => {
    if (!key.escape) return;
    // Esc backs out of the text field first, then dismisses the whole batch.
    if (typing && current.options.length > 0) {
      setTyping(false);
      setDraft('');
      return;
    }
    onCancel();
  });

  const record = (answer) => {
    const next = [...answers, { question: current.question, answer }];
    if (step + 1 >= questions.length) {
      onAnswer(next);
      return;
    }
    setAnswers(next);
    setStep(step + 1);
    setTyping(questions[step + 1].options.length === 0);
    setDraft('');
    setHighlighted(null);
  };

  const items = [
    ...current.options.map((option, i) => ({
      key: `opt-${i}`,
      label: `${i + 1}. ${option.label}`,
      value: option.value,
      description: option.description,
    })),
    { key: 'freeform', label: '✎ Something else…', value: FREEFORM_VALUE, description: 'Type your own answer.' },
  ];

  const active = highlighted ?? items[0];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="cyan">{current.header}</Text>
        {questions.length > 1 && (
          <Text dimColor>{step + 1} of {questions.length}</Text>
        )}
      </Box>
      <Box marginBottom={1}><Text wrap="wrap">{current.question}</Text></Box>

      {/* What has already been answered, so the batch reads as one exchange. */}
      {answers.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {answers.map((entry, i) => (
            <Text key={i} dimColor wrap="truncate">✓ {entry.answer}</Text>
          ))}
        </Box>
      )}

      {!typing && (
        <>
          <SelectInput
            key={step}
            items={items}
            onHighlight={(item) => setHighlighted(item)}
            onSelect={(item) => {
              if (item.value === FREEFORM_VALUE) {
                setTyping(true);
                return;
              }
              record(item.value);
            }}
          />
          {active?.description ? (
            <Box marginTop={1}><Text dimColor wrap="wrap">{active.description}</Text></Box>
          ) : null}
          <Box marginTop={1}>
            <Text dimColor>↑↓ move · enter select · esc dismiss</Text>
          </Box>
        </>
      )}

      {typing && (
        <>
          <Box>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={() => {
                const answer = draft.trim();
                if (!answer) return; // Enter on an empty field would answer with nothing.
                record(answer);
              }}
              placeholder="Type your answer"
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              enter submit · esc {current.options.length > 0 ? 'back to options' : 'dismiss'}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
