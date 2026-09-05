import fs from 'fs/promises';
import { AGENT_DIR } from '../core/paths.js';
import path from 'path';
import madge from 'madge';
import chalk from 'chalk';

/**
 * A lightweight, in-memory TF-IDF indexer for the workspace.
 * Provides instant "Background RAG" capabilities without needing a vector database.
 */
export class WorkspaceIndexer {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.index = new Map(); // token -> [{ chunkId, score }]
    this.chunks = new Map(); // chunkId -> { filePath, text, lines }
    this.dependencyGraph = {}; // File dependencies
    this.isReady = false;
  }

  async buildIndex() {
    this.isReady = false;
    this.index.clear();
    this.chunks.clear();

    try {
      const files = await this._getAllFiles(this.workspaceRoot);
      let chunkCounter = 0;

      for (const file of files) {
        if (this._shouldIgnore(file)) continue;

        try {
          const content = await fs.readFile(file, 'utf-8');
          // Chunk by 50 lines for precision
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i += 50) {
            const chunkLines = lines.slice(i, i + 50);
            const chunkText = chunkLines.join('\n');
            const chunkId = `chunk_${chunkCounter++}`;
            
            this.chunks.set(chunkId, { 
              filePath: file.replace(this.workspaceRoot, ''), 
              text: chunkText,
              startLine: i + 1,
              endLine: i + chunkLines.length
            });

            // Tokenize
            const tokens = this._tokenize(chunkText);
            const tokenCounts = {};
            for (const token of tokens) {
              tokenCounts[token] = (tokenCounts[token] || 0) + 1;
            }

            // Index
            for (const [token, count] of Object.entries(tokenCounts)) {
              if (!this.index.has(token)) {
                this.index.set(token, []);
              }
              this.index.get(token).push({ chunkId, score: count });
            }
          }
        } catch (err) {
          // Skip binary or unreadable files silently
        }
      }
      
      this.isReady = true;
      console.log(`\n[WorkspaceIndexer] Built index over ${this.chunks.size} chunks from ${files.length} files.`);

      // Build dependency graph using madge
      try {
        const res = await madge(this.workspaceRoot, { includeNpm: false, fileExtensions: ['js', 'jsx', 'ts', 'tsx'] });
        this.dependencyGraph = res.obj();
        console.log(`[WorkspaceIndexer] Built dependency graph with ${Object.keys(this.dependencyGraph).length} modules.`);
      } catch (err) {
        console.error(`[WorkspaceIndexer] Failed to build dependency graph:`, err.message);
      }
    } catch (err) {
      console.error(`\n[WorkspaceIndexer] Failed to build index:`, err.message);
    }
  }

  search(query, topK = 5) {
    if (!this.isReady) return [{ error: "Index is still building in the background. Try again in a few seconds." }];

    const queryTokens = this._tokenize(query);
    if (queryTokens.length === 0) return [];

    const chunkScores = new Map();

    for (const token of queryTokens) {
      if (this.index.has(token)) {
        const postings = this.index.get(token);
        // IDF weighting: rarer tokens matter more
        const idf = Math.log(this.chunks.size / (1 + postings.length));
        
        for (const posting of postings) {
          const tfidf = posting.score * idf;
          chunkScores.set(posting.chunkId, (chunkScores.get(posting.chunkId) || 0) + tfidf);
        }
      }
    }

    const sorted = [...chunkScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
    
    return sorted.map(([chunkId, score]) => {
      const chunk = this.chunks.get(chunkId);
      
      // Look up dependencies if available
      let depsStr = '';
      const relativePath = chunk.filePath.startsWith('/') ? chunk.filePath.slice(1) : chunk.filePath;
      if (this.dependencyGraph && this.dependencyGraph[relativePath]) {
        const deps = this.dependencyGraph[relativePath];
        if (deps.length > 0) {
          depsStr = `\nDependencies:\n  - ${deps.join('\n  - ')}`;
        }
      }

      return {
        file: chunk.filePath,
        lines: `${chunk.startLine}-${chunk.endLine}`,
        score: score.toFixed(2),
        content: chunk.text + depsStr
      };
    });
  }

  _tokenize(text) {
    // lowercase, remove non-alphanumeric, filter out tiny words
    return text.toLowerCase().split(/[^a-z0-9_]+/g).filter(t => t.length > 2);
  }

  async _getAllFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'build', AGENT_DIR].includes(entry.name) && !entry.name.startsWith('.')) {
          files.push(...await this._getAllFiles(res));
        }
      } else {
        files.push(res);
      }
    }
    return files;
  }

  _shouldIgnore(filePath) {
    const ext = path.extname(filePath);
    return ['.png', '.jpg', '.jpeg', '.gif', '.zip', '.tar', '.gz', '.pdf', '.mp4', '.sqlite', '.lock'].includes(ext);
  }
}
