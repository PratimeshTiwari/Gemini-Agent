/**
 * Prompt text, kept in files instead of template literals.
 *
 * `prompt-builder.js` was 1,035 lines, and roughly two thirds of that was
 * English inside backticks. Two concrete problems with that, neither of them
 * aesthetic:
 *
 * **A prompt change is invisible in a diff.** Reword one line of the reasoning
 * protocol and it shows up as a modified line inside a template literal in a
 * very large file, indistinguishable from a logic change. That file is also the
 * one CLAUDE.md warns in capitals never to bulk-edit with a regex, because a
 * greedy pattern silently removed three tool definitions — twice.
 *
 * **Template literals have escaping rules and prose does not.** A single
 * unescaped backtick in that file ends the string and the failure surfaces
 * somewhere else entirely, as `ReferenceError: memory is not defined` from an
 * unrelated function. Markdown has no such trap.
 *
 * Only *static* prose moves here. Anything the builder computes — tiers,
 * topologies, the reviewer's name, phase numbering that shifts with the
 * reasoning level — stays in JavaScript, because that is logic and it belongs
 * where logic is read. A markdown file full of `${isBrief ? '2' : '3'}` would
 * be worse than what it replaced.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

// Read once. These are static files that ship with the agent, and buildPrompt
// is on the hot path of every turn.
const cache = new Map();

/**
 * The text of `prompts/<name>.md`, with trailing whitespace trimmed.
 *
 * A missing file throws at the first prompt rather than silently sending the
 * model a prompt with a hole in it — a system prompt quietly missing its
 * reasoning protocol is the kind of fault that looks like the model got worse.
 *
 * @param {string} name - file name without the extension
 * @returns {string}
 */
export function prompt(name) {
  if (cache.has(name)) return cache.get(name);

  const file = join(PROMPTS_DIR, `${name}.md`);
  let text;
  try {
    text = readFileSync(file, 'utf-8').trimEnd();
  } catch (err) {
    throw new Error(`Missing prompt file ${name}.md (${file}): ${err.message}`);
  }

  cache.set(name, text);
  return text;
}

/** Forget the cache. Tests only — the files do not change at runtime. */
export function clearPromptCache() {
  cache.clear();
}
