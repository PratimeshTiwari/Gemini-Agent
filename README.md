# Agent CLI 🤖

A local, Claude Code-style coding agent with **no LLM API client**. Inference happens by
driving a real browser tab: the agent sends your prompt over a WebSocket to a Chrome
extension, which types it into gemini.google.com or chatgpt.com and streams the reply back.
It reads and edits files in your workspace and runs commands, using your own logged-in chat
session. No API key, no hosted backend, no telemetry.

## ✨ What it does

- **Two topologies.** *Solo* — one agent plans, implements and reviews. *Duo* — a primary
  agent implements and a reviewer subagent on the **other** model audits it. Same-model
  review is not offered on purpose: two tabs of one model buy far less than one tab of a
  second, and cross-model disagreement is the signal worth paying for.
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
- **GitHub PR agent.** Polls your open PRs, classifies review comments, reads CI logs, and
  writes a plan per comment. `ctrl+o` opens the dashboard.
- **A terminal UI that behaves like one.** Real streaming, no mouse tracking, so scroll,
  drag-select and copy stay your terminal's. Settled turns are committed to scrollback and
  only the in-flight turn repaints.

## 🚀 Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18 or newer
- Google Chrome
- A logged-in tab on gemini.google.com (the agent has no API key — it drives your own browser session)

### 2. Install

```bash
git clone <this repo>
cd Agent-CLI
./setup.sh
```

`setup.sh` does every step that can be automated — installs both workspaces, builds the
extension bundle, puts `agent-cli` on your `PATH`, runs the tests — and then prints the two
that cannot be: loading the Chrome extension, and signing into a chat tab. There is no API
key to configure, which is exactly why a human has to be logged in somewhere. It is safe to
re-run; every step checks before it acts.

<details>
<summary>Or do it by hand</summary>

```bash
npm install                          # both workspaces
npm run build --workspace=extension  # Chrome loads the bundle, not the sources
npm link --workspace=server          # puts agent-cli on your PATH
```

</details>

### 3. `agent-cli`, from any folder

`npm link` (or `setup.sh`) puts two commands on your `PATH`, both pointing at the same program:

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
- `npm link` installs into your **current Node version's** bin directory. If you switch Node
  versions with `nvm`, re-run `npm link --workspace=server` on the new version.
- **`npm link` refused, on a managed or work machine?** It writes into npm's *global* prefix,
  which you often cannot write to there. `sudo npm link` is the wrong answer — it leaves
  root-owned files in a tree npm later tries to modify as you. `./setup.sh` detects this and
  installs a two-line shim into `~/.local/bin` instead, which needs no privileges and, unlike a
  link, keeps working when you switch Node versions. If that directory is not on your `PATH` it
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

This is what makes the agent work without an API key: it types your prompt into a
real chat tab and scrapes the reply back.

1. Open `chrome://extensions/`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension/`** folder in this repository.
4. It appears as **Agent CLI Bridge** — pin it to your toolbar so you can see its status.
5. Open [gemini.google.com](https://gemini.google.com) and sign in. Leave the tab open.

The CLI shows `🟢 Agent` in its status bar once the extension connects. While it shows
`🟡`, the tab isn't open or the extension isn't loaded.

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
3. Pick `vscode-companion/cli-agent-companion-1.3.1.vsix`.

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

Handy keys: `ctrl+e` expand/collapse all steps · `ctrl+t` shell · `ctrl+o` GitHub tab ·
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
- **`ctrl+v`** attaches an image from the clipboard.
- **"Add to Agent Chat"** in VS Code (`cmd+alt+l`) drops the selection in as
  `@file.js:12-30`.
- **`ctrl+f`** attaches commands that failed in a VS Code terminal. They are
  *offered*, not inserted: the status bar shows `2 failed ^f` and nothing touches
  your prompt until you ask. Something you chose to attach goes in; something
  that merely happened to you waits.

### Reading what came back

- **`ctrl+e`** expands or collapses every step of every turn. Expanded steps show
  full output — settled turns are ordinary scrollback and are not truncated.
- **File edits are drawn as a diff**, green for additions and red for removals,
  both in the transcript and on the approval prompt.
- Scroll, select and copy with the mouse exactly as in any other command's
  output. The agent never takes the mouse.

### When it asks before acting

Commands that destroy more than they name stop and ask first, showing what is at
stake — `/clear`, `/new`, `/allowlist clear`, `/github clear-state`. Cancel is
always the default, so a reflex `enter` changes nothing. Commands that name their
target (`/memory forget 3`, `/allowlist remove <cmd>`) just do it.

A single turn is capped at 30 tool rounds. Nothing failing is required — it is
there because every round is a prompt typed into your browser, and a model that
keeps going is spending your quota. It stops, says so, and `continue` resumes.

When the conversation outgrows the effort rung's budget, older turns are replaced
by a summary automatically, and the agent tells you what it compacted.

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
- Type `/config` to choose which web model (Gemini, ChatGPT) implements and which one reviews it. Setting a reviewer on the *other* model is what Duo means, and it is the only kind of review worth a second tab — there is no separate `/mode` screen any more, though the name still answers.
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
├── config.json        # topology, model roles, command allowlist, agent name
├── memory.md          # what the agent has learned here (/memory)
├── skills/            # one .md per skill (/skills)
├── artifacts/         # task.md, plan.md, walkthrough.md — written for you to read
├── state/             # editor.json, github.json, plan-approval.json
├── backups/           # file backups powering /undo
├── github-pr-plans/   # GitHub PR agent output
├── sessions/          # conversation history (local copy)
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
