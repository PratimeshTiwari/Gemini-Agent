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
  const defs = new Set(index.find(name).map((d) => `${d.file}:${d.line}`));

  let hits = index.references(name);
  if (!includeDefinition) hits = hits.filter((h) => !defs.has(`${h.file}:${h.line}`));

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
    ...(coverage(index) ? { note: coverage(index) } : {}),
  };
}
