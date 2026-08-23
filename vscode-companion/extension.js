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
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
