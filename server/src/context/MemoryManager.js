import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

/**
 * Manages long-term memory persisted in .gemini/memory.json
 */
export class MemoryManager {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
    this.memoryDir = join(workspacePath, '.gemini');
    this.memoryFile = join(this.memoryDir, 'memory.json');
    this.memoryEnabled = true; // User preference toggle
    this._ensureDir();
  }

  _ensureDir() {
    if (!existsSync(this.memoryDir)) {
      try {
        mkdirSync(this.memoryDir, { recursive: true });
      } catch (err) {
        console.error('Failed to create .gemini directory:', err);
      }
    }
  }

  toggleMemory() {
    this.memoryEnabled = !this.memoryEnabled;
    return this.memoryEnabled;
  }

  isMemoryEnabled() {
    return this.memoryEnabled;
  }

  _loadMemory() {
    if (!existsSync(this.memoryFile)) return [];
    try {
      const data = readFileSync(this.memoryFile, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.error('Failed to load memory.json:', err);
      return [];
    }
  }

  _saveMemory(memories) {
    try {
      writeFileSync(this.memoryFile, JSON.stringify(memories, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save memory.json:', err);
    }
  }

  addMemory(fact) {
    if (!this.memoryEnabled) return false;
    const memories = this._loadMemory();
    if (!memories.includes(fact)) {
      memories.push(fact);
      this._saveMemory(memories);
    }
    return true;
  }

  removeMemory(index) {
    const memories = this._loadMemory();
    if (index >= 0 && index < memories.length) {
      memories.splice(index, 1);
      this._saveMemory(memories);
      return true;
    }
    return false;
  }

  getAllMemories() {
    if (!this.memoryEnabled) return [];
    return this._loadMemory();
  }
}
