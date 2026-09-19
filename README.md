# Agent CLI 🤖

A local, Claude Code-style coding agent with **no LLM API client**. Inference happens by
driving a real browser tab: the agent sends your prompt over a WebSocket to a Chrome
extension, which types it into gemini.google.com and streams the reply back.
It reads and edits files in your workspace and runs commands, using your own logged-in chat
session. No API key, no hosted backend, no telemetry.

## ✨ What it does

- **Two topologies.** *Solo* — one tab plans, implements and reviews. *Duo* — a reviewer
  subagent audits the work from **a second Gemini tab that has never seen the
  conversation**. What it contributes is not different weights, it is missing context: it
  has nothing to check against but the code it is sent, so it reads the file instead of
  reasoning from a citation. Each subagent turn gets its own tab and its own lane, so it
  genuinely runs alongside your turn rather than queueing behind it.
- **Every write is a diff you approve.** Per-hunk accept/reject, backups, atomic writes, and
  `/undo`. Commands are risk-classified before they run, and `/allowlist` remembers the
  answers you have already given.
- **Background tasks that wake the agent.** `run_background` starts a dev server or a watcher;
  `manage_task watch` has the agent start a turn on its own when that process logs a failure,
  with the failing lines already in hand.
- **One instruction surface.** `AGENT.md`, walked up from your code the way git finds `.git`.
  Nothing else to configure — see [Project instructions](#-project-instructions).
- **Skills.** Markdown files the agent opens only when their one-line description matches
  what it is doing, so you can write as many as you like without paying for them every turn.
- **Editor awareness.** A VS Code companion hands over your active file, cursor position and
  the Problems panel, so `get_diagnostics` reads your real TypeScript and ESLint errors
  instead of running a build.
- **One effort ladder.** `/effort` runs from `⚡ flash` (terse) through `🧠 flash-thinking`
  (3-phase) to `🏃 brief` / `🪜 standard` / `🔭 deep` on Pro, which add a checklist, then
  approach enumeration and an adversarial self-review. Each rung names the browser tab its
  prompt is written for — that pairing is the whole point, so there is one setting, not two.
- **A terminal UI that behaves like one.** Real streaming, no mouse tracking, so scroll,
  drag-select and copy stay your terminal's. Settled turns are committed to scrollback and
  only the in-flight turn repaints.

## 🚀 Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v20 or newer (`engines` in `package.json`; `setup.sh` checks it)
- Google Chrome
- A logged-in tab on gemini.google.com (the agent has no API key — it drives your own browser session)

### 2. Install

Two ways, and they end in the same place. **Automatic** is one command;
**manual** is the same steps typed out, for anyone who would rather see them.

Whichever you pick, steps 4 and 5 below are yours either way — loading a Chrome
extension and signing into a chat tab are things no installer can do for you.

#### Automatic

```bash
curl -fsSL https://raw.githubusercontent.com/PratimeshTiwari/Gemini-Agent/main/setup.sh | bash
```

> **Which branch — read this before pasting the command above.**
>
> Everything is developed on `v1-stable` and reaches `main` through a PR. **Until the first
> such merge lands, `main` does not contain `setup.sh` at all and the command above returns
> 404.** Use this one meanwhile — same script, same result:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/PratimeshTiwari/Gemini-Agent/v1-stable/setup.sh | bash
> ```
>
> After the merge, the `main` command is the right one: it is the released branch, and the
> `v1-stable` form then tracks development instead. `git rev-list --left-right --count
> main...v1-stable` says how far apart they currently are — never a number written down here,
> because that goes stale on the next commit.

Clones to `~/Gemini-Agent`, installs both workspaces, builds the extension bundle, puts
`agent` on your `PATH`, runs the tests, and offers to add a line to your `~/.zshrc` so the
command survives a new terminal. Then it prints the two steps that cannot be automated:
loading the Chrome extension, and signing into a chat tab. There is no API key to configure,
which is exactly why a human has to be logged in somewhere.

Re-running it is an update, not a second install — it fast-forwards an existing checkout and
leaves local changes alone. If something is already sitting at the target path and is not a
checkout, it stops rather than writing over it.

| Knob | |
| --- | --- |
| `AGENT_INSTALL_DIR=~/src/agent` | clone somewhere else |
| `AGENT_BRANCH=v1-stable` | a branch other than `main` |
| `AGENT_REPO=<url>` | a fork |
| `--yes` (or `AGENT_YES=1`) | take the default on every question, ask nothing |

Piping a script from the internet into your shell is worth being suspicious of.
[Read it first](setup.sh) — or clone and run it from the checkout, which is the same script
and the same result:

```bash
git clone https://github.com/PratimeshTiwari/Gemini-Agent.git
cd Gemini-Agent && ./setup.sh   # asks where to install; enter for ~/Gemini-Agent
```

#### Manual

```bash
git clone https://github.com/PratimeshTiwari/Gemini-Agent.git
cd Gemini-Agent

npm install                          # both workspaces
npm run build --workspace=extension  # Chrome loads the bundle, not the sources
npm test                             # optional, and a good smoke check

npm start                            # run it; workspace defaults to ../
cd server && npm start -- --workspace /path/to/project
```

The build step is not optional on a fresh clone. `extension/service-worker.js` is a
committed artifact and Chrome loads *that*, not the sources under
`extension/src/background/` — skip it and you ship whatever was committed last.

That leaves `agent` off your `PATH`. `npm start` from the checkout always works; for the
command, `./setup.sh` installs a shim, or write one yourself — see below.

<details>
<summary>Why there is no <code>npm link</code> step</summary>

Because it is the worse answer on every machine, and the *failing* answer on a managed one.
`npm link` writes into npm's **global prefix**, which on a work laptop is usually somewhere
you cannot write — and `sudo npm link` is the wrong fix, because it leaves root-owned files
in a tree npm will later try to modify as you.

`setup.sh` writes a two-line shim to `~/.local/bin` (or `~/bin`) instead — a directory you
already own — that calls the checkout by absolute path:

```sh
#!/bin/sh
exec node /path/to/Gemini-Agent/server/src/index.js "$@"
```

If that directory is not on your `PATH`, setup offers to add the line to your shell rc file.
Nothing is written to your rc file without asking.

The shim has a second advantage over a link: it survives switching Node versions with `nvm`.
A link points into the bin directory of whichever Node created it, so changing version
silently takes the command away.

If even `~/.local/bin` is not writable, `npm start` from the checkout always works.

</details>

### 3. `agent-cli`, from any folder

Either path puts two commands on your `PATH`, both pointing at the same program:

| Command | |
| --- | --- |
| `agent-cli` | the full name |
| `agent` | short alias, type this one |

**The workspace is whatever directory you are standing in.** There is no
per-project setup and no config to point at a folder:

```bash
cd ~/code/xyz
agent-cli            # xyz is now the workspace — it reads and edits files here
```

Check it worked:

```bash
which agent-cli      # -> .../bin/agent-cli
agent-cli --help
```

<details>
<summary>If the command isn't found</summary>

- Your shell may be caching an old lookup. Run `hash -r` (zsh/bash) or open a new terminal.
- **There is no `npm link` step, deliberately.** It writes into npm's *global* prefix, which
  on a managed or work machine you often cannot write to — and `sudo npm link` is the wrong
  answer, because it leaves root-owned files in a tree npm later tries to modify as you.
  `./setup.sh` installs a two-line shim into `~/.local/bin` instead, which needs no
  privileges and, unlike a link, keeps working when you switch Node versions with `nvm`. If
  that directory is not on your `PATH` it
  prints the one line to add. To do it by hand:

  ```bash
  mkdir -p ~/.local/bin
  printf '#!/bin/sh\nexec node "%s/server/src/index.js" "$@"\n' "$PWD" > ~/.local/bin/agent
  cp ~/.local/bin/agent ~/.local/bin/agent-cli
  chmod +x ~/.local/bin/agent ~/.local/bin/agent-cli
  ```
- Upgrading from an older checkout? The command used to be `gemini-agent`. It was renamed —
  use `agent-cli`, and remove any old shell alias pointing at the previous name.

</details>

To work on a different directory without `cd`-ing there, pass it explicitly:

```bash
agent-cli --workspace ~/code/other-project
agent-cli --continue                       # resume the last session here
agent-cli --port 7788                      # if 7777 is taken
```

### 4. Install the Chrome extension bridge

**This step is manual on both paths.** `setup.sh` prints these instructions at the end
rather than performing them: loading an unpacked extension is a browser-UI action, and
signing in is yours by definition.

This is what makes the agent work without an API key: it types your prompt into a
real chat tab and scrapes the reply back.

1. Open `chrome://extensions/`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension/`** folder in this repository.
4. It appears as **Agent CLI Bridge** — pin it to your toolbar so you can see its status.
5. Open [gemini.google.com](https://gemini.google.com) and sign in. Leave the tab open.

The CLI's status bar reads `● agent` in cyan once the extension connects. While it reads
`○ agent` in yellow, the tab isn't open or the extension isn't loaded.

> If you edit anything under `extension/src/background/`, rebuild the bundle —
> Chrome loads `extension/service-worker.js`, not the sources:
> ```bash
> npm run build --workspace=extension
> ```

### 5. (Optional) VS Code companion

Four things, all of which the agent can use immediately:

- **Editor state** — the file you're in and where the cursor is.
- **Diagnostics** — the Problems panel. The agent reads your TypeScript and ESLint errors
  with `get_diagnostics` instead of running a build, and uses it to check its own edits.
- **Add to Agent Chat** — select code and send it to the prompt as `@client.js:12-40`. The
  full text goes to the model on submit; only the marker sits in the terminal. Four ways in:
  `cmd+alt+L`, right-click, the `cmd+.` lightbulb, or the button on the editor tab bar.
  (The floating *Chat ⌘L* widget you may see on a selection belongs to Antigravity/Copilot —
  it is their own widget and no extension can add to it. `cmd+.` is the native equivalent.)
- **Plan review** — a plan opens with `✅ Approve · 📤 Submit review · ❌ Reject` at the top and
  `💬 Comment` on every heading. Leave comments on the sections that need changing and submit,
  and the agent revises the plan against all of them at once — the way you'd review a PR.
  Approving with no comments is still one click.

To install:

1. In VS Code, open the Extensions panel (`Cmd+Shift+X`).
2. `...` menu → **Install from VSIX...**
3. Pick `vscode-companion/cli-agent-companion-1.5.0.vsix`.

It talks to the CLI through files in `.agent/state/`, so it works whether or not the agent is
running — a selection queued before you start `agent-cli` is waiting for you when you do.

### 6. First run

```bash
cd ~/code/your-project
agent-cli
```

Type a request and press Enter. In **plan mode** (the default) every file edit is shown
as a diff you approve; `shift+tab` switches to **auto mode**, which applies safe edits
on its own.

Handy keys: `ctrl+e` expand/collapse all steps · `ctrl+t` shell · `ctrl+b` Gemini tab ·
`esc` stop the run · `/help` for everything else.

## 📄 Project instructions

Everything the agent should know **before its first action in a repo** goes in one file:
`AGENT.md`, at the root of the code.

```markdown
# AGENT.md

- The API client is generated — edit `openapi.yaml`, never `src/generated/`.
- Tests run with `pnpm vitest`, not npm.
- Migrations are checked in; never edit one that has already shipped.
```

There is no command to run and nothing to register. The agent walks **up** from the code
looking for `AGENT.md`, the way git finds `.git`, and reads every one it passes — outermost
first, so the nearest file has the last word. Your personal `~/.agent/AGENT.md` is the
outermost layer of all:

```
~/.agent/AGENT.md                 you, in every project
/work/base-repo/AGENT.md          every repo under base-repo
/work/base-repo/api/AGENT.md      just this repo   ← last word
```

**Instructions or skill?** The test is *should the agent know this before it touches
anything here?* A convention it could break in its first edit — the generated directory, the
test runner — belongs in `AGENT.md`, which is always in context. Something it only needs
sometimes, like how to cut a release, belongs in a [skill](#-skills), which costs one line of
prompt until it is actually relevant. Encoding "always" as "when relevant" hands the model a
judgement call it will occasionally get wrong, after it has already edited something.

> Earlier versions also read `.agent/rules.md`, a scoped `rules.md`, `.agent/mistakes.md` and
> folders registered with `/context add`. Five discovery rules for one idea. They are gone;
> `AGENT.md` is the only one. If you have any of those files, the agent names them once at
> startup and leaves them alone — move what you still want into `AGENT.md` and delete them.

## 🧩 Skills

A skill is a markdown file of instructions the agent reads **only when it is relevant**,
so you can write as many as you like without bloating every prompt. Only the one-line
`description` is ever in the system prompt; the agent opens the file itself when that
description matches what it is doing.

```bash
/skills                       # browse, open, or create
/skills new code-review       # scaffold one for this project and open it
/skills new --global deploy   # one you want in every project
/skills list
/skills dir                   # show the folders skills are loaded from
/skills dir add ~/my-skills   # load skills you keep somewhere else
```

The search walks **up** from your project, the way git finds `.git`. The nearest definition
of a name wins, so a repo overrides its parent and the parent overrides your personal set —
with no configuration:

```
~/.agent/skills/                    yours, everywhere
/work/base-repo/.agent/skills/        every repo under base-repo
/work/base-repo/api/.agent/skills/    just this repo  ← wins
```

That is what makes a monorepo work: put a skill in `/work/base-repo/.agent/skills/` and every
repo underneath picks it up. `/skills dir add` stays for skills kept outside the tree
entirely — a shared git repo of them, say.

A skill looks like this:

```markdown
---
name: code-review
description: Reviewing a diff or a pull request before it merges.
---

# Code review

## When to use it
...

## Steps
1. ...
```

## 🔁 Self-healing background tasks

The agent can start a long-running process and be woken when it breaks, instead of having to
remember to check:

```
run_background   npm run dev          → starts it, returns a task id
manage_task      watch  <task id>     → wake me if this logs a failure
```

When a watched task logs something that looks wrong — `error`, `failed`, `exception`,
`EADDRINUSE`, `Cannot find module`, or a pattern you supply — the agent starts a turn on its
own with the failing lines and their surrounding output already in hand, reads the code, and
fixes it. It fires once per fault, not once per line, and never interrupts a turn already in
progress.

The same instinct applies to ordinary commands: a non-zero exit is marked `status="failed"` in
what the model sees, with an instruction to diagnose and fix rather than report. That is
bounded — four consecutive failing rounds ends the turn, lists the actual errors and asks you,
rather than burning a session on variations of one broken command.

**A limit worth knowing:** the agent cannot read your *other* terminal windows. Those belong to
your terminal emulator and there is no API for them. Run the process through `run_background`
so the agent owns the pipe, or point it at a log file.

## ⌨️ Using the prompt

### Writing more than one line

The prompt is a real multi-line editor.

| key | what it does |
| --- | --- |
| `ctrl+j` | newline, without sending — **works in every terminal** |
| `shift+enter` | the same, where your terminal reports the modifier |
| `enter` | send |
| `↑` `↓` | move **a line** when the prompt has several; recall previous commands when the caret is already on the first or last line |
| `←` `→` | move by character |
| `ctrl+u` | clear the prompt · `ctrl+w` delete the last word |

`shift+enter` needs the kitty keyboard protocol, which the terminal has to
support — VS Code's built-in terminal does not, for instance. `ctrl+j` is a
literal line feed and no terminal can take it away, so it is the one to learn.

A prompt taller than a third of the window scrolls inside itself rather than
pushing the transcript off screen, and shows `… N more lines` when it does.

### Attaching things

- **Paste** anything. More than four lines is folded to `[Pasted text #1 +42 lines]`
  so it costs one row; the model still gets all of it when you send.
- **`ctrl+v`** attaches an image from the clipboard; `/image <path>` attaches a
  file. While one is attached the status bar says `1 image`, and `/image remove`
  takes it back off.
- **"Add to Agent Chat"** in VS Code (`cmd+alt+l`) drops the selection in as
  `@file.js:12-30`.
- **`ctrl+f`** attaches commands that failed in a VS Code terminal. They are
  *offered*, not inserted: the status bar shows `2 failed ^f` and nothing touches
  your prompt until you ask. Something you chose to attach goes in; something
  that merely happened to you waits.

  And only from terminals you point at: right-click a terminal → **Agent CLI:
  Watch This Terminal for Failures**, or run it from the command palette.
  Forwarding every failure from every terminal meant a typo you had already
  fixed arrived as a marker you then had to delete. Per session, because a
  terminal is a per-session thing.

### Reading what came back

- **`ctrl+e`** expands or collapses every step of every turn. Expanded steps show
  full output — settled turns are ordinary scrollback and are not truncated.
- **File edits are drawn as a diff**, green for additions and red for removals,
  both in the transcript and on the approval prompt.
- Scroll, select and copy with the mouse exactly as in any other command's
  output. The agent never takes the mouse.

### When it asks before acting

Commands that destroy more than they name stop and ask first, showing what is at
stake — `/clear`, `/new`, `/allowlist clear`. Cancel is
always the default, so a reflex `enter` changes nothing. Commands that name their
target (`/memory forget 3`, `/allowlist remove <cmd>`) just do it.

A single turn is capped at 30 tool rounds. Nothing failing is required — it is
there because every round is a prompt typed into your browser, and a model that
keeps going is spending your quota. It stops, says so, and `continue` resumes.

When the conversation outgrows the effort rung's budget, older turns are replaced
by a summary automatically, and the agent tells you what it compacted. **The turns
themselves are kept** — the agent can search back through them when it needs a
detail the summary left out, rather than asking you to repeat it. They live in
`.agent/sessions/archive.jsonl`.

## 🔍 Seeing what the agent is being told

`/settings` → **Context** lists the files actually feeding the prompt, not just
how much is in it:

```
  Instructions   AGENT.md            template — looks like the unedited template
  Memory file    .agent/memory.md    7 facts
  Skills         .agent/skills       3 skills
  Skills         ~/notes/skills      missing — you added this folder and it is not there any more
```

Press **enter** on any row to open that file in your editor, or use
`/open <path>` directly.

This matters because `AGENT.md` is *walked* — every level from your code up to
the project root, nearest last — so which files are in play is not obvious, and
a stock template that was never filled in looks exactly like a real one to the
model. The list says which is which.

## ⚙️ Configuration & Commands

Once the agent is running, you can use built-in slash commands to manage your session:
- Type `/help` in the CLI to see all available commands.
- Type `/config` to turn the reviewer on or off. With one on, a second Gemini tab audits the work without having seen the conversation that produced it — which is the point of it, and why the tab is worth opening. There is no separate `/mode` screen any more, though the name still answers.
- Type `/effort` to pick how hard the agent works — one ladder from `flash` to `deep`. It sets
  the prompt profile **and switches the browser's mode picker to match**, so a prompt written
  for Pro is not typed into a Flash tab. It tells you which model it chose. Nothing is
  hardcoded — the names and the list differ by subscription, so it reads your picker and
  matches on what each option is *for*.

  This needs the current extension. If `/effort` says it is switching and the browser does not
  move, reload the extension at `chrome://extensions` and hard-refresh the Gemini tab — the
  page holds the old content script until you do.
- Type `/allowlist` to view and manage your auto-approved and auto-rejected command rules.
- Type `/settings` for one page of everything that is set, including the Context tab above.
- Type `/open <path>` to open a file in your editor.
- Type `/compact` to fold older turns into a summary by hand, or `/clear` to drop them.
- Type `/logs` to read failures grouped by where they came from, and `/commands` for
  every shell command the agent has run, blocked or rejected.
- Type `/logs extension` for how long the browser is actually taking — the median and
  slowest tenth for each stage of a turn, from finding the input box to the reply finishing.
  That is the number to compare when it feels slower than it used to.

## 🗂 One repo, or several under one folder

### If you have one repo

Nothing to configure. Open it and go:

```bash
cd ~/work/my-api
agent
```

The agent creates `~/work/my-api/.agent/` the first time and keeps everything
there. You can stop reading this section.

### If you keep several repos under one folder

Say your work looks like this — `payments-api` and `dashboard` are two separate
projects you keep side by side:

```
~/work/
├── payments-api/
└── dashboard/
```

You have two choices, and the first is fine:

**Either** treat them as unrelated. Run `agent` inside each one, and each gets
its own `.agent/` folder. Nothing is shared, and nothing needs explaining.

**Or** tie them together, if they share conventions and you want one set of
skills for both. Create a single `.agent/` folder at the top:

```bash
mkdir -p ~/work/.agent/skills
```

That one directory is the signal. From then on, opening either project finds it
by walking **up** the folders — the same way `git` finds `.git` from a
subdirectory — and they share whatever is in it:

```
~/work/
├── .agent/                ← you created this
│   ├── skills/               shared: both projects see these
│   ├── config.json           shared: default model, effort, allowlist
│   ├── payments-api/         the agent creates these two, one per project
│   └── dashboard/            history, memory, artifacts, backups, logs
├── AGENT.md               ← optional: rules for both projects
├── payments-api/
│   └── AGENT.md           ← optional: rules for this one only
└── dashboard/
```

You never create the `payments-api/` and `dashboard/` folders *inside* `.agent/`
— the agent makes them, so one project's history and `/undo` cannot reach into
the other's.

**"Scope" is just which of them you are working on.** It is decided when you
start, never guessed from which files get edited, and it shows in the status
bar. These two commands are identical:

```bash
cd ~/work/payments-api && agent          # the obvious way
cd ~/work && agent --scope payments-api  # the same thing, from the top
```

### Where do I put a skill?

**Usually: the group folder, and stop thinking about it.** `/skills new <name>`
already writes there, and a skill is only pulled into a prompt when its
`description` line matches what the agent is doing — so a skill that only
applies to one project can simply say so:

```markdown
---
name: release
description: Cutting a release of payments-api. Not used for the dashboard.
---
```

**If you really want one project to have its own**, give that project its own
`.agent/skills/` folder:

```bash
mkdir -p ~/work/payments-api/.agent/skills
```

Skills are then searched from the project upwards, so `payments-api` sees both
its own and the group's, with its own winning if a name appears twice:

```
~/work/payments-api/.agent/skills/    this project   ← wins
~/work/.agent/skills/                 both projects
~/.agent/skills/                      every project you open
```

> **One consequence worth knowing.** That folder also makes `payments-api` its
> own root, so its history, memory and artifacts move out of
> `~/work/.agent/payments-api/` and into `~/work/payments-api/.agent/`. Skills
> still resolve from both places; it is the *state* that stops being shared.
> If that is not what you wanted, use a `description` line instead.

### Where do I put instructions?

`AGENT.md`, next to the code, and it is not in `.agent/` at all. Every one from
your home directory down to the project is read, nearest last — so the project's
file has the final word. See [Project instructions](#-project-instructions).

## 📂 Where the agent keeps its files

Everything the agent writes into a workspace lives in one directory, `.agent/`:

```
<your project>/.agent/
├── config.json        # model roles, effort, command allowlist, agent name
├── memory.md          # what the agent has learned here (/memory)
├── skills/            # one .md per skill (/skills)
├── artifacts/         # task.md, plan.md, walkthrough.md — written for you to read
├── state/             # editor.json, diagnostics.json, plan-approval.json
├── backups/           # file backups powering /undo
├── sessions/          # conversation history, and archive.jsonl — turns a
│                     #   summary replaced, kept so the agent can look them up
└── logs/
    ├── errors.jsonl     # every failure, tagged with the flow it came from (/logs)
    ├── traces.jsonl     # how long each browser turn took, per stage
    └── commands/        # one file per day: every shell command run (/commands)
```

Your conversation history is saved **twice**: once next to the project in
`.agent/sessions/`, and once in `~/.agent/workspaces/<project>-<hash>/`. The second
copy means a clean checkout or a deleted `.agent/` folder doesn't lose your history —
whichever copy has more turns wins on startup and rebuilds the other. Override the
home location with `AGENT_CLI_HOME`.

Earlier versions spread this across `.gemini/`, `.gemini-agent/` and
`.agent-github-plans/`. The agent migrates those into `.agent/` automatically the
first time it starts in a workspace, and prints a one-line summary when it does.

---

## 📚 Where the reasoning lives

- **`CLAUDE.md`** — the architecture, the layout, and the gotchas that cost real
  time if you meet them by surprise.
- **`AGENT.md`** — what the agent itself is told about this project.

Five planning documents used to sit here too. Every phase in them is now done or
explicitly declined, so what outlived them was folded into `CLAUDE.md`; git has
the originals.

---

## 📜 Releases

Versioned by what has actually merged into `main`. Each beta is one pull request
from one branch, and those branches are kept on purpose — they *are* the history,
so the list below can be checked rather than believed:

```bash
git log main --merges --format="%h %ad %s" --date=short
```

**Each entry shows the release number, the PR and the branch, because the three
stopped agreeing partway through and guessing between them is worse than saying
so.** The release number follows the `beta-vN` branch names, which run 1-8, then
10 and 11.

Two gaps cancel each other out, which is why the numbers look right again at the
end. **PR #6** was opened and closed without merging, so the PR number runs one
ahead of the beta from v6 to v8. Then there is no **`beta-v9`** — that work
landed inside `beta-v10-code-cleanup` — and from v10 they line up once more.

**Beta v12 came from `fix/bridge-lock-and-cli`**, not a `beta-` branch. It was a
fix release, and it is numbered in sequence because it is the twelfth thing that
reached `main`.

Removals are listed with the reason, because on this project they matter as much
as the additions. The rule behind most of them: **a broken tool is worse than a
missing one**, since the model reaches for it and concludes the code is not there.

---

### Unreleased — heading for v1.0

Everything on `v1-stable` that has not been through a PR — several sessions of
work, and the largest release by far, so it is grouped by area rather than
listed flat.

**How far ahead it is, as of now:**

```bash
git rev-list --left-right --count main...v1-stable   # "0  <n>" — a clean fast-forward
```

Deliberately not written out here. This paragraph said "113 commits ahead" for
about a day, during which it was wrong roughly forty times — a count in prose
is stale the moment the next commit lands, and the command is both shorter and
always right.

#### At a glance

The detail is grouped by area below. This is the shape of it.

**Added**
- `find_symbol` / `find_references` — structural code search, on acorn.
- `grep_search` takes several patterns at once, with context lines and ranking.
- `run_background` + `manage_task` — dev servers and watchers that outlive a turn.
- `recall_history` — the model can look into its own compacted history.
- A **second Gemini tab as a reviewer** (`/config`), with no memory of the
  conversation that produced the work.
- `/history`, `/plans`, `/commands`, `/logs`, `/update`, `/name`, `/restart`.
- A **command audit trail** — every shell command run, blocked or refused.
- Prompts typed during a turn are **queued**, not dropped; `↑` takes one back.
- `/image <path>` and `/image remove`, with `1 image` in the status bar.
- A VS Code companion that forwards failed terminal commands and the Problems panel.

**Changed**
- **One instruction surface**: `AGENT.md`, walked up from the code.
- **One effort ladder**: `/effort` — flash · flash-thinking · brief · standard · deep.
- **One lane per browser tab**, so subagents genuinely run at once.
- The turn's clock moved **out of the tab**, so a turn survives you looking away.
- Approval is decided in one place from the tool catalog's own flags.
- `node_modules` **98.5 MB → 72.7 MB** (figlet and `@inquirer/prompts` gone).
- Startup **2.46 s → 0.53 s** to the prompt box.

**Removed**
- The **GitHub PR agent** (2,009 lines) — documented first, for a possible rebuild.
- **ChatGPT**, and with it the second bridge. One model, one bridge.
- `semantic_search` and the retrieval subsystem; `ast-chunker`; the skills registry.
- `rules.md`, `mistakes.md`, `contextFolders`, `memory.json`.
- `topology`, `reasoningEffort`, `modelTier`/`reasoningLevel` as stored settings.
- Mouse tracking, permanently — scroll, drag-select and copy are the terminal's.
- The runtime scope switcher, and `/agent-dir`.

**Fixed** — the ones worth naming are in *Told the truth, enforced something
else* below: nine cases where the model was handed an accurate description and
the code did something different. Plus the flicker that was deleting your
scrollback seven times a second, prompts lost while Chrome was in the
background, and a rejected edit that drew in green as though it had applied.

**Quality**: 1,710 tests, **92.5% line coverage** (90.8% branch, 94.3% function).

#### The GitHub PR agent is gone (2026-09-19)
- **Removed**, and documented in `CLAUDE.md` in enough detail to rebuild from:
  what each of the nine files did, the interface decisions worth keeping, and
  the two things that were still broken. 2,009 lines plus a tab, two hooks, a
  content script and eight test files.
- *Why:* every `flow: 'github'` entry in the error log was `poll: fetch failed`,
  three review directories were ever written, and the tab left comments reading
  `⚠ not analysed` after being sent for analysis. It was a second product inside
  the first, and the first still had bugs that stopped it doing its job.
- The migrations stay: an older `.agent/github-pr-plans/` is still renamed on
  startup, and the `github` flow label in the error log still exists so old logs
  stay readable.

#### One model, and five things that were silently wrong (2026-09-19)
- **ChatGPT removed.** One bridge, one model. *Duo* now means a second Gemini
  tab that has not seen your conversation — which is the half of a reviewer
  that was ever doing the work. A config naming ChatGPT is folded to Gemini on
  read, because config saving preserves keys it does not own and a stored
  `main: 'chatgpt'` would otherwise point the agent at a site with no bridge.
- **A review that ends in prose is kept.** `ask_reviewer` produced a complete
  adversarial review, failed to wrap it in `return_result`, and the whole thing
  was discarded as a failure with the answer sitting in the payload.
- **`/compact` actually hands the conversation over.** It summarised, reset the
  prompt state and reset the context counter — and never told the browser, so
  the tab stayed on the thread that still held every turn it had just
  summarised. The counter then described a conversation that did not exist, in
  the status bar, in `/context` and in the auto-compaction threshold at once.
  The new chat is acknowledged now, and the counter only resets if it happened.
- **`/clear` stops zeroing the context counter.** It clears the CLI's record and
  deliberately leaves the tab alone, so the model still remembers — and the bar
  should say so.
- **The tool-call repair loop is capped at two.** Every other retry here was
  capped; a model stuck on a formatting habit could re-ask forever, a full
  browser turn each round. When it stops it hands you the raw reply, which
  usually contains the answer in prose.
- **The bridge can be injected twice.** Its constants were declared at the top
  level of a world that outlives the script, so re-injecting threw
  `Identifier … has already been declared` on line one. That silently disabled
  the repair rung written for exactly the case that guarantees a copy is already
  there. It also stops the copy it replaces, rather than leaving its observers
  running.

#### Told the truth, enforced something else (2026-09-19)

Nine of these, all the same shape and all found by *using* the agent rather
than reading it. The model was given an accurate description and the code did
something different — which is the worst of the three arrangements, because
nothing on screen gives you a reason to doubt it.

- **Plan mode exempted every `.md` file, anywhere.** The exemption itself was
  deliberate and is kept: `task.md` and `plan.md` are files the system prompt
  *tells* the model to keep current, and it cannot tick a checklist if every
  tick needs a keystroke. The bug was that the test was the **extension**
  instead of the **location**, so `README.md`, `CLAUDE.md`, `AGENT.md` — and
  anything at all outside the workspace, since these tools take absolute paths
  — were exempt too. It now resolves the path and checks it is inside
  `.agent/artifacts/`, and fails closed on anything it cannot resolve.
- **`run_background` reached none of the safety machinery.** Not the risk
  classifier, not the `critical` block, not the command log, and not plan
  mode's approval — for the one tool that leaves a process running after the
  turn ends. Every gate was written as `name === 'run_command'`.
- **And plan mode still let it through after that was fixed.** The read-only
  exemption said *any shell tool the classifier calls safe*, and
  `run_background` is a shell tool — so `run_background npm run dev` was exempt
  on the strength of a verdict about the **command text**, while the process it
  spawns outlives the turn. The classifier reads a string; it cannot see that.
- **`grep_search`'s `includes` matched nothing whenever it named a path**, and
  its `pattern` rejected the array its own description told the model to send.
- **Six tool parameters were undocumented**, one of them in neither form — so
  the model never sent them. The drift check that should have caught it was
  comparing an empty list to an empty list.
- **`find_references` answered 0 for every method**, under the message *"It may
  be dead code."* A method is only ever called as `x.name()`, and member
  properties were excluded — correctly for a variable, wrongly for a method.
  Measured on this repo: `buildToolResultBatch` 0 against 17 real call sites.
  That is a tool arguing for the deletion of code called everywhere.
- **…and the definition was missing** from the same answer, which promises
  "list the definition too".
- **`run_command`'s timeout pointed at an alternative it never named**, and
  `cwd: "."` was judged outside the workspace, so the agent could not run its
  own tests.

The cure in each case was the same: stop keeping a list at the call site.
Approval is decided in `core/tool-policy.js` from the catalog's own
`mutates` / `shell` / `detached` flags, so a tool that writes is gated by
saying so once, beside its description.

#### Smaller, from the same pass (2026-09-19)
- **An attached image can be removed.** `/image remove`, and the status bar
  says `1 image` while one is armed. Before this, the only ways to be rid of one
  were to send it or restart — and nothing on screen said it was there.
- **An instant command stops leaving a frozen `Thinking…` behind.** Every local
  command raised a spinner and took it down a moment later, around a write to
  the committed transcript — stranding the row above the command it belonged
  to, at `0s`, forever. Only `/compact` waits on anything, so only `/compact`
  raises it now.
- **The turn's confirming look leaked a timer, once per turn, compounding.** It
  was scheduled with a `setTimeout` nobody held, so stopping a turn did not stop
  it — and the next turn re-armed the same orphan into a second polling chain at
  the old cadence, with no handle anywhere to stop it.
- **A rejected edit stops looking like an applied one.** The model was told the
  truth and the transcript drew `✓ edit_file` in green on a change never
  written.

#### Made honest by testing it (2026-09-19, late)

Coverage was measured rather than assumed — `node --test
--experimental-test-coverage` — and the low files were worked in order of how
badly they would fail, not how interesting they were.

- **Every tool is now called once by a test.** That sweep did not exist, and its
  absence had already shipped a total breakage: a stray edit left `find_symbol`
  referring to a variable it never defines, so **every** call returned
  `isMethod is not defined` while 1,474 other tests stayed green. The sweep
  asserts almost nothing about what comes back — only that the call the agent
  makes does not throw, which is the failure that costs a whole turn.
- **Every slash command is now driven once, bare and with arguments.**
  `use-slash-commands.js` was the least-covered file in the repo at 8.7%, and
  the surface almost every bug reported from use has come from. It is 55.5% now.
- **A wrong effort word is rejected instead of ignored.** `/effort deeep` fell
  through to the status display, which prints the current rung and the ladder
  and reads exactly like a confirmation — so you believe it changed and every
  later turn goes out on the old rung.
- **A bare `/` lists the commands.** It used to answer `No such command: /` and
  then advise "Type `/` on its own to see what there is", which is what had just
  been done. An unknown command now says so *and then* lists them.
- **The minifier on the tool-result path always returns a string.** A cycle or a
  BigInt threw, was caught, and returned `''` — handing the model a tool that
  ran and produced nothing, which is worse than an error. Every test fixture
  passed a *string* result, so that branch had never been taken.
- **The startup migration's three promises are assertions now.** It moves your
  config, instructions, backups and logs before anything is on screen, and sat
  at 46% coverage. Nothing was wrong — all four behaviours were probed first and
  all four held — but a migration that clobbers has destroyed the thing it
  overwrote by the time anyone looks.
- **`server/README.md` is gone.** It had drifted for nine days advertising two
  subsystems deleted in September, and everything in it was already in this file
  or `CLAUDE.md`. A third document is a third place to drift.

#### The engine
- **Prompt economics.** The full system prompt goes out on turn 0 and every Nth
  turn, never every turn — resending a large payload each time trips Gemini's
  repetition filters and A/B-test modals. The **tool anchor** (names only, 56
  tokens) rides every turn anyway, because the model does not gradually forget
  its tools: it forgets them completely and then denies having any.
- **One list of tools** (`core/tool-catalog.js`). Four places had to agree about
  which tools exist and nothing checked any pair, which is how `recall_history`
  and `get_diagnostics` shipped registered, implemented and **unreachable**.
- **One lane per tab** — `main:<model>` and `sub:<requestId>` — so a background
  background turn and your own prompt genuinely overlap instead of queueing.
- **The extension addresses tabs by identity.** It used to take whatever tab was
  last, so your prompt could land in the middle of a subagent's conversation.
- **Removed: `semantic_search` and the whole retrieval subsystem** (~290 lines,
  the `madge` dependency, and a full-repo read at every startup). *Why:* its
  tokenizer split on non-alphanumerics only, so `getUserById` was one token and
  the query `user` could never match it — broken for the query type that
  dominates code search.
- **Removed: the Claude bridge, `swarm` topology and `ask_reasoner`** (~520
  lines, 14 DOM selectors). *Why:* cross-model review is the point and two
  bridges deliver it; the third was maintenance for something a second model
  already provided.

#### Search and context
- **`find_symbol` / `find_references`** — exact and structural. They return the
  definition rather than the forty call sites, and never the name in a comment
  or a string. For a **method**, `x.name()` uses are included and marked, because
  that is the only way a method is ever called — without that, "who calls this?"
  answered *nothing* for every method in a codebase.
- **`grep_search` takes several patterns at once**, because when you do not know
  what a codebase calls something, guessing one term at a time costs a round
  trip per guess.
- **Session recall** — the agent can look up turns that compaction replaced with
  a summary. Better than making compaction cleverer, because it does not require
  deciding in advance what will matter.
- **Removed: `ast-chunker`.** *Why:* it walked `ast.body` only, so every class
  method and every `export const foo = () => {}` was invisible — it resolved
  **24%** of this repo's own top-level symbols. Its replacement uses
  `acorn-walk` and `acorn-jsx` and resolves 282 of 282.
- **Rejected: an embedding index**, considered and argued down rather than
  overlooked. The context window here is a browser chat tab, so twenty retrieved
  chunks is 10,000 tokens typed into Gemini per query, most of it unread.

#### Telling the agent about your project
- **`AGENT.md`, walked up from the code** so the nearest file wins, and a
  Context tab listing every instruction source with its state — loaded, empty,
  missing, or *an unedited template*. That last state was found by pointing the
  detector at this repo.
- **Removed: `rules.md`, `mistakes.md`, `contextFolders`,
  `/context add|remove|list`, `/init-skills`.** *Why:* seven mechanisms existed
  for "tell the model about this project", with six different discovery rules
  between them. The count of *rules* was the mess. Two axes, one mechanism each:
  **where the file is** decides who it applies to, **which file** decides whether
  it is always in context (`AGENT.md`) or fetched on request (`skills/`).
  Retired files are **named, never moved** — `AGENT.md` is usually tracked in
  git, so folding `rules.md` into it would write an unasked-for diff into your
  repo on startup.
- **Removed: `memory.json`**, converted to `memory.md`. *Why:* a learned fact is
  exactly the thing that is subtly wrong six weeks later, and a fact you cannot
  correct in an editor does not get corrected.
- **Fixed twice: the write-only trap.** `manage_memory` wrote facts to disk and
  no prompt ever carried one back — a tool call per fact, forever, for nothing.
  The same shape turned up again in `.agent/artifacts/task.md`: the model was
  told to keep a checklist and tick it off, and never saw the file again, so
  ticking meant guessing the exact line text. Both ride the prompt now.

#### Safety
- **Every write becomes a diff** with per-hunk accept/reject, a backup and
  `undo()`. Nothing reaches disk unreviewed.
- **A shell lexer**, because the command classifier could be walked straight
  past: `echo hi; rm -rf /tmp/x` classified as *safe* on its first word. Every
  segment is classified now and the worst one wins.
- **The bridge binds to `127.0.0.1` and checks `Origin`.** It used to bind to
  every interface with no auth, on a tool that runs shell commands.
- **An audit trail** — `.agent/logs/commands/<date>.jsonl`, every command run,
  blocked or rejected. Nothing reads it back into a prompt. `git push --force`
  does not fail, so the error log never sees the one command you would most want
  to find later.
- **`/logs rates`** — how often the text channel itself fails, as a rate. Seven
  parse failures is not something you can act on; seven in 412 turns is.

#### The terminal UI
- **Settled turns go to scrollback**, only the in-flight turn is live, and every
  live row is bounded. When Ink's frame outgrows the viewport it clears the
  screen on *every* render: measured at 108 full clears and 3.85 MB of escape
  codes in 15 seconds, which is what "it flickers and I can't scroll or copy"
  actually was. A later measurement found the same fault from *below* — the
  frame had a minimum height, so a terminal under 13 rows overflowed however
  much the turn gave up.
- **Code blocks you can drag-select cleanly**, with the language on a dim rule
  outside what a drag picks up, and `ctrl+y` for the last block.
- **A real multi-line prompt**, bounded to a third of the viewport.
- **Removed: mouse tracking, permanently.** *Why:* a terminal that is tracking
  hands the app the wheel and suppresses drag-select. Everything clickable
  became a keybinding, so scroll, selection and copy stay your terminal's.
- **Removed: the transcript selection model.** *Why:* Ink cannot repaint what it
  has committed, so there is nothing to point at a single row with. `ctrl+e`
  toggles every step at once instead.

#### Configuration
- **Removed: `reasoningEffort`, `modelTier` and `reasoningLevel` as stored
  keys.** *Why:* nine states for five meanings, and the UI apologised for the
  impossible combinations at the point of use instead of preventing them. One
  ladder now — `flash`, `flash-thinking`, `brief`, `standard`, `deep` — with the
  rest derived, so they cannot disagree.
- **Removed: `topology` as a setting**, `/mode`, and the mode menu. *Why:* a
  derived value in a config file is one someone edits and is ignored for
  editing. It is a getter over `modelConfig` now.
- **Removed: the runtime scope switcher.** *Why:* its own doc comment said
  switching scope "is closer to opening a different project than to changing a
  setting" — which is the argument against having it as a setting. `--scope` at
  launch reaches the same place with no window where the transcript on screen
  belongs to the old scope.

#### Commands and configuration
- **`/update`** — notice when `main` has moved, pull it, and say exactly what
  that leaves you to reload. Three artifacts ship from this repo and pulling
  only updates one of them: the extension bundle needs a reload, content
  scripts a hard refresh, and the `.vsix` a reinstall. The reminder is derived
  from what actually changed, and it survives the restart until you say it is
  done.
- **`/name <text>`** — name the agent, which until now could only be done by
  editing a file that does not exist in a fresh clone. It had a reader (the
  banner) and no writer.
- **`find_symbol` / `find_references`** in the tool list, and `/logs rates`.

#### Housekeeping
- **Removed as dead:** `TokenCounter` (a 30-line class nothing could reach), five `paths.js`
  helpers with no caller — two of them leftovers of the deleted retrieval subsystem — and
  three test seams no test ever used. `chalk` as a dependency.
- **Fixed, found by the same audit:** `/set-workspace` has always had a **recent** category
  and nothing ever wrote the file it reads, so it silently offered nothing. One missing call.
- **A setting changed from `/settings` now shows that it changed.** Four screens ran the
  command and then put the reply in the transcript *after* reopening the settings page on
  top of it — so the change happened and the confirmation was invisible.
- **A restart no longer goes out from under a running turn.** `/workspace`, `/restart` and
  `/update` left immediately; the browser kept generating into a socket nobody was holding
  and the reply was never drawn.
- **Gemini's tables and nested lists survive the scrape.** The reply's DOM is converted by a
  walker now rather than a series of passes, so a tag nobody listed still comes out readable
  — `<table>`, `<blockquote>`, `<del>` and `<dl>` were all being concatenated or dropped.
- **`/open` uses the editor this terminal is running inside.** It fell back to a hardcoded
  `code`, which no VS Code *fork* installs, and then to the OS default for the file type —
  which is how a markdown file opened in RStudio.

#### Not done, on purpose
- **The two bridges were not collapsed** — and then one of them was deleted,
  on 2026-09-19, which settled the argument by removing its subject. Keeping
  ~600 duplicated lines was defensible while both shipped: the cost it removed
  was "fix it twice", and fixing the scrape twice took one commit. The jsdom
  tests still run, against the one bridge, and say in a comment not to restore
  a second target just to make the comparison mean something again.
- **An optional API backend** stays a fork rather than a plan. It would remove
  the ceiling — structured tool calls, real parallelism, caching — and it
  contradicts the standing "no API keys" decision that is the identity of the
  project.

---

### Beta v12 — 2026-09-07 · PR #12 · `fix/bridge-lock-and-cli`

- **Installed as `agent`**, running in the current directory.
- **The extension lock is handed back when a turn dies**, not only when it
  finishes. A wedged lock silently swallowed every later prompt.
- **A failed scrape is reported in seconds, not five minutes.**
- Extension renamed to "Gemini Agent Bridge" and bumped to 1.1.0.
- **Removed:** `jest`, a duplicate `esbuild`, and `ora`. *Why:* unused
  dependencies on a tool people install globally.

### Beta v11 — 2026-09-07 · PR #11 · `beta-11-followup`

- **Reworked what goes to the model and how often** — the turn-0-and-every-Nth
  rule this project's prompt economics still rest on.
- **Reasoning levels for the pro tier.**
- **Questions that can be answered, dismissed, or asked in a batch.**
- **The edit-approval prompt shows the change** it is asking about.
- **A live spinner on running tool rows**, and a refined GitHub dashboard.
- **`.agent/backups` is pruned.**
- **Fixed:** saving config destroyed keys it did not own; a rejected GitHub
  token could not be cleared.

### Beta v10 — 2026-09-05 · PR #10 · `beta-v10-code-cleanup`

The consolidation release.

- **All workspace state unified under `.agent/`**, with `paths.js` as the single
  source of truth.
- **`server/src` reorganised into named folders** — `core/`, `bridge/`,
  `context/`, `github/`, `mcp/`, `ui/`.
- **Claude-Code-style transcript**, slash palette.
- **The agent loop blocks on diff approval** instead of racing past it.
- **Removed: local LLM support.** *Why:* a second inference path with its own
  failure modes, competing with the browser bridge that is the point of the
  project.
- **Removed:** dead code and unused dependencies; the GitHub plans folder is no
  longer created just by constructing the handler.

### Beta v8 — 2026-09-05 · PR #9 · `beta-v8-ui`

- **Claude Code visual aesthetic**, and the first fix for the scroll glitches.
- **Fixed:** missing tabs and UI rendering issues.

### Beta v7 — 2026-09-04 · PR #8 · `beta-v7-parallel-subagents`

- **`<Static>` for native history scrolling** — the change the whole current
  frame-budget design grew out of.
- **The header became a footer**, so settled history flows into scrollback.
- **Chrome extension tab pooling and the wakeup protocol.**
- **Production edge cases:** compaction, fuzzy diff matching, OS-error retries,
  swarming.
- **Fixed:** subagent routing; explicit flex constraints so Ink stopped
  overlapping text.

### Beta v6 — 2026-09-02 · PR #7 · `beta-v6-system-prompts`

- **Tiered model profiles** and a GitHub PR agent rewrite.
- **Context routing, self-correction, and the command allowlist** — with a
  toggle, so it can be turned off without editing config.

### Beta v5 — 2026-08-30 · PR #5 · `beta-v5-github-agent`

- **The GitHub PR agent**: a headless agent loop, PR-specific directories, a
  concurrency queue, and a five-stage comment-analysis prompt.
- **Fixed:** background callbacks were not wired, so the agent never actually
  invoked the AI.

### Beta v4 — 2026-08-30 · PR #4 · `beta-v4-subagents`

- **Subagents**, reasoning profiles, a modularised extension, and UI
  virtualisation.
- **Local LLM support** (removed again in v10).

### Beta v3 — 2026-08-27 · PR #3 · `beta-v3`

- **The CLI UI**, and the first serious pass at the prompt.

### Beta v2 — 2026-08-27 · PR #2 · `beta-v2`

- **Multi-model support** — ChatGPT and Claude bridges alongside Gemini.
- **Fixed:** DOM reliability, error handling, and the CLI workflow.

### Beta v1 — 2026-08-27 · PR #1 · `beta-v1`

- **Smart context management**, image support, and extension stability.

### Initial release — 2026-08-18

The agent, straight onto `main` before the branch-and-PR rule existed: the
browser bridge, the agent loop, and tool-call parsing out of reply text. Four
commits, including two bug fixes for multi-line paste and the tool-call regex.
