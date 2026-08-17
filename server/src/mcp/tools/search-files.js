/**
 * Tool: search_files
 *
 * Fuzzy file name search across the workspace.
 */

import fg from 'fast-glob';
import { relative } from 'path';

/**
 * Simple fuzzy match scoring.
 * Returns a score (higher = better match), or -1 if no match.
 */
function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact substring match gets highest score
  if (t.includes(q)) {
    // Bonus if it matches the filename (not just path)
    const filename = t.split('/').pop();
    if (filename.includes(q)) return 100 + (q.length / filename.length) * 50;
    return 50 + (q.length / t.length) * 30;
  }

  // Fuzzy character matching
  let qIdx = 0;
  let score = 0;
  let consecutive = 0;

  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (t[tIdx] === q[qIdx]) {
      qIdx++;
      consecutive++;
      score += consecutive * 2; // Bonus for consecutive matches
    } else {
      consecutive = 0;
    }
  }

  // All query chars must match
  if (qIdx < q.length) return -1;

  // Normalize by length
  return score / t.length * 10;
}

export async function searchFiles(args, context) {
  const { query, maxResults = 20 } = args;
  const { workspace } = context;

  if (!query || query.trim().length === 0) {
    throw new Error('Search query cannot be empty');
  }

  // Get all files in workspace
  const files = await fg('**/*', {
    cwd: workspace,
    dot: false,
    ignore: ['node_modules/**', '.git/**', '.gemini-agent/**'],
    onlyFiles: true,
    absolute: false,
  });

  // Score and sort by relevance
  const scored = files
    .map(file => ({
      path: file,
      score: fuzzyScore(query, file),
    }))
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return {
    query,
    totalFiles: files.length,
    matchCount: scored.length,
    matches: scored.map(f => ({
      path: f.path,
      score: Math.round(f.score * 100) / 100,
    })),
  };
}
