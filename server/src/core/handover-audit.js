/**
 * Checking the handover block against what the turn actually did.
 *
 * `prompts/pro-handover-review.md` asks for a closing block — checklist, what
 * ran, whose callers were checked, what was skipped — in bold, with the hedge
 * explicitly forbidden: *"either you looked, and you cite what you saw, or the
 * answer is 'not checked'"*. Nothing ever compared the answer to anything.
 *
 * Measured before this existed: `grep -rn "## Review\|Callers checked" server/src
 * --exclude-dir=prompts` returned **one hit, in the file that writes the
 * format**. A checklist whose answers are only prose is a checklist the model
 * can satisfy by writing prose — and a model out of budget will always find
 * prose cheaper than a tool call.
 *
 * The observed failure: a review closed with `Checklist: 3/3 review dimensions
 * evaluated`, inventing three dimensions in the same sentence; `Ran: Adversarial
 * security and reliability analysis`, naming an activity and running nothing;
 * and `Callers checked: server/src/core/agent-loop.js, .../diff-engine.js,
 * server/src/bridge/` — three paths, one of them a directory, with
 * `find_references` never called. Its recommendation was to add whitespace-fuzzy
 * matching to `diff-engine.js`, which has had it at line 235 for months.
 *
 * Three constraints, and each one is load-bearing:
 *
 * - **It reports, it never rewrites.** The model's text reaches the user
 *   unchanged. Editing an agent's self-report to make it accurate is worse than
 *   leaving it wrong, because then nothing on screen is the agent's own voice.
 * - **"Unsupported" is not "false".** A model can legitimately answer from an
 *   earlier turn's reads. So a finding says *"claimed a command ran; none ran
 *   this turn"* — a fact about this turn, which is checkable — and never "the
 *   agent lied".
 * - **It fails open.** No block, or one in a shape it does not recognise,
 *   produces nothing. A detector that punishes an unusual format teaches the
 *   model to stop emitting the format, and then the thing being measured
 *   disappears rather than improving.
 *
 * What it cannot catch, and why the reviewer still matters: `Callers checked:
 * diff-engine.js` was **true** — the file was read. The error was reasoning from
 * one citation instead of reading on to line 235. No local check sees that; only
 * a second reader does.
 */

/** The closing block, however much prose precedes it. */
const BLOCK = /^[ \t]*#{1,4}[ \t]*Review[ \t]*$/im;

/** `- Label: value`, tolerant of `*`, missing space, and bold markers. */
const LINE = /^[ \t]*[-*][ \t]*\*{0,2}([A-Za-z][A-Za-z /]*?)\*{0,2}[ \t]*:[ \t]*(.*)$/;

/**
 * Phrases that turn a claim into a non-claim.
 *
 * The prompt offers these as first-class answers — `[or: not run, because …]` —
 * so a model that honestly says it did not run anything must not be reported as
 * having claimed it did. Getting this wrong would punish the exact behaviour the
 * block is asking for.
 */
const DISCLAIMED = /\b(not\s+run|not\s+checked|none|n\/a|nothing|did\s+not|didn't|no\s+(?:command|test|call)s?)\b/i;

/** Tools whose use would support each claim. */
const SUPPORTED_BY = {
  ran: ['run_command'],
  callers: ['find_references', 'grep_search', 'find_symbol'],
  read: ['read_file'],
};

/** Which labels map to which claim, in the shapes the block actually uses. */
function claimFor(label) {
  const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (l === 'ran' || l === 'ran it' || l === 'tests') return 'ran';
  if (l.startsWith('callers')) return 'callers';
  if (l.startsWith('checklist')) return 'checklist';
  return null;
}

/**
 * Did any of `tools` run this turn?
 * @param {Map<string, number>|Record<string, number>|null} evidence
 */
function ranAny(evidence, tools) {
  if (!evidence) return false;
  const get = evidence instanceof Map
    ? (k) => evidence.get(k)
    : (k) => evidence[k];
  return tools.some((t) => Number(get(t)) > 0);
}

/**
 * Audit a reply's handover block against the turn's record.
 *
 * @param {string} text - the model's reply, tool calls already stripped
 * @param {object} turn
 * @param {Map<string, number>|Record<string, number>} [turn.evidence] - tool
 *   call counts for this turn, from `AgentLoop._turnEvidence`
 * @param {{total: number, done: number}|null} [turn.checklist] - what
 *   `task.md` actually contains, or null if there is no list
 * @returns {{findings: {claim: string, said: string, because: string}[]}}
 *   Empty findings means "nothing to report" — including when there was no
 *   block to read, which is not a failure.
 */
export function auditHandover(text, { evidence = null, checklist = null } = {}) {
  const findings = [];
  if (typeof text !== 'string' || !text) return { findings };

  const start = text.search(BLOCK);
  if (start === -1) return { findings };

  for (const raw of text.slice(start).split('\n')) {
    const m = raw.match(LINE);
    if (!m) continue;

    const claim = claimFor(m[1]);
    const said = m[2].trim();
    if (!claim || !said) continue;

    // "not run, because …" is an answer the prompt explicitly offers. Treating
    // it as a claim would report honesty as a finding.
    if (DISCLAIMED.test(said)) continue;

    if (claim === 'checklist') {
      const m2 = said.match(/(\d+)\s*\/\s*(\d+)/);
      if (!m2) continue;                       // prose, not a count: fail open
      const [, done, total] = m2.map(Number);

      // No list on disk is not a contradiction: the model may be reporting
      // against something it never wrote down, which is its own problem and not
      // one this can prove.
      if (!checklist || !checklist.total) continue;

      if (total !== checklist.total) {
        findings.push({
          claim: 'checklist',
          said,
          because: `task.md has ${checklist.total} item${checklist.total === 1 ? '' : 's'}, not ${total}`,
        });
      } else if (done > checklist.done) {
        findings.push({
          claim: 'checklist',
          said,
          because: `${checklist.done} of ${checklist.total} are ticked in task.md`,
        });
      }
      continue;
    }

    if (!ranAny(evidence, SUPPORTED_BY[claim])) {
      findings.push({
        claim,
        said,
        because: claim === 'ran'
          ? 'no command ran this turn'
          : 'no find_references or grep_search ran this turn',
      });
    }
  }

  return { findings };
}

/**
 * One dim line for the transcript, or null when there is nothing to say.
 *
 * Deliberately not a paragraph, and deliberately about *this turn* rather than
 * about the agent. It lives in the live frame, where a row that wraps is
 * charged as one and drawn as two.
 *
 * @param {{claim: string, because: string}[]} findings
 * @param {number} [width] - columns available; the reasons truncate, not the count
 */
export function describeFindings(findings, width = 80) {
  if (!findings?.length) return null;

  const reasons = findings.map((f) => f.because).join('; ');
  const head = findings.length === 1
    ? 'unverified in the handover: '
    : `${findings.length} unverified in the handover: `;

  const room = Math.max(12, width - head.length - 2);
  return head + (reasons.length <= room ? reasons : `${reasons.slice(0, room - 1)}…`);
}

/**
 * Count a markdown checklist.
 *
 * Shared with the prompt builder's view of `task.md` so the audit and the model
 * are counting the same thing. Anything that is not a `- [ ]` / `- [x]` line is
 * not an item — a heading or a note between items must not change the total.
 *
 * @param {string} body
 * @returns {{total: number, done: number}|null}
 */
export function countChecklist(body) {
  if (typeof body !== 'string') return null;
  const items = body.match(/^[ \t]*[-*][ \t]*\[[ xX]\]/gm);
  if (!items) return null;
  return {
    total: items.length,
    done: items.filter((i) => /\[[xX]\]/.test(i)).length,
  };
}
