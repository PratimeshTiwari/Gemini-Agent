import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { prompt, clearPromptCache } from './prompt-loader.js';
import { PromptBuilder } from './prompt-builder.js';
import { EFFORT_LEVELS } from './effort.js';

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

test('prompt()', async (t) => {
  await t.test('reads a file that exists', () => {
    assert.match(prompt('pro-guardrails'), /ANTI-HALLUCINATION GUARDRAILS/);
  });

  // A system prompt quietly missing its reasoning protocol is the kind of fault
  // that looks like the model got worse, so this must be loud and immediate.
  await t.test('a missing file throws rather than returning nothing', () => {
    assert.throws(() => prompt('no-such-prompt'), /Missing prompt file/);
  });

  await t.test('the same file comes back the same', () => {
    assert.equal(prompt('core-flash'), prompt('core-flash'));
    clearPromptCache();
    assert.match(prompt('core-flash'), /^## Rules/);
  });
});

test('the prompt files themselves', async (t) => {
  const files = fs.readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md'));

  await t.test('there are some, and every one loads', () => {
    assert.ok(files.length >= 5, `${files.length} prompt files`);
    for (const f of files) assert.ok(prompt(path.basename(f, '.md')).length > 0, f);
  });

  // The whole point of moving prose out of template literals is that markdown
  // has no escaping rules. A `${` that survived the move would be sent to the
  // model verbatim, which is a silently corrupted prompt.
  await t.test('none contains a template placeholder', () => {
    for (const f of files) {
      const body = fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf8');
      assert.doesNotMatch(body, /\$\{/, `${f} still has an interpolation in it`);
    }
  });

  await t.test('none is empty or whitespace', () => {
    for (const f of files) {
      assert.ok(fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf8').trim().length > 0, f);
    }
  });
});

// The move was verified byte-for-byte against the previous implementation at
// the time. This is the guard that keeps it that way: every rung must still
// produce a prompt with the parts that rung is supposed to have.
test('every effort level still assembles a complete prompt', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));

  for (const level of EFFORT_LEVELS) {
    await t.test(level.id, () => {
      const p = new PromptBuilder(ws, ws)
        .buildPrompt({ userMessage: 'x', mode: 'auto', topology: 'single', modelConfig: { effort: level.id } });

      assert.match(p, /<system_instructions>/);
      assert.match(p, /## Tool Call Format/, 'the tool call format is missing');
      assert.match(p, /read_file/, 'the tool definitions are missing');

      if (level.tier === 'pro') {
        assert.match(p, /PRINCIPAL ENGINEER/);
        assert.match(p, /ANTI-HALLUCINATION GUARDRAILS/, 'guardrails came from a file and did not arrive');
      }
      if (level.level === 'brief') assert.doesNotMatch(p, /RESTATE AND DECOMPOSE/);
      if (level.level === 'standard' || level.level === 'deep') {
        assert.match(p, /RESTATE AND DECOMPOSE/, 'plan-first came from a file and did not arrive');
      }
      assert.doesNotMatch(p, /\$\{/, 'an interpolation leaked into the prompt');
    });
  }
});
