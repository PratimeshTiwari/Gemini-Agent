import { test, describe } from 'node:test';
import assert from 'node:assert';
import { pickModelFor, planModelSwitch } from '../../src/core/model-match.js';
import { AgentLoop } from '../../src/core/agent-loop.js';

/** Exactly what the picker showed on the owner's plan, labels and blurbs. */
const OWNER_PLAN = [
  { label: '3.5 Flash-Lite', description: 'Fastest answers' },
  { label: '3.8 Flash', description: 'All-around help', selected: true },
  { label: '3.1 Pro', description: 'Advanced reasoning' },
  { label: 'Extended thinking', description: 'Complex problem solving' },
];

/** A plan without the extended option — the case that must not silently break. */
const LEAN_PLAN = [
  { label: '3.8 Flash', description: 'All-around help', selected: true },
  { label: '3.1 Pro', description: 'Advanced reasoning' },
];

describe('pickModelFor — decide by what an option is for, not what it is called', () => {
  test('the fast rung takes the fastest thing offered', () => {
    assert.equal(pickModelFor('flash', OWNER_PLAN).model.label, '3.5 Flash-Lite');
  });

  test('the deep rung prefers extended thinking over pro', () => {
    assert.equal(pickModelFor('deep', OWNER_PLAN).model.label, 'Extended thinking');
  });

  test('the pro rungs take the reasoning model', () => {
    for (const rung of ['brief', 'standard']) {
      assert.equal(pickModelFor(rung, OWNER_PLAN).model.label, '3.1 Pro', rung);
    }
  });

  test('a plan without extended thinking degrades to pro rather than failing', () => {
    assert.equal(pickModelFor('deep', LEAN_PLAN).model.label, '3.1 Pro');
  });

  test('a plan without a lite option still gives the fast rung something', () => {
    assert.equal(pickModelFor('flash', LEAN_PLAN).model.label, '3.8 Flash');
  });

  /**
   * Version numbers move. The whole reason the list is read from the page is
   * that `3.8 Flash` will not be called that for long.
   */
  test('the version number is not what is matched on', () => {
    const renamed = [
      { label: '4.2 Flash-Lite', description: 'Fastest answers' },
      { label: '4.9 Flash', description: 'All-around help' },
      { label: '4.0 Pro', description: 'Advanced reasoning' },
    ];
    assert.equal(pickModelFor('flash', renamed).model.label, '4.2 Flash-Lite');
    assert.equal(pickModelFor('standard', renamed).model.label, '4.0 Pro');
  });

  test('a description alone is enough when the label says nothing', () => {
    const opaque = [
      { label: 'Model A', description: 'Fastest answers' },
      { label: 'Model B', description: 'Advanced reasoning' },
    ];
    assert.equal(pickModelFor('flash', opaque).model.label, 'Model A');
    assert.equal(pickModelFor('standard', opaque).model.label, 'Model B');
  });

  test('the fast rung refuses a heavy option even when the words overlap', () => {
    const tricky = [
      { label: 'Flash Extended', description: 'Complex problem solving' },
      { label: 'Flash', description: 'Fastest answers' },
    ];
    assert.equal(pickModelFor('flash', tricky).model.label, 'Flash');
  });

  test('nothing to pick from is null, not a guess', () => {
    assert.equal(pickModelFor('flash', []), null);
    assert.equal(pickModelFor('flash', undefined), null);
    assert.equal(pickModelFor('nonsense', OWNER_PLAN), null);
  });

  test('it says why, because a switch you cannot explain reads as a bug', () => {
    assert.match(pickModelFor('deep', OWNER_PLAN).why, /Extended thinking/);
    assert.match(pickModelFor('deep', OWNER_PLAN).why, /deep/);
  });
});

describe('planModelSwitch — the cheapest interaction is the one not performed', () => {
  test('already on the right model means no click', () => {
    const plan = planModelSwitch('flash-thinking', OWNER_PLAN);
    assert.equal(plan.action, 'none');
    assert.match(plan.reason, /already on 3\.8 Flash/);
  });

  test('a different model means switch, and names it', () => {
    const plan = planModelSwitch('deep', OWNER_PLAN);
    assert.equal(plan.action, 'switch');
    assert.equal(plan.model.label, 'Extended thinking');
  });

  test('no list yet is unavailable, not a failure to act on', () => {
    const plan = planModelSwitch('deep', []);
    assert.equal(plan.action, 'unavailable');
    assert.match(plan.reason, /not reported a model list/);
  });

  test('a plan that offers nothing suitable says what it does offer', () => {
    const odd = [{ label: 'Canvas', description: 'Drawing' }];
    const plan = planModelSwitch('deep', odd);
    assert.equal(plan.action, 'unavailable');
    assert.match(plan.reason, /Canvas/);
  });
});

/**
 * What `/effort` says after asking the browser to change model.
 *
 * Each of these is a *request* to a page nobody here controls, so the useful
 * follow-up is "check the picker" — not a remedy for a failure that may not
 * have happened. It used to lead with "if nothing happens, reload the
 * extension", which is advice for a stale bridge: a different problem, offered
 * before there was any sign of one.
 *
 * The confirmation earns its line because of what silence costs. An unnoticed
 * failure leaves a prompt written for Pro being typed into a Flash tab —
 * CLAUDE.md's worst case, the long prompt going to the model that handles long
 * prompts worst — and the picker is the only place that is visible.
 */
describe('the message after an effort switch', () => {
  const run = async (effort, modelOptions) => {
    // Only what `/effort` reaches for. Growing this as it errors is how the
    // stub stays honest about the command's real dependencies.
    const loop = {
      modelConfig: { effort: 'standard' },
      modelOptions,
      promptBuilder: { resetPromptState() {} },
      switchModelTo() {},
      requestModelOptions() {},
      _saveConfig() {},
    };
    const { handleSlashCommand } = await import('../../src/core/slash-commands.js');
    return (await handleSlashCommand(loop, 'effort', [effort])).message;
  };

  /*
   * It used to say "check the Gemini tab's picker now reads X before you send
   * anything — the picker is the only proof it landed". It was not the only
   * proof: the extension re-reads the picker after the click, and now reports
   * what it *says* rather than echoing what was asked for. So the message
   * promises a line, instead of sending the user to go and find a browser tab.
   */
  test('a known switch says the picker will be read back', async () => {
    const msg = await run('brief', [{ label: 'Gemini Pro' }, { label: '3.8 Flash' }]);
    assert.match(msg, /Switching the browser/);
    assert.match(msg, /read back after the switch/);
    assert.match(msg, /Gemini Pro/);
    assert.doesNotMatch(msg, /Check the Gemini tab/i, 'it still sends the user looking');
  });

  test('so does an unknown one, while it goes looking', async () => {
    const msg = await run('brief', []);
    assert.match(msg, /Asking the browser/);
    assert.match(msg, /read back after the switch/);
  });

  // Nothing was asked for, so there is nothing to confirm. `none` needs the
  // *selected* option to already be the one this effort wants — my first
  // version of this test passed a list the effort could not match at all,
  // which is `unavailable`, a different branch.
  test('already on it asks for nothing', async () => {
    const msg = await run('brief', [
      { label: 'Gemini Pro', selected: true },
      { label: '3.8 Flash' },
    ]);
    assert.match(msg, /already on/);
    assert.doesNotMatch(msg, /read back after the switch/);
  });

  test('it no longer leads with reload instructions', async () => {
    for (const options of [[], [{ label: 'Gemini Pro' }]]) {
      const msg = await run('brief', options);
      assert.doesNotMatch(msg, /chrome:\/\/extensions/,
        'a stale bridge is a different problem, and there is no sign of one yet');
      assert.doesNotMatch(msg, /If nothing happens/);
    }
  });
});

/**
 * The switch is reported from what the picker reads, not from what was asked.
 *
 * `switchedTo` used to echo the requested label straight back from the content
 * script, so "Browser mode switched to X" was printed whenever the click did
 * not throw — a claim rather than an observation. Which is exactly why the CLI
 * then told the user to go and check the picker themselves: the one thing that
 * could have checked it was throwing the answer away.
 */
describe('noteModelOptions reports what landed', () => {
  const notes = () => {
    const said = [];
    const loop = Object.create(AgentLoop.prototype);
    Object.assign(loop, { _notify: (m) => said.push(m), modelOptions: null });
    return { loop, said };
  };

  test('a switch that landed says so', () => {
    const { loop, said } = notes();
    loop.noteModelOptions([{ label: 'Gemini Pro', selected: true }], 'Gemini Pro', 'Gemini Pro');
    assert.match(said[0], /now Gemini Pro/);
    assert.ok(said[0].startsWith('✓'), `not a success row: ${said[0]}`);
  });

  /*
   * The case the old code could not report at all: the click succeeded, the
   * picker did not move. Silence here is worse than a warning, because the
   * prompt profile *did* change on this side — so the model is being sent
   * deep-tier prompts while the tab is still on Flash.
   */
  test('a switch that did not land is a warning, not silence', () => {
    const { loop, said } = notes();
    loop.noteModelOptions([{ label: '3.8 Flash', selected: true }], '3.8 Flash', 'Gemini Pro');
    assert.ok(said[0].startsWith('!'), `not a failure row: ${said[0]}`);
    assert.match(said[0], /still 3.8 Flash/);
    assert.match(said[0], /asked for Gemini Pro/);
    // The one thing the person can actually do about it, and how to get there.
    assert.match(said[0], /by hand in the Gemini tab/);
    assert.match(said[0], /ctrl\+b/);
  });

  test('a picker that reads nothing recognisable still says something', () => {
    const { loop, said } = notes();
    loop.noteModelOptions([{ label: 'x' }], null, 'Gemini Pro');
    assert.match(said[0], /still unknown/);
  });

  // Case matters to nobody but a string compare. "gemini pro" and "Gemini Pro"
  // are the same picker entry, and warning about that would be noise on every
  // single switch.
  test('the comparison is not case-sensitive', () => {
    const { loop, said } = notes();
    loop.noteModelOptions([{ label: 'gemini pro', selected: true }], 'gemini pro', 'Gemini Pro');
    assert.ok(said[0].startsWith('✓'));
  });
});
