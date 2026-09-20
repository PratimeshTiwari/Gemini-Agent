/**
 * Tools: find_symbol, find_references
 *
 * The structural half of working in a codebase, and the half grep is worst at.
 * `grep_search` finds the string `resolveEffort`; it cannot tell the definition
 * from the forty call sites, and it cannot tell either from the word in a
 * comment. See `context/symbol-index.js` for why this is acorn rather than an
 * embedding index, ctags or tree-sitter.
 *
 * Both tools group by file and cap what comes back, for the reason
 * `grep_search` learned: every character returned is retyped into a browser
 * chat tab on the next turn, and fifty flat rows repeat the path fifty times.
 */

import { symbolIndex } from '../../context/symbol-index.js';

/** Results past this are a wall of text the model will not read. */
const MAX_HITS = 60;

/**
 * What could not be indexed, said out loud.
 *
 * The failure that matters is not a missing feature, it is the model searching,
 * finding nothing, and concluding the symbol does not exist. If TypeScript or
 * an unparseable file was skipped, the answer is "not found *here*", and the
 * next move is `grep_search` rather than a wrong conclusion.
 */
function coverage(index) {
  if (index.skipped.length === 0) return '';
  const byReason = new Map();
  for (const s of index.skipped) {
    byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
  }
  const parts = [...byReason.entries()].map(([reason, n]) => `${n} ${reason}`);
  return `Not covered: ${parts.join(', ')}. Use grep_search for those.`;
}

export async function findSymbol(args, context) {
  const { name } = args;
  const index = symbolIndex(context.workspace);
  const hits = index.find(name);

  if (hits.length === 0) {
    return {
      name,
      found: 0,
      filesIndexed: index.indexed,
      message: `No definition of "${name}" in ${index.indexed} indexed files. `
        + (coverage(index) || 'Try grep_search — it may be a property, a string, or in a comment.'),
    };
  }

  return {
    name,
    found: hits.length,
    filesIndexed: index.indexed,
    definitions: hits.slice(0, MAX_HITS),
    ...(hits.length > MAX_HITS ? { truncated: hits.length - MAX_HITS } : {}),
    ...(coverage(index) ? { note: coverage(index) } : {}),
  };
}

export async function findReferences(args, context) {
  const { name, includeDefinition = true } = args;
  const index = symbolIndex(context.workspace);
  const definitions = index.find(name);
  const defs = new Set(definitions.map((d) => `${d.file}:${d.line}`));

  /**
   * A method is only ever called as `x.name()`, so for one of those the member
   * uses are not noise — they are the entire answer.
   *
   * Without this, `find_references` returned **0** for every method in the
   * repo: `buildToolResultBatch` 0 against 2 real call sites, `acceptDiff` 0
   * against 3 — under a message reading "It may be dead code", which is an
   * invitation to delete something called everywhere.
   *
   * Gated on the name being *defined* as a method here, rather than always on,
   * because `obj.name` is ambiguous by nature. Measured on this repo: turning
   * it on unconditionally makes `find_references("map")` 165 rows of `.map(`
   * and `join` 180 — a wall of text about `Array.prototype`, every character
   * of which is retyped into a browser next turn. `map` and `join` are not
   * defined here, so the gate excludes them and keeps the names people
   * actually ask about.
   */
  const isMethod = definitions.some((d) => d.kind === 'method');

  let hits = index.references(name, { includeMembers: isMethod });
  if (!includeDefinition) {
    hits = hits.filter((h) => !defs.has(`${h.file}:${h.line}`));
  } else {
    /**
     * A method's definition is not a *use* of it, so `referencesIn` never
     * emitted one — `class X { foo() {} }` has `foo` as a non-computed
     * `MethodDefinition` key, which is deliberately not visited.
     *
     * The prompt says otherwise: "list the definition too (default true)" and
     * "the definition is marked". So for a function, whose `id` really is an
     * Identifier, the definition appeared; for a method it never did, and the
     * tool quietly did not do the thing its own description promised. Adding
     * it here rather than in `referencesIn` keeps that function answering the
     * one question it is good at.
     */
    const have = new Set(hits.map((h) => `${h.file}:${h.line}`));
    for (const d of definitions) {
      const at = `${d.file}:${d.line}`;
      if (have.has(at)) continue;
      have.add(at);
      hits.push({ file: d.file, line: d.line, column: 1, text: index.sourceLine(d.file, d.line) });
    }
    hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  if (hits.length === 0) {
    return {
      name,
      found: 0,
      filesIndexed: index.indexed,
      message: `No uses of "${name}" in ${index.indexed} indexed files. `
        + (coverage(index) || 'It may be dead code, or reached by a computed name.'),
    };
  }

  // Grouped by file, busiest first: on a large repo the module that owns a
  // concept is usually the one that mentions it most.
  const byFile = new Map();
  for (const hit of hits.slice(0, MAX_HITS)) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, []);
    byFile.get(hit.file).push({
      line: hit.line,
      text: hit.text.slice(0, 160),
      ...(defs.has(`${hit.file}:${hit.line}`) ? { isDefinition: true } : {}),
      // `x.name` rather than a bare `name`. Marked because a same-named method
      // on a different object is indistinguishable from here, and an answer
      // that hides that ambiguity is worse than one that states it.
      ...(hit.member ? { viaMember: true } : {}),
    });
  }

  return {
    name,
    found: hits.length,
    filesIndexed: index.indexed,
    files: [...byFile.entries()]
      .map(([file, lines]) => ({ file, count: lines.length, lines }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)),
    ...(hits.length > MAX_HITS ? { truncated: hits.length - MAX_HITS } : {}),
    ...(isMethod ? {
      methodNote: `"${name}" is a method here, so \`x.${name}\` uses are included and marked `
        + '`viaMember`. Those could be a same-named method on another object — check the line '
        + 'before treating one as a call to this definition.',
    } : {}),
    ...(coverage(index) ? { note: coverage(index) } : {}),
  };
}
