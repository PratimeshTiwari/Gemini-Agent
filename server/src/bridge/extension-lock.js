/**
 * One in-flight prompt per model, rather than one for the whole bridge.
 *
 * There is no API here: a prompt is typed into a real chat tab and the reply is
 * scraped back, so a tab can only be doing one thing at a time. That much was
 * always true. What was not true is that *every* tab shares one turn.
 *
 * `_executeToolCalls` fans `ask_reviewer` / `ask_researcher` / `ask_subagent`
 * out with `Promise.all`, and the duo topology exists precisely so the reviewer
 * runs on the other model. But a single global `isExtensionBusy` meant the
 * ChatGPT review queued behind the Gemini prompt that asked for it: the
 * concurrency was in the JavaScript and nowhere else. A lane per model makes it
 * real, and costs nothing where there is only one model in play.
 *
 * **A lane is a tab, not a model.** That distinction used to be unavailable:
 * the extension addressed tabs by URL pattern and took whatever was last, so
 * two concurrent same-model requests raced for one tab and could interleave two
 * prompts into a single conversation. Keying by model was the only safe thing
 * to do. Tab identity landed in the extension, so it no longer is — a subagent
 * turn opens its *own* tab, which means it shares nothing with the user's turn
 * but the site.
 *
 * So there are two kinds of lane:
 *
 * - `main:<model>` — the model's own conversation tab, sticky for the session.
 *   One at a time, because there is one tab and one thread in it.
 * - `sub:<requestId>` — one subagent turn, in a tab created for it and closed
 *   after. These have no reason to wait for anything, including each other.
 *
 * What that buys: `_executeToolCalls` fans the `ask_*` calls out with
 * `Promise.all` and they now genuinely run at once, same model or not. And a
 * background GitHub turn stops queueing behind whatever the user is typing —
 * the two were always going to different tabs, and only this lock said
 * otherwise.
 *
 * Sub lanes are deleted when they go idle. One per turn, kept forever, is a map
 * that grows for the life of the session with nothing ever reading it again.
 */

/** The lane a model's own conversation runs in. */
export const mainLane = (model) => `main:${model || 'gemini'}`;

/** The lane one subagent turn runs in — its own tab, so its own lane. */
export const subLane = (requestId) => `sub:${requestId}`;

/**
 * Which lane a payload belongs to.
 *
 * A subagent request without a `requestId` falls back to the model's main lane.
 * That is the conservative reading: without an id there is nothing to tell two
 * such turns apart, so serialising them is the only safe answer.
 */
export const laneFor = (payload) => (payload?.isSubagent && payload.requestId
  ? subLane(payload.requestId)
  : mainLane(payload?.targetModel));
export class ExtensionLock {
  /**
   * @param {object} handlers
   * @param {(payload: object) => void} handlers.send - hand a payload to the bridge
   * @param {(model: string) => void} handlers.onStall - a lane went quiet past the timeout
   * @param {number} handlers.timeoutMs - how long to wait before calling that
   */
  constructor({ send, onStall, timeoutMs }) {
    this.send = send;
    this.onStall = onStall;
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, {busy: boolean, queue: object[], watchdog: any}>} */
    this.lanes = new Map();
  }

  /**
   * A bare model name means that model's main lane.
   *
   * Every caller outside this file used to pass a model, and most still mean
   * exactly that — `release('gemini')` is "the user's Gemini turn is over".
   * Normalising here rather than making them all spell it keeps the common case
   * readable, and a lane name is unambiguous because a model name has no colon.
   */
  _key(lane) {
    const name = lane || 'gemini';
    return String(name).includes(':') ? String(name) : mainLane(name);
  }

  _lane(lane) {
    const key = this._key(lane);
    if (!this.lanes.has(key)) {
      this.lanes.set(key, { busy: false, queue: [], watchdog: null, model: null });
    }
    return this.lanes.get(key);
  }

  /** Queue a payload for its lane and start it if that lane is free. */
  enqueue(payload) {
    const name = laneFor(payload);
    const lane = this._lane(name);
    // Remembered so a stall can say which *tab* went quiet. The lane name is
    // an id; "no response from the chatgpt tab" is what a person can act on.
    lane.model = payload?.targetModel || lane.model;
    lane.queue.push(payload);
    this._pump(name);
  }

  _pump(name) {
    const lane = this._lane(name);
    if (lane.busy || lane.queue.length === 0) return;
    lane.busy = true;
    this._arm(name);
    this.send(lane.queue.shift());
  }

  /**
   * Hand a lane back. Every path that ends a turn has to reach this, or that
   * lane wedges for the rest of the session and later prompts vanish into it
   * silently — which is why it takes the model rather than inferring it.
   */
  release(name) {
    const key = this._key(name);
    const lane = this._lane(key);
    this._disarm(key);
    lane.busy = false;
    this._pump(key);

    // A sub lane is one turn in a tab that has since been closed. Keeping the
    // entry once it is idle and empty is a map that grows for the life of the
    // session with nothing ever reading it again.
    if (key.startsWith('sub:') && !lane.busy && lane.queue.length === 0) {
      this.lanes.delete(key);
    }
  }

  /** Is this lane mid-turn? A bare model name means that model's main lane. */
  isBusy(name) {
    return this._lane(name).busy;
  }

  /** Any tab at all — what the UI's "thinking" state is really asking. */
  get anyBusy() {
    return [...this.lanes.values()].some((lane) => lane.busy);
  }

  /**
   * Give up on everything in flight and drop what was queued behind it.
   *
   * Used when a turn dies rather than completes. The queued prompts belong to
   * that dead turn, so replaying them would be wrong.
   */
  abortAll() {
    for (const key of [...this.lanes.keys()]) {
      const lane = this._lane(key);
      this._disarm(key);
      lane.queue.length = 0;
      lane.busy = false;
      if (key.startsWith('sub:')) this.lanes.delete(key);
    }
  }

  _arm(name) {
    const key = this._key(name);
    const lane = this._lane(key);
    this._disarm(key);
    lane.watchdog = setTimeout(() => {
      lane.watchdog = null;
      if (!lane.busy) return;
      // The lane says what to release; the model says what to tell the person.
      this.onStall(key, lane.model);
    }, this.timeoutMs);
    lane.watchdog.unref?.();
  }

  _disarm(name) {
    const lane = this._lane(name);
    if (lane.watchdog) {
      clearTimeout(lane.watchdog);
      lane.watchdog = null;
    }
  }
}
