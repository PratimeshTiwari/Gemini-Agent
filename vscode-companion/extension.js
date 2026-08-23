const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function activate(context) {
    let timeout;
    
    function writeState() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const geminiDir = path.join(workspaceRoot, '.gemini-agent');
        
        if (!fs.existsSync(geminiDir)) {
            try { fs.mkdirSync(geminiDir); } catch(e) {}
        }

        const stateFile = path.join(geminiDir, 'editor_state.json');
        const document = editor.document;
        const selection = editor.selection;
        
        // Get visible text (approximate by getting +- 50 lines from cursor)
        const startLine = Math.max(0, selection.active.line - 50);
        const endLine = Math.min(document.lineCount - 1, selection.active.line + 50);
        const visibleRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
        const visibleText = document.getText(visibleRange);

        const state = {
            activeFile: document.uri.fsPath.replace(workspaceRoot, ''),
            cursorLine: selection.active.line + 1,
            cursorChar: selection.active.character + 1,
            visibleText: visibleText,
            timestamp: Date.now()
        };

        try {
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        } catch(e) {}
    }

    vscode.window.onDidChangeActiveTextEditor(() => {
        clearTimeout(timeout);
        timeout = setTimeout(writeState, 500);
    }, null, context.subscriptions);

    vscode.window.onDidChangeTextEditorSelection(() => {
        clearTimeout(timeout);
        timeout = setTimeout(writeState, 500);
    }, null, context.subscriptions);
    
    // Initial write
    writeState();

    // -- Plan Approval CodeLens --
    class PlanApprovalCodeLensProvider {
        provideCodeLenses(document, token) {
            if (!document.fileName.endsWith('implementation_plan.md')) {
                return [];
            }
            
            const range = new vscode.Range(0, 0, 0, 0);
            
            const approveLens = new vscode.CodeLens(range, {
                title: '✅ Approve Plan',
                command: 'geminiCompanion.approvePlan',
                tooltip: 'Approve the implementation plan and proceed'
            });
            
            const rejectLens = new vscode.CodeLens(range, {
                title: '❌ Reject Plan',
                command: 'geminiCompanion.rejectPlan',
                tooltip: 'Reject the implementation plan'
            });
            
            return [approveLens, rejectLens];
        }
    }

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'markdown', scheme: 'file', pattern: '**/implementation_plan.md' },
            new PlanApprovalCodeLensProvider()
        )
    );

    function writePlanApproval(status) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const geminiDir = path.join(workspaceRoot, '.gemini');
        
        if (!fs.existsSync(geminiDir)) {
            try { fs.mkdirSync(geminiDir); } catch(e) {}
        }

        const approvalFile = path.join(geminiDir, 'plan_approval.json');
        try {
            fs.writeFileSync(approvalFile, JSON.stringify({ status, timestamp: Date.now() }));
            vscode.window.showInformationMessage(`Plan ${status === 'accept' ? 'Approved' : 'Rejected'}! You can return to the terminal.`);
        } catch(e) {
            vscode.window.showErrorMessage('Failed to write plan approval.');
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('geminiCompanion.approvePlan', () => {
            writePlanApproval('accept');
        }),
        vscode.commands.registerCommand('geminiCompanion.rejectPlan', () => {
            writePlanApproval('reject');
        })
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
