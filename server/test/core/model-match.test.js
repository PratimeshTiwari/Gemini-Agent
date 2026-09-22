import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  modelMismatch, pickModelFor, planModelSwitch, explainModelMismatch, browserModelPin,
} from '../../src/core/model-match.js';
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
    assert.equal(pickModelFor('lite', OWNER_PLAN).model.label, '3.5 Flash-Lite');
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
    assert.equal(pickModelFor('lite', LEAN_PLAN).model.label, '3.8 Flash');
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
    assert.equal(pickModelFor('lite', renamed).model.label, '4.2 Flash-Lite');
    assert.equal(pickModelFor('pro', renamed).model.label, '4.0 Pro');
  });

  test('a description alone is enough when the label says nothing', () => {
    const opaque = [
      { label: 'Model A', description: 'Fastest answers' },
      { label: 'Model B', description: 'Advanced reasoning' },
    ];
    assert.equal(pickModelFor('lite', opaque).model.label, 'Model A');
    assert.equal(pickModelFor('pro', opaque).model.label, 'Model B');
  });

  test('the fast rung refuses a heavy option even when the words overlap', () => {
    const tricky = [
      { label: 'Flash Extended', description: 'Complex problem solving' },
      { label: 'Flash', description: 'Fastest answers' },
    ];
    assert.equal(pickModelFor('lite', tricky).model.label, 'Flash');
  });

  test('nothing to pick from is null, not a guess', () => {
    assert.equal(pickModelFor('lite', []), null);
    assert.equal(pickModelFor('lite', undefined), null);
    assert.equal(pickModelFor('nonsense', OWNER_PLAN), null);
  });

  test('it says why, because a switch you cannot explain reads as a bug', () => {
    assert.match(pickModelFor('pro', OWNER_PLAN).why, /3\.1 Pro/);
    assert.match(pickModelFor('pro', OWNER_PLAN).why, /pro/);
  });
});

describe('planModelSwitch — the cheapest interaction is the one not performed', () => {
  test('already on the right model means no click', () => {
    const plan = planModelSwitch('flash', OWNER_PLAN);
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
    // Past tense: the row is `<Static>` scrollback from the moment the command
    // ran, so a present participle read as live status for the whole session.
    assert.match(msg, /asked the browser/i);
    assert.doesNotMatch(msg, /asking the browser/i);
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
  /*
   * A pin and a lucky intent match produce an identical row, and only one of
   * them is something the user chose. Saying which is the difference between a
   * setting you can trust and a coincidence you cannot tell from one.
   */
  test('a pinned model is labelled as pinned, not as a lucky guess', async () => {
    const msg = await run('pro', [{ label: 'Extended thinking' }, { label: '3.1 Pro' }], {
      modelConfig: { effort: 'pro', browserModels: { pro: 'Extended thinking' } },
    });
    assert.match(msg, /switching the browser to \*\*Extended thinking\*\*/);
    assert.match(msg, /_\(pinned\)_/);
  });

  /*
   * The one way this feature can fail quietly: a pin naming a label Google has
   * since renamed, or that belongs to another plan. It must not strand the rung
   * on nothing, and it must not do it in silence.
   */
  test('a pin the plan does not offer is warned about, not swallowed', async () => {
    const msg = await run('pro', [{ label: '3.1 Pro', description: 'Advanced reasoning' }], {
      modelConfig: { effort: 'pro', browserModels: { pro: 'Gemini 9 Ultra' } },
    });
    assert.match(msg, /⚠/);
    assert.match(msg, /Gemini 9 Ultra/);
    assert.match(msg, /3\.1 Pro/, 'it still switches to the best it can find');
  });

  test('mid-chat, it says the next message resends the whole prompt', async () => {
    const msg = await run('lite', [{ label: '3.8 Flash' }], {
      conversationHistory: [{ role: 'user', content: 'hi' }],
    });
    assert.match(msg, /resends the full prompt/);
    assert.match(msg, /\/compact/);
  });

  test('and says nothing of the sort in a fresh chat', async () => {
    const msg = await run('lite', [{ label: '3.8 Flash' }], { conversationHistory: [] });
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

/*
 * The CLI said PRO while the Gemini tab's picker said Flash, and nothing
 * mentioned it — a pro-tier prompt typed into a Flash tab, which `CLAUDE.md`
 * names as the worst case.
 */
describe('modelMismatch — only when both halves are known', () => {
  test('a different selected model is a mismatch, and names both sides', () => {
    const m = modelMismatch('pro', [
      { label: '3.8 Flash', selected: true },
      { label: '3.1 Pro', description: 'reasoning' },
    ]);
    assert.deepEqual(m, { current: '3.8 Flash', wanted: '3.1 Pro' });
  });

  test('agreement is silence', () => {
    assert.equal(modelMismatch('pro', [
      { label: '3.1 Pro', description: 'reasoning', selected: true },
      { label: '3.8 Flash' },
    ]), null);
  });

  /*
   * The controls, and they matter more than the positive case. A warning that
   * fires on missing information is one people learn to dismiss — at which
   * point it costs more than the mismatch it exists to catch.
   */
  test('nothing reported selected is silence, not a guess', () => {
    assert.equal(modelMismatch('pro', [{ label: '3.8 Flash' }, { label: '3.1 Pro' }]), null);
    assert.equal(modelMismatch('pro', []), null);
    assert.equal(modelMismatch('pro'), null);
    assert.equal(modelMismatch('pro', null), null);
  });

  // `unavailable` — nothing offered suits the rung — is a different problem and
  // not one the picker can fix, so it is not dressed up as one.
  test('a plan with nothing suitable is silence', () => {
    assert.equal(modelMismatch('lite', [{ label: 'Extended thinking', selected: true }]), null);
  });

  test('every rung on the ladder can be checked without throwing', () => {
    for (const e of EFFORT_LEVELS) {
      assert.doesNotThrow(() => modelMismatch(e.id, OWNER_PLAN), e.id);
    }
  });
});

/*
 * `browserModels` — the escape hatch the intent matcher never had.
 *
 * Everything above decides by what an option is *for*, which is what survives a
 * rename. It is still a scored word match over labels Google writes, and when
 * it picks wrong the only remedy was editing `INTENT` in source. A pin is the
 * user saying which label they mean.
 */
describe('browserModelPin — the config override, read by rung', () => {
  test('reads the rung it was asked for, case-insensitively', () => {
    const mc = { browserModels: { lite: 'Fast', flash: 'Thinking', pro: '3.1 Pro' } };
    assert.equal(browserModelPin(mc, 'pro'), '3.1 Pro');
    assert.equal(browserModelPin(mc, 'LITE'), 'Fast');
    assert.equal(browserModelPin(mc, ' flash '), 'Thinking');
  });

  // Absent is the default and must stay indistinguishable from "decide by
  // intent" — every config written before this existed is in this case.
  test('absent, blank and the wrong type are all "no pin"', () => {
    assert.equal(browserModelPin({}, 'pro'), '');
    assert.equal(browserModelPin(undefined, 'pro'), '');
    assert.equal(browserModelPin({ browserModels: {} }, 'pro'), '');
    assert.equal(browserModelPin({ browserModels: { pro: 3 } }, 'pro'), '');
    assert.equal(browserModelPin({ browserModels: { pro: '   ' } }, 'pro'), '');
  });
});

describe('pickModelFor — a pin overrides the intent match, when it can', () => {
  test('an exact pin wins, including one the intent match vetoes', () => {
    // `pro` avoids "extended" and "complex", so this option is unreachable by
    // intent — which is exactly the case a pin exists for.
    const pick = pickModelFor('pro', OWNER_PLAN, 'Extended thinking');
    assert.equal(pick.model.label, 'Extended thinking');
    assert.equal(pick.pinned, true);
  });

  test('a substring pin survives the version number moving', () => {
    assert.equal(pickModelFor('pro', OWNER_PLAN, 'Pro').model.label, '3.1 Pro');
    const renamed = OWNER_PLAN.map((m) => (m.label === '3.1 Pro' ? { ...m, label: '3.2 Pro' } : m));
    assert.equal(pickModelFor('pro', renamed, 'Pro').model.label, '3.2 Pro');
  });

  test('case does not matter', () => {
    assert.equal(
      pickModelFor('pro', OWNER_PLAN, 'extended THINKING').model.label, 'Extended thinking',
    );
  });

  test('an exact label beats being a substring of another', () => {
    const plan = [{ label: '3.1 Pro Preview' }, { label: 'Pro' }];
    assert.equal(pickModelFor('pro', plan, 'Pro').model.label, 'Pro');
  });

  /*
   * The failure a pin could introduce, and why it cannot.
   *
   * A pin this plan does not offer — a rename, another subscription, a config
   * copied off another machine — would strand the rung on nothing for the life
   * of the install. That is worse than the occasional bad intent match it was
   * added to fix, so an unresolvable pin is reported and stepped over.
   */
  test('a pin this plan does not offer falls back, and says so', () => {
    const pick = pickModelFor('pro', OWNER_PLAN, 'Gemini 9 Ultra');
    assert.equal(pick.model.label, '3.1 Pro', 'it still picks by intent');
    assert.equal(pick.pinned, false);
    assert.match(pick.pinMissed, /does not offer/);
    assert.match(pick.why, /Gemini 9 Ultra/, 'and the reason rides on `why`');
  });

  // "Flash" is both `3.5 Flash-Lite` and `3.8 Flash`. Picking one of those by
  // position is how you land on a model nobody chose.
  test('an ambiguous pin is treated as missed, not resolved by position', () => {
    const pick = pickModelFor('lite', OWNER_PLAN, 'Flash');
    assert.equal(pick.pinned, false);
    assert.match(pick.pinMissed, /matches 2/);
    assert.equal(pick.model.label, '3.5 Flash-Lite');
  });

  test('no pin is byte for byte what it was before', () => {
    for (const rung of EFFORT_LEVELS.map((e) => e.id)) {
      assert.deepEqual(
        pickModelFor(rung, OWNER_PLAN), pickModelFor(rung, OWNER_PLAN, ''), rung,
      );
    }
  });
});

describe('planModelSwitch and explainModelMismatch carry the pin', () => {
  test('a pinned switch says it was pinned', () => {
    const plan = planModelSwitch('pro', OWNER_PLAN, 'Extended thinking');
    assert.equal(plan.action, 'switch');
    assert.equal(plan.model.label, 'Extended thinking');
    assert.equal(plan.pinned, true);
  });

  test('already on the pinned model is still no click', () => {
    const plan = planModelSwitch('pro', [
      { label: 'Extended thinking', description: 'Complex problem solving', selected: true },
      { label: '3.1 Pro', description: 'Advanced reasoning' },
    ], 'Extended thinking');
    assert.equal(plan.action, 'none');
    assert.equal(plan.pinned, true);
  });

  test('a missed pin still switches, and carries the reason', () => {
    const plan = planModelSwitch('pro', OWNER_PLAN, 'nothing like this');
    assert.equal(plan.action, 'switch');
    assert.equal(plan.pinned, false);
    assert.match(plan.pinMissed, /does not offer/);
  });

  // The point of the pin: it redefines what "the right model" means, so a
  // picker that agreed with the intent match now disagrees with you.
  test('a pin turns an agreeing picker into a mismatch', () => {
    const models = [
      { label: '3.1 Pro', description: 'Advanced reasoning', selected: true },
      { label: 'Extended thinking', description: 'Complex problem solving' },
    ];
    assert.equal(explainModelMismatch('pro', models).state, 'agree');

    const pinned = explainModelMismatch('pro', models, 'Extended thinking');
    assert.equal(pinned.state, 'mismatch');
    assert.equal(pinned.wanted, 'Extended thinking');
    assert.equal(pinned.pinned, true);
  });

  test('a mismatch the pin did not cause reports itself as unpinned', () => {
    const models = [
      { label: '3.8 Flash', description: 'All-around help', selected: true },
      { label: '3.1 Pro', description: 'Advanced reasoning' },
    ];
    assert.equal(explainModelMismatch('pro', models).pinned, false);
  });

  // `modelMismatch` keeps its two-field contract: the status row only needs
  // "warn or don't", and an extra key is one more thing to start relying on.
  test('modelMismatch still answers with exactly current and wanted', () => {
    const m = modelMismatch('pro', [
      { label: '3.1 Pro', description: 'Advanced reasoning', selected: true },
      { label: 'Extended thinking', description: 'Complex problem solving' },
    ], 'Extended thinking');
    assert.deepEqual(m, { current: '3.1 Pro', wanted: 'Extended thinking' });
  });
});

/*
 * `requestModelOptions` was fire-and-forget, and that was half of A4.
 *
 * Reported from use with two screenshots: the status bar on `LITE`, the tab
 * still on `Pro`, and no warning row — on a terminal tall enough that the
 * height-shedding rule was not the explanation. The warning was not choosing
 * silence. `discover_models` had gone unanswered, so `modelOptions` stayed
 * empty, `explainModelMismatch` sat in `unknown`, and there was nothing to
 * compare against and no record that there was nothing.
 */
describe('requestModelOptions — silence gets written down', () => {
  const mkws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'picker-'));

  const loopWith = (workspace, over = {}) => {
    const sent = [];
    const said = [];
    const loop = Object.create(AgentLoop.prototype);
    Object.assign(loop, {
      workspace,
      modelConfig: { effort: 'pro' },
      modelOptions: null,
      _notify: (m) => said.push(m),
      _toExtension: (type) => sent.push(type),
      ...over,
    });
    return { loop, sent, said };
  };

  const errors = (ws) => {
    const file = path.join(ws, '.agent', 'logs', 'errors.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  };

  /*
   * Mocked timers, not a real wait. This repo has already learned once that a
   * wall-clock assertion with no margin measures the machine rather than the
   * code — and the watchdog's whole point is an 8s window nobody should sit
   * through in a test.
   */
  test('a second ask does not arm a second watchdog', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { loop, sent } = loopWith(mkws());
    loop.requestModelOptions();
    const first = loop._modelOptionsWatchdog;
    loop.requestModelOptions();
    assert.equal(sent.length, 2, 'both asks still reach the extension');
    assert.strictEqual(loop._modelOptionsWatchdog, first, 'but there is only one timer');
  });

  test('an answer disarms it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ws = mkws();
    const { loop } = loopWith(ws);
    loop.requestModelOptions();
    assert.ok(loop._modelOptionsWatchdog, 'armed');
    loop.noteModelOptions([{ label: '3.1 Pro', selected: true }]);
    assert.equal(loop._modelOptionsWatchdog, null, 'disarmed');
    t.mock.timers.tick(30000);
    assert.equal(errors(ws).filter((r) => r.op === 'model_options_unanswered').length, 0);
  });

  // A malformed answer is still an answer — leaving the timer armed would log
  // a silence that did not happen.
  test('an empty list is an answer too', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { loop } = loopWith(mkws());
    loop.requestModelOptions();
    loop.noteModelOptions([]);
    assert.equal(loop._modelOptionsWatchdog, null);
  });

  test('silence lands in the log where /logs agent can find it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ws = mkws();
    const { loop } = loopWith(ws);
    loop.requestModelOptions();
    t.mock.timers.tick(30000);
    const row = errors(ws).find((r) => r.op === 'model_options_unanswered');
    assert.ok(row, 'nothing recorded the unanswered ask');
    assert.equal(row.flow, 'agent');
    assert.equal(row.meta.effort, 'pro');
  });

  /*
   * A row only when somebody is waiting for one. `/effort` leaves
   * `_pendingEffortSwitch` set and has already printed "asked the browser…",
   * so it owes a follow-up. The once-a-minute background poll owes nothing —
   * a notice every minute about a picker you are not setting is the kind of
   * warning people learn to scroll past, which costs more than it saves.
   */
  test('it tells you only when you were the one waiting', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const poll = loopWith(mkws());
    poll.loop.requestModelOptions();
    t.mock.timers.tick(30000);
    assert.deepEqual(poll.said, [], 'a background poll says nothing');

    const asked = loopWith(mkws(), { _pendingEffortSwitch: 'pro' });
    asked.loop.requestModelOptions();
    t.mock.timers.tick(30000);
    assert.match(asked.said[0], /never answered/);
    assert.match(asked.said[0], /ctrl\+b/);
    assert.equal(asked.loop._pendingEffortSwitch, null, 'and it is not left pending');
  });
});
