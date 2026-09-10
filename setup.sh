#!/usr/bin/env bash
#
# setup.sh — everything that can be automated, once.
#
# The two steps that cannot be are printed at the end: loading the Chrome
# extension and signing into a chat tab. There is no API key to configure,
# which is the whole point — inference happens in your own browser session,
# so a human has to be logged into it.
#
# Safe to re-run: every step checks before it acts.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

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
  warn "npm link failed (permissions?). Try: sudo npm link --workspace=server"
  warn "Or skip it and run the agent from here with: npm start"
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

The status bar shows 🟢 once the extension connects, 🟡 while it has not.

$(bold "Optional: the VS Code companion")

     Extensions panel → ... → Install from VSIX...
     $ROOT/vscode-companion/cli-agent-companion-1.3.1.vsix

EOF
