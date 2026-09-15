#!/usr/bin/env bash
#
# setup.sh — everything that can be automated, once.
#
# Two ways in, and the script works out which one it is:
#
#   curl -fsSL <raw-url>/setup.sh | bash      # no checkout yet: clone, then run
#   ./setup.sh                                # inside a checkout: just run
#
# The two steps that cannot be automated are printed at the end: loading the
# Chrome extension and signing into a chat tab. There is no API key to
# configure, which is the whole point — inference happens in your own browser
# session, so a human has to be logged into it.
#
# Safe to re-run: every step checks before it acts.
#
# Knobs, all optional:
#   AGENT_REPO=<url>        where to clone from
#   AGENT_BRANCH=<name>     which branch (default: main)
#   AGENT_INSTALL_DIR=<dir> where to put it (default: ~/Gemini-Agent)
#   --yes / AGENT_YES=1     take the default on every question, ask nothing

set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

ASSUME_YES="${AGENT_YES:-0}"
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
  esac
done

# Ask a yes/no question, defaulting to no.
#
# Reads from /dev/tty, never from stdin. Piped from curl, stdin *is the script*
# — a `read` there eats the rest of the source and the shell runs whatever is
# left. That is the classic way a curl-pipe installer corrupts itself, so the
# terminal is addressed directly or the question is not asked at all.
ask() {
  [ "$ASSUME_YES" = "1" ] && return 0
  # `[ -r /dev/tty ]` is not enough. The device node can exist and pass a read
  # test and still fail to open, when the process has no controlling terminal —
  # which is the case this whole function exists to survive. Opening it for
  # real, quietly, in a subshell, is the only test that answers the question.
  ( : < /dev/tty ) 2>/dev/null || return 1
  printf '  \033[1m%s\033[0m [y/N] ' "$1" > /dev/tty
  local reply=''
  read -r reply < /dev/tty || return 1
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# ── 0. Get the code, if we do not already have it ────────────────────
#
# `$0` is not a path when the script arrives through a pipe (it is "bash", or
# "-"), so the checkout is identified by what is next to the script rather than
# by how it was invoked: a sibling `server/package.json` means we are in one.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -z "$SELF_DIR" ] || [ ! -f "$SELF_DIR/server/package.json" ]; then
  REPO="${AGENT_REPO:-https://github.com/PratimeshTiwari/Gemini-Agent.git}"
  BRANCH="${AGENT_BRANCH:-main}"
  TARGET="${AGENT_INSTALL_DIR:-$HOME/Gemini-Agent}"

  step "Fetching the code"

  if ! command -v git >/dev/null 2>&1; then
    echo "  git is not installed, and this step needs it."
    echo "  macOS: xcode-select --install   ·   Debian/Ubuntu: sudo apt install git"
    exit 1
  fi

  if [ -d "$TARGET/.git" ]; then
    # Re-running the one-liner is an update, not a second install.
    ok "found an existing checkout at $TARGET"
    git -C "$TARGET" fetch --quiet origin "$BRANCH"
    if [ -n "$(git -C "$TARGET" status --porcelain)" ]; then
      warn "local changes present — not touching them, using the checkout as it is"
    else
      git -C "$TARGET" checkout --quiet "$BRANCH"
      git -C "$TARGET" merge --quiet --ff-only "origin/$BRANCH" 2>/dev/null \
        && ok "updated to origin/$BRANCH" \
        || warn "could not fast-forward to origin/$BRANCH — using the checkout as it is"
    fi
  elif [ -e "$TARGET" ]; then
    # Refusing beats clobbering: this is someone's directory.
    echo "  $TARGET already exists and is not a git checkout."
    echo "  Move it, or choose somewhere else:"
    echo "      AGENT_INSTALL_DIR=~/somewhere-else bash setup.sh"
    exit 1
  else
    git clone --quiet --branch "$BRANCH" "$REPO" "$TARGET"
    ok "cloned $BRANCH into $TARGET"
  fi

  # Hand over to the copy that came with the code. `exec` so there is one
  # process and one exit status, and the script that continues is the one that
  # matches the tree it is setting up.
  exec bash "$TARGET/setup.sh" "$@"
fi

cd "$SELF_DIR"
ROOT="$(pwd)"

# ── 1. Node ──────────────────────────────────────────────────────────
step "Checking Node"

if ! command -v node >/dev/null 2>&1; then
  echo "  Node is not installed. Get it from https://nodejs.org (v18 or newer)."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  Node $(node -v) is too old — v18 or newer is required."
  exit 1
fi
ok "node $(node -v)"

# ── 2. Dependencies ──────────────────────────────────────────────────
step "Installing dependencies"
npm install --silent
ok "server and extension workspaces installed"

# ── 3. The extension bundle ──────────────────────────────────────────
# service-worker.js is committed, but a fresh clone that has never built it —
# or one where src/background/ moved ahead of it — ships stale code to Chrome.
step "Building the extension bundle"
npm run build --workspace=extension --silent
ok "extension/service-worker.js"

# ── 4. The command on your PATH ──────────────────────────────────────
# npm link writes into the bin directory of the Node you are running now. If
# you switch versions with nvm, run this again on the new one.
step "Putting 'agent-cli' on your PATH"

if npm link --workspace=server --silent 2>/dev/null; then
  if command -v agent-cli >/dev/null 2>&1; then
    ok "agent-cli → $(command -v agent-cli)"
    ok "agent (short alias)"
  else
    warn "linked, but the shell has not noticed yet — run 'hash -r' or open a new terminal"
  fi
else
  # `npm link` writes into the *global* prefix, which on a managed machine is
  # usually somewhere you cannot write — and `sudo npm link` is the wrong answer
  # to that, because it leaves root-owned files in a tree npm will later try to
  # modify as you.
  #
  # A shim needs none of it: two lines of sh in a directory you already own,
  # calling this checkout by absolute path. It also survives switching Node
  # versions with nvm, which a link does not — the link points at the bin
  # directory of whichever Node created it.
  warn "npm link failed — no write access to npm's global prefix, most likely"
  step "Installing a shim instead"

  # Declared at the top of this branch and read again in 4b below.
  SHIM_DIR=""
  for candidate in "$HOME/.local/bin" "$HOME/bin"; do
    case ":$PATH:" in
      *":$candidate:"*) [ -d "$candidate" ] && [ -w "$candidate" ] && SHIM_DIR="$candidate" && break ;;
    esac
  done

  # Nothing suitable already on PATH: make the conventional one and say the line.
  ON_PATH_ALREADY=1
  if [ -z "$SHIM_DIR" ]; then
    SHIM_DIR="$HOME/.local/bin"
    mkdir -p "$SHIM_DIR" 2>/dev/null || true
    ON_PATH_ALREADY=0
  fi

  if [ -w "$SHIM_DIR" ]; then
    for name in agent agent-cli; do
      cat > "$SHIM_DIR/$name" <<SHIM
#!/bin/sh
# Installed by Gemini-Agent's setup.sh because npm link was not available.
# Points at the checkout it was run from; move the checkout and re-run setup.
exec node "$ROOT/server/src/index.js" "\$@"
SHIM
      chmod +x "$SHIM_DIR/$name"
    done
    ok "agent, agent-cli → $SHIM_DIR"

    if [ "$ON_PATH_ALREADY" -eq 0 ]; then
      warn "$SHIM_DIR is not on your PATH yet. Add this to ~/.zshrc (or ~/.bashrc):"
      printf '\n    export PATH="%s:$PATH"\n\n' "$SHIM_DIR"
    fi
  else
    warn "could not write a shim to $SHIM_DIR either"
    warn "Run it from this directory with: npm start"
  fi
fi

# ── 4b. The shell rc file ────────────────────────────────────────────
#
# Only ever *offered*, and only when it would actually change something: if
# `agent` already resolves, appending a line to someone's rc file is noise they
# have to read past forever. Writing to a shell rc without asking is the kind
# of thing that makes an installer unwelcome.
step "Making 'agent' stick around"

rc_file() {
  case "$(basename "${SHELL:-}")" in
    zsh)  printf '%s\n' "$HOME/.zshrc" ;;
    bash) [ -f "$HOME/.bash_profile" ] && printf '%s\n' "$HOME/.bash_profile" \
                                       || printf '%s\n' "$HOME/.bashrc" ;;
    *)    printf '' ;;
  esac
}

MARKER="# added by Gemini-Agent setup.sh"

if command -v agent >/dev/null 2>&1; then
  ok "'agent' already resolves — nothing to add"
else
  RC="$(rc_file)"
  # The line to add depends on which of the two paths above ran: a shim needs
  # its directory on PATH, no shim at all needs an alias into the checkout.
  if [ -n "${SHIM_DIR:-}" ] && [ -x "${SHIM_DIR:-}/agent" ]; then
    LINE="export PATH=\"$SHIM_DIR:\$PATH\"  $MARKER"
  else
    LINE="alias agent='node \"$ROOT/server/src/index.js\"'  $MARKER"
  fi

  if [ -z "$RC" ]; then
    warn "unrecognised shell (${SHELL:-unset}) — add this yourself:"
    printf '\n    %s\n\n' "$LINE"
  elif [ -f "$RC" ] && grep -qF "$MARKER" "$RC"; then
    ok "$RC already has it"
  else
    echo "  This would go at the end of $RC:"
    printf '\n    %s\n\n' "$LINE"
    if ask "Add it?"; then
      printf '\n%s\n' "$LINE" >> "$RC"
      ok "added to $RC — open a new terminal, or: source $RC"
    else
      warn "not added. Add it yourself when you want 'agent' on your PATH."
    fi
  fi
fi

# ── 5. Tests, as a smoke check ───────────────────────────────────────
step "Running the test suite"
if npm test --silent >/dev/null 2>&1; then
  ok "all tests pass"
else
  warn "some tests failed — the agent will still run; see 'npm test' for detail"
fi

# ── What is left, and why ────────────────────────────────────────────
cat <<EOF

$(bold "Two steps left — both need a human")

1. Load the Chrome extension
     • open chrome://extensions/
     • turn on Developer mode (top right)
     • Load unpacked → select:
         $ROOT/extension
     • pin "Agent CLI Bridge" to your toolbar

2. Open https://gemini.google.com and sign in. Leave the tab open.
   This is the inference: the agent types into that tab and reads the reply.
   There is no API key anywhere in this project.

$(bold "Then")

     cd ~/code/your-project
     agent-cli

The status bar reads '● agent' in cyan once the extension connects, and
'○ agent' in yellow while it has not.

$(bold "Optional: the VS Code companion")

     Extensions panel → ... → Install from VSIX...
     $ROOT/vscode-companion/cli-agent-companion-1.5.0.vsix

EOF
