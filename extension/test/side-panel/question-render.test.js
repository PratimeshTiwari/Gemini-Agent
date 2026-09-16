/**
 * The panel's question, against the payloads that used to hang a turn.
 *
 * `ask_question` parks the agent loop on `pendingQuestionResolve` with **no
 * timeout**, so a surface that draws an unanswerable picker does not merely
 * look wrong — it ends the session. That is what the side panel did until it
 * could answer at all, and it is what a malformed payload did to the terminal
 * before `question.js` existed.
 *
 * The server normalises now, so the panel is fed a clean shape. These run the
 * shipped `appendQuestion` over **both** the normalised payload and the raw
 * ones a model actually emits — the second because a reloaded extension can
 * talk to an agent that has not restarted yet.
 *
 * The property that matters is the same in every case: there is always a way
 * to answer and a way to get out.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const PANEL = resolve(here, '../../side-panel/panel.js');

/** Lift `appendQuestion` and the helpers it needs out of the shipped file. */
function loadPanel() {
  const src = readFileSync(PANEL, 'utf8');
  const lift = (name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`${name} not found`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`${name} never closed`);
  };

  const dom = new JSDOM('<body><div id="stream"></div></body>');
  const { document } = dom.window;
  const sent = [];
  const sandbox = {
    document,
    messageStream: document.getElementById('stream'),
    scrollToBottom() {},
    removeThinking() {},
    showThinking() {},
    chrome: { runtime: { sendMessage: (m) => sent.push(m) } },
  };
  const body = `${lift('escapeHtml')}\n${lift('closeQuestion')}\n${lift('appendQuestion')}\nreturn appendQuestion;`;
  const fn = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));
  return { appendQuestion: fn, document, sent };
}

let panel;
beforeEach(() => { panel = loadPanel(); });

/** Everything a person needs to get the turn moving again. */
function assertAnswerable(document, why) {
  const box = document.querySelector('.question-freeform');
  const submit = document.querySelector('.question-submit');
  const dismiss = document.querySelector('.question-dismiss');
  assert.ok(box, `no way to type an answer — ${why}`);
  assert.ok(submit, `no way to send one — ${why}`);
  assert.ok(dismiss, `no way out — ${why}`);
}

describe('however the payload arrives, the turn can be unblocked', () => {
  const shapes = {
    'normalised, as the server now sends': {
      question: 'Which parser?',
      options: [{ label: 'acorn', description: 'fast' }, { label: 'babel', description: '' }],
      header: 'Parser',
      questions: [{
        header: 'Parser',
        question: 'Which parser?',
        options: [{ label: 'acorn', description: 'fast' }, { label: 'babel', description: '' }],
      }],
    },
    'options as bare strings': { question: 'Which?', options: ['a', 'b'] },
    'options as a single string, not an array': { question: 'Which?', options: 'only one' },
    'no options at all': { question: 'What should I call it?' },
    'no question text': { options: ['a'] },
    'nothing whatsoever': {},
    'a batch of questions': {
      questions: [
        { question: 'Which db?', options: [{ label: 'Postgres' }] },
        { question: 'Which port?', options: [] },
      ],
    },
    'questions as bare strings': { questions: ['Just tell me?'] },
  };

  for (const [name, payload] of Object.entries(shapes)) {
    test(name, () => {
      panel.appendQuestion(payload);
      assertAnswerable(panel.document, name);
      // Never an empty picker: something readable is always on screen.
      const text = panel.document.querySelector('.question-text')?.textContent || '';
      assert.ok(text.trim().length > 0, 'the question rendered blank');
    });
  }
});

describe('answering', () => {
  test('an option fills the box, and sending reports it', () => {
    panel.appendQuestion({ question: 'Which?', options: ['acorn', 'babel'] });
    const [first] = panel.document.querySelectorAll('.question-option');
    first.dispatchEvent(new panel.document.defaultView.Event('click'));
    assert.equal(panel.document.querySelector('.question-freeform').value, 'acorn');

    panel.document.querySelector('.question-submit')
      .dispatchEvent(new panel.document.defaultView.Event('click'));
    assert.deepEqual(panel.sent, [{ type: 'question_response', payload: { answer: 'acorn' } }]);
  });

  test('several questions answer as the paired array the loop expects', () => {
    panel.appendQuestion({ questions: [{ question: 'A?' }, { question: 'B?' }] });
    const boxes = panel.document.querySelectorAll('.question-freeform');
    boxes[0].value = 'one';
    boxes[1].value = 'two';
    panel.document.querySelector('.question-submit')
      .dispatchEvent(new panel.document.defaultView.Event('click'));
    assert.deepEqual(panel.sent[0].payload.answer, [
      { question: 'A?', answer: 'one' },
      { question: 'B?', answer: 'two' },
    ]);
  });

  test('a half-answered batch sends nothing rather than a partial one', () => {
    panel.appendQuestion({ questions: [{ question: 'A?' }, { question: 'B?' }] });
    panel.document.querySelectorAll('.question-freeform')[0].value = 'one';
    panel.document.querySelector('.question-submit')
      .dispatchEvent(new panel.document.defaultView.Event('click'));
    assert.equal(panel.sent.length, 0);
  });

  // Dismissing must still resolve the promise, or declining to answer is the
  // same as hanging.
  test('dismissing cancels, which is an answer as far as the loop is concerned', () => {
    panel.appendQuestion({ question: 'Which?' });
    panel.document.querySelector('.question-dismiss')
      .dispatchEvent(new panel.document.defaultView.Event('click'));
    assert.deepEqual(panel.sent, [{ type: 'question_response', payload: { cancelled: true } }]);
  });

  test('answering then dismissing sends only the answer', () => {
    panel.appendQuestion({ question: 'Which?' });
    panel.document.querySelector('.question-freeform').value = 'a';
    const click = (sel) => panel.document.querySelector(sel)
      .dispatchEvent(new panel.document.defaultView.Event('click'));
    click('.question-submit');
    click('.question-dismiss');
    assert.equal(panel.sent.length, 1);
    assert.equal(panel.sent[0].payload.answer, 'a');
  });

  test('it cannot be answered twice', () => {
    panel.appendQuestion({ question: 'Which?', options: ['a'] });
    const submit = panel.document.querySelector('.question-submit');
    panel.document.querySelector('.question-freeform').value = 'a';
    submit.dispatchEvent(new panel.document.defaultView.Event('click'));
    submit.dispatchEvent(new panel.document.defaultView.Event('click'));
    assert.equal(panel.sent.length, 1, 'a second answer would resolve nothing and confuse the record');
  });
});

/**
 * The question text and its options are **scraped off gemini.google.com**.
 * That makes them third-party input, and the side panel is an extension page
 * with `chrome.*` in scope — so markup getting through here is not cosmetic.
 */
describe('what the model writes is never markup', () => {
  test('tags in the visible text stay text', () => {
    panel.appendQuestion({
      question: '<img src=x onerror=alert(1)>',
      options: ['<script>bad()</script>'],
    });
    const stream = panel.document.getElementById('stream');
    assert.equal(stream.querySelector('img'), null, 'the question became an element');
    assert.equal(stream.querySelector('script'), null, 'an option became an element');
    assert.match(stream.innerHTML, /&lt;img/);
  });

  // The one that actually bit. `escapeHtml` was `textContent` -> `innerHTML`,
  // which is the usual idiom and does **not** escape quotes — fine for text,
  // wrong for the `data-value="…"` these templates interpolate into. A quote
  // closed the attribute and the rest parsed as markup; jsdom built a real
  // event handler from it.
  test('a quote cannot break out of an attribute', () => {
    panel.appendQuestion({ question: 'pick one', options: ['" onmouseover="STOLEN'] });
    const button = panel.document.querySelector('.question-option');
    assert.equal(button.hasAttribute('onmouseover'), false,
      'an option label injected an event handler into the panel');
    assert.deepEqual(
      [...button.attributes].map((a) => a.name).sort(),
      ['class', 'data-value'],
      'an option label added an attribute of its own',
    );
    // And it is still usable as an answer, quotes and all.
    assert.equal(button.getAttribute('data-value'), '" onmouseover="STOLEN');
  });

  test('the same for the question text, which rides in data-question', () => {
    panel.appendQuestion({ question: '" onload="STOLEN' });
    const block = panel.document.querySelector('.question-block');
    assert.equal(block.hasAttribute('onload'), false);
    assert.equal(block.getAttribute('data-question'), '" onload="STOLEN');
  });
});
