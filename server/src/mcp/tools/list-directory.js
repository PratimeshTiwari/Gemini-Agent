/**
 * Tool: list_directory
 *
 * List directory contents with file/directory info.
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { resolve, relative, join } from 'path';

export async function listDirectory(args, context) {
  const { path: dirPath = '.', recursive = false, maxDepth = 3 } = args;
  const { workspace } = context;

  const absPath = dirPath.startsWith('/') ? dirPath : resolve(workspace, dirPath);
  const relPath = relative(workspace, absPath) || '.';

  if (!existsSync(absPath)) {
    throw new Error(`Directory not found: ${relPath}`);
  }

  const stat = statSync(absPath);
  if (!stat.isDirectory()) {
    throw new Error(`${relPath} is not a directory. Use read_file to read files.`);
  }

  const tree = buildTree(absPath, workspace, recursive, maxDepth, 0);

  return {
    path: relPath,
    ...tree,
  };
}

function buildTree(absPath, workspace, recursive, maxDepth, currentDepth) {
  let entries;
  try {
    entries = readdirSync(absPath, { withFileTypes: true });
  } catch (err) {
    return { error: `Cannot read directory: ${err.message}` };
  }

  // Sort: directories first, then files, alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const children = [];
  let totalFiles = 0;
  let totalDirs = 0;

  for (const entry of entries) {
    const entryPath = join(absPath, entry.name);
    const relPath = relative(workspace, entryPath);

    if (entry.isDirectory()) {
      // Skip hidden/system directories
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (entry.name === 'node_modules') {
        children.push({
          name: entry.name,
          type: 'directory',
          path: relPath,
          note: '(skipped)',
        });
        totalDirs++;
        continue;
      }

      totalDirs++;
      const child = {
        name: entry.name,
        type: 'directory',
        path: relPath,
      };

      if (recursive && currentDepth < maxDepth) {
        const subtree = buildTree(entryPath, workspace, recursive, maxDepth, currentDepth + 1);
        child.children = subtree.children;
        child.fileCount = subtree.totalFiles;
        child.dirCount = subtree.totalDirs;
        totalFiles += subtree.totalFiles;
        totalDirs += subtree.totalDirs;
      }

      children.push(child);
    } else {
      totalFiles++;
      try {
        const stat = statSync(entryPath);
        children.push({
          name: entry.name,
          type: 'file',
          path: relPath,
          size: formatBytes(stat.size),
          sizeBytes: stat.size,
        });
      } catch {
        children.push({
          name: entry.name,
          type: 'file',
          path: relPath,
        });
      }
    }
  }

  return { children, totalFiles, totalDirs };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
