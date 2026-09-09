import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePaste, countLines, shouldCollapse, pasteMarker, expandPastes, applyPaste,
  attachedPastes, nextPasteId,
} from './paste.js';

test('normalizePaste', async (t) => {
  await t.test('turns the CR a terminal sends into a real line break', () => {
    assert.equal(normalizePaste('a\r\nb'), 'a\nb');
    assert.equal(normalizePaste('a\rb'), 'a\nb');
    assert.equal(normalizePaste('a\nb'), 'a\nb');
  });

  await t.test('survives nothing at all', () => {
    assert.equal(normalizePaste(undefined), '');
    assert.equal(normalizePaste(null), '');
  });
});

test('shouldCollapse', async (t) => {
  await t.test('leaves a short paste alone', () => {
    assert.equal(shouldCollapse('one line'), false);
    assert.equal(shouldCollapse('a\nb\nc'), false);
  });

  await t.test('collapses anything tall or long', () => {
    assert.equal(shouldCollapse('a\nb\nc\nd\ne'), true);
    assert.equal(shouldCollapse('x'.repeat(401)), true);
  });
});

test('applyPaste', async (t) => {
  await t.test('inserts a small paste as its own text', () => {
    const { value, paste } = applyPaste('run ', 'npm test', 1);
    assert.equal(value, 'run npm test');
    assert.equal(paste, null);
  });

  await t.test('collapses a big paste to a marker and hands it back', () => {
    const text = Array.from({ length: 42 }, (_, i) => `line ${i}`).join('\n');
    const { value, paste } = applyPaste('fix ', text, 1);
    assert.equal(value, 'fix [Pasted text #1 +42 lines]');
    assert.equal(paste.text, text);
    assert.equal(paste.marker, '[Pasted text #1 +42 lines]');
  });

  await t.test('normalises CR inside the collapsed text', () => {
    const { paste } = applyPaste('', 'a\r\nb\r\nc\r\nd\r\ne\r\nf', 3);
    assert.equal(paste.text, 'a\nb\nc\nd\ne\nf');
  });

  await t.test('says one line, not one lines', () => {
    assert.equal(pasteMarker(2, 'x'.repeat(500)), '[Pasted text #2 +1 line]');
  });

  await t.test('ignores an empty paste', () => {
    assert.deepEqual(applyPaste('keep', '', 1), { value: 'keep', paste: null });
  });
});

test('expandPastes', async (t) => {
  const pastes = [
    { id: 1, marker: '[Pasted text #1 +2 lines]', text: 'one\ntwo' },
    { id: 2, marker: '[Pasted text #2 +1 line]', text: 'solo' },
  ];

  await t.test('puts the real text back', () => {
    assert.equal(expandPastes('see [Pasted text #1 +2 lines]', pastes), 'see one\ntwo');
  });

  await t.test('expands every marker in one prompt', () => {
    assert.equal(
      expandPastes('[Pasted text #1 +2 lines] and [Pasted text #2 +1 line]', pastes),
      'one\ntwo and solo',
    );
  });

  await t.test('drops a paste whose marker the user deleted', () => {
    // Deleting the marker is how you take the paste back out.
    assert.equal(expandPastes('never mind', pastes), 'never mind');
  });

  await t.test('leaves a prompt with no markers untouched', () => {
    assert.equal(expandPastes('plain question', pastes), 'plain question');
    assert.equal(expandPastes('', pastes), '');
  });

  await t.test('counts lines the way the marker claims', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\nb'), 2);
  });
});


test('attachedPastes — what the prompt actually still references', async (t) => {
  const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');

  await t.test('counts a paste while its marker is in the prompt', () => {
    const { value, paste } = applyPaste('', big, 1);
    assert.equal(attachedPastes(value, [paste]).length, 1);
  });

  await t.test('stops counting it the moment the marker is deleted', () => {
    // The bug: the hint read the length of the list, which only grows, so it
    // said "1 paste attached" forever — including after the marker was removed
    // and after the message had been sent.
    const { value, paste } = applyPaste('', big, 1);
    assert.equal(attachedPastes(value.replace(paste.marker, ''), [paste]).length, 0);
  });

  await t.test('counts nothing on an empty prompt', () => {
    const { paste } = applyPaste('', big, 1);
    assert.equal(attachedPastes('', [paste]).length, 0);
    assert.equal(attachedPastes(undefined, [paste]).length, 0);
  });

  await t.test('counts only the ones still referenced', () => {
    const a = applyPaste('', big, 1);
    const b = applyPaste('', big, 2);
    const prompt = `keep ${b.paste.marker}`;
    assert.deepEqual(attachedPastes(prompt, [a.paste, b.paste]).map((p) => p.id), [2]);
  });
});

test('nextPasteId', async (t) => {
  const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');

  await t.test('never reuses an id after one is dropped', () => {
    // `pastes.length + 1` reused the id once a marker was deleted, so two
    // different blocks ended up sharing one marker and expandPastes would
    // substitute the wrong text.
    const pastes = [];
    for (let i = 0; i < 3; i++) pastes.push(applyPaste('', big, nextPasteId(pastes)).paste);
    assert.deepEqual(pastes.map((p) => p.id), [1, 2, 3]);

    pastes.splice(1, 1); // the user deleted the second marker
    const next = applyPaste('', big, nextPasteId(pastes)).paste;
    assert.equal(next.id, 4, 'must not reuse 3');
    assert.equal(new Set([...pastes, next].map((p) => p.marker)).size, 3, 'markers stay unique');
  });

  await t.test('starts at 1', () => {
    assert.equal(nextPasteId([]), 1);
    assert.equal(nextPasteId(), 1);
  });
});
