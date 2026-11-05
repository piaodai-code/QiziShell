const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  classifySkillSource,
  workspaceRelative,
  normalizeSupportPath,
  collectSupportEntries,
  normalizeSkill,
  includeListedSkill,
  buildSkillForest,
  normalizeMemoryFiles,
} = require('../agent-files');

assert.strictEqual(classifySkillSource('openclaw-workspace'), 'private');
assert.strictEqual(classifySkillSource('openclaw-workshop'), 'private');
assert.strictEqual(classifySkillSource('agents-skills-personal'), 'global');
assert.strictEqual(classifySkillSource('openclaw-bundled'), null);

const root = '/Users/example/.openclaw/workspace';
assert.strictEqual(
  workspaceRelative(`${root}/skills/work/web/SKILL.md`, root),
  'skills/work/web/SKILL.md',
);
assert.strictEqual(workspaceRelative(`${root}/../secrets/SKILL.md`, root), null);
assert.strictEqual(workspaceRelative('/Users/example/.agents/skills/pdf/SKILL.md', root), null);

const workspaceSkill = normalizeSkill({
  name: 'web',
  skillKey: 'web',
  source: 'openclaw-workspace',
  filePath: `${root}/skills/work/web/SKILL.md`,
}, root);
const personalSkill = normalizeSkill({
  name: 'pdf',
  skillKey: 'pdf',
  source: 'agents-skills-personal',
  filePath: '/Users/example/.agents/skills/pdf/SKILL.md',
}, root);
const bundled = normalizeSkill({
  name: 'apple-notes',
  skillKey: 'apple-notes',
  source: 'openclaw-bundled',
  filePath: '/opt/openclaw/skills/apple-notes/SKILL.md',
}, root);
assert.strictEqual(workspaceSkill.readable, true);
assert.strictEqual(personalSkill.readable, false);
assert.strictEqual(bundled, null);
const workshopSkill = normalizeSkill({
  name: 'skill-merge',
  skillKey: 'skill-merge',
  source: 'openclaw-workshop',
  filePath: `${root}/agent/workshop-skills/skill-merge/SKILL.md`,
}, root);
assert.strictEqual(workshopSkill.scope, 'private');
assert.strictEqual(includeListedSkill(workshopSkill, 'xiao_dudu'), true);
assert.strictEqual(includeListedSkill(workshopSkill, 'main'), false);
assert.strictEqual(includeListedSkill(workspaceSkill, 'main'), true);
assert.strictEqual(includeListedSkill(personalSkill, 'xiao_dudu'), false);

const forest = buildSkillForest([workspaceSkill, personalSkill]);
assert.strictEqual(forest.private[0].name, 'web');
assert.strictEqual(forest.private[0].skill.name, 'web');
assert.deepStrictEqual(forest.private[0].children, []);
assert.strictEqual(forest.global[0].name, 'pdf');
assert.strictEqual(forest.global[0].skill.name, 'pdf');

const flat = buildSkillForest([workshopSkill, workspaceSkill]);
assert.deepStrictEqual(flat.private.map((node) => node.name).sort(), ['skill-merge', 'web']);
assert.ok(flat.private.every((node) => node.skill && !node.name.includes('/')));

assert.strictEqual(normalizeSupportPath('references/notes.md'), 'references/notes.md');
assert.strictEqual(normalizeSupportPath('reference/notes.md'), 'reference/notes.md');
assert.strictEqual(normalizeSupportPath('scripts/run.py'), 'scripts/run.py');
assert.strictEqual(normalizeSupportPath('checklist.md'), 'checklist.md');
assert.strictEqual(normalizeSupportPath('SKILL.md'), null);
assert.strictEqual(normalizeSupportPath('../SKILL.md'), null);
assert.strictEqual(normalizeSupportPath('scripts/../../etc/passwd'), null);
assert.strictEqual(normalizeSupportPath('notes/secret.md'), null);
assert.strictEqual(normalizeSupportPath('references/pic.png'), null);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qizi-skill-'));
fs.mkdirSync(path.join(scratch, 'references'));
fs.mkdirSync(path.join(scratch, 'scripts'));
fs.mkdirSync(path.join(scratch, 'node_modules'));
fs.writeFileSync(path.join(scratch, 'SKILL.md'), '# skill\n');
fs.writeFileSync(path.join(scratch, 'checklist.md'), '# list\n');
fs.writeFileSync(path.join(scratch, 'references', 'notes.md'), '# notes\n');
fs.writeFileSync(path.join(scratch, 'scripts', 'run.py'), 'print(1)\n');
fs.writeFileSync(path.join(scratch, 'node_modules', 'skip.js'), 'nope\n');
fs.writeFileSync(path.join(scratch, 'LICENSE.txt'), 'nope\n');
assert.deepStrictEqual(
  collectSupportEntries(scratch).map((file) => file.relativePath),
  ['checklist.md', 'references/notes.md', 'scripts/run.py'],
);
fs.rmSync(scratch, { recursive: true, force: true });

const withSupport = buildSkillForest([workspaceSkill], () => [
  { relativePath: 'references/notes.md' },
  { relativePath: '../secret.md' },
  { relativePath: 'scripts/run.py' },
  { relativePath: 'checklist.md' },
]);
const webNode = withSupport.private[0];
assert.strictEqual(webNode.type, 'folder');
assert.strictEqual(webNode.skill.name, 'web');
assert.strictEqual(webNode.skill.supportPath, '');
const notes = webNode.children.find((child) => child.name === 'references').children[0].skill;
assert.strictEqual(notes.supportPath, 'references/notes.md');
assert.strictEqual(notes.skillKey, 'web');
assert.strictEqual(notes.displayPath, 'skills/work/web/references/notes.md');
assert.ok(webNode.children.some((child) => child.name === 'scripts'));
assert.ok(webNode.children.some((child) => child.skill?.supportPath === 'checklist.md'));

const memories = normalizeMemoryFiles([
  { name: 'USER.md', missing: false },
  { name: 'AGENTS.md', missing: true },
  { name: 'SOUL.md', missing: false },
]);
assert.deepStrictEqual(memories.map((file) => file.name), [
  'IDENTITY.md', 'AGENTS.md', 'SOUL.md', 'MEMORY.md', 'USER.md',
]);
assert.strictEqual(memories[1].missing, true);
assert.strictEqual(memories[0].missing, null);
assert.strictEqual(memories.find((file) => file.name === 'SOUL.md').missing, false);

console.log('agent-files smoke ok');
