/**
 * Path guards the approval path asks before it decides.
 *
 * Lived in `agent-loop.js`, which meant `tool-policy.js` could not ask the
 * question without importing the loop it is called from. A pure path test
 * belongs beside `paths.js`, not inside the turn loop.
 */
import path from 'path';
import * as paths from './paths.js';

/**
 * Is this path one of the agent's own artifacts under `.agent/artifacts/`?
 *
 * Resolved and prefix-checked rather than matched by name, because the model
 * supplies the path: `task.md`, `./task.md`, an absolute path and
 * `../../../etc/task.md` are all the same string test and very different
 * files. `path.relative` answering with a leading `..` is the one reliable
 * way to ask "is this inside that directory".
 */
export function isAgentArtifact(workspace, candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  try {
    const dir = paths.artifactsDir(workspace);
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(workspace, candidate);
    const rel = path.relative(dir, abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false; // unresolvable means "not an artifact", which means "ask"
  }
}
