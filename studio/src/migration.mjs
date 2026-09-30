import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const slash = filename => filename.replaceAll('\\', '/');
const canonical = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;
const inside = (root, filename) => { const rel = path.relative(root, filename); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const text = value => `${JSON.stringify(value, null, 2)}\n`;

function noLinks(filename) {
  const resolved = path.resolve(filename);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接或目录联接：${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolved;
}

function inventory(root) {
  const files = [], directories = [];
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, item.name), relative = slash(path.relative(root, full));
      if (relative === '.ip-system/write.lock') continue;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`源项目含符号链接或目录联接：${relative}`);
      if (stat.isDirectory()) { directories.push(relative); walk(full); }
      else if (stat.isFile()) files.push({ path: relative, size: stat.size, sha256: digest(fs.readFileSync(full)) });
      else throw new Error(`源项目含特殊文件：${relative}`);
    }
  }
  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, directories };
}

function prefixes(registry, source) {
  const mappings = registry.assets.map(entry => ({ from: slash(entry.path), to: `assets/${entry.type}/${entry.asset_id}`, kind: 'asset' }));
  for (const [key, directory] of [['resumes', 'resume'], ['exports', 'export']]) {
    for (const item of registry[key] ?? []) {
      const old = slash(item.path ?? item.output ?? '');
      if (old && fs.existsSync(path.join(source, old))) mappings.push({ from: old, to: `deliveries/${directory}/${path.posix.basename(old)}`, kind: key });
    }
  }
  mappings.push({ from: '.ip-system', to: '.ip-system', kind: 'history' });
  return mappings.sort((a, b) => b.from.length - a.from.length);
}

function mapped(relative, mappings) {
  const found = mappings.find(item => relative === item.from || relative.startsWith(`${item.from}/`));
  if (found) return `${found.to}${relative.slice(found.from.length)}`;
  if (/^00_项目管理\/审核_[^/]+\.json$/u.test(relative)) return `production/review-inputs/${path.posix.basename(relative)}`;
  if (/^06_AI生成记录(?:\/|$)/u.test(relative) || /\.(?:ps1|mjs|cjs|py|bat|cmd)$/i.test(relative) || /^00_项目管理\/正式版整理_/u.test(relative)) return `production/history/${relative}`;
  if (/(?:^|\/)(?:来源材料|原始材料|原始资料|参考原图)(?:\/|$)/u.test(relative) || /(?:^|\/)参考小说[^/]*$/u.test(relative)) return `sources/legacy/${relative}`;
  return `production/legacy/${relative}`;
}

async function preflight({ project, to }, { ownToken } = {}) {
  const errors = [], warnings = [];
  let source, target, registry, listing, mapping, validation;
  try {
    if (!project || !to) throw new Error('迁移必须指定 project 与 to');
    source = noLinks(project); target = noLinks(to);
    if (inside(canonical(source), canonical(target)) || inside(canonical(target), canonical(source))) throw new Error('迁移目标与源项目不能相同或相互包含');
    if (fs.existsSync(target)) throw new Error('迁移目标已存在，拒绝覆盖；请使用新的目标目录');
    if (!fs.statSync(source).isDirectory()) throw new Error('源项目必须为普通目录');
    const lockFile = path.join(source, '.ip-system/write.lock');
    if (fs.existsSync(lockFile) && (!ownToken || json(lockFile).token !== ownToken)) throw new Error('源项目存在活动或未知写入锁；迁移不恢复或删除锁');
    if (fs.existsSync(path.join(source, '.ip-system/pending.json'))) throw new Error('源项目存在待恢复事务；迁移不执行恢复');
    registry = json(path.join(source, 'project.json'));
    if (registry.schema_version !== 1) throw new Error('迁移仅接受 schema_version: 1 的项目');
    const { validateProject } = await import('./project-service.mjs');
    validation = validateProject({ project: source, strict: false });
    if (!validation.ok) throw new Error(`源项目校验失败：${validation.errors.join('；')}`);
    warnings.push(...validation.warnings);
    listing = inventory(source); mapping = prefixes(registry, source);
    const seen = new Map();
    for (const item of listing.files) {
      if (item.path === 'project.json') continue;
      const destination = mapped(item.path, mapping), key = canonical(destination);
      if (seen.has(key)) throw new Error(`迁移文件目标冲突：${seen.get(key)} 与 ${item.path}`);
      seen.set(key, item.path);
    }
  } catch (error) { errors.push(error.message); }
  return { ok: errors.length === 0, action: 'migration-preflight', project: source, to: target, output: target, errors, warnings, mapping, stats: validation?.stats, registry, listing };
}

/** Read-only, including when the source has an interrupted transaction or stale lock. */
export async function migrationPreflight(options) {
  const result = await preflight(options);
  const { registry, listing, ...publicResult } = result;
  return { ...publicResult, files: listing?.files.length ?? 0, source_project_sha256: listing?.files.find(item => item.path === 'project.json')?.sha256 };
}

/** Copy into a new project while preserving every immutable byte and the source tree. */
export async function migrateProject({ project, to }) {
  const initial = await preflight({ project, to });
  if (!initial.ok) { const { registry, listing, ...result } = initial; return { ...result, action: 'migrate' }; }
  const source = initial.project, target = initial.to, token = crypto.randomUUID();
  const lockFile = path.join(source, '.ip-system/write.lock');
  let acquired = false, created = false, recordPath, record;
  try {
    const fd = fs.openSync(lockFile, 'wx');
    try { fs.writeFileSync(fd, text({ pid: process.pid, host: os.hostname(), token, started_at: new Date().toISOString(), action: 'migrate' })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    acquired = true;
    const checked = await preflight({ project: source, to: target }, { ownToken: token });
    if (!checked.ok) throw new Error(checked.errors.join('；'));
    // A second source read under the lock is the baseline, not the unlocked preflight.
    const baseline = checked.listing;
    const migrationId = crypto.randomUUID();
    noLinks(path.dirname(target)); fs.mkdirSync(path.dirname(target), { recursive: true });
    // The final directory creation is exclusive even if another actor raced preflight.
    fs.mkdirSync(target); created = true;
    recordPath = path.join(target, '.ip-system/migrations', migrationId, 'migration.json');
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(path.join(target, '.ip-system/migration-incomplete.json'), text({ migration_id: migrationId, token, record: slash(path.relative(target, recordPath)), from: source, started_at: new Date().toISOString() }), { flag: 'wx' });
    record = { schema_version: 1, migration_id: migrationId, status: 'incomplete', from: source, to: target, started_at: new Date().toISOString(), source_project_sha256: baseline.files.find(item => item.path === 'project.json').sha256, prefix_mappings: checked.mapping, files: [] };
    fs.writeFileSync(recordPath, text(record), { flag: 'wx' });
    for (const name of ['assets', 'sources', 'production', 'deliveries']) fs.mkdirSync(path.join(target, name), { recursive: true });
    for (const directory of baseline.directories) fs.mkdirSync(noLinks(path.join(target, mapped(directory, checked.mapping))), { recursive: true });
    for (const item of baseline.files) {
      if (item.path === 'project.json') continue;
      const destination = mapped(item.path, checked.mapping), full = noLinks(path.join(target, destination));
      if (!inside(target, full)) throw new Error('迁移映射越出目标项目');
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.copyFileSync(path.join(source, item.path), full, fs.constants.COPYFILE_EXCL);
      if (digest(fs.readFileSync(full)) !== item.sha256) throw new Error(`复制校验失败：${item.path}`);
      record.files.push({ from: item.path, to: destination, sha256: item.sha256, size: item.size });
    }
    const registry = structuredClone(checked.registry);
    registry.schema_version = 2;
    for (const entry of registry.assets) entry.path = `assets/${entry.type}/${entry.asset_id}`;
    registry.updated_at = new Date().toISOString();
    registry.migration = { migration_id: migrationId, record: slash(path.relative(target, recordPath)), from_schema_version: 1, migrated_at: registry.updated_at };
    const registryBytes = text(registry);
    fs.writeFileSync(path.join(target, 'project.json'), registryBytes, { flag: 'wx' });
    const { validateMigratingProject } = await import('./project-service.mjs');
    const validation = validateMigratingProject({ project: target, strict: false, migrationToken: token });
    if (!validation.ok) throw new Error(`迁移目标校验失败：${validation.errors.join('；')}`);
    for (const item of record.files) {
      const filename = noLinks(path.join(target, item.to)), stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.size !== item.size || digest(fs.readFileSync(filename)) !== item.sha256) throw new Error(`迁移目标复制后发生变化：${item.to}`);
    }
    if (digest(fs.readFileSync(path.join(target, 'project.json'))) !== digest(registryBytes)) throw new Error('迁移目标 project.json 在校验后发生变化');
    const expectedTargets = new Set([...record.files.map(item => item.to), 'project.json', slash(path.relative(target, recordPath)), '.ip-system/migration-incomplete.json']);
    if (inventory(target).files.some(item => !expectedTargets.has(item.path))) throw new Error('迁移目标出现非本次迁移新增文件');
    if (fs.existsSync(path.join(target, '.ip-system/write.lock')) || fs.existsSync(path.join(target, '.ip-system/pending.json'))) throw new Error('迁移目标出现外部锁或待恢复事务');
    if (json(lockFile).token !== token) throw new Error('迁移期间源项目锁被外部改变');
    if (JSON.stringify(inventory(source)) !== JSON.stringify(baseline)) throw new Error('迁移期间源项目发生变化，目标保留为 incomplete；请核对后使用新的目标目录');
    record.status = 'complete'; record.completed_at = new Date().toISOString(); record.target_project_sha256 = digest(fs.readFileSync(path.join(target, 'project.json')));
    fs.writeFileSync(recordPath, text(record));
    fs.unlinkSync(path.join(target, '.ip-system/migration-incomplete.json'));
    return { ok: true, action: 'migrate', project: source, to: target, output: target, migration: recordPath, errors: [], warnings: validation.warnings, mapping: checked.mapping, stats: validation.stats, files: record.files.length };
  } catch (error) {
    if (created && recordPath && record) { record.status = 'incomplete'; record.failed_at = new Date().toISOString(); record.error = error.message; fs.writeFileSync(recordPath, text(record)); }
    return { ok: false, action: 'migrate', project: source, to: target, output: created ? target : undefined, incomplete: created, migration: recordPath, errors: [error.message], warnings: initial.warnings };
  } finally {
    if (acquired && fs.existsSync(lockFile)) { try { if (json(lockFile).token === token) fs.unlinkSync(lockFile); } catch { /* Preserve any replacement or unreadable lock. */ } }
  }
}
