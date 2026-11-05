/**
 * 当前 Agent 的记忆文件和技能清单。
 * 记忆文件走 agents.files.get / agents.files.set。
 * 工作区里的技能走 agents.workspace.get 读取。
 * 启孜不列出 agent/workshop-skills。其他 Agent 的工坊技能走 skill_workshop write_file 写回。
 * 工作区 skills/ 和启孜的全局技能，在这台电脑挂载了网关磁盘时直接读写 SKILL.md。
 * 技能目录里的 references、scripts 等辅助 Markdown 和脚本，挂在技能下面，同样只在该目录内读写。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MEMORY_FILES = [
  { name: 'IDENTITY.md', label: 'IDENTITY.md' },
  { name: 'AGENTS.md', label: 'AGENTS.md' },
  { name: 'SOUL.md', label: 'SOUL.md' },
  { name: 'MEMORY.md', label: 'MEMORY.md' },
  { name: 'USER.md', label: 'USER.md' },
];

const MEMORY_NAMES = new Set(MEMORY_FILES.map((file) => file.name));
const PRIVATE_SOURCES = new Set([
  'openclaw-workspace',
  'agents-skills-project',
  'openclaw-workshop',
]);
const GLOBAL_SOURCES = new Set(['openclaw-managed', 'agents-skills-personal', 'openclaw-extra']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SUPPORT_DIRS = new Set(['references', 'reference', 'scripts', 'script', 'templates', 'assets']);
const SUPPORT_EXT = new Set(['.md', '.markdown', '.js', '.mjs', '.cjs', '.py', '.sh', '.bash', '.ts', '.tsx', '.jsx']);
const SUPPORT_SKIP = new Set(['node_modules', '__pycache__']);

function classifySkillSource(source) {
  if (PRIVATE_SOURCES.has(source)) return 'private';
  if (GLOBAL_SOURCES.has(source)) return 'global';
  return null;
}

function workspaceRelative(filePath, workspaceDir) {
  const file = String(filePath || '');
  const root = String(workspaceDir || '').replace(/\/+$/, '');
  if (!file || !root || !file.startsWith(`${root}/`)) return null;
  const rel = file.slice(root.length + 1);
  if (!rel || rel.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return rel;
}

function resolveMountedSkillFile(filePath) {
  const remote = String(filePath || '').replaceAll('\\', '/');
  if (!remote.startsWith('/') || !remote.endsWith('/SKILL.md') || remote.includes('//')) return null;
  const parts = remote.split('/').slice(1);
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  const candidates = [remote];
  try {
    for (const volume of fs.readdirSync('/Volumes')) {
      if (!volume || volume.startsWith('.')) continue;
      candidates.push(`/Volumes/${volume}${remote}`);
    }
  } catch {
    // 没有挂载其他磁盘时，只试网关给出的原路径。
  }
  for (const candidate of candidates) {
    let real;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    const realPosix = real.replaceAll('\\', '/');
    if (realPosix !== remote && !realPosix.endsWith(remote)) continue;
    return real;
  }
  return null;
}

function displaySkillPath(filePath) {
  const file = String(filePath || '').replaceAll('\\', '/');
  const mark = '/skills/';
  const index = file.lastIndexOf(mark);
  if (index >= 0) return file.slice(index + 1);
  const parts = file.split('/').filter(Boolean);
  return parts.slice(-3).join('/');
}

function isSupportDir(name) {
  return SUPPORT_DIRS.has(String(name || '').toLowerCase());
}

function normalizeSupportPath(value) {
  if (value == null || value === '') return '';
  const rel = String(value).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!rel || rel.includes('//')) return null;
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  if (parts.length > 7) return null;
  if (parts.length === 1 && parts[0].toLowerCase() === 'skill.md') return null;
  const ext = path.posix.extname(parts[parts.length - 1]).toLowerCase();
  if (!SUPPORT_EXT.has(ext)) return null;
  if (parts.length > 1 && !isSupportDir(parts[0])) return null;
  return parts.join('/');
}

function supportDisplayPath(skill, supportPath) {
  const base = String(skill?.displayPath || '').replace(/\/SKILL\.md$/i, '');
  return `${base}/${supportPath}`;
}

function collectSupportEntries(skillDir) {
  const found = [];
  function walk(dir, relParts, inside) {
    if (relParts.length > 6 || found.length >= 200) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (found.length >= 200) return;
      const name = ent.name;
      if (!name || name.startsWith('.') || SUPPORT_SKIP.has(name)) continue;
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, name);
      if (ent.isDirectory()) {
        if (!inside && !isSupportDir(name)) continue;
        walk(abs, [...relParts, name], true);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!inside && name.toLowerCase() === 'skill.md') continue;
      if (!SUPPORT_EXT.has(path.extname(name).toLowerCase())) continue;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      found.push({ relativePath: [...relParts, name].join('/') });
    }
  }
  walk(skillDir, [], false);
  found.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh'));
  return found;
}

function listSkillSupport(skill) {
  const local = resolveMountedSkillFile(skill?.filePath);
  if (!local) return [];
  return collectSupportEntries(path.dirname(local));
}

function resolveMountedSupportFile(skillFilePath, supportPath) {
  const rel = normalizeSupportPath(supportPath);
  if (!rel) return null;
  const skillFile = resolveMountedSkillFile(skillFilePath);
  if (!skillFile) return null;
  const skillDir = path.dirname(skillFile);
  let realDir;
  try {
    realDir = fs.realpathSync(skillDir);
  } catch {
    return null;
  }
  const target = path.resolve(skillDir, ...rel.split('/'));
  let listed;
  try {
    listed = fs.lstatSync(target);
  } catch {
    return null;
  }
  if (listed.isSymbolicLink() || !listed.isFile()) return null;
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return null;
  }
  const root = realDir.replaceAll('\\', '/');
  const file = realTarget.replaceAll('\\', '/');
  if (file !== root && !file.startsWith(`${root}/`)) return null;
  return realTarget;
}

function skillTreeKey(skill) {
  return String(skill?.skillKey || skill?.name || 'SKILL.md');
}

function isWorkshopSkill(skill) {
  const source = String(skill?.source || '');
  const filePath = String(skill?.filePath || skill?.displayPath || '').replaceAll('\\', '/');
  return source === 'openclaw-workshop' || filePath.includes('/workshop-skills/');
}

function includeListedSkill(skill, agentId) {
  if (!skill) return false;
  if (agentId !== 'main' && skill.scope === 'global') return false;
  if (agentId === 'main' && isWorkshopSkill(skill)) return false;
  return true;
}

function normalizeSkill(raw, workspaceDir) {
  const source = String(raw?.source || '');
  const scope = classifySkillSource(source);
  if (!scope) return null;
  const name = String(raw?.name || raw?.skillKey || '').trim();
  const skillKey = String(raw?.skillKey || name).trim();
  if (!name || !skillKey) return null;
  const filePath = String(raw?.filePath || '');
  const relativePath = workspaceRelative(filePath, workspaceDir);
  const mountedPath = scope === 'global' ? resolveMountedSkillFile(filePath) : null;
  const readable = Boolean(
    mountedPath
    || (relativePath && (relativePath === 'SKILL.md' || relativePath.endsWith('/SKILL.md'))),
  );
  return {
    kind: 'skill',
    scope,
    source,
    name,
    skillKey,
    readable,
    displayPath: readable ? (relativePath || displaySkillPath(filePath)) : displaySkillPath(filePath),
    filePath,
  };
}

function insertSkill(root, skill) {
  const key = skillTreeKey(skill);
  if (!root.children.has(key)) {
    root.children.set(key, {
      type: 'file',
      name: skill.name,
      children: new Map(),
      skill,
    });
  }
  const node = root.children.get(key);
  node.skill = skill;
  node.name = skill.name;
  node.type = node.children.size ? 'folder' : 'file';
}

function findSkillNode(root, skill) {
  return root?.children?.get(skillTreeKey(skill)) || null;
}

function attachSupportFiles(root, skill, files) {
  const node = findSkillNode(root, skill);
  if (!node || !Array.isArray(files) || !files.length) return;
  for (const file of files) {
    const rel = normalizeSupportPath(file?.relativePath);
    if (!rel) continue;
    const segs = rel.split('/');
    let cursor = node;
    segs.forEach((seg, index) => {
      const leaf = index === segs.length - 1;
      if (!cursor.children.has(seg)) {
        cursor.children.set(seg, {
          type: leaf ? 'file' : 'folder',
          name: seg,
          children: new Map(),
          skill: null,
        });
      }
      const next = cursor.children.get(seg);
      if (leaf) {
        next.type = next.children.size ? 'folder' : 'file';
        next.name = seg;
        next.skill = {
          ...skill,
          name: seg,
          supportPath: rel,
          displayPath: supportDisplayPath(skill, rel),
          readable: true,
        };
      }
      cursor = next;
    });
  }
  if (node.children.size) node.type = 'folder';
}

function treeFromMap(node, atRoot = false) {
  const children = [...node.children.values()]
    .map((child) => ({
      type: child.skill && child.children.size === 0 ? 'file' : (child.children.size ? 'folder' : 'file'),
      name: child.name,
      skill: child.skill
        ? {
          kind: 'skill',
          scope: child.skill.scope,
          source: child.skill.source,
          name: child.skill.name,
          skillKey: child.skill.skillKey,
          readable: child.skill.readable,
          displayPath: child.skill.displayPath,
          filePath: child.skill.filePath,
          supportPath: child.skill.supportPath || '',
        }
        : null,
      children: treeFromMap(child, false),
    }))
    .sort((a, b) => {
      if (!atRoot && a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });
  return children;
}

function buildSkillForest(skills, listSupport = listSkillSupport) {
  const buckets = { global: { children: new Map() }, private: { children: new Map() } };
  for (const skill of skills) {
    if (!buckets[skill.scope]) continue;
    insertSkill(buckets[skill.scope], skill);
    const extra = typeof listSupport === 'function' ? listSupport(skill) : [];
    attachSupportFiles(buckets[skill.scope], skill, extra);
  }
  return {
    global: treeFromMap(buckets.global, true),
    private: treeFromMap(buckets.private, true),
  };
}

function normalizeMemoryFiles(listed) {
  const byName = new Map((listed || []).map((file) => [file?.name, file]));
  return MEMORY_FILES.map((file) => ({
    kind: 'memory',
    name: file.name,
    label: file.label,
    missing: file.name === 'IDENTITY.md' ? null : Boolean(byName.get(file.name)?.missing),
  }));
}

function isUnexpectedProperty(err) {
  return /unexpected property/i.test(String(err?.message || ''));
}

function isConflict(err) {
  return err?.details?.type === 'agent_file_conflict'
    || /changed since it was read/i.test(String(err?.message || ''));
}

function assertAgentId(agentId) {
  const id = String(agentId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    const error = new Error('未指定 Agent');
    error.clientError = true;
    throw error;
  }
  return id;
}

function assertContent(content) {
  if (typeof content !== 'string') {
    const error = new Error('没有可保存的内容');
    error.clientError = true;
    throw error;
  }
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
    const error = new Error('文件超过 2 MB，没有写入');
    error.clientError = true;
    throw error;
  }
  return content;
}

async function listAgentFileCatalog(request, agentId) {
  const id = assertAgentId(agentId);
  const [files, status] = await Promise.all([
    request('agents.files.list', { agentId: id }),
    request('skills.status', { agentId: id }),
  ]);
  const workspace = String(files?.workspace || status?.workspaceDir || '');
  const showGlobalSkills = id === 'main';
  const skills = (Array.isArray(status?.skills) ? status.skills : [])
    .map((skill) => normalizeSkill(skill, workspace))
    .filter((skill) => includeListedSkill(skill, id));
  return {
    ok: true,
    agentId: id,
    showGlobalSkills,
    memories: normalizeMemoryFiles(files?.files),
    skills: buildSkillForest(skills),
  };
}

function findSkill(forest, source, skillKey) {
  const scope = classifySkillSource(source);
  if (!scope) return null;
  const stack = [...(forest[scope] || [])];
  while (stack.length) {
    const node = stack.pop();
    if (
      node?.skill?.skillKey === skillKey
      && node.skill.source === source
      && !node.skill.supportPath
    ) return node.skill;
    if (Array.isArray(node?.children)) stack.push(...node.children);
  }
  return null;
}

async function resolveSkill(request, agentId, source, skillKey) {
  const catalog = await listAgentFileCatalog(request, agentId);
  const skill = findSkill(catalog.skills, source, skillKey);
  if (!skill) {
    const error = new Error('没有找到这个技能');
    error.clientError = true;
    throw error;
  }
  return skill;
}

async function readAgentFile(request, payload) {
  const agentId = assertAgentId(payload?.agentId);
  if (payload?.kind === 'memory') {
    const name = String(payload.name || '');
    if (!MEMORY_NAMES.has(name)) {
      return { ok: false, error: '这个文件不在记忆清单里' };
    }
    const result = await request('agents.files.get', { agentId, name });
    const file = result?.file || {};
    return {
      ok: true,
      kind: 'memory',
      name,
      missing: file.missing === true,
      content: file.missing ? '' : String(file.content || ''),
      hash: file.hash || null,
      writable: true,
    };
  }
  if (payload?.kind === 'skill') {
    const skill = await resolveSkill(request, agentId, payload.source, payload.skillKey);
    if (payload.supportPath) {
      const supportPath = normalizeSupportPath(payload.supportPath);
      if (!supportPath) return { ok: false, error: '这个辅助文件不在技能目录里。' };
      return readSupportFile(agentId, skill, supportPath);
    }
    if (skill.scope === 'global') return readGlobalSkill(agentId, skill);
    if (!skill.readable) {
      return {
        ok: false,
        error: '这个技能不在当前 Agent 的工作区里，网关不允许从这里读取。',
      };
    }
    const result = await request('agents.workspace.get', { agentId, path: skill.displayPath });
    const file = result?.file || {};
    return {
      ok: true,
      kind: 'skill',
      name: skill.name,
      skillKey: skill.skillKey,
      source: skill.source,
      scope: skill.scope,
      displayPath: skill.displayPath,
      missing: false,
      content: String(file.content || ''),
      hash: sha256(String(file.content || '')),
      writable: skill.source === 'openclaw-workshop' || Boolean(resolveMountedSkillFile(skill.filePath)),
    };
  }
  return { ok: false, error: '未知文件' };
}

function readSupportFile(agentId, skill, supportPath) {
  if (skill.scope === 'global' && agentId !== 'main') {
    return { ok: false, error: '全局技能只在启孜这里查看和修改。' };
  }
  const local = resolveMountedSupportFile(skill.filePath, supportPath);
  if (!local) return { ok: false, error: '这台电脑上看不到这个辅助文件，没法打开。' };
  const stat = fs.statSync(local);
  if (stat.size > MAX_FILE_BYTES) return { ok: false, error: '文件超过 2 MB，没有打开。' };
  const content = fs.readFileSync(local, 'utf8');
  return {
    ok: true,
    kind: 'skill',
    name: path.basename(supportPath),
    skillKey: skill.skillKey,
    source: skill.source,
    scope: skill.scope,
    supportPath,
    displayPath: supportDisplayPath(skill, supportPath),
    missing: false,
    content,
    hash: sha256(content),
    writable: true,
  };
}

function readGlobalSkill(agentId, skill) {
  if (agentId !== 'main') return { ok: false, error: '全局技能只在启孜这里查看和修改。' };
  const local = resolveMountedSkillFile(skill.filePath);
  if (!local) return { ok: false, error: '这台电脑上看不到这份全局技能文件，没法打开。' };
  const stat = fs.statSync(local);
  if (stat.size > MAX_FILE_BYTES) return { ok: false, error: '文件超过 2 MB，没有打开。' };
  const content = fs.readFileSync(local, 'utf8');
  return {
    ok: true,
    kind: 'skill',
    name: skill.name,
    skillKey: skill.skillKey,
    source: skill.source,
    scope: skill.scope,
    displayPath: skill.displayPath,
    missing: false,
    content,
    hash: sha256(content),
    writable: true,
  };
}

function backupFile(backupDir, agentId, name, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeAgent = agentId.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(backupDir, safeAgent, safeName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${stamp}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function toolFailure(result) {
  const error = result?.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  return '技能没有写回';
}

async function mainSessionKey(request, agentId) {
  try {
    const listed = await request('sessions.list', { limit: 200 });
    const want = `agent:${agentId}:main`;
    const found = (listed?.sessions || []).find((session) => session?.key === want);
    return found?.key || null;
  } catch {
    return null;
  }
}

function saveMountedSkillFile(agentId, skill, content, payload, backupDir, missingMessage) {
  const local = resolveMountedSkillFile(skill.filePath);
  if (!local) return { ok: false, error: missingMessage };
  const previous = fs.readFileSync(local, 'utf8');
  const currentHash = sha256(previous);
  if (payload.hash && payload.hash !== currentHash) {
    return { ok: false, error: '服务器上的技能已经变了，没有覆盖。请重新打开这个技能。', conflict: true };
  }
  let backupPath = null;
  if (previous && backupDir) backupPath = backupFile(backupDir, agentId, skill.skillKey || skill.name, previous);
  fs.writeFileSync(local, content, 'utf8');
  return {
    ok: true,
    name: skill.name,
    hash: sha256(content),
    backupName: backupPath ? path.basename(backupPath) : null,
  };
}

async function saveMountedSupportFile(agentId, skill, supportPath, content, payload, backupDir) {
  if (skill.scope === 'global' && agentId !== 'main') {
    return { ok: false, error: '全局技能只在启孜这里修改。' };
  }
  const local = resolveMountedSupportFile(skill.filePath, supportPath);
  if (!local) return { ok: false, error: '这台电脑上看不到这个辅助文件，没有写入。' };
  const previous = fs.readFileSync(local, 'utf8');
  const currentHash = sha256(previous);
  if (payload.hash && payload.hash !== currentHash) {
    return { ok: false, error: '服务器上的文件已经变了，没有覆盖。请重新打开这个文件。', conflict: true };
  }
  let backupPath = null;
  const backupName = `${skill.skillKey || skill.name}__${supportPath.replaceAll('/', '__')}`;
  if (previous && backupDir) backupPath = backupFile(backupDir, agentId, backupName, previous);
  fs.writeFileSync(local, content, 'utf8');
  return {
    ok: true,
    name: path.basename(supportPath),
    hash: sha256(content),
    backupName: backupPath ? path.basename(backupPath) : null,
  };
}

function saveGlobalSkill(agentId, skill, content, payload, backupDir) {
  if (agentId !== 'main' || skill.scope !== 'global') {
    return { ok: false, error: '全局技能只在启孜这里修改。' };
  }
  return saveMountedSkillFile(agentId, skill, content, payload, backupDir, '这台电脑上看不到这份全局技能文件，没有写入。');
}

async function saveWorkshopSkill(request, agentId, payload, content, backupDir) {
  const skill = await resolveSkill(request, agentId, payload.source, payload.skillKey);
  if (skill.source !== 'openclaw-workshop' || !skill.readable) {
    return {
      ok: false,
      error: '这个技能不在当前 Agent 的技能工坊里。网关只允许写回 agent/workshop-skills 里的技能。',
    };
  }
  const current = await request('agents.workspace.get', { agentId, path: skill.displayPath });
  const previous = String(current?.file?.content || '');
  const currentHash = sha256(previous);
  const loadedHash = payload.hash || null;
  if (loadedHash && loadedHash !== currentHash) {
    return { ok: false, error: '服务器上的技能已经变了，没有覆盖。请重新打开这个技能。', conflict: true };
  }
  let backupPath = null;
  if (previous && backupDir) backupPath = backupFile(backupDir, agentId, skill.skillKey || skill.name, previous);
  const sessionKey = await mainSessionKey(request, agentId);
  const params = {
    name: 'skill_workshop',
    agentId,
    args: {
      action: 'write_file',
      name: skill.skillKey || skill.name,
      file_path: 'SKILL.md',
      content,
      reason: '从 QiziShell 保存',
    },
  };
  if (sessionKey) params.sessionKey = sessionKey;
  const result = await request('tools.invoke', params);
  if (!result?.ok) return { ok: false, error: toolFailure(result) };
  return {
    ok: true,
    name: skill.name,
    hash: sha256(content),
    backupName: backupPath ? path.basename(backupPath) : null,
  };
}

async function saveAgentFile(request, payload, backupDir) {
  const agentId = assertAgentId(payload?.agentId);
  const content = assertContent(payload?.content);
  if (payload?.kind === 'skill') {
    const skill = await resolveSkill(request, agentId, payload.source, payload.skillKey);
    if (payload.supportPath) {
      const supportPath = normalizeSupportPath(payload.supportPath);
      if (!supportPath) return { ok: false, error: '这个辅助文件不在技能目录里。' };
      return saveMountedSupportFile(agentId, skill, supportPath, content, payload, backupDir);
    }
    if (skill.scope === 'global') return saveGlobalSkill(agentId, skill, content, payload, backupDir);
    if (skill.source === 'openclaw-workshop') return saveWorkshopSkill(request, agentId, payload, content, backupDir);
    return saveMountedSkillFile(agentId, skill, content, payload, backupDir, '这台电脑上看不到这份私人技能文件，没有写入。');
  }
  if (payload?.kind !== 'memory') return { ok: false, error: '未知文件' };
  const name = String(payload.name || '');
  if (!MEMORY_NAMES.has(name)) return { ok: false, error: '这个文件不在记忆清单里' };

  const current = await request('agents.files.get', { agentId, name });
  const file = current?.file || {};
  const missing = file.missing === true;
  const currentHash = file.hash || null;
  const loadedHash = payload.hash || null;
  if (!missing && loadedHash && currentHash && loadedHash !== currentHash) {
    return { ok: false, error: '服务器上的文件已经变了，没有覆盖。请重新打开这个文件。', conflict: true };
  }

  let backupPath = null;
  if (!missing && typeof file.content === 'string' && backupDir) {
    backupPath = backupFile(backupDir, agentId, name, file.content);
  }

  const params = { agentId, name, content };
  if (!missing && currentHash) params.expectedHash = currentHash;
  if (missing) params.expectedMissing = true;
  if (current?.workspace) params.expectedWorkspace = current.workspace;

  let saved;
  try {
    saved = await request('agents.files.set', params);
  } catch (err) {
    if (isConflict(err)) {
      return { ok: false, error: '服务器上的文件已经变了，没有覆盖。请重新打开这个文件。', conflict: true };
    }
    if (isUnexpectedProperty(err)) {
      saved = await request('agents.files.set', { agentId, name, content });
    } else {
      throw err;
    }
  }
  return {
    ok: true,
    name,
    hash: saved?.file?.hash || null,
    backupName: backupPath ? path.basename(backupPath) : null,
  };
}

module.exports = {
  MEMORY_FILES,
  classifySkillSource,
  workspaceRelative,
  normalizeSupportPath,
  collectSupportEntries,
  normalizeSkill,
  includeListedSkill,
  buildSkillForest,
  normalizeMemoryFiles,
  listAgentFileCatalog,
  readAgentFile,
  saveAgentFile,
};
