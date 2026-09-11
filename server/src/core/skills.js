/**
 * Skills: reusable instructions the agent can pull in when they are relevant.
 *
 * One markdown file per skill, with a short frontmatter block naming it and
 * saying when it applies.
 *
 * The search walks *up* from the workspace, the way git finds `.git`, eslint
 * finds its config and editors find `.editorconfig`. That is what makes a
 * monorepo work without configuring anything:
 *
 *     ~/.agent/skills/                  yours, everywhere
 *     /work/.agent/skills/              every repo under /work
 *     /work/base-repo/.agent/skills/      every repo under base-repo
 *     /work/base-repo/api/.agent/skills/  just this repo
 *
 * Nearest wins, so a repo overrides its parent and the parent overrides your
 * personal set — without renaming anything or pointing at directories by hand.
 * `skillFolders` in config.json stays for skills kept outside the tree
 * entirely (a shared git repo of them, say); it is the escape hatch, not the
 * main road.
 *
 * Only the *catalogue* — name and description, a line each — goes into the
 * system prompt. The body is left on disk and the model reads it with the
 * `read_file` tool when it decides the skill applies. That matters here more
 * than in most agents: the prompt is retyped into a browser tab, and a large
 * one trips Gemini's repetition filters (see the prompt economics note in
 * CLAUDE.md), so skills must not grow the prompt in proportion to how many
 * you have written.
 *
 * This replaces the `SkillRegistry` that used to sit unused in `skills/`: that
 * one wanted skills written as JavaScript classes and registered in code,
 * which is both a second way to declare a tool — `mcp/mcp-server.js` already
 * owns that — and something you cannot write without editing the agent.
 */

import fs from 'fs';
import path from 'path';
import * as paths from './paths.js';

/** A filename-safe skill name. Returns '' if nothing usable is left. */
export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Split `---` frontmatter off a skill file.
 *
 * Deliberately not a YAML parser: a skill has two scalar fields, and pulling in
 * a dependency to read them would be the tail wagging the dog.
 *
 * @returns {{ meta: Record<string,string>, body: string }}
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: source.trim() };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: source.slice(match[0].length).trim() };
}

/** The scaffold `/skills new` writes. */
export function skillTemplate(name) {
  return `---
name: ${name}
description: One line on when the agent should read this. This is the only part that is always in the prompt.
---

# ${name}

Replace this with the instructions. Anything here is read only when the agent
decides the description above matches the task, so there is no cost to being
thorough.

## When to use it

## Steps

1.
2.

## Gotchas
`;
}

/**
 * The directories searched, most specific first.
 *
 * @param {string} workspace
 * @param {string[]} [extraFolders] - `skillFolders` from config.json; relative
 *   entries resolve against the workspace, so a repo can commit a path.
 */
export function skillSearchPath(workspace, extraFolders = []) {
  const dirs = [];

  // Up from the workspace to the filesystem root, nearest first. Bounded by
  // path.dirname reaching a fixed point, so a relative or malformed workspace
  // cannot spin here.
  // Note this walks *directories*, so it uses the literal `<dir>/.agent/skills`
  // at each level rather than paths.skillsDir(), which resolves to the shared
  // root and would return the same answer for every step.
  // From the code, not the workspace: with the group open and repo-1 active,
  // repo-1's own skills live under repo-1, and starting at the workspace
  // never saw them.
  let dir = paths.codeDir(workspace);
  for (let i = 0; i < 64; i++) {
    dirs.push(path.join(dir, paths.AGENT_DIR, 'skills'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // The personal set, which is outside any project.
  dirs.push(path.join(paths.homeDir(), 'skills'));

  // Explicitly registered folders come last: they are the escape hatch.
  for (const folder of extraFolders) {
    if (!folder) continue;
    dirs.push(path.isAbsolute(folder) ? folder : path.resolve(workspace, folder));
  }

  return [...new Set(dirs)];
}

/**
 * Every skill visible from this workspace, sorted by name.
 *
 * A name found in an earlier directory shadows a later one, so a project can
 * override a personal skill.
 *
 * @returns {Array<{name, description, file, relative, source}>}
 */
export function listSkills(workspace, extraFolders = []) {
  const byName = new Map();

  for (const dir of skillSearchPath(workspace, extraFolders)) {
    let entries;
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue; // a directory that is not there yet is the normal case
    }

    for (const file of entries) {
      const full = path.join(dir, file);
      let meta = {};
      try {
        ({ meta } = parseFrontmatter(fs.readFileSync(full, 'utf8')));
      } catch {
        continue; // unreadable file: skip it rather than break the prompt
      }
      const name = meta.name || path.basename(file, '.md');
      if (byName.has(name)) continue; // an earlier directory already claimed it

      const relative = path.relative(workspace, full);
      byName.set(name, {
        name,
        description: meta.description || '',
        file: full,
        // Outside the workspace an absolute path is the only one read_file can use.
        relative: relative.startsWith('..') ? full : relative,
        source: dir,
      });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create a skill file. Never overwrites.
 *
 * @param {string} workspace
 * @param {string} rawName
 * @param {{ global?: boolean, dir?: string }} [where] - default is this
 *   workspace; `global` writes to `~/.agent/skills` so every project sees it.
 * @returns {{ ok: boolean, file?: string, name?: string, error?: string }}
 */
export function createSkill(workspace, rawName, where = {}) {
  const name = slugify(rawName);
  if (!name) return { ok: false, error: 'A skill needs a name, e.g. `/skills new code-review`.' };

  const dir = where.dir
    || (where.global ? path.join(paths.homeDir(), 'skills') : paths.skillsDir(workspace));
  const file = path.join(dir, `${name}.md`);
  if (fs.existsSync(file)) return { ok: false, error: `A skill called \`${name}\` already exists.`, file, name };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, skillTemplate(name), 'utf8');
  } catch (err) {
    return { ok: false, error: `Could not write ${file}: ${err.message}` };
  }
  return { ok: true, file, name };
}

/**
 * The block that goes into the system prompt: what exists and where to read it.
 * Empty string when there are no skills, so nothing is spent on the feature
 * until it is used.
 */
export function skillCatalogue(workspace, extraFolders = []) {
  const skills = listSkills(workspace, extraFolders);
  if (skills.length === 0) return '';

  const lines = skills.map((s) => {
    const desc = s.description || '(no description)';
    return `- ${s.name}: ${desc} → read \`${s.relative}\``;
  });

  return [
    'Instructions available on demand. Read the file with `read_file` when the',
    'description matches what you are doing; ignore the rest.',
    ...lines,
  ].join('\n');
}
