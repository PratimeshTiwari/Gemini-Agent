/**
 * Taking a shell command apart before deciding whether it is safe.
 *
 * The classifier used to read the first word of the string and stop:
 *
 *     command.split(/\s+/)[0]   →  "echo"   →  safe  →  runs with no approval
 *
 * for `echo hi; rm -rf /tmp/x`. Every shell operator was invisible to it —
 * `;`, `&&`, `||`, `|`, a redirection, a `$(…)` substitution. In auto mode
 * "safe" means the command executes without asking, so a single safe-looking
 * leading word was enough to run anything at all. The model does not have to be
 * malicious for that to fire: `grep x . || npm publish` is the shape a confused
 * model emits when it is trying to be helpful about a fallback.
 *
 * So: split first, classify every piece, and let the worst piece decide. This
 * module only does the splitting, and it is deliberately a *lexer*, not a shell
 * — it does not need to understand what a command means, only where one ends
 * and the next begins, and which text will be executed as a command at all.
 *
 * It errs toward finding more commands than a real shell would. A false extra
 * segment costs one approval prompt. A missed one costs everything.
 */

/** Operators that end one command and start another, longest first. */
const OPERATORS = ['&&', '||', ';;', ';', '|&', '|', '&', '\n'];

/**
 * Every command in a command line, including ones nested in substitutions.
 *
 * @param {string} input
 * @returns {string[]} non-empty segments, in the order they appear
 */
export function splitCommands(input) {
  const text = String(input ?? '');
  const out = [];
  let current = '';
  let quote = null; // "'" or '"' while inside one

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) out.push(trimmed);
    current = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // A backslash escapes the next character, in and out of double quotes.
    // Single quotes are literal, so nothing escapes inside them.
    if (ch === '\\' && quote !== "'") {
      current += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
        current += ch;
        continue;
      }
      // Substitutions interpolate inside double quotes but not single ones,
      // so `echo "$(rm -rf /)"` really does run rm.
      if (quote === '"') {
        const nested = readSubstitution(text, i);
        if (nested) {
          out.push(...splitCommands(nested.inner));
          current += nested.raw;
          i = nested.end;
          continue;
        }
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    const nested = readSubstitution(text, i);
    if (nested) {
      out.push(...splitCommands(nested.inner));
      current += nested.raw;
      i = nested.end;
      continue;
    }

    // `2>&1` and `&>log` are redirections, not backgrounding. Splitting on the
    // `&` in them produced a segment ending in `2>` and a stray `1`, which then
    // read as two commands neither of which was the real one.
    if (ch === '&' && (text[i + 1] === '>' || /[>&]\s*$/.test(current))) {
      current += ch;
      continue;
    }

    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      flush();
      i += op.length - 1;
      continue;
    }

    current += ch;
  }

  flush();
  return out;
}

/**
 * A `$(…)`, `` `…` `` or `$((…))` starting at `i`, if there is one.
 *
 * Arithmetic — `$(( … ))` — runs no commands, but it is reported anyway: the
 * inner text is then classified as an unknown command and asks for approval,
 * which is the cheap side of being wrong.
 *
 * @returns {{ inner: string, raw: string, end: number } | null}
 */
function readSubstitution(text, i) {
  if (text[i] === '`') {
    const close = findUnescaped(text, '`', i + 1);
    if (close === -1) return null;
    return { inner: text.slice(i + 1, close), raw: text.slice(i, close + 1), end: close };
  }

  if (text[i] === '$' && text[i + 1] === '(') {
    let depth = 0;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') {
        depth--;
        if (depth === 0) {
          return { inner: text.slice(i + 2, j), raw: text.slice(i, j + 1), end: j };
        }
      }
    }
  }

  return null;
}

function findUnescaped(text, ch, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === ch) return i;
  }
  return -1;
}

/**
 * The binary a segment runs, lowercased, with `VAR=x` prefixes skipped.
 *
 * `FOO=1 rm -rf x` is an `rm`, not a `FOO=1`, and reading the first word
 * literally would have classified it as an unknown command — which happens to
 * fail safe, but for the wrong reason and not always.
 */
export function binaryOf(segment) {
  for (const word of String(segment ?? '').trim().split(/\s+/)) {
    if (!word) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue; // environment prefix
    return word.toLowerCase();
  }
  return '';
}

/**
 * Files a segment writes to through a redirection.
 *
 * Unambiguous in a way that argument paths are not: whatever follows `>` is a
 * file being written, whereas deciding which *argument* of an arbitrary command
 * is a path it will modify is guesswork. The classifier uses this to tell
 * `cat x > notes.md` from `cat x > ~/.ssh/authorized_keys`, and deliberately
 * does not guess about the rest — an over-eager rule here blocks outright,
 * with no way for the user to approve.
 *
 * @returns {string[]} the targets, as written (unexpanded)
 */
export function redirectTargets(segment) {
  const text = String(segment ?? '');
  const targets = [];
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && quote !== "'") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }

    // Only output redirections name a file being written. `<` reads one.
    if (ch === '>') {
      let j = i + 1;
      if (text[j] === '>') j++;          // >>
      if (text[j] === '&') continue;     // >&2 is a file descriptor, not a path
      while (j < text.length && /\s/.test(text[j])) j++;

      let word = '';
      if (text[j] === '"' || text[j] === "'") {
        // `> "my file.txt"` — the space is part of the name, so reading to the
        // next whitespace would have reported a target of `"my`.
        const q = text[j++];
        while (j < text.length && text[j] !== q) word += text[j++];
        j++;
      } else {
        while (j < text.length && !/[\s;|&<>]/.test(text[j])) word += text[j++];
      }
      if (word) targets.push(word);
      i = j - 1;
    }
  }
  return targets;
}
