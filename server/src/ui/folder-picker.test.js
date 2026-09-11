import test from 'node:test';
import assert from 'node:assert/strict';
import { canPickFolder, pickFolder } from './folder-picker.js';

test('canPickFolder reports what this machine can actually do', async (t) => {
  await t.test('it names a mechanism or says no — never maybe', () => {
    const answer = canPickFolder();
    assert.ok(answer === false || ['macos', 'zenity', 'kdialog', 'windows'].includes(answer), String(answer));
  });

  // A menu row that silently does nothing is worse than no row: people press
  // it twice and conclude the tool is broken. So the answer has to be a fact
  // about this machine, not an assumption about the platform.
  await t.test('a headless Linux box gets no picker', () => {
    const platform = process.platform;
    const display = process.env.DISPLAY;
    const wayland = process.env.WAYLAND_DISPLAY;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      assert.equal(canPickFolder(), false);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      if (display !== undefined) process.env.DISPLAY = display;
      if (wayland !== undefined) process.env.WAYLAND_DISPLAY = wayland;
    }
  });

  await t.test('macOS always has one', () => {
    const platform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      assert.equal(canPickFolder(), 'macos');
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }
  });
});

test('pickFolder', async (t) => {
  // Cancelling is a non-zero exit from every one of these dialogs, so it is
  // indistinguishable from a failure and must be treated the same way: null,
  // never a throw into a turn.
  await t.test('returns null rather than throwing where no picker exists', async () => {
    const platform = process.platform;
    const display = process.env.DISPLAY;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      delete process.env.DISPLAY;
      assert.equal(await pickFolder('x'), null);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      if (display !== undefined) process.env.DISPLAY = display;
    }
  });
});
