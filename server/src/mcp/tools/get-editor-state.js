import fs from 'fs/promises';
import path from 'path';

export default {
  name: 'get_editor_state',
  description: 'Gets the user\'s current editor state (active file, cursor position, and visible text) if the VS Code companion extension is installed.',
  schema: {
    type: 'object',
    properties: {},
    required: []
  },
  async execute(args, context) {
    const stateFile = path.join(context.workspaceIndexer ? context.workspaceIndexer.workspaceRoot : process.cwd(), '.gemini-agent', 'editor_state.json');
    
    try {
      const content = await fs.readFile(stateFile, 'utf-8');
      const state = JSON.parse(content);
      
      const lastUpdate = new Date(state.timestamp);
      const now = new Date();
      const diffMs = now - lastUpdate;
      
      // If the state is older than 5 minutes, the user probably stepped away or closed VS Code
      if (diffMs > 300000) {
        return { result: `The editor state was last updated ${Math.round(diffMs/1000)} seconds ago. It might be stale.\nLast active file: ${state.activeFile}\nCursor: Line ${state.cursorLine}, Char ${state.cursorChar}` };
      }
      
      return {
        result: `Active File: ${state.activeFile}\nCursor Position: Line ${state.cursorLine}, Char ${state.cursorChar}\n\nVisible Text:\n\`\`\`\n${state.visibleText}\n\`\`\``
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { error: 'Editor state not found. The user needs to install the Gemini-Agent VS Code companion extension and open this workspace.' };
      }
      return { error: `Failed to read editor state: ${err.message}` };
    }
  }
};
