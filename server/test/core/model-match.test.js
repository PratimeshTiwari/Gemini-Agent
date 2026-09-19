import { test, describe } from 'node:test';
import assert from 'node:assert';
import { pickModelFor, planModelSwitch } from '../../src/core/model-match.js';
import { EFFORT_LEVELS } from '../../src/core/effort.js';
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

  test('the pro rung takes the reasoning model', () => {
    assert.equal(pickModelFor('pro', OWNER_PLAN).model.label, '3.1 Pro');
  });

  /*
   * `INTENT` is keyed by rung id, which makes it what a rung change breaks
   * *silently*: an unknown id returns null, `planModelSwitch` answers
   * `unavailable`, and the message merely softens from "Switching the browser"
   * to "Asking the browser". Collapsing five rungs to three broke exactly this
   * and nothing else caught it.
   */
  test('every rung on the ladder can pick something', () => {
    for (const e of EFFORT_LEVELS) {
      assert.ok(pickModelFor(e.id, OWNER_PLAN), `${e.id} matched nothing in the owner's plan`);
      assert.ok(pickModelFor(e.id, LEAN_PLAN), `${e.id} matched nothing in the lean plan`);
    }
  });

  test('a retired rung id matches nothing, rather than pretending to', () => {
    for (const gone of ['brief', 'standard', 'deep']) {
      assert.equal(pickModelFor(gone, OWNER_PLAN), null, gone);
    }
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
    assert.equal(pickModelFor('pro', renamed).model.label, '4.0 Pro');
  });

  test('a description alone is enough when the label says nothing', () => {
    const opaque = [
      { label: 'Model A', description: 'Fastest answers' },
      { label: 'Model B', description: 'Advanced reasoning' },
    ];
    assert.equal(pickModelFor('flash', opaque).model.label, 'Model A');
    assert.equal(pickModelFor('pro', opaque).model.label, 'Model B');
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
    assert.match(pickModelFor('pro', OWNER_PLAN).why, /3\.1 Pro/);
    assert.match(pickModelFor('pro', OWNER_PLAN).why, /pro/);
  });
});

describe('planModelSwitch — the cheapest interaction is the one not performed', () => {
  test('already on the right model means no click', () => {
    const plan = planModelSwitch('flash-thinking', OWNER_PLAN);
    assert.equal(plan.action, 'none');
    assert.match(plan.reason, /already on 3\.8 Flash/);
  });

  /*
   * `pro` reaches for the reasoning model and *avoids* extended thinking —
   * that preference belonged to `deep`, which is gone. Asserting the label
   * rather than just `action: 'switch'` is what makes that visible.
   */
  test('a different model means switch, and names it', () => {
    const plan = planModelSwitch('pro', OWNER_PLAN);
    assert.equal(plan.action, 'switch');
    assert.equal(plan.model.label, '3.1 Pro');
  });

  test('no list yet is unavailable, not a failure to act on', () => {
    const plan = planModelSwitch('pro', []);
    assert.equal(plan.action, 'unavailable');
    assert.match(plan.reason, /not reported a model list/);
  });

  test('a plan that offers nothing suitable says what it does offer', () => {
    const odd = [{ label: 'Canvas', description: 'Drawing' }];
    const plan = planModelSwitch('pro', odd);
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
  const run = async (effort, modelOptions, over = {}) => {
    // Only what `/effort` reaches for. Growing this as it errors is how the
    // stub stays honest about the command's real dependencies.
    const loop = {
      modelConfig: { effort: 'pro' },
      modelOptions,
      promptBuilder: { resetPromptState() {} },
      switchModelTo() {},
      requestModelOptions() {},
      _saveConfig() {},
      ...over,
    };
    const { handleSlashCommand } = await import('../../src/core/slash-commands.js');
    return (await handleSlashCommand(loop, 'effort', [effort])).message;
  };

  /*
   * One row, not four. It used to answer with the rung's label, its blurb, the
   * browser line and an italic paragraph about the picker being read back —
   * and a menu pick pushes only the answer, so that landed in the transcript
   * with nothing above it saying where it came from.
   */
  test('a known switch names what changed and what the browser is doing', async () => {
    const msg = await run('pro', [{ label: 'Gemini Pro' }, { label: '3.8 Flash' }]);
    assert.match(msg, /switching the browser to \*\*Gemini Pro\*\*/);
    assert.match(msg, /⚙ effort/);
    assert.doesNotMatch(msg, /Check the Gemini tab/i, 'it still sends the user looking');
    // One row. The blurb belongs to bare `/effort`, which lists every rung.
    assert.ok(msg.split('\n').length <= 2, `expected one row, got:\n${msg}`);
  });

  /*
   * The only branch that cannot confirm anything — there is no model list to
   * match against — so it is the only one that offers the key showing the tab.
   */
  test('with no list it says so, and offers the tab', async () => {
    const msg = await run('pro', []);
    assert.match(msg, /asking the browser/i);
    assert.match(msg, /ctrl\+b/);
  });

  // Nothing was asked for, so there is nothing to confirm. `none` needs the
  // *selected* option to already be the one this effort wants — my first
  // version of this test passed a list the effort could not match at all,
  // which is `unavailable`, a different branch.
  test('already on it asks for nothing', async () => {
    const msg = await run('pro', [
      { label: 'Gemini Pro', selected: true },
      { label: '3.8 Flash' },
    ]);
    assert.match(msg, /already on/);
    assert.doesNotMatch(msg, /read back after the switch/);
  });

  /*
   * `/effort` calls `resetPromptState()`, so the next message carries the whole
   * system prompt — up to 26 KB — into a thread that already has one. That is
   * the large-repeated-payload case Gemini's filters react to, and it is
   * invisible: the command looks instant and the price lands on the next turn.
   *
   * Only when there *is* a chat to resend into. On a fresh one there is no cost
   * and the line would be noise on every first command of every session.
   */
  test('mid-chat, it says the next message resends the whole prompt', async () => {
    const msg = await run('flash', [{ label: '3.8 Flash' }], {
      conversationHistory: [{ role: 'user', content: 'hi' }],
    });
    assert.match(msg, /resends the full prompt/);
    assert.match(msg, /\/compact/);
  });

  test('and says nothing of the sort in a fresh chat', async () => {
    const msg = await run('flash', [{ label: '3.8 Flash' }], { conversationHistory: [] });
    assert.doesNotMatch(msg, /resends/);
  });

  test('it no longer leads with reload instructions', async () => {
    for (const options of [[], [{ label: 'Gemini Pro' }]]) {
      const msg = await run('pro', options);
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
