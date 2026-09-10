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
- **Tiered prompts.** `⚡ Flash` (terse), `🧠 Flash Thinking` (3-phase reasoning), `🔬 Pro`
  (full protocol with chain-of-thought and anti-hallucination guardrails) — matched to
  whichever model you have selected in the browser tab.
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

## ⚙️ Configuration & Commands

Once the agent is running, you can use built-in slash commands to manage your session:
- Type `/help` in the CLI to see all available commands.
- Type `/mode` to switch between Solo and Duo — Duo puts a reviewer on the *other* model, which is the only kind of review worth the second tab.
- Type `/config` to choose which web model (Gemini, ChatGPT) acts as your primary and which reviews it.
- Type `/model <flash|flash-thinking|pro>` to dynamically adjust the cognitive effort and prompt complexity (optimizing for the model you select in your browser tab).
- Type `/allowlist` to view and manage your auto-approved and auto-rejected command rules.

## 📂 Where the agent keeps its files

Everything the agent writes into a workspace lives in one directory, `.agent/`:

```
<your project>/.agent/
├── config.json        # topology, model roles, command allowlist, agent name
├── memory.json        # long-term memory (/memory)
├── skills/            # one .md per skill (/skills)
├── artifacts/         # task.md, plan.md, walkthrough.md — written for you to read
├── state/             # editor.json, github.json, plan-approval.json
├── backups/           # file backups powering /undo
├── github-pr-plans/   # GitHub PR agent output
├── sessions/          # conversation history (local copy)
└── logs/agent.log
```

Your conversation history is saved **twice**: once next to the project in
`.agent/sessions/`, and once in `~/.agent/workspaces/<project>-<hash>/`. The second
copy means a clean checkout or a deleted `.agent/` folder doesn't lose your history —
whichever copy has more turns wins on startup and rebuilds the other. Override the
home location with `AGENT_CLI_HOME`.

Earlier versions spread this across `.gemini/`, `.gemini-agent/` and
`.agent-github-plans/`. The agent migrates those into `.agent/` automatically the
first time it starts in a workspace, and prints a one-line summary when it does.
