# Agent CLI 🤖

A local, Claude Code-style coding agent with **no LLM API client**. Inference happens by
driving a real browser tab: the agent sends your prompt over a WebSocket to a Chrome
extension, which types it into gemini.google.com and streams the reply back.
It reads and edits files in your workspace and runs commands, using your own logged-in chat
session. No API key, no hosted backend, no telemetry.

## ✨ What it does

- **Subagents, which are one switch rather than a topology.** `ask_subagent` hands work to
  **a second Gemini tab that has never seen the conversation** — `role: "review"` to have a
  change read by someone who does not share your assumptions, `"research"` instead of a long
  chain of your own reads, `"task"` for a self-contained errand. What a cold reader
  contributes is not different weights, it is missing context: it has nothing to check
  against but the code it is sent, so it opens the file instead of reasoning from a citation.
  Each subagent turn gets its own tab and its own lane, so it genuinely runs alongside your
  turn rather than queueing behind it. *Solo* and *Duo* were retired with the `topology`
  setting they named — a derived value in a config file is one someone edits and is ignored
  for editing.
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
- **One effort ladder, three rungs — named after the tabs they expect.** `/effort` runs
  from `⚡ lite` (terse) through `🧠 flash` (3-phase) to `🪜 pro`, which plans first, then
  investigates, implements, verifies, and sends the diff to a second tab reading it cold.
  The names are the picker's own words, so "flash" means the same thing in both places —
  and the CLI warns when the tab is on a different model from the rung.
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

> **`main` is the released branch, and the command above is the right one.**
>
> This used to carry a warning that `main` did not contain `setup.sh` yet and the command
> would 404. That was true before the first merge and stopped being true at **PR #13**,
> fifteen merges ago. Work is developed on a branch and reaches `main` through a PR, so
> `main` is always the last thing that passed review.
>
> To install a development branch instead, use `AGENT_BRANCH` from the table below rather
> than a different URL. How far any branch is from `main` is a question to ask git, never
> a number written here — it goes stale on the next commit:
>
> ```bash
> git rev-list --left-right --count main...<branch>
> ```

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
| `AGENT_BRANCH=<branch>` | a branch other than `main` |
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
3. Pick `vscode-companion/cli-agent-companion-1.6.0.vsix`.

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
- Type `/config` to turn **subagents** on or off — one switch, and it is on by default. With them on, `ask_subagent` can hand work to a second Gemini tab that has not seen the conversation: a cold review of a change, a search you would otherwise do as a long chain of reads, or a self-contained errand. `/config off` works as well as `/config subagents off`, and `solo` / `duo` are still accepted as words for off and on. There is no separate `/mode` screen, though the name still answers.
- Type `/effort` to pick how hard the agent works — one ladder, `lite` · `flash` · `pro`. Changing it mid-chat says so: the next message resends the whole system prompt into
  the thread, and the row names `/compact` as the way to start a fresh one instead. It sets
  the prompt profile **and switches the browser's mode picker to match**, so a prompt written
  for Pro is not typed into a Flash tab. It tells you which model it chose. Nothing is
  hardcoded — the names and the list differ by subscription, so it reads your picker and
  matches on what each option is *for*.

  **If it picks the wrong one, pin it.** The match is a scored word match against labels
  Google writes and renames, so it can be wrong — and the only remedy used to be editing the
  source. Add `browserModels` under `modelConfig` in `.agent/config.json` and name the picker
  entry you want, one per rung:

  ```json
  "modelConfig": {
    "effort": "pro",
    "browserModels": { "lite": "Fast", "flash": "Thinking", "pro": "Pro" }
  }
  ```

  Partial is fine — pin one rung and the rest keep matching by intent, which is also what
  every existing config does. The label is checked against what your picker is offering *right
  now*, exact first and then as a substring, so `"Pro"` keeps working when `3.1 Pro` becomes
  `3.2 Pro`. A pin naming something your plan does not offer, or matching two entries at once,
  is deliberately **not** used: `/effort` falls back to the intent match and says
  `⚠ config pins "…", which this plan does not offer`, rather than stranding the rung on a
  model that is not there. `/effort` and `/settings` both mark a pinned choice as pinned, so a
  pin never looks like a lucky guess.

  This needs the current extension. If `/effort` says it is switching and the browser does not
  move, reload the extension at `chrome://extensions` and hard-refresh the Gemini tab — the
  page holds the old content script until you do.

  If the browser never answers at all — a changed selector on the picker, a tab that never got
  the message — that is now written to `/logs agent` as `model_options_unanswered`, and
  `/effort` follows its `asked the browser for …` row with a second row saying nothing came
  back. It used to do neither, so an unreadable picker was indistinguishable from one that
  agreed with you.
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

### v2.5.1 — 2026-09-22 · PR #25 · `v2.5.1/echo-and-guardrails`

**Four small fixes, each reported from use in the same session, none changing
behavior outside its own narrow case.**

```bash
git log --oneline v2.5..v2.5.1
```

#### `/compact` and `/undo` answered with nothing saying what caused it

Both rewrite the transcript instead of appending to it — `/undo` removes a
turn, `/compact` replaces the older ones with a summary — and only `/clear`'s
rewrite had reason to skip the `❯ /command` row that every other slash command
pushes before its reply. The other two glued their answer onto the end of
whatever the model last said, so a `/compact` refusal read as part of the
model's own reply. `/clear` is unaffected: it takes its own early-return path
above this branch and never reaches it.

#### `/compact`'s refusal mixed two units and read as self-contradictory

*"the older turns are only 114 characters"* sat directly above *"Context is
~23,248 tokens"* — both true, measuring different things, and side by side
they read as the tool contradicting itself. The first is
`conversationHistory.slice(0, -5)`, only what `/compact` would actually
summarise; the second is everything ever typed into the browser tab, system
prompt included, which is what auto-compaction actually watches. The message
now says which is which.

#### The model-picker warning couldn't tell "agrees" from "can't tell"

`modelMismatch` returned the same `null` whether the browser genuinely agreed
with the active rung or no picker read had ever succeeded — reported twice
from use, status bar on `PRO`, browser on a different model, no warning row
either time. `explainModelMismatch` exposes the real state, and a picker read
that comes back with a list but nothing marked selected is now logged
(`op: model_picker_unreadable`) instead of being silently indistinguishable
from agreement.

Confirmed live, not yet fixed: `discover_models` itself has no timeout, so a
request that never gets an answer leaves the picker's state unknown forever —
the warning cannot be shown, because it never receives anything to compare
against. Tracked for a follow-up.

#### Pro guessed file paths the terse rungs already refuse to

Reported from use: a `pro`-tier turn called `read_file` on an unverified path
with no search first. The guess was right, which is precisely why nothing
caught it — `core-terse.md` (the `lite` rung) and `reasoning-lite.md` both
say never to guess a path, and `pro-guardrails.md` did not, despite a code
comment claiming the rule had been folded into it. It hadn't: the guardrails
covered file *content* and function signatures already read, never path
*existence*. Restored, in pro's voice — `+261` characters, pro rung only.

---

### Unreleased — `v2.2`

**Evidence discipline.** An answer that arrives before its own evidence, and an
audit that could not see the claim it was written to check.

```bash
git log --oneline v2.1..v2.2
```

#### The audit could not see a claim about files

Reported with screenshots. A `## Review` block closed a turn with five
**Verified Files**, two of which did not exist — one of them in
`server/src/github/`, a directory deleted wholesale in `e375aed`. The
architecture above it was invented too: an `agentLoop.on(...)` event API, `F2`
navigation and three dialog components, none of which exist.

`handover-audit.js` exists for exactly this and passed it clean, twice over. Its
label table could return `ran`, `callers` or `checklist` and nothing else, while
carrying a `read` entry no label could ever reach — dead the day it was written,
and invisible because a detector that never fires looks identical to one with
nothing to report. And its parser required `- Label: value`, skipping any line
whose value was empty — which is the shape real blocks use, with the paths
nested beneath.

A path either exists or it does not, which makes this the one claim in a
handover that can be settled rather than weighed. It now is, twice: the path has
to exist, **and** the turn has to have opened it. The count alone only answered
"did anything get read", which a block citing five files passes on the strength
of one unrelated read elsewhere in the turn — so the per-turn record now keeps
which files were touched, not just how many times. `grep_search` and
`list_directory` deliberately do not count: they yield paths the model has seen
*mentioned*, and citing from a search result without opening the file is the
exact failure this exists to catch.

Unsupported is still not false. A model may legitimately cite something it read
three turns ago, so a finding says what *this turn* has no record of — a fact
that can be checked — and never that the claim is a lie. It still fails open on
prose, on an honest "none", and on a bare directory, because a detector that
punishes an unusual format teaches the model to stop emitting the format.

#### A conclusion written before its evidence is not shown

A tool call is a question; a handover block is "I am done". A reply carrying both
concluded before the results existed.

**The model had already been told** — every tool-result turn ends with *"Reply
once, with exactly one of: the next tool call, or your final answer to the
user"*, and that is the turn this happened on. So the matching prompt rule, now
added for the `flash` and `pro` rungs, is the weaker half. The loop declining to
print the conclusion is the fix; an instruction can be ignored, and was.

Detected on the handover block alone, never on length or tone: ordinary
narration beside a tool call is correct and common.

#### Three things that were happening and counted nowhere

- **`turn0_no_tools`** — turn 0 asked about the code and answered without
  opening anything. The most-reported failure here, and it had no log row at
  all: the existing detector catches an *explicit* refusal, which sits at
  0.38%, while a model answering from priors and denying nothing produced
  silence.
- **`premature_conclusion`** — the reply above, as a rate.
- **The picker mismatch could not see its own case.** The warning for "your tab
  is on Flash while the agent is on `pro`" compares against a model list
  requested **once**, 1.5s after the extension connects. Change the picker
  mid-session — which is exactly when people change it — and the stale list
  still said Pro. Re-read at the end of a turn now, throttled to a minute.

#### Also

- **`/compact` no longer draws the transcript twice.** The rebuild dropped the
  position marker the merge runs on, so the next real turn appended the whole
  history again: measured at 6 rows on screen, **11** after one merge.

---

### In review — `v2.1` · [PR #19](https://github.com/PratimeshTiwari/Gemini-Agent/pull/19)

Three faults reported from use, each reproduced before it was touched. What they
have in common: the product was measured rather than reasoned about, and in two
of the three the written explanation of the behaviour was itself wrong.

```bash
git log --oneline main..v2.1
npm test 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"
```

#### Prose is not a malformed tool call

Asked whether the system prompt should be re-sent in chunks, the model answered
correctly and illustrated it with a **bare** code fence. Gemini labels an
untagged fence "Plaintext" in its own UI, so nothing on screen suggested JSON —
but the parser's language tag was optional and the body only had to open with
`[` and close with `}`. Measured: `plaintext`, `text` and `bash` all escape;
untagged is the one that matches.

The throw sits inside the `replace` callback, so it discarded the **entire
reply**. The loop then sent *"Please correct the previous JSON formatting
error."* into the thread — about a tool call that was never made. Models comply
with false premises: it invented one and spent the turn investigating a question
it had already answered. Preserved in `.agent/logs/errors.jsonl`.

A block that yields no call is also no longer deleted from the reply, so a model
answering "your config should be:" keeps its answer.

#### `--resume` and `--continue` reach the browser

The model's memory is the Gemini chat thread, not `history.jsonl`, and the whole
chain to reopen it existed — `open_thread` → `chrome.tabs.update(/app/<id>)`.
Only `/history` and the side panel called it. The launch flags called the
*storage* method and stopped, so the transcript came back while the tab opened a
new conversation and the model was told nothing about either.

The invariant is now asserted directly: a reopened thread **or** a recap, never
neither. Verified end-to-end against a fake extension over the real bridge.

#### `/update` says it is working

Bare `/update` runs `git fetch origin` — **1,086ms warm, up to 10s cold** — and
raised no spinner, so the input box cleared and nothing happened. Reported as
*"/update seems glitched out."* The comment in the source claiming a spinner was
unavailable "because `/update` on its own answers instantly" had never been
measured and was false.

#### Removed: `open_in_editor`

Opened a file in your editor at a line. Deleted because the terminal already
does it better and for free: paths printed as `file.js:12` are clickable in
every terminal this runs in, so the tool spent a browser round trip to reach a
worse version of a thing that was one click away.

It had also never been called — not once in 41 sessions — which is the evidence
that decided it. Seven other tools share that zero and are **kept**: four are
useful and need a trigger rather than a reminder, and three are correctly idle
(`manage_task` has nothing to manage while `run_background` is unused;
`recall_history` has nothing to recall until `/compact` stops stalling).

`isVSCodeFamily` in `core/host-editor.js` is now unreferenced outside its own
test. Left in place and flagged rather than swept up with this, because an
audit of dead exports is its own pass.

#### Measured while looking

- A turn costs **4,673ms median** (14,913ms p90) over 265 real turns, of which
  typing the prompt is **23ms — 0.5%**. Prompt length is nearly free; round
  trips are not.
- Turn 0 on `pro` is **26,268 characters ≈ 6,557 tokens**; turn 1 is **370**.
- **Eight of eighteen tools have never been called**, despite being named on
  every turn. A name is not a trigger.

---

### v2 — 2026-09-20 · PR #17 · `fix/bridge-speed-and-stability`

**Most of it is `fix`** — this release is mostly the product being made to do
what it already said it did.

```bash
git show --stat fb2c955
```

The count was deliberately never written out in prose. It said "113 commits
ahead" for about a day, during which it was wrong roughly forty times — and "82"
for another, which is the same mistake made by the paragraph warning about it.
That rule still stands for every entry above: print the command, not the number.

#### What this branch is

Three things, and the first is most of it.

**Nine bugs of one shape: the model was told the truth and the code did
something else** — see *Told the truth, enforced something else* below. Plan
mode exempting every `.md` file anywhere, `run_background` reaching none of the
safety machinery, `find_references` answering **0** for every method under a
message reading "It may be dead code". Every one was found by *using* the agent.

**The bridge stopped losing turns.** The reconnect alarm was being cleared on
connect, so a healthy bridge had none; prompts dispatched while Chrome was away
were written to no sockets and dropped; and the turn's clock lived in a tab
Chrome throttles to roughly one tick a minute, which is the whole of "it hangs
while I'm not looking at Chrome".

**Two subsystems removed**, and `agent-loop.js` taken apart: the GitHub PR agent
(2,009 lines, documented first for a possible rebuild) and ChatGPT (one bridge,
one model). `agent-loop.js` 2,669 → 2,193 lines.

**The transcript stopped lying about order and about how many times it happened.**
A turn is drawn in the order things occurred rather than "all the tools, then all
the prose" — and `<Static>` is handed **rows** instead of turns. Ink's `<Static>`
never re-renders an item, so a growing turn could only be shown by remounting it
and reprinting the whole transcript *below* the copy already on screen. On a tall
terminal you saw the banner three times, once per tool round. Measured at 210×64:
**3× → 1×**, 0 full clears, 22,868 → 15,312 bytes.

**The effort ladder is three rungs** — `lite`, `flash`, `pro` — because
five was one tier wearing three hats. `standard → deep` was three substantive
blocks for 4.2%, so `pro` is the old `standard` plus the one of them with a
demonstrated job: a second tab reading the diff cold. The other two are paid in
*output* tokens on every turn, which no prompt measurement shows.

**Added**
- `/history` — reopen a past conversation from inside the session.
- `/image <path>` and `/image remove`, with `1 image` in the status bar.
- `d` on a diff opens the rest of it before you approve.
- `ctrl+b` brings the Gemini tab forward.
- The task panel gets its own key, state and row budget.
- Prompts typed during a turn are queued; `↑` takes one back.
- A handover review that arrives when there is something to hand over, checked
  against what the turn actually did.
- One ceiling for a batch of tool results, divided fairly rather than
  first-come.
- A warning when the browser tab is on a different model from the effort rung,
  naming both and the key that shows the tab.
- `/open` says when the file is not there; `/clear` says which half it cleared.
- Escape clears what you typed before it kills a turn.
- The settings exit screen reports what you changed, not what moved.
- Plan mode offers the mode switch on the diff, where the evidence is.
- `setup.sh` asks where to install.
- A pty harness in the repo — 20 scenarios driving the real CLI with a fake
  extension, asserting text, files, drawing order, string counts, and that the
  frame cost 0 full clears.

**Removed**
- The GitHub PR agent — `github/`, the tab, two hooks, a content script.
- ChatGPT, the second bridge, and `topology` as a stored setting.
- `figlet` and `@inquirer/prompts`; `node_modules` 98.5 MB → 72.7 MB.
- The `brief` and `deep` effort rungs; a stored config naming one folds to `pro`.
- `server/README.md` — the root README and `CLAUDE.md` already covered it.

**Changed**
- The rungs are named after the tabs they expect: `lite` · `flash` · `pro`.
- Tables are drawn at the width the terminal actually is.
- Plain `✓` / `!` instead of emoji on the compaction, diff and model-switch rows.
- Two latency bugs, measured: a reply ending in a code block was read as
  mid-construct (**−10.8s on ~13% of rounds**) and the send path slept 500ms
  before looking (**−0.5s every round**). Extension **1.25.0**.

**Quality**: 1,755 tests (1,545 server + 210 extension) and 20 pty scenarios, **92.8% line coverage** (91.0% branch, 94.4% function).


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

### v1.0 — 2026-09-16 · PR #13 · `v1-stable`

The largest release by far, so it is grouped by area rather than listed flat.
`v1.1-bug-fixes` (PR #14) and `v1.2-github` (PR #16) followed it on 2026-09-17;
their changes are folded into the areas below rather than split out, because
they were fixes to this work rather than a release of their own.

#### At a glance

The detail is grouped by area below. This is the shape of it.

**Added**
- `find_symbol` / `find_references` — structural code search, on acorn.
- `run_background` + `manage_task` — dev servers and watchers that outlive a turn.
- `recall_history` — the model can look into its own compacted history.
- A **reviewer** (`/config`) with no memory of the conversation that produced
  the work.
- `/plans`, `/commands`, `/logs`, `/update`, `/name`, `/restart`.
- A **command audit trail** — every shell command run, blocked or refused.
- `/image` — attach a screenshot from the clipboard.
- A VS Code companion that forwards failed terminal commands and the Problems panel.

**Changed**
- **One instruction surface**: `AGENT.md`, walked up from the code.
- **One effort ladder**: `/effort` — flash · flash-thinking · brief · standard · deep.
- Startup **2.46 s → 0.53 s** to the prompt box.

**Removed**
- `semantic_search` and the retrieval subsystem; `ast-chunker`; the skills registry.
- `rules.md`, `mistakes.md`, `contextFolders`, `memory.json`.
- `topology`, `reasoningEffort`, `modelTier`/`reasoningLevel` as stored settings.
- Mouse tracking, permanently — scroll, drag-select and copy are the terminal's.
- The runtime scope switcher, and `/agent-dir`.

**Fixed** — the flicker that was deleting your scrollback seven times a second,
the auto-mode command classifier that could be walked past with a `;`, a bridge
that bound to every interface with no auth, and `diff-engine` writing backups
outside the backup directory.

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
