import fs from 'fs';
import path from 'path';

/**
 * WorkspaceSummarizer
 * 
 * Generates a high-level map of the directory tree to give the agent
 * a persistent understanding of the workspace structure.
 */
export class WorkspaceSummarizer {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
    this.ignoreList = new Set(['node_modules', '.git', '.gemini', 'dist', 'build', 'coverage']);
  }

  /**
   * Generates a structural summary of the workspace (ignoring common hidden/build dirs).
   * @param {number} maxDepth - Max directory depth to traverse
   * @returns {string}
   */
  summarize(maxDepth = 3) {
    if (!fs.existsSync(this.workspacePath)) return 'Workspace not found.';
    
    let summary = `Workspace Directory: ${this.workspacePath}\n\n`;
    summary += this._traverse(this.workspacePath, 0, maxDepth);
    return summary;
  }

  _traverse(dirPath, currentDepth, maxDepth) {
    if (currentDepth > maxDepth) return '';

    let result = '';
    let items;
    try {
      items = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return '';
    }

    // Sort: directories first, then files
    items.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const item of items) {
      if (this.ignoreList.has(item.name) || item.name.startsWith('.')) continue;

      const indent = '  '.repeat(currentDepth);
      if (item.isDirectory()) {
        result += `${indent}📂 ${item.name}/\n`;
        result += this._traverse(path.join(dirPath, item.name), currentDepth + 1, maxDepth);
      } else {
        result += `${indent}📄 ${item.name}\n`;
      }
    }

    return result;
  }
}
