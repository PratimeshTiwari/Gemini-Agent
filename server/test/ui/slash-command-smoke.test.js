/**
 * Every slash command, driven once, bare and with arguments.
 *
 * `use-slash-commands.js` is 967 lines at **8.69% line coverage** — the lowest
 * in the repo — and it is the surface almost every bug reported from use has
 * come from: `/image` with no way to detach, `/clear` not saying which half it
 * cleared, `/effort` not reporting what the picker reads, a local command
 * cancelling a running turn.
 *
 * Same shape as `test/mcp/tool-smoke.test.js`, for the same reason: shallow and
 * total beats deep and partial when the failure being guarded is "this entry
 * point throws". A command that crashes takes the turn with it, and the CLI is
 * the only place the user can see it happen.
 *
 * **The collaborators are real**, not stubs. A first pass used hand-written
 * stubs and produced three confident false positives — `getAllMemories is not a
 * function` against a method that exists and has three callers — because the
 * stub was wrong, not the code. Real `MemoryManager`, `ContextManager`,
 * `DiffEngine` and `TaskManager` cost nothing here and cannot lie that way.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSlashCommand } from '../../src/ui/hooks/use-slash-commands.js';
import { SLASH_COMMANDS } from '../../src/ui/constants.js';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { MemoryManager } from '../../src/context/memory-manager.js';
import { ContextManager } from '../../src/context/context-manager.js';
import { DiffEngine } from '../../src/core/diff-engine.js';
import { TaskManager } from '../../src/core/task-manager.js';

/**
 * Not driven from a test, each for a reason that is not "it might fail".
 *
 * `exit` and `restart` leave the process — under `node --test` that takes the
 * runner with them. `update` runs `git pull` against the real remote. `compact`
 * and `new` both wait on a browser round trip that has no extension here.
 */
const NOT_DRIVEN = new Set(['exit', 'restart', 'update', 'compact', 'new']);

function harness() {
  const ws = fs.mkdtempSync(join(tmpdir(), 'slash-'));
  fs.mkdirSync(join(ws, '.agent'), { recursive: true });

  const loop = Object.create(AgentLoop.prototype);
  Object.assign(loop, {
    workspace: ws,
    codeDir: ws,
    mode: 'auto',
    modelConfig: { main: 'gemini', effort: 'high' },
    conversationHistory: [],
    isProcessing: false,
    commandRules: { enabled: true, allow: [], block: [] },
    sessionStore: { appendTurn() {}, saveHistory() {}, listSessions: () => [] },
    promptBuilder: { resetPromptState() {}, noteMessageSent() {} },
    memoryManager: new MemoryManager(ws),
    contextManager: new ContextManager(ws),
    diffEngine: new DiffEngine(ws),
    taskManager: new TaskManager(ws),
    callbacks: { sendToPanel() {} },
    _saveConfig() {},
  });

  const history = [];
  const run = (query) => handleSlashCommand(query, {
    agentLoop: loop,
    wsServer: { clients: new Set() },
    resetScreen() {},
    setActiveMenu() {},
    setHistory: (f) => history.push(typeof f === 'function' ? f([]) : f),
    setIsProcessing() {},
    setPendingImage() {},
    pendingImage: null,
  });

  const lastMessage = () => {
    const last = history.at(-1);
    const entry = Array.isArray(last) ? last.at(-1) : last;
    return String(entry?.content ?? '');
  };

  return { ws, loop, run, lastMessage, cleanup: () => fs.rmSync(ws, { recursive: true, force: true }) };
}

describe('every command runs', () => {
  test('none of them throws', async () => {
    const broken = [];

    for (const { name } of SLASH_COMMANDS) {
      if (NOT_DRIVEN.has(name)) continue;
      const h = harness();
      try {
        await h.run(`/${name}`);
      } catch (e) {
        broken.push(`/${name}: ${e.message}`);
      } finally {
        h.cleanup();
      }
    }

    assert.deepEqual(broken, [], `\n  ${broken.join('\n  ')}\n`);
  });

  /*
   * A command that answers "No such command" about itself is the `/name` bug:
   * it shipped fully implemented, listed in the menu, and unreachable because
   * the dispatcher kept its own copy of the list.
   */
  test('none of them is unreachable', async () => {
    const missing = [];

    for (const { name } of SLASH_COMMANDS) {
      if (NOT_DRIVEN.has(name)) continue;
      const h = harness();
      await h.run(`/${name}`);
      if (/No such command/.test(h.lastMessage())) missing.push(`/${name}`);
      h.cleanup();
    }

    assert.deepEqual(missing, [], `listed in the menu and not dispatched: ${missing.join(', ')}`);
  });

  // The control. If the sweep cannot detect an unreachable command it proves
  // nothing, so check that the detector fires on a name that really is absent.
  test('and the check would notice if one were', async () => {
    const h = harness();
    await h.run('/definitelyNotACommand');

    assert.match(h.lastMessage(), /No such command/);
    h.cleanup();
  });
});

describe('arguments do not break anything', () => {
  /*
   * The forms people actually type, including the wrong ones. Bare commands are
   * the easy path; every bug reported from use has been in an argument form or
   * a mistake.
   */
  const CASES = [
    '/image remove', '/image /nonexistent/x.png',
    '/open', '/open nope.txt',
    '/logs agent', '/logs nosuchflow', '/logs rates', '/logs tools',
    '/name Ada', '/name',
    '/memory on', '/memory off',
    '/allowlist', '/allowlist add ls',
    '/effort pro', '/effort nonsense',
    '/help extra args', '/context', '/plans', '/history', '/commands', '/skills',
  ];

  test('none of them throws', async () => {
    const broken = [];

    for (const q of CASES) {
      const h = harness();
      try {
        await h.run(q);
      } catch (e) {
        broken.push(`${q}: ${e.message}`);
      } finally {
        h.cleanup();
      }
    }

    assert.deepEqual(broken, [], `\n  ${broken.join('\n  ')}\n`);
  });
});

describe('a wrong word is rejected, not ignored', () => {
  /*
   * `/effort deeep` used to fall through to the status display, which prints
   * the current rung and the ladder — indistinguishable from a confirmation.
   * The typo is the likeliest way to get there, and believing the setting
   * changed means every later turn goes out on the old rung.
   */
  test('an invalid effort says so and changes nothing', async () => {
    const h = harness();
    await h.run('/effort nonsense');

    assert.match(h.lastMessage(), /not an effort level/);
    assert.equal(h.loop.modelConfig.effort, 'high', 'it changed the effort to something invalid');
    h.cleanup();
  });

  test('a valid one still applies, silently on the rejection front', async () => {
    const h = harness();
    await h.run('/effort lite');

    assert.equal(h.loop.modelConfig.effort, 'low');
    assert.doesNotMatch(h.lastMessage(), /not an effort level/);
    h.cleanup();
  });
});

describe('a bare slash is the question, not an unknown command', () => {
  /*
   * It answered `No such command: /` and then advised "Type `/` on its own to
   * see what there is" — which is what had just been done. The input bar opens
   * the menu while you type it, so this is reached by submitting it, and the
   * one reply guaranteed to be useless was the one it gave.
   */
  test('it lists the commands instead of refusing', async () => {
    const h = harness();
    await h.run('/');

    const msg = h.lastMessage();
    assert.doesNotMatch(msg, /No such command/);
    assert.match(msg, /\/help/);
    assert.match(msg, /\/effort/);
    h.cleanup();
  });

  test('an unknown command still says so, and then lists them', async () => {
    const h = harness();
    await h.run('/nosuchthing');

    assert.match(h.lastMessage(), /No such command: `\/nosuchthing`/);
    assert.match(h.lastMessage(), /\/help/, 'refusing without saying what there is instead');
    h.cleanup();
  });
});
