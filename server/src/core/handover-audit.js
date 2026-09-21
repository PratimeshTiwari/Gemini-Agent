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

/**
 * Is there a closing report in this text at all?
 *
 * Exported because the loop needs the question *before* it decides whether the
 * reply may be shown. A handover block is the model saying "I am done" — so one
 * sitting in the same reply as a tool call is a conclusion written before its
 * own evidence arrived, and `auditHandover` deliberately never sees it: the
 * audit runs only on a turn's final reply, because a claim made in passing is
 * not the closing report.
 *
 * That left the shape unguarded in both directions, which is what was reported
 * with screenshots — a Review block listing five verified files landing *before*
 * the `<tool_results>` that were supposed to support it.
 */
export function hasHandoverBlock(text) {
  return typeof text === 'string' && BLOCK.test(text);
}

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
  files: ['read_file'],
};

/**
 * Which labels map to which claim, in the shapes the block actually uses.
 *
 * `files` was the hole, and `SUPPORTED_BY` had a `read` entry that nothing
 * could ever reach — this function returned `ran`, `callers`, `checklist` or
 * null, so a read claim was unauditable by construction. Reported from use:
 * a `Review` block listing five **Verified Files**, two of which did not
 * exist — `server/src/ui/components/TasksPane.jsx`, and
 * `server/src/github/poller.js` in a directory deleted wholesale in
 * `e375aed`. The audit that exists for exactly this passed it clean, because
 * "Verified Files" matched no label it knew.
 *
 * It is the cheapest claim in the block to check and the most damaging to get
 * wrong: a path either exists or it does not, and an invented one is what an
 * invented architecture gets built on.
 */
function claimFor(label) {
  const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (l === 'ran' || l === 'ran it' || l === 'tests') return 'ran';
  if (l.startsWith('callers')) return 'callers';
  if (l.startsWith('checklist')) return 'checklist';
  // "Verified files", "Files", "Files read", "Read", "Checked files" — the
  // shapes seen in real blocks. Matched on the noun, because the adjective is
  // what varies.
  if (/^(verified|checked|inspected|reviewed)?\s*files?( (read|verified|checked|inspected))?$/.test(l)
      || l === 'read' || l === 'files') return 'files';
  return null;
}

/**
 * Paths out of a claim, whether it is one line or a nested list.
 *
 * The real block writes the label with **nothing after the colon** and the
 * paths as deeper list items beneath it — which the old parser dropped on the
 * floor, because it required `- Label: value` and skipped an empty value. So
 * the one shape that actually occurs was the one shape not read.
 *
 * A path is recognised by having a separator and an extension. Prose in the
 * same list is left alone rather than guessed at: a claim this cannot parse
 * must fail open, or the block stops being written at all.
 */
const PATH = /(?:^|[\s`'"(\[,])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z]\w*)/g;

/** `./a/b.js`, `/root/a/b.js` and `a/b.js` are the same file, not three. */
function normalisePath(p) {
  return String(p || '').trim().replace(/^\.\//, '').replace(/^\/+/, '');
}

function pathsIn(lines) {
  const out = [];
  for (const line of lines) {
    for (const m of line.matchAll(PATH)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
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
export function auditHandover(text, { evidence = null, checklist = null, exists = null, opened = null } = {}) {
  const findings = [];
  if (typeof text !== 'string' || !text) return { findings };

  const start = text.search(BLOCK);
  if (start === -1) return { findings };

  const lines = text.slice(start).split('\n');
  const indentOf = (line) => (line.match(/^[ \t]*/) || [''])[0].length;

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(LINE);
    if (!m) continue;

    const claim = claimFor(m[1]);

    /*
     * A label's value may be beside it or beneath it.
     *
     * This read `- Label: value` only, and skipped the line when the value was
     * empty — so the shape real blocks actually use, a label with the paths as
     * deeper list items under it, was parsed as nothing at all. That is how a
     * five-file claim with two invented paths went unread.
     *
     * A blank line does not end the group: models put one between a label and
     * its list often enough that treating it as a terminator loses the list.
     */
    const own = [];
    const base = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= base) break;
      own.push(lines[j]);
    }

    const said = m[2].trim() || own.map((l) => l.trim()).join(' ');
    if (!claim || !said) continue;

    // "not run, because …" is an answer the prompt explicitly offers. Treating
    // it as a claim would report honesty as a finding.
    if (DISCLAIMED.test(said)) continue;

    /*
     * A path either exists or it does not, which makes this the one claim in
     * the block that can be settled rather than weighed.
     *
     * `exists` is injected so this stays a pure function — the caller knows the
     * workspace, and a test can hand it a set. Without one, the claim degrades
     * to "was anything read at all", which is the old `read` check that was
     * unreachable.
     */
    if (claim === 'files') {
      const paths = pathsIn([m[2], ...own]);
      if (!paths.length) continue;               // prose, not paths: fail open
      const missing = exists ? paths.filter((f) => !exists(f)) : [];
      if (missing.length) {
        findings.push({
          claim: 'files',
          said: missing.join(', '),
          because: missing.length === 1
            ? `${missing[0]} does not exist`
            : `${missing.length} of ${paths.length} do not exist: ${missing.join(', ')}`,
        });
        continue;
      }

      /*
       * The path is real. Was *this* one opened, or merely named?
       *
       * The count alone answers "did anything get read", which a block citing
       * five files passes on the strength of one unrelated read somewhere else
       * in the turn. `opened` is the set of paths the turn actually touched, so
       * each citation is checked against its own evidence.
       *
       * Compared on the tail rather than exactly: the model writes
       * `server/src/ui/App.jsx` where the call may have said `./server/src/ui/App.jsx`
       * or an absolute path, and the same file under two spellings is not two
       * files. Matching loosely errs toward believing the model, which is the
       * right direction for a check that reports rather than blocks.
       *
       * **Unsupported is not false.** A model may legitimately cite something it
       * read three turns ago, so the finding says what *this turn* has no record
       * of — a fact that can be checked — and never that the claim is a lie.
       */
      if (opened && opened.size > 0) {
        const touched = [...opened].map(normalisePath);
        const unopened = paths.filter((f) => {
          const n = normalisePath(f);
          return !touched.some((t) => t === n || t.endsWith('/' + n) || n.endsWith('/' + t));
        });
        if (unopened.length) {
          findings.push({
            claim: 'files',
            said: unopened.join(', '),
            because: unopened.length === 1
              ? `this turn has no record of opening ${unopened[0]}`
              : `this turn has no record of opening ${unopened.length} of ${paths.length}: ${unopened.join(', ')}`,
          });
        }
        continue;
      }

      if (!ranAny(evidence, SUPPORTED_BY.files)) {
        findings.push({
          claim: 'files',
          said,
          because: 'no file was read this turn',
        });
      }
      continue;
    }

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
