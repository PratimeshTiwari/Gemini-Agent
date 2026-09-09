import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  slugify, parseFrontmatter, listSkills, createSkill, skillCatalogue, skillTemplate,
} from './skills.js';

const freshWorkspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));

test('slugify', async (t) => {
  await t.test('makes a filename out of whatever the user typed', () => {
    assert.equal(slugify('Code Review'), 'code-review');
    assert.equal(slugify('  PR   triage!! '), 'pr-triage');
    assert.equal(slugify('release/deploy'), 'release-deploy');
  });

  await t.test('returns empty when nothing usable is left, so callers can refuse', () => {
    assert.equal(slugify('!!!'), '');
    assert.equal(slugify(''), '');
    assert.equal(slugify(undefined), '');
  });
});

test('parseFrontmatter', async (t) => {
  await t.test('reads the two fields a skill declares', () => {
    const { meta, body } = parseFrontmatter('---\nname: triage\ndescription: Sort issues\n---\n\nBody here.');
    assert.equal(meta.name, 'triage');
    assert.equal(meta.description, 'Sort issues');
    assert.equal(body, 'Body here.');
  });

  await t.test('strips quotes around a value', () => {
    const { meta } = parseFrontmatter('---\nname: "quoted"\n---\nx');
    assert.equal(meta.name, 'quoted');
  });

  await t.test('treats a file with no frontmatter as all body', () => {
    const { meta, body } = parseFrontmatter('just instructions');
    assert.deepEqual(meta, {});
    assert.equal(body, 'just instructions');
  });
});

test('createSkill', async (t) => {
  await t.test('writes a scaffold and reports where', () => {
    const ws = freshWorkspace();
    const r = createSkill(ws, 'Code Review');
    assert.equal(r.ok, true);
    assert.equal(r.name, 'code-review');
    assert.ok(fs.existsSync(r.file));
    assert.match(fs.readFileSync(r.file, 'utf8'), /^---\nname: code-review\n/);
  });

  await t.test('never overwrites an existing skill', () => {
    const ws = freshWorkspace();
    createSkill(ws, 'dup');
    fs.writeFileSync(path.join(ws, '.agent/skills/dup.md'), 'MY WORK');
    const again = createSkill(ws, 'dup');
    assert.equal(again.ok, false);
    assert.match(again.error, /already exists/);
    assert.equal(fs.readFileSync(path.join(ws, '.agent/skills/dup.md'), 'utf8'), 'MY WORK');
  });

  await t.test('refuses a name that slugifies to nothing', () => {
    const r = createSkill(freshWorkspace(), '???');
    assert.equal(r.ok, false);
    assert.match(r.error, /needs a name/);
  });
});

test('listSkills', async (t) => {
  await t.test('is empty, not an error, before any skill exists', () => {
    assert.deepEqual(listSkills(freshWorkspace()), []);
  });

  await t.test('reads name and description off each file, sorted', () => {
    const ws = freshWorkspace();
    fs.mkdirSync(path.join(ws, '.agent/skills'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agent/skills/zebra.md'), '---\nname: zebra\ndescription: last\n---\nbody');
    fs.writeFileSync(path.join(ws, '.agent/skills/alpha.md'), '---\nname: alpha\ndescription: first\n---\nbody');
    const skills = listSkills(ws);
    assert.deepEqual(skills.map((s) => s.name), ['alpha', 'zebra']);
    assert.equal(skills[0].description, 'first');
    assert.equal(skills[0].relative, path.join('.agent', 'skills', 'alpha.md'));
  });

  await t.test('falls back to the filename when frontmatter is missing', () => {
    const ws = freshWorkspace();
    fs.mkdirSync(path.join(ws, '.agent/skills'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agent/skills/bare.md'), 'no frontmatter at all');
    const [skill] = listSkills(ws);
    assert.equal(skill.name, 'bare');
    assert.equal(skill.description, '');
  });

  await t.test('ignores non-markdown files', () => {
    const ws = freshWorkspace();
    fs.mkdirSync(path.join(ws, '.agent/skills'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agent/skills/notes.txt'), 'ignore me');
    assert.deepEqual(listSkills(ws), []);
  });
});

test('skillCatalogue', async (t) => {
  await t.test('costs nothing until a skill exists', () => {
    // The catalogue is part of the system prompt, which is retyped into a
    // browser tab — an unused feature must not add a single line to it.
    assert.equal(skillCatalogue(freshWorkspace()), '');
  });

  await t.test('lists the description and the path, never the body', () => {
    const ws = freshWorkspace();
    fs.mkdirSync(path.join(ws, '.agent/skills'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, '.agent/skills/deploy.md'),
      '---\nname: deploy\ndescription: Shipping to prod\n---\nSECRET BODY THAT MUST NOT BE IN THE PROMPT',
    );
    const cat = skillCatalogue(ws);
    assert.match(cat, /deploy: Shipping to prod/);
    assert.match(cat, /\.agent\/skills\/deploy\.md/);
    assert.ok(!cat.includes('SECRET BODY'), 'the body must stay on disk');
  });

  await t.test('the scaffold it writes round-trips through the parser', () => {
    const { meta } = parseFrontmatter(skillTemplate('round-trip'));
    assert.equal(meta.name, 'round-trip');
    assert.ok(meta.description.length > 0);
  });
});
