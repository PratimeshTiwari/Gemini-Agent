/**
 * Load one function out of a content script, for testing.
 *
 * Content scripts are not modules — they are plain scripts with top-level
 * `chrome.*` calls and event-listener registration, so importing one is not an
 * option and stubbing enough of Chrome to evaluate the whole file would test the
 * stubs as much as the code. Lifting a single pure function out by brace
 * matching keeps the test honest: it runs the shipped source, verbatim, with
 * nothing mocked inside it.
 *
 * The alternative — exporting from the content script behind a
 * `typeof module !== 'undefined'` guard — puts test scaffolding in the file
 * Chrome loads. Not worth it for functions that take a DOM node and return a
 * string.
 */
import { readFileSync } from 'fs';

/**
 * @param {string} file   absolute path to the content script
 * @param {string} name   the function to lift out
 * @param {object} globals  names the function closes over (`document`, `Node`, …)
 * @returns {Function}
 */
export function loadFunction(file, name, globals = {}) {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);

  // Walk to the matching close brace. Good enough for these functions and it
  // fails loudly rather than silently truncating, which an index-of-the-next-
  // "function" heuristic does not.
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`unbalanced braces reading ${name} from ${file}`);

  const names = Object.keys(globals);
  const body = `${src.slice(start, end)}\nreturn ${name};`;
  return new Function(...names, body)(...names.map((n) => globals[n]));
}
