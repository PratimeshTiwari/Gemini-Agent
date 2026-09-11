/**
 * Checking a tool call against the schema the prompt promised.
 *
 * `TOOL_DEFINITIONS` declares parameters per tool and `PromptBuilder` renders
 * them into the system prompt as *the contract* — "path (string, required)".
 * Nothing then checked the call against it. `_extractToolCalls` did
 * `_cleanJsonString` → `JSON.parse` → dispatch, so a missing or wrong-typed
 * argument reached the handler and failed somewhere inside it, with a message
 * written for a developer reading a stack trace rather than for a model
 * deciding what to send next.
 *
 * There is no tool-call API here — the call is parsed out of prose — so this is
 * the layer that has to do what a real one would. Two jobs:
 *
 *  1. **Coerce what is obviously meant.** Models emit `"10"` for a number often
 *     enough that treating it as a failure is throwing away a working turn.
 *  2. **Fail with something actionable.** The message names the tool, the
 *     parameter, what was expected and what arrived, because the model's next
 *     move is decided entirely by that sentence.
 *
 * Booleans are deliberately *not* coerced the way numbers are: `Boolean("false")`
 * is `true`, so a model writing `"false"` would get the opposite of what it
 * asked for — silently, and in the one case where it matters most (`isRegex`,
 * `recursive`). The strings are handled explicitly instead.
 */

import { z } from 'zod';

/** Extra keys are kept, not rejected: an unknown argument is harmless noise. */
const BOOLEAN_WORDS = { true: true, false: false, yes: true, no: false, '1': true, '0': false };

const looseBoolean = z.preprocess((value) => {
  if (typeof value === 'string') {
    const word = BOOLEAN_WORDS[value.trim().toLowerCase()];
    if (word !== undefined) return word;
  }
  return value;
}, z.boolean());

/** A `z` schema for one declared parameter. */
function schemaForType(type) {
  switch (type) {
    case 'number':
      // `.coerce` turns "10" into 10 but leaves "abc" as a real failure.
      return z.coerce.number();
    case 'boolean':
      return looseBoolean;
    case 'array':
      // A single value where a list was asked for is what the model means.
      return z.preprocess((v) => (v !== undefined && !Array.isArray(v) ? [v] : v), z.array(z.any()));
    case 'object':
      return z.object({}).passthrough();
    case 'string':
    default:
      return z.string();
  }
}

/**
 * Build a schema from a tool's declared `parameters` block.
 *
 * @param {Record<string, {type?: string, required?: boolean}>} parameters
 */
export function schemaFor(parameters = {}) {
  const shape = {};
  for (const [name, spec] of Object.entries(parameters || {})) {
    const base = schemaForType(spec?.type);
    shape[name] = spec?.required ? base : base.optional();
  }
  return z.object(shape).passthrough();
}

/** `path (string, required)` — the same phrasing the prompt used. */
function describe(name, spec) {
  return `\`${name}\` (${spec?.type || 'string'}${spec?.required ? ', required' : ', optional'})`;
}

/** What actually arrived, so the model can see its own mistake. */
function describeValue(value) {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * Validate and coerce one tool call.
 *
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
export function validateArgs(toolName, parameters, args) {
  const spec = parameters || {};
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

  const result = schemaFor(spec).safeParse(input);
  if (result.success) return { ok: true, value: result.data };

  const problems = [];
  for (const issue of result.error.issues) {
    const name = issue.path[0];
    const declared = spec[name];
    const got = input[name];
    if (got === undefined && declared?.required) {
      problems.push(`${describe(name, declared)} is required but was not given`);
    } else {
      problems.push(`${describe(name, declared)} got ${describeValue(got)}`);
    }
  }

  // Which parameters exist at all: half of these failures are a guessed name,
  // and the model cannot see the schema again until the next refresh turn.
  const known = Object.entries(spec).map(([n, s]) => describe(n, s)).join(', ');
  const given = Object.keys(input);

  return {
    ok: false,
    message: `${toolName} was called with arguments that do not match its schema.\n`
      + `  ${problems.join('\n  ')}\n`
      + `Parameters: ${known || '(none)'}\n`
      + `You sent: ${given.length ? given.join(', ') : '(none)'}\n`
      + 'Fix the arguments and call it again. Do not apologise or change tools.',
  };
}
