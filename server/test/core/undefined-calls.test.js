/**
 * Calling something nothing defines.
 *
 * `/exit` crashed the process with `ReferenceError: leave is not defined`.
 * `leave` had been moved into `core/restart.js` and the local copy deleted —
 * and the one call site was not updated, because nothing looks at call sites
 * when a function moves. Every test passed, because no test runs `/exit`.
 *
 * This repo moves functions between files constantly (four modules changed
 * homes in one evening), and it has no linter installed — `.eslintrc.json`
 * exists for editors and there is no `lint` script — so `no-undef`, the rule
 * that would have caught this in a second, never runs.
 *
 * `acorn` is already a dependency for the symbol index, so this is that rule,
 * narrowed to the case that actually bites: a **call** to a bare name that the
 * file neither declares nor imports. Deliberately not a full scope analyser —
 * bindings are collected from anywhere in the file, so shadowing can only make
 * it quieter, never wrong. A missing binding is unambiguous.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative, extname } from 'path';
import * as acorn from 'acorn';
import jsx from 'acorn-jsx';
import * as walk from 'acorn-walk';
// The JSX and import-specifier walkers this project's sources need. Without
// them a .jsx file parses and then throws on the walk — the trap CLAUDE.md
// documents, met again inside a minute.
import { WALK_BASE } from '../../src/context/symbol-index.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const Parser = acorn.Parser.extend(jsx());

/** Names that exist without being declared anywhere. */
const GLOBALS = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'globalThis', 'process',
  'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'queueMicrotask', 'structuredClone', 'fetch', 'Buffer', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'AbortController', 'Promise', 'JSON', 'Math', 'Object',
  'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Map',
  'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'EvalError', 'ReferenceError', 'AggregateError', 'Intl', 'WebSocket',
  'Event', 'EventTarget', 'performance', 'crypto', 'atob', 'btoa', 'isNaN', 'isFinite',
  'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape',
  'super', 'eval',
]);

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...files(full)); continue; }
    if (['.js', '.jsx'].includes(extname(name))) out.push(full);
  }
  return out;
}

/** Every name this file binds, at any scope. */
function bindings(ast) {
  const names = new Set();
  const add = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': names.add(node.name); break;
      case 'ObjectPattern': node.properties.forEach((p) => add(p.value ?? p.argument)); break;
      case 'ArrayPattern': node.elements.forEach(add); break;
      case 'AssignmentPattern': add(node.left); break;
      case 'RestElement': add(node.argument); break;
      default: break;
    }
  };
  walk.full(ast, (node) => {
    switch (node.type) {
      case 'VariableDeclarator': add(node.id); break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) names.add(node.id.name);
        (node.params || []).forEach(add);
        break;
      case 'CatchClause': add(node.param); break;
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        names.add(node.local.name);
        break;
      default: break;
    }
  }, WALK_BASE);
  return names;
}

describe('every function called is one that exists', () => {
  for (const file of files(SRC)) {
    const rel = relative(SRC, file);
    test(rel, () => {
      const ast = Parser.parse(readFileSync(file, 'utf8'), {
        ecmaVersion: 'latest', sourceType: 'module', locations: true,
      });
      const known = bindings(ast);
      const missing = [];

      walk.full(ast, (node) => {
        if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
        const callee = node.callee;
        // Only bare `name(...)`. A member call resolves at runtime and is not
        // this rule's business.
        if (!callee || callee.type !== 'Identifier') return;
        if (known.has(callee.name) || GLOBALS.has(callee.name)) return;
        missing.push(`${callee.name}() at line ${callee.loc.start.line}`);
      }, WALK_BASE);

      assert.deepEqual(missing, [], `nothing defines:\n  ${missing.join('\n  ')}`);
    });
  }
});
