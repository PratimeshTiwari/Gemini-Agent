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
# Always /dev/tty, never stdin: piped from curl, stdin *is the script*, and a
# `read` there eats the rest of the source. `[ -r /dev/tty ]` is not a
# sufficient test — the node can exist and still fail to open with no
# controlling terminal, so it is opened for real in a subshell.
ask() {
  [ "$ASSUME_YES" = "1" ] && return 0
  ( : < /dev/tty ) 2>/dev/null || return 1
  printf '  \033[1m%s\033[0m [y/N] ' "$1" > /dev/tty
  local reply=''
  read -r reply < /dev/tty || return 1
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# ── 0. Get the code, if we do not already have it ────────────────────
#
# `$0` is not a path when piped, so a checkout is identified by a sibling
# `server/package.json` rather than by how the script was invoked.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -z "$SELF_DIR" ] || [ ! -f "$SELF_DIR/server/package.json" ]; then
  REPO="${AGENT_REPO:-https://github.com/PratimeshTiwari/Gemini-Agent.git}"
  BRANCH="${AGENT_BRANCH:-main}"

  step "Fetching the code"

  # Where it goes. AGENT_INSTALL_DIR wins outright; otherwise offer the default
  # and take a different answer. No tty, or --yes, means the default without a
  # question — the same rule every other prompt here follows.
  TARGET="${AGENT_INSTALL_DIR:-}"
  if [ -z "$TARGET" ]; then
    TARGET="$HOME/Gemini-Agent"
    if [ "$ASSUME_YES" != "1" ] && ( : < /dev/tty ) 2>/dev/null; then
      printf '  \033[1mInstall to %s?\033[0m [Y/n] ' "$TARGET" > /dev/tty
      read -r reply < /dev/tty || reply=''
      case "$reply" in
        [nN]*)
          printf '  Path: ' > /dev/tty
          read -r chosen < /dev/tty || chosen=''
          [ -n "$chosen" ] && TARGET="$chosen"
          ;;
      esac
    fi
  fi
  # `read` hands back a literal ~; no shell expanded it on the way.
  case "$TARGET" in "~") TARGET="$HOME" ;; "~/"*) TARGET="$HOME/${TARGET#\~/}" ;; esac

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

  # Continue in the copy that came with the code, so the script matches the
  # tree it is setting up. `exec`: one process, one exit status.
  exec bash "$TARGET/setup.sh" "$@"
fi

cd "$SELF_DIR"
ROOT="$(pwd)"

# ── 1. Node ──────────────────────────────────────────────────────────
step "Checking Node"

if ! command -v node >/dev/null 2>&1; then
  echo "  Node is not installed. Get it from https://nodejs.org (v20 or newer)."
  exit 1
fi

# 20, matching `engines` in package.json. It used to check 18, which let a v18
# user through this gate and then fail on npm's own check a step later — a
# worse failure than the one this is here to give, because it arrives after
# the script has said the version is fine.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  Node $(node -v) is too old — v20 or newer is required."
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
#
# A shim, never `npm link`. The link needs npm's global prefix, which a managed
# machine does not grant, and it breaks on an nvm version switch. Two lines of
# sh in a directory you already own has neither problem.
step "Putting 'agent' and 'agent-cli' on your PATH"

# Read again in 4b below.
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
# Installed by Gemini-Agent's setup.sh. Points at the checkout it was run
# from; move the checkout and re-run setup.
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

# ── 4b. The shell rc file ────────────────────────────────────────────
#
# Offered, never assumed, and only when `agent` does not already resolve.
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
  # A shim needs its directory on PATH; no shim needs an alias.
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
