/**
 * Where a symbol is defined, and who uses it.
 *
 * The structural half of working in a codebase, and the half grep is worst at.
 * `grep_search` can find the string `resolveEffort`; it cannot tell the
 * definition from the forty call sites, and it cannot tell either from the word
 * appearing in a comment. That gap is recorded in `CLAUDE.md` under "What a
 * large codebase actually needs" and has been open since the `ast-chunker` was
 * deleted.
 *
 * **Why this is not that file.** `ast-chunker` walked `ast.body` only, so every
 * class method and every `export const foo = () => {}` was invisible — it
 * resolved 24% of this repo's own top-level symbols — and plain acorn cannot
 * parse `.jsx` at all, which is most of `ui/`. `acorn-walk` visits every node
 * rather than the top level, and `acorn-jsx` handles the JSX. Both were named
 * in `CLAUDE.md` as what a working version wants; this is them.
 *
 * **Why not an embedding index.** Decided and recorded: code search is mostly
 * exact-symbol search, an embedding index goes stale on every edit, and the
 * context window here is a browser chat tab, so every retrieved chunk is typed
 * into Gemini by a content script. This is the opposite trade — exact, cheap,
 * and it returns *locations* rather than prose.
 *
 * **Why not ctags or tree-sitter.** Both cover more languages and neither is
 * free. Universal ctags is not installed on a typical machine, and this project
 * has a standing rule that a tool which silently does nothing is worse than no
 * tool. tree-sitter is a native build. acorn is three small pure-JS packages
 * that cover this codebase completely. What it does *not* cover, it says so
 * about, per file, by name — because the failure that matters is the model
 * concluding a symbol does not exist when the truth is that nothing looked.
 */

import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
import * as walk from 'acorn-walk';
import { readFileSync, statSync } from 'fs';
import { relative, join, extname } from 'path';
import fg from 'fast-glob';
import { AGENT_DIR } from '../core/paths.js';

const JsxParser = Parser.extend(jsx());

/** What acorn can read. Everything else is reported, not silently dropped. */
export const PARSEABLE = new Set(['.js', '.jsx', '.mjs', '.cjs']);

/** Extensions worth *mentioning* when skipped — code we simply cannot read. */
const CODE_LIKE = new Set(['.ts', '.tsx', '.py', '.go', '.rb', '.rs', '.java', '.php', '.c', '.cpp']);

const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module', locations: true };

/**
 * JSX walkers, because `acorn-jsx` teaches the parser and not the walker.
 *
 * `acorn-jsx` produces `JSXElement` and friends, and `acorn-walk` throws "No
 * walker function defined for node type JSXElement" the moment it meets one —
 * so a `.jsx` file parses perfectly and then fails on the walk. Adding the
 * parser without these is how "acorn cannot parse .jsx" gets written down as a
 * fact when the truth is that nobody taught the walker.
 *
 * Only the nodes that can *contain* something worth finding are descended into.
 * `JSXText` is prose and `JSXEmptyExpression` is nothing.
 */
const JSX_BASE = {
  JSXElement(node, state, c) {
    c(node.openingElement, state);
    for (const child of node.children) c(child, state);
    if (node.closingElement) c(node.closingElement, state);
  },
  JSXFragment(node, state, c) {
    for (const child of node.children) c(child, state);
  },
  JSXOpeningElement(node, state, c) {
    c(node.name, state);
    for (const attr of node.attributes) c(attr, state);
  },
  JSXClosingElement(node, state, c) { c(node.name, state); },
  JSXAttribute(node, state, c) { if (node.value) c(node.value, state); },
  JSXSpreadAttribute(node, state, c) { c(node.argument, state, 'Expression'); },
  JSXExpressionContainer(node, state, c) { c(node.expression, state, 'Expression'); },
  JSXSpreadChild(node, state, c) { c(node.expression, state, 'Expression'); },
  JSXMemberExpression(node, state, c) { c(node.object, state); },
  JSXNamespacedName() {},
  JSXIdentifier() {},
  JSXText() {},
  JSXEmptyExpression() {},
  JSXOpeningFragment() {},
  JSXClosingFragment() {},
};

/**
 * Import and export specifiers, which `acorn-walk` ignores outright.
 *
 * Its base defines `ImportSpecifier` as `ignore`, so the name in
 * `import { InputBar } from …` is never visited — and "who imports this?" is
 * the first question anyone asks a reference search. Without these, the answer
 * for a UI component is the one JSX tag and nothing else.
 *
 * Both halves of `import { X as Y }` are visited: searching for `X` should find
 * the import, and searching for `Y` should find the uses. For the plain
 * `import { X }` form acorn gives the two the same position, which is why the
 * caller dedupes by line and column.
 */
const MODULE_BASE = {
  ImportSpecifier(node, state, c) {
    if (node.imported) c(node.imported, state, 'Expression');
    if (node.local && node.local !== node.imported) c(node.local, state, 'Expression');
  },
  ImportDefaultSpecifier(node, state, c) { if (node.local) c(node.local, state, 'Expression'); },
  ImportNamespaceSpecifier(node, state, c) { if (node.local) c(node.local, state, 'Expression'); },
  ExportSpecifier(node, state, c) {
    if (node.local) c(node.local, state, 'Expression');
    if (node.exported && node.exported !== node.local) c(node.exported, state, 'Expression');
  },
};

/** `acorn-walk`'s defaults plus the JSX and module ones. */
const BASE = { ...walk.base, ...JSX_BASE, ...MODULE_BASE };

/**
 * Every definition in one source text.
 *
 * `walk.full` rather than a loop over `ast.body` — that is the whole difference
 * between this and the file it replaces. A method on a class, a function
 * assigned to a const, a function in an object literal: all are definitions
 * somebody will search for, and none of them is a top-level statement.
 *
 * @returns {Array<{name: string, kind: string, line: number}>}
 */
export function definitionsIn(source) {
  const ast = JsxParser.parse(source, PARSE_OPTIONS);
  const out = [];
  const add = (name, kind, node) => {
    if (name) out.push({ name, kind, line: node.loc.start.line });
  };

  walk.full(ast, (node) => {
    switch (node.type) {
      case 'ClassDeclaration':
      case 'ClassExpression':
        add(node.id?.name, 'class', node);
        break;
      case 'FunctionDeclaration':
        add(node.id?.name, 'function', node);
        break;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        // Not constructors. Every class has one, so indexing them means
        // `find_symbol("constructor")` answers with the whole codebase — and
        // nobody searches for a constructor by that name; they search for the
        // class. `kind` otherwise distinguishes a getter from a plain method,
        // which is worth keeping: they are different things to find.
        if (node.kind !== 'constructor') {
          add(node.key?.name, node.kind && node.kind !== 'init' ? node.kind : 'method', node);
        }
        break;
      case 'Property':
        // Only when the value is callable. `{ retries: 3 }` is data, and
        // indexing it makes every config key a "definition".
        if (/FunctionExpression|ArrowFunctionExpression|ClassExpression/.test(node.value?.type || '')) {
          add(node.key?.name, 'method', node);
        }
        break;
      case 'VariableDeclarator':
        if (/FunctionExpression|ArrowFunctionExpression|ClassExpression/.test(node.init?.type || '')) {
          add(node.id?.name, node.init.type === 'ClassExpression' ? 'class' : 'function', node);
        } else if (node.id?.type === 'Identifier' && node.init) {
          add(node.id.name, 'const', node);
        }
        break;
      default:
        break;
    }
  }, BASE);

  return out;
}

/**
 * Every place a name is *used* in one source text.
 *
 * Identifier nodes, which is what separates this from grep: the word inside a
 * comment or a string is not an Identifier and never appears here. Property
 * keys are excluded for the same reason — `{ readFile: 1 }` is not a use of
 * `readFile` — except when computed, where they genuinely are.
 *
 * @returns {Array<{line: number, column: number}>}
 */
export function referencesIn(source, name) {
  const ast = JsxParser.parse(source, PARSE_OPTIONS);
  const out = [];
  // `import { X }` gives `imported` and `local` the same position, and visiting
  // both is how the import is found at all — so the duplicate is deduped here
  // rather than by not looking.
  const seen = new Set();
  const hit = (node) => {
    const at = `${node.loc.start.line}:${node.loc.start.column}`;
    if (seen.has(at)) return;
    seen.add(at);
    out.push({ line: node.loc.start.line, column: node.loc.start.column + 1 });
  };

  walk.full(ast, (node) => {
    if (node.name !== name) return;
    // `<Banner />` is a use of `Banner` as surely as `Banner()` is, and it is
    // the *only* use in most of `ui/components`. It is a JSXIdentifier, not an
    // Identifier, so a check for one node type misses every component.
    if (node.type === 'Identifier' || node.type === 'JSXIdentifier') hit(node);
  }, {
    ...BASE,
    // A member's property and a non-computed key are not references to a
    // variable of that name: `fs.readFile` does not use a `readFile` binding,
    // and `{ readFile: 1 }` declares a key.
    MemberExpression(node, state, c) {
      c(node.object, state, 'Expression');
      if (node.computed) c(node.property, state, 'Expression');
    },
    Property(node, state, c) {
      if (node.computed) c(node.key, state, 'Expression');
      c(node.value, state, 'Expression');
    },
    MethodDefinition(node, state, c) {
      if (node.computed) c(node.key, state, 'Expression');
      c(node.value, state, 'Expression');
    },
    // An attribute *name* is not a reference; its value can be.
    JSXAttribute(node, state, c) { if (node.value) c(node.value, state); },
  });
  return out;
}

/**
 * A symbol index over a workspace, rebuilt only where files have changed.
 *
 * Built on first use rather than at startup. `semantic_search` was deleted in
 * part for costing a full-repo read every time the agent launched, and a symbol
 * index that nobody asks for should cost nothing.
 */
export class SymbolIndex {
  constructor(workspace) {
    this.workspace = workspace;
    /** @type {Map<string, {mtime: number, defs: Array, source: string}>} */
    this.files = new Map();
    /** @type {Array<{file: string, reason: string}>} */
    this.skipped = [];
  }

  /** Every file worth parsing, plus the code-like ones we cannot. */
  _candidates() {
    const entries = fg.sync(['**/*.{js,jsx,mjs,cjs,ts,tsx,py,go,rb,rs,java,php,c,cpp}'], {
      cwd: this.workspace,
      // `node_modules/**` matches only the top level, and this is a workspaces
      // repo — `server/node_modules` and `extension/node_modules` were being
      // parsed, which is where 343 of the first run's 343 skips came from.
      //
      // `service-worker.js` is a committed *build artifact*: every symbol in it
      // is a duplicate of one in `extension/src/background/`, and answering
      // "where is pickMainTab defined" with the bundle as well as the source is
      // two answers to a question with one.
      ignore: [
        '**/node_modules/**', '**/.git/**', `**/${AGENT_DIR}/**`,
        '**/dist/**', '**/build/**', '**/*.min.js',
        'extension/service-worker.js',
      ],
      absolute: true,
      suppressErrors: true,
    });
    return entries;
  }

  /**
   * Parse what has changed since last time.
   *
   * An unparseable file is recorded and skipped, never thrown: one file with a
   * syntax error in it must not make the whole index unavailable — that is the
   * state where the model is told nothing exists.
   */
  refresh() {
    const seen = new Set();
    this.skipped = [];

    for (const abs of this._candidates()) {
      const ext = extname(abs);
      const rel = relative(this.workspace, abs);
      seen.add(abs);

      if (!PARSEABLE.has(ext)) {
        if (CODE_LIKE.has(ext)) this.skipped.push({ file: rel, reason: `acorn cannot parse ${ext}` });
        continue;
      }

      let mtime;
      let source;
      try {
        mtime = statSync(abs).mtimeMs;
        const cached = this.files.get(abs);
        if (cached && cached.mtime === mtime) continue;
        source = readFileSync(abs, 'utf8');
      } catch (err) {
        this.skipped.push({ file: rel, reason: err.code || 'unreadable' });
        this.files.delete(abs);
        continue;
      }

      try {
        this.files.set(abs, { mtime, defs: definitionsIn(source), source });
      } catch (err) {
        this.files.set(abs, { mtime, defs: [], source, unparsed: true });
        this.skipped.push({ file: rel, reason: `syntax error at line ${err.loc?.line ?? '?'}` });
      }
    }

    // Files that have been deleted since the last pass.
    for (const abs of [...this.files.keys()]) {
      if (!seen.has(abs)) this.files.delete(abs);
    }
    return this;
  }

  /** How many files are actually in the index, for the honest footer. */
  get indexed() {
    return [...this.files.values()].filter((f) => !f.unparsed).length;
  }

  /**
   * Where `name` is defined.
   *
   * @returns {Array<{file: string, line: number, kind: string}>}
   */
  find(name) {
    const out = [];
    for (const [abs, entry] of this.files) {
      for (const def of entry.defs) {
        if (def.name === name) {
          out.push({ file: relative(this.workspace, abs), line: def.line, kind: def.kind });
        }
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  /**
   * Where `name` is used, with the line of source at each point.
   *
   * @returns {Array<{file: string, line: number, column: number, text: string}>}
   */
  references(name) {
    const out = [];
    for (const [abs, entry] of this.files) {
      if (entry.unparsed) continue;
      // Cheap reject: parsing every file again to find a name that is not in it
      // is the difference between this being usable and not.
      if (!entry.source.includes(name)) continue;
      let hits;
      try {
        hits = referencesIn(entry.source, name);
      } catch {
        continue;
      }
      const lines = entry.source.split('\n');
      for (const hit of hits) {
        out.push({
          file: relative(this.workspace, abs),
          line: hit.line,
          column: hit.column,
          text: (lines[hit.line - 1] || '').trim(),
        });
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
}

/** One index per workspace, kept between calls so the parse is paid once. */
const indexes = new Map();

export function symbolIndex(workspace) {
  if (!indexes.has(workspace)) indexes.set(workspace, new SymbolIndex(workspace));
  return indexes.get(workspace).refresh();
}

/** Test seam: forget every cached index. */
export function resetSymbolIndexes() {
  indexes.clear();
}
