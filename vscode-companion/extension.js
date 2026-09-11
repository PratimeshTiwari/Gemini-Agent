const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Must match AGENT_DIR in server/src/core/paths.js
const AGENT_DIR = '.agent';

/** The workspace root, or null when no folder is open. */
function workspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

/** Absolute path to a file in `.agent/state/`, creating the directory. */
function statePath(name) {
    const root = workspaceRoot();
    if (!root) return null;
    const dir = path.join(root, AGENT_DIR, 'state');
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) { /* the write below will report it */ }
    return path.join(dir, name);
}

function writeState(name, data) {
    const file = statePath(name);
    if (!file) return false;
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Append one JSON object to a `.jsonl` file in `.agent/state/`.
 *
 * Append-only rather than rewritten, like `chat-queue.jsonl`: the CLI drains by
 * deleting the whole file, and truncating here would race with that.
 */
function appendState(name, data) {
    const file = statePath(name);
    if (!file) return false;
    try {
        fs.appendFileSync(file, `${JSON.stringify(data)}\n`);
        return true;
    } catch (e) {
        return false;
    }
}

function activate(context) {
    const sub = (...items) => context.subscriptions.push(...items);

    // ── Terminal output ───────────────────────────────────────────────
    //
    // The agent can already be woken when a process *it* started fails —
    // `run_background` plus `manage_task watch`. It could never see a terminal
    // you opened yourself, because those belong to the terminal emulator and
    // there is no API for them. Inside VS Code there now is one: shell
    // integration reports each command, its output and its exit code.
    //
    // Only failures are forwarded, and only their tail. A passing `npm test` is
    // not news, and a full build log is tens of thousands of characters that
    // would be typed into a browser chat tab verbatim.
    if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
        const MAX_OUTPUT_CHARS = 4000;
        const running = new Map(); // execution -> collected output

        sub(vscode.window.onDidStartTerminalShellExecution(async (event) => {
            const execution = event.execution;
            let collected = '';
            running.set(execution, () => collected);
            try {
                for await (const chunk of execution.read()) {
                    collected += chunk;
                    // Keep the tail: a failure explains itself at the end, and
                    // holding a whole build log in memory helps nobody.
                    if (collected.length > MAX_OUTPUT_CHARS * 2) {
                        collected = collected.slice(-MAX_OUTPUT_CHARS);
                    }
                }
            } catch (e) {
                /* the terminal closed mid-command */
            }
            running.set(execution, () => collected);
        }));

        sub(vscode.window.onDidEndTerminalShellExecution((event) => {
            const getOutput = running.get(event.execution);
            running.delete(event.execution);

            // exitCode is undefined when the shell could not report one, which
            // is not the same as success — but it is not a failure either, and
            // guessing would fill the queue with noise.
            if (event.exitCode === undefined || event.exitCode === 0) return;

            const output = (getOutput ? getOutput() : '').slice(-MAX_OUTPUT_CHARS);
            appendState('terminal.jsonl', {
                timestamp: Date.now(),
                command: event.execution.commandLine?.value || '(unknown command)',
                cwd: event.execution.cwd?.fsPath || event.execution.cwd?.path || null,
                exitCode: event.exitCode,
                terminal: event.terminal?.name || null,
                output: output.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd(),
            });
        }));
    }

    // ── Editor state ──────────────────────────────────────────────────
    let editorTimer;

    function writeEditorState() {
        const editor = vscode.window.activeTextEditor;
        const root = workspaceRoot();
        if (!editor || !root) return;

        const document = editor.document;
        const selection = editor.selection;

        // Approximate the viewport as ±50 lines around the cursor.
        const startLine = Math.max(0, selection.active.line - 50);
        const endLine = Math.min(document.lineCount - 1, selection.active.line + 50);
        const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);

        writeState('editor.json', {
            activeFile: document.uri.fsPath.replace(root, ''),
            cursorLine: selection.active.line + 1,
            cursorChar: selection.active.character + 1,
            visibleText: document.getText(range),
            timestamp: Date.now(),
        });
    }

    const scheduleEditorState = () => {
        clearTimeout(editorTimer);
        editorTimer = setTimeout(writeEditorState, 500);
    };

    sub(
        vscode.window.onDidChangeActiveTextEditor(scheduleEditorState),
        vscode.window.onDidChangeTextEditorSelection(scheduleEditorState),
    );
    writeEditorState();

    // ── Diagnostics ───────────────────────────────────────────────────
    //
    // The Problems panel is the cheapest real signal the editor has: the
    // language server has already type-checked and linted everything, and the
    // agent would otherwise have to run a build to learn the same thing.
    //
    // Debounced hard, because onDidChangeDiagnostics fires continuously while
    // a project is being indexed, and each fire would otherwise be a file write.
    let diagnosticsTimer;
    const SEVERITY = ['error', 'warning', 'info', 'hint'];
    const MAX_PROBLEMS = 200;

    function writeDiagnostics() {
        const root = workspaceRoot();
        if (!root) return;

        const problems = [];
        for (const [uri, diags] of vscode.languages.getDiagnostics()) {
            // Only files in this workspace; node_modules and other folders are noise.
            if (!uri.fsPath.startsWith(root)) continue;
            if (uri.fsPath.includes(`${path.sep}node_modules${path.sep}`)) continue;

            for (const d of diags) {
                problems.push({
                    file: path.relative(root, uri.fsPath),
                    line: d.range.start.line + 1,
                    column: d.range.start.character + 1,
                    severity: SEVERITY[d.severity] || 'info',
                    message: d.message.split('\n')[0].slice(0, 300),
                    source: d.source || undefined,
                });
                if (problems.length >= MAX_PROBLEMS) break;
            }
            if (problems.length >= MAX_PROBLEMS) break;
        }

        writeState('diagnostics.json', { timestamp: Date.now(), problems });
    }

    sub(vscode.languages.onDidChangeDiagnostics(() => {
        clearTimeout(diagnosticsTimer);
        diagnosticsTimer = setTimeout(writeDiagnostics, 1500);
    }));
    setTimeout(writeDiagnostics, 3000); // after the language servers have warmed up

    // ── Add to Agent Chat ─────────────────────────────────────────────
    //
    // Appends, rather than overwrites, so several selections can be queued
    // before the agent picks them up — and so this works when the CLI is not
    // running yet. The CLI drains the file (see ui/chat-queue.js).
    function addToChat() {
        const editor = vscode.window.activeTextEditor;
        const root = workspaceRoot();
        if (!editor || !root) {
            vscode.window.showWarningMessage('Agent CLI: open a file first.');
            return;
        }

        const selection = editor.selection;
        const document = editor.document;
        // No selection means "this line", which is what you want when you are
        // pointing at an error rather than highlighting a block.
        const range = selection.isEmpty
            ? document.lineAt(selection.active.line).range
            : selection;

        const entry = {
            file: path.relative(root, document.uri.fsPath),
            startLine: range.start.line + 1,
            endLine: range.end.line + 1,
            text: document.getText(range),
            language: document.languageId,
            timestamp: Date.now(),
        };

        const file = statePath('chat-queue.jsonl');
        if (!file) return;
        try {
            fs.appendFileSync(file, JSON.stringify(entry) + '\n');
            const lines = entry.endLine - entry.startLine + 1;
            vscode.window.setStatusBarMessage(
                `Agent CLI: added ${entry.file}:${entry.startLine}${lines > 1 ? `-${entry.endLine}` : ''}`,
                3000,
            );
        } catch (e) {
            vscode.window.showErrorMessage(`Agent CLI: could not queue selection — ${e.message}`);
        }
    }

    sub(vscode.commands.registerCommand('agentCli.addToChat', addToChat));

    // The floating "Chat ⌘L" widget that Antigravity and Copilot draw on a
    // selection is their own custom widget, not a VS Code extension point —
    // nothing can contribute to it. The native equivalent is a Code Action:
    // it appears on the lightbulb the moment you select something, and ⌘. is
    // the same one-chord reach. So the selection has three ways in — ⌥⌘L, the
    // right-click menu, and ⌘..
    class AddToChatActionProvider {
        provideCodeActions(document, range) {
            // Only for a real selection. Offering this on every cursor move
            // would push the actual quick-fixes down the list on every keypress.
            if (range.isEmpty) return [];

            const lines = range.end.line - range.start.line + 1;
            const action = new vscode.CodeAction(
                `Add to Agent Chat (${lines} line${lines === 1 ? '' : 's'})`,
                vscode.CodeActionKind.Empty,
            );
            action.command = { command: 'agentCli.addToChat', title: 'Add to Agent Chat' };
            return [action];
        }
    }

    sub(vscode.languages.registerCodeActionsProvider(
        { scheme: 'file' },
        new AddToChatActionProvider(),
        { providedCodeActionKinds: [vscode.CodeActionKind.Empty] },
    ));

    // ── Plan review ───────────────────────────────────────────────────
    //
    // A plan is reviewed the way a PR is: leave comments on the parts that need
    // changing, then submit. Approving without comments is still one click —
    // the review flow exists for the case where the plan is nearly right, which
    // "approve or reject" had no answer for.
    let comments = [];

    // Matched on the path rather than with a DocumentSelector glob. The plan
    // lives inside a dot-directory (`.agent/artifacts/`), and whether `**/`
    // crosses one is glob-implementation trivia — get it wrong and the lenses
    // simply never appear, with nothing to debug. This also stops an unrelated
    // `plan.md` elsewhere in the repo from offering to approve a plan.
    const isPlanFile = (fileName) => {
        const p = String(fileName || '').replace(/\\/g, '/');
        return p.endsWith(`/${AGENT_DIR}/artifacts/plan.md`)
            || p.endsWith(`/${AGENT_DIR}/artifacts/implementation_plan.md`);
    };

    function persistComments() {
        writeState('plan-review.json', { comments, timestamp: Date.now() });
    }

    function submitReview(status) {
        const file = statePath('plan-approval.json');
        if (!file) return;
        try {
            fs.writeFileSync(file, JSON.stringify({ status, comments, timestamp: Date.now() }));
            const n = comments.length;
            comments = [];
            persistComments();
            planLenses.fire();
            vscode.window.showInformationMessage(
                status === 'accept' ? 'Plan approved — back to the terminal.'
                    : status === 'changes_requested'
                        ? `Review submitted with ${n} comment${n === 1 ? '' : 's'}.`
                        : 'Plan rejected.',
            );
        } catch (e) {
            vscode.window.showErrorMessage('Agent CLI: could not write the review.');
        }
    }

    const planLenses = new vscode.EventEmitter();

    class PlanReviewCodeLensProvider {
        constructor() {
            this.onDidChangeCodeLenses = planLenses.event;
        }

        provideCodeLenses(document) {
            if (!isPlanFile(document.fileName)) return [];

            const top = new vscode.Range(0, 0, 0, 0);
            const n = comments.length;
            const lenses = [
                new vscode.CodeLens(top, {
                    title: '✅ Approve',
                    command: 'agentCli.approvePlan',
                    tooltip: 'Approve the plan and let the agent start',
                }),
                new vscode.CodeLens(top, {
                    title: n > 0 ? `📤 Submit review (${n})` : '📤 Submit review',
                    command: 'agentCli.submitReview',
                    tooltip: 'Send your comments back for the plan to be revised',
                }),
                new vscode.CodeLens(top, {
                    title: '❌ Reject',
                    command: 'agentCli.rejectPlan',
                    tooltip: 'Reject the plan outright',
                }),
            ];

            // A comment lens on every heading, so feedback lands on the section
            // it is about rather than on the plan as a whole.
            for (let i = 0; i < document.lineCount; i++) {
                const text = document.lineAt(i).text;
                if (!/^#{1,4}\s+\S/.test(text)) continue;
                const heading = text.replace(/^#+\s*/, '').trim();
                const existing = comments.filter((c) => c.line === i + 1).length;
                lenses.push(new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
                    title: existing > 0 ? `💬 ${existing} comment${existing === 1 ? '' : 's'}` : '💬 Comment',
                    command: 'agentCli.commentOnPlan',
                    arguments: [i + 1, heading],
                    tooltip: `Leave a comment on "${heading}"`,
                }));
            }

            return lenses;
        }
    }

    sub(vscode.languages.registerCodeLensProvider(
        { language: 'markdown', scheme: 'file' },
        new PlanReviewCodeLensProvider(),
    ));

    sub(
        vscode.commands.registerCommand('agentCli.approvePlan', () => submitReview('accept')),
        vscode.commands.registerCommand('agentCli.rejectPlan', () => submitReview('reject')),
        vscode.commands.registerCommand('agentCli.submitReview', () => {
            if (comments.length === 0) {
                vscode.window.showWarningMessage(
                    'No comments yet — use 💬 Comment on a section, or ✅ Approve if the plan is fine.',
                );
                return;
            }
            submitReview('changes_requested');
        }),
        vscode.commands.registerCommand('agentCli.commentOnPlan', async (line, section) => {
            const comment = await vscode.window.showInputBox({
                prompt: `Comment on "${section}"`,
                placeHolder: 'What should change here?',
            });
            if (!comment || !comment.trim()) return;
            comments.push({ line, section, comment: comment.trim() });
            persistComments();
            planLenses.fire();  // repaint the counts
        }),
    );

    // The plan is opened by the CLI, but a user who closes it should be able to
    // get back without hunting through .agent/.
    sub(vscode.commands.registerCommand('agentCli.openPlan', async () => {
        const root = workspaceRoot();
        if (!root) return;
        const dir = path.join(root, AGENT_DIR, 'artifacts');
        for (const name of ['implementation_plan.md', 'plan.md']) {
            const file = path.join(dir, name);
            if (fs.existsSync(file)) {
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
                return;
            }
        }
        vscode.window.showInformationMessage('No plan has been written yet.');
    }));
}

function deactivate() {}

module.exports = { activate, deactivate };
