/**
 * A background turn no longer waits behind whatever the user is typing.
 *
 * `bridge/extension-lock.js` has the unit tests for lane bookkeeping. These are
 * the wiring: that `AgentLoop` actually puts its two kinds of request into two
 * kinds of lane, and that the paths which *end* a turn release the one they
 * started — which is the half that wedges a lane for the rest of the session
 * when it is wrong, silently, with later prompts vanishing into it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { ExtensionLock, mainLane, subLane } from '../../src/bridge/extension-lock.js';

/** An AgentLoop with only the parts these paths touch. */
function loop() {
  const sent = [];
  const self = Object.create(AgentLoop.prototype);
  self.workspace = '/tmp';
  // `mainModel` is a getter over modelConfig — set the config, not the getter.
  self.modelConfig = { main: 'gemini' };
  self.pendingSubagents = new Map();
  self.isProcessing = true;
  self.callbacks = { sendToPanel: () => {}, injectPrompt: (p) => sent.push(p) };
  self.extensionLock = new ExtensionLock({
    send: (p) => sent.push(p),
    onStall: (lane, model) => self._onExtensionStall(lane, model),
    timeoutMs: 60_000,
  });
  self._notify = () => {};
  return { self, sent };
}

describe('two kinds of request, two kinds of lane', () => {
  test('a subagent turn goes out while the user\'s turn is still in flight', () => {
    const { self, sent } = loop();
    self._enqueueExtensionRequest({ prompt: 'user', targetModel: 'gemini' });
    self._enqueueExtensionRequest({
      prompt: 'background', targetModel: 'gemini', isSubagent: true, requestId: 'r1',
    });
    assert.deepEqual(sent.map((p) => p.prompt), ['user', 'background'],
      'a GitHub turn queued behind the user and they were never sharing a tab');
  });

  test('the user\'s own turns are still strictly one at a time', () => {
    const { self, sent } = loop();
    self._enqueueExtensionRequest({ prompt: 'a', targetModel: 'gemini' });
    self._enqueueExtensionRequest({ prompt: 'b', targetModel: 'gemini' });
    assert.deepEqual(sent.map((p) => p.prompt), ['a'], 'one tab, one thread in it');
    self._releaseExtension();
    assert.deepEqual(sent.map((p) => p.prompt), ['a', 'b']);
  });

  test('the default release is the main lane, not every lane', () => {
    const { self, sent } = loop();
    self._enqueueExtensionRequest({ prompt: 'user1', targetModel: 'gemini' });
    self._enqueueExtensionRequest({ prompt: 'user2', targetModel: 'gemini' });
    self._enqueueExtensionRequest({
      prompt: 'bg', targetModel: 'gemini', isSubagent: true, requestId: 'r1',
    });
    self._releaseExtension();   // the user's turn ended
    assert.deepEqual(sent.map((p) => p.prompt), ['user1', 'bg', 'user2']);
    assert.equal(self.extensionLock.isBusy(subLane('r1')), true,
      'the background turn was freed by the user\'s turn ending');
  });
});

describe('a stalled tab takes down only its own turn', () => {
  test('a stalled subagent fails that subagent and nothing else', () => {
    const { self } = loop();
    let settled = null;
    self.pendingSubagents.set('r1', { resolve: (v) => { settled = v; }, reject: () => {}, targetModel: 'gemini' });
    self._enqueueExtensionRequest({ prompt: 'user', targetModel: 'gemini' });
    self._enqueueExtensionRequest({
      prompt: 'bg', targetModel: 'gemini', isSubagent: true, requestId: 'r1',
    });

    self._onExtensionStall(subLane('r1'), 'gemini');

    assert.equal(settled?.success, false, 'the caller was left waiting forever');
    assert.match(settled.error, /stopped responding/);
    assert.equal(self.isProcessing, true,
      'the user\'s turn was killed for a background tab they never asked about');
    assert.equal(self.extensionLock.isBusy(mainLane('gemini')), true,
      'the user\'s lane was freed by someone else\'s stall');
  });

  test('a stalled main lane is still the loud case', () => {
    const { self } = loop();
    self._enqueueExtensionRequest({ prompt: 'user', targetModel: 'gemini' });
    self._onExtensionStall(mainLane('gemini'), 'gemini');
    assert.equal(self.isProcessing, false);
    assert.equal(self.extensionLock.anyBusy, false, 'the stalled turn was left holding its lane');
  });
});
