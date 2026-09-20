/**
 * A timeout should name the tool that would have worked.
 *
 * `run_background` exists for dev servers, watchers and builds, it is wired,
 * and it works — spawning, capturing stdout and recording an exit code, all
 * verified directly. Across every stored session it has been called **zero**
 * times, out of 52 tool calls.
 *
 * Which is not proof it is unwanted. `run_command` timing out is precisely the
 * moment `run_background` was written for, and nothing pointed from one to the
 * other: the model saw "Command timed out after 30s", which reads as something
 * to retry rather than as the wrong tool. Not knowing a tool exists at the
 * moment you need it is indistinguishable from it not existing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCPServer } from '../../src/mcp/mcp-server.js';

describe('a timed-out command says what to do instead', () => {
  test('it names run_background and how to read its output', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'timeout-'));
    const out = await new MCPServer(ws).executeTool('run_command', { command: 'sleep 3', timeout: 1 }, {});

    const msg = out.result?.message ?? out.error ?? '';
    assert.match(msg, /timed out/);
    assert.match(msg, /run_background/, 'the model is left with no alternative to try');
    assert.match(msg, /manage_task/, 'and no way to read what it produces');
    rmSync(ws, { recursive: true, force: true });
  });

  /*
   * And the other reading: a command that *should* have finished needs a bigger
   * timeout, not a different tool. Offering only one of the two answers sends
   * every slow test suite to the background process manager.
   */
  test('it also offers the other explanation', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'timeout-'));
    const out = await new MCPServer(ws).executeTool('run_command', { command: 'sleep 3', timeout: 1 }, {});

    assert.match(out.result?.message ?? '', /timeout/, 'raising the timeout is not suggested');
    rmSync(ws, { recursive: true, force: true });
  });

  // The control: a command that finishes must not carry any of this.
  test('a command that finished says none of it', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'timeout-'));
    const out = await new MCPServer(ws).executeTool('run_command', { command: 'echo hi' }, {});

    assert.equal(out.result?.timedOut, false);
    assert.doesNotMatch(JSON.stringify(out.result ?? ''), /run_background/);
    rmSync(ws, { recursive: true, force: true });
  });
});
