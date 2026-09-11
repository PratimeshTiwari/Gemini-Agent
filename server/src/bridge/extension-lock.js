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
 * Two tabs of the *same* model stay out of scope, and deliberately. The
 * extension addresses tabs by URL pattern rather than identity, so two
 * concurrent same-model requests race for one tab and can interleave two
 * prompts into a single conversation. Making that safe means threading tab
 * identity through the whole bridge, to buy something a second model already
 * provides.
 */
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

  _lane(model) {
    const key = model || 'gemini';
    if (!this.lanes.has(key)) this.lanes.set(key, { busy: false, queue: [], watchdog: null });
    return this.lanes.get(key);
  }

  /** Queue a payload for its `targetModel` and start it if that lane is free. */
  enqueue(payload) {
    this._lane(payload.targetModel).queue.push(payload);
    this._pump(payload.targetModel);
  }

  _pump(model) {
    const lane = this._lane(model);
    if (lane.busy || lane.queue.length === 0) return;
    lane.busy = true;
    this._arm(model);
    this.send(lane.queue.shift());
  }

  /**
   * Hand a lane back. Every path that ends a turn has to reach this, or that
   * lane wedges for the rest of the session and later prompts vanish into it
   * silently — which is why it takes the model rather than inferring it.
   */
  release(model) {
    const lane = this._lane(model);
    this._disarm(model);
    lane.busy = false;
    this._pump(model);
  }

  /** Is this model's tab mid-turn? */
  isBusy(model) {
    return this._lane(model).busy;
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
    for (const model of this.lanes.keys()) {
      const lane = this._lane(model);
      this._disarm(model);
      lane.queue.length = 0;
      lane.busy = false;
    }
  }

  _arm(model) {
    const lane = this._lane(model);
    this._disarm(model);
    lane.watchdog = setTimeout(() => {
      lane.watchdog = null;
      if (!lane.busy) return;
      this.onStall(model);
    }, this.timeoutMs);
    lane.watchdog.unref?.();
  }

  _disarm(model) {
    const lane = this._lane(model);
    if (lane.watchdog) {
      clearTimeout(lane.watchdog);
      lane.watchdog = null;
    }
  }
}
