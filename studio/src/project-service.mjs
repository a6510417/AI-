import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIRECTORIES, CHAPTER_FILES, TYPES, SYSTEM, filled, object, VERSION, fail, hash, now, jsonText, referenceKey, createAssetSkeleton, normalizeReviewRecord, normalizeReviewDisposition } from './rules.mjs';
import { safePath, readJSON, writeSynced, atomicJSON, fingerprint, compareFiles } from './storage.mjs';
import { workingPath, layoutFor, assetDirectory, outputPath } from './layout.mjs';
import { readProject, registryErrors, readSnapshot, findEntry, operation } from './registry.mjs';
import { inspectAsset } from './asset-validation.mjs';
import { wasAdopted, ensureNoErrors, staleReviews, exportClosure, scopeSelection, playbackProjection } from './dependencies.mjs';
import { withLock, transactionBase, commit, pendingStatus } from './transactions.mjs';
import { reviewRecord, reviewForSnapshot } from './reviews.mjs';
import { copySnapshot, handoffMarkdown, dataMarkdown } from './output.mjs';
import { renderPackageLinks } from './links.mjs';
export { DIRECTORIES, CHAPTER_FILES, TYPES, safePath };
function renderStagedViews(root, project, staged, indexName, warnings, enabled = project.schema_version === 2) {
  if (!enabled) return;
  const transactionToken = readJSON(safePath(root, `${SYSTEM}/write.lock`)).token;
  const result = renderPackageLinks({ project: root, output: staged, transactionToken });
  ensureNoErrors(result.errors ?? []);
  warnings.push(...(result.warnings ?? []).filter(warning => !warnings.includes(warning)));
  const filename = path.join(staged, indexName), index = readJSON(filename);
  index.warnings = [...warnings];
  atomicJSON(filename, index);
}
export function initProject({ root = 'projects', id, name, schemaVersion = 2 }) {
  const profile = layoutFor(schemaVersion);
  if (!/^IP\d+$/.test(id ?? '')) fail('项目 ID 必须为 IP 加数字，例如 IP003');
  if (!filled(name) || /[<>:"/\\|?*\x00-\x1F]/.test(name) || /[ .]$/.test(name) || name.length > 80) fail('项目名称不能为空，不可含路径或 Windows 文件名非法字符，且不超过 80 字符');
  root = path.resolve(root);
  fs.mkdirSync(root, { recursive: true });
  const basename = `${id}_${name}`;
  const target = safePath(root, basename);
  if (fs.existsSync(target)) fail(`项目已存在，拒绝覆盖：${target}`);
  if (fs.readdirSync(root).some(item => item.startsWith(`${id}_`))) fail(`项目 ID ${id} 已在目标根目录使用，请选择新的项目 ID`);
  const staging = safePath(root, `.init-${crypto.randomUUID()}`);
  fs.mkdirSync(staging);
  try {
    for (const directory of profile.directories) fs.mkdirSync(path.join(staging, directory));
    fs.mkdirSync(path.join(staging, SYSTEM));
    const project = { schema_version: profile.schemaVersion, project_id: id, name, created_at: now(), updated_at: now(), assets: [], adoption_history: [], review_items: [], exports: [], operations: [] };
    operation(project, 'init', { project_id: id, name });
    writeSynced(path.join(staging, 'project.json'), jsonText(project));
    const templateDirectory = safePath(staging, profile.templatePath);
    fs.mkdirSync(templateDirectory, { recursive: true });
    const skeleton = createAssetSkeleton({ projectId: id, type: 'CH', sequence: 1 });
    writeSynced(path.join(templateDirectory, 'asset.json'), jsonText(skeleton.asset));
    for (const [filename, content] of Object.entries(skeleton.files)) writeSynced(path.join(templateDirectory, filename), content);
    writeSynced(path.join(templateDirectory, '使用说明.md'), '# 空白模板\n\n这些文件不是已登记资产，与“新建章节”使用相同骨架。优先使用 new-asset 创建并登记章节；也可复制本目录到小说资产目录，填写全部内容后通过 save-version --path 登记。复制时同步元数据及配套文件的项目、章节编号和版本，避免与已登记资产重号。七个章节文件必须同时存在；没有新增设定时 candidates 可保留空数组。\n');
    if (fs.existsSync(target)) fail('项目在创建期间已被其他操作建立，拒绝覆盖');
    fs.renameSync(staging, target);
    return { ok: true, action: 'init', project: target, message: `项目已创建，空白模板位于 ${profile.templatePath}；尚无已采用资产。` };
  } catch (error) {
    // Only our freshly created, verified staging directory is removed.
    if (path.dirname(staging) === root && path.basename(staging).startsWith('.init-')) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function validateProjectInternal({ project: root, strict = false }, migrationToken) {
  root = path.resolve(root);
  const errors = [], warnings = [];
  let project;
  try { project = readProject(root, { migrationToken }); } catch (error) { return { ok: false, errors: [error.message], warnings, stats: { assets: 0, versions: 0, adopted: 0 } }; }
  errors.push(...registryErrors(root, project));
  for (const directory of layoutFor(project).directories) {
    try { if (!fs.statSync(safePath(root, directory)).isDirectory()) errors.push(`${directory} 应为目录`); }
    catch (error) { errors.push(`项目目录缺失或无效 ${directory}：${error.message}`); }
  }
  try { if (pendingStatus(root)) warnings.push('存在待恢复事务；先运行 recover --project <项目目录>，再核对原业务结果。当前检查不能视为已提交验收。'); } catch (error) { errors.push(error.message); }
  const cache = new Map();
  if (!errors.length) {
    for (const entry of project.assets) {
      const work = inspectAsset(root, project, entry, workingPath(root, entry.path, project, entry), { strict: strict && !(project.schema_version === 2 && entry.lifecycle === 'retired'), cache });
      errors.push(...work.errors); warnings.push(...work.warnings);
      for (const saved of entry.versions) {
        try {
          const snapshot = readSnapshot(root, project, entry.asset_id, saved.version, cache);
          const isAdopted = entry.adopted_version === saved.version;
          const inspection = inspectAsset(root, project, entry, snapshot.directory, { strict: isAdopted, legacy: !isAdopted, cache: new Map(cache) });
          errors.push(...inspection.errors); warnings.push(...inspection.warnings);
          if (entry.adopted_version === saved.version && !wasAdopted(project, entry.asset_id, saved.version)) errors.push(`${entry.asset_id}@${saved.version}：采用指针没有真实采用记录`);
        } catch (error) { errors.push(error.message); }
      }
      if (work.asset && entry.versions.some(saved => saved.version === work.asset.version)) {
        try {
          const snapshot = readSnapshot(root, project, entry.asset_id, work.asset.version, cache);
          const actual = fingerprint(root, workingPath(root, entry.path, project, entry));
          if (JSON.stringify(actual) !== JSON.stringify(snapshot.manifest.files)) warnings.push(`${entry.asset_id}：工作稿与同号历史快照不同；继续保存前请递增 version。导出仍读取已采用快照。`);
        } catch { /* history validation already reports this */ }
      }
    }
  }
  if (!project.assets.length) warnings.push('尚未登记资产；空项目可以开始创作，不能导出交接包。');
  for (const index of project.content_reviews ?? []) {
    try {
      const record = reviewRecord(root, project, index.review_id);
      const snapshot = readSnapshot(root, project, record.asset_id, record.version, cache);
      if (record.manifest_sha256 !== snapshot.saved.manifest_sha256) errors.push(`${record.review_id}：审核绑定的快照校验值不一致`);
    } catch (error) { errors.push(error.message); }
  }
  for (const review of project.review_items ?? []) warnings.push(`${review.asset_id}@${review.version} ${review.via?.length ? `经 ${review.via.join(' → ')} 间接` : ''}引用 ${review.dependency_id}@${review.referenced_version}；当前上游采用 ${review.current_version}，请复核固定历史引用。`);
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], stats: { assets: project.assets.length, versions: project.assets.reduce((sum, entry) => sum + (entry.versions?.length ?? 0), 0), adopted: project.assets.filter(entry => entry.adopted_version).length } };
}
export function validateProject(options) { return validateProjectInternal(options); }
// Migration-only read verification. There is no CLI flag to bypass the sentinel.
export function validateMigratingProject({ project, strict = false, migrationToken }) {
  if (!filled(migrationToken)) fail('内部迁移验证需要目标哨兵的精确 token');
  return validateProjectInternal({ project, strict }, migrationToken);
}

export function recoverProject({ project: root }) {
  const result = withLock(root, resolved => ({ ok: true, action: 'recover', project: resolved, recovered_transaction: null, recovered_lock: null }), { allowInterruptedClaims: true });
  result.message = result.recovered_transaction || result.recovered_lock ? '已恢复既有中断事务或旧锁；请读取状态并核对原业务结果。仅完成已有提交，不追加新的业务操作。' : '没有待恢复事务或旧锁；未执行业务写入。';
  return result;
}

// Ordinary saves and production imports share this immutable snapshot contract.
// Callers hold the synchronous project lock and commit the returned move.
export function stageAssetSnapshot(root, project, entry, directory, { reason, transaction, name = 'snapshot' }) {
  if (fs.existsSync(path.join(directory, '_snapshot.json'))) fail('工作资产中不能有保留文件 _snapshot.json');
  const inspected = inspectAsset(root, project, entry, directory);
  ensureNoErrors(inspected.errors);
  const asset = inspected.asset;
  if (entry.versions.some(saved => saved.version === asset.version)) fail(`${entry.asset_id}@${asset.version} 已保存，历史版本不可覆盖；请递增工作稿 version`);
  for (const item of project.assets) for (const saved of item.versions) readSnapshot(root, project, item.asset_id, saved.version);
  const target = `${SYSTEM}/snapshots/${entry.asset_id}/${asset.version}`;
  if (fs.existsSync(safePath(root, target))) fail('历史快照目录已存在但未登记；请先核对恢复记录，拒绝覆盖');
  transaction ??= transactionBase(root);
  const stagedRelative = `${transaction.relative}/${name}`;
  const staged = safePath(root, stagedRelative);
  fs.mkdirSync(staged);
  const before = fingerprint(root, directory);
  for (const filename of Object.keys(before)) {
    const destination = safePath(root, `${stagedRelative}/${filename}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    writeSynced(destination, fs.readFileSync(path.join(directory, filename)));
  }
  compareFiles(fingerprint(root, staged), before, '保存中的快照');
  compareFiles(fingerprint(root, directory), before, '保存期间工作稿');
  const timestamp = now();
  const modified = Math.max(...Object.keys(before).map(filename => fs.statSync(path.join(directory, filename)).mtimeMs));
  const manifest = { schema_version: 1, project_id: project.project_id, asset_id: asset.asset_id, version: asset.version, created_at: timestamp, modified_at: new Date(modified).toISOString(), source_path: entry.path, previous_version: entry.versions.at(-1)?.version ?? null, reason, files: before };
  writeSynced(path.join(staged, '_snapshot.json'), jsonText(manifest));
  entry.versions.push({ version: asset.version, path: target, created_at: timestamp, modified_at: manifest.modified_at, manifest_sha256: hash(jsonText(manifest)) });
  operation(project, 'save-version', { asset_id: asset.asset_id, version: asset.version, reason, files: Object.keys(before), manifest_sha256: hash(jsonText(manifest)) });
  return { asset, warnings: inspected.warnings, files: before, move: { kind: 'snapshot', staged: stagedRelative, target, files: fingerprint(root, staged) } };
}

function reservedAssetIds(project) {
  return new Set([
    ...project.assets.map(entry => entry.asset_id),
    ...(project.operations ?? []).filter(event => event.action === 'cleanup-deleted-assets').flatMap(event => (event.removed_assets ?? []).map(entry => entry.asset_id)),
  ].filter(id => typeof id === 'string' && /^IP\d+-[A-Z]+-\d{3,}$/.test(id)));
}

export function cleanupDeletedAssets({ project: root, assets, reason }) {
  if (!filled(reason)) fail('清理已删候选必须提供具体 --reason');
  const ids = String(assets ?? '').split(',').map(id => id.trim());
  if (!ids.length || ids.some(id => !/^IP\d+-[A-Z]+-\d{3,}$/.test(id)) || new Set(ids).size !== ids.length) fail('必须用 --assets 指定不重复的已删除候选ID');
  return withLock(root, resolved => {
    const project = readProject(resolved); ensureNoErrors(registryErrors(resolved, project));
    if (project.schema_version !== 2) fail('清理已删候选仅支持布局v2');
    const entries = ids.map(id => findEntry(project, id)), selected = new Set(ids), cache = new Map();
    for (const entry of entries) {
      if (entry.lifecycle !== 'retired' || entry.adopted_version || (project.adoption_history ?? []).some(event => event.asset_id === entry.asset_id)) fail(`${entry.asset_id}：仅能清理从未采用的退役候选`);
      if (fs.existsSync(workingPath(resolved, entry.path, project, entry))) fail(`${entry.asset_id}：工作目录仍存在，清理不负责删除文件`);
    }
    // Keep every historical snapshot intact; refuse to detach an ID still referenced
    // by any other working asset or frozen version, including unadopted drafts.
    for (const entry of project.assets) {
      const inspections = [];
      if (!selected.has(entry.asset_id)) inspections.push(inspectAsset(resolved, project, entry, workingPath(resolved, entry.path, project, entry), { cache }));
      for (const saved of entry.versions) {
        const snapshot = readSnapshot(resolved, project, entry.asset_id, saved.version, cache);
        if (!selected.has(entry.asset_id)) inspections.push(inspectAsset(resolved, project, entry, snapshot.directory, { legacy: true, cache }));
      }
      for (const inspection of inspections) {
        ensureNoErrors(inspection.errors);
        const ref = inspection.refs.find(ref => selected.has(ref.asset_id));
        if (ref) fail(`${entry.asset_id}：仍引用${ref.asset_id}@${ref.version}，不能清理登记`);
      }
    }
    project.assets = project.assets.filter(entry => !selected.has(entry.asset_id));
    operation(project, 'cleanup-deleted-assets', { reason, removed_assets: entries });
    commit(resolved, project, { action: 'cleanup-deleted-assets' });
    return { ok: true, action: 'cleanup-deleted-assets', removed: ids, message: '已移除已删除候选的现行登记；原登记、编号与历史快照保留，未删除文件或改变采用指针。' };
  });
}

export function saveVersion({ project: root, asset: assetId, path: assetPath, reason = '保存本轮工作稿快照' }) {
  if (Boolean(assetId) === Boolean(assetPath)) fail('save-version 必须且只能提供 --asset 或 --path');
  if (!filled(reason)) fail('save-version 的 --reason 不能是空白');
  return withLock(root, resolved => {
    const project = readProject(resolved);
    ensureNoErrors(registryErrors(resolved, project));
    let entry;
    if (assetPath) {
      const normalized = assetPath.replaceAll('\\', '/');
      const directory = workingPath(resolved, normalized, project);
      const metadata = readJSON(path.join(directory, 'asset.json'));
      entry = project.assets.find(item => item.asset_id === metadata.asset_id);
      if (entry && entry.path.replaceAll('\\', '/') !== normalized) fail('该 ID 已登记到另一个工作目录，拒绝替换');
      if (!entry) {
        if (reservedAssetIds(project).has(metadata.asset_id)) fail('该资产ID已用于历史记录，不能重新登记；请使用新的编号');
        entry = { asset_id: metadata.asset_id, type: metadata.type, path: normalized, aliases: [], versions: [], adopted_version: null };
        project.assets.push(entry);
      }
    } else entry = findEntry(project, assetId);
    if (project.schema_version === 2 && entry.lifecycle === 'retired') fail('退役候选不能保存新版本；请先 restore-asset 恢复');
    ensureNoErrors(registryErrors(resolved, project));
    const directory = workingPath(resolved, entry.path, project, entry);
    const saved = stageAssetSnapshot(resolved, project, entry, directory, { reason });
    commit(resolved, project, { action: 'save-version', moves: [saved.move] });
    return { ok: true, action: 'save-version', asset_id: saved.asset.asset_id, version: saved.asset.version, warnings: saved.warnings, message: '已保存不可覆盖的历史快照；采用指针未自动改变。' };
  });
}
export function newAsset({ project: root, type, title = '', sequence }) {
  return withLock(root, resolved => {
    const project = readProject(resolved); ensureNoErrors(registryErrors(resolved, project));
    if (!TYPES.includes(type)) fail(`不支持的资产类型：${type}`);
    const usedIds = reservedAssetIds(project);
    const highest = Math.max(0, ...[...usedIds].filter(id => id.split('-')[1] === type).map(id => Number(id.split('-')[2])));
    const number = sequence ?? String(highest + 1).padStart(3, '0');
    const skeleton = createAssetSkeleton({ projectId: project.project_id, type, sequence: number, title });
    if (usedIds.has(skeleton.asset.asset_id)) fail(`资产已存在或编号已使用，拒绝覆盖：${skeleton.asset.asset_id}`);
    const target = assetDirectory(project, type, skeleton.asset.asset_id);
    if (fs.existsSync(workingPath(resolved, target, project, { type, asset_id: skeleton.asset.asset_id }))) fail(`工作目录已存在，拒绝覆盖：${target}`);
    const transaction = transactionBase(resolved), stagedRelative = `${transaction.relative}/asset`;
    const staged = safePath(resolved, stagedRelative); fs.mkdirSync(staged);
    writeSynced(path.join(staged, 'asset.json'), jsonText(skeleton.asset));
    for (const [filename, content] of Object.entries(skeleton.files)) {
      if (filename === 'asset.json' || filename === '_snapshot.json') fail('骨架不能覆盖保留元数据');
      const destination = safePath(staged, filename); fs.mkdirSync(path.dirname(destination), { recursive: true }); writeSynced(destination, content);
    }
    project.assets.push({ asset_id: skeleton.asset.asset_id, type, path: target, aliases: [], versions: [], adopted_version: null });
    operation(project, 'new-asset', { asset_id: skeleton.asset.asset_id, type, path: target });
    commit(resolved, project, { action: 'new-asset', moves: [{ kind: 'working-asset', staged: stagedRelative, target, files: fingerprint(resolved, staged) }] });
    return { ok: true, action: 'new-asset', asset_id: skeleton.asset.asset_id, version: skeleton.asset.version, path: target, message: '已创建并登记空白工作资产；填写、检查、保存及审核后才能采用。' };
  });
}

export function recordReview({ project: root, asset: assetId, version, file }) {
  return withLock(root, resolved => {
    const project = readProject(resolved); ensureNoErrors(registryErrors(resolved, project));
    const snapshot = readSnapshot(resolved, project, assetId, version);
    const input = readJSON(safePath(resolved, file));
    const reviewId = `REV-${crypto.randomUUID()}`;
    const record = normalizeReviewRecord(input, { reviewId, projectId: project.project_id, assetId, version, manifestSha256: snapshot.saved.manifest_sha256, recordedAt: now() });
    const transaction = transactionBase(resolved), stagedRelative = `${transaction.relative}/review`;
    const staged = safePath(resolved, stagedRelative); fs.mkdirSync(staged);
    writeSynced(path.join(staged, 'review.json'), jsonText(record));
    const target = `${SYSTEM}/reviews/${reviewId}`;
    (project.content_reviews ??= []).push({ review_id: reviewId, path: `${target}/review.json`, sha256: hash(jsonText(record)), asset_id: assetId, version, manifest_sha256: snapshot.saved.manifest_sha256 });
    operation(project, 'record-review', { review_id: reviewId, asset_id: assetId, version, method: record.method, result: record.result, coverage: record.coverage });
    commit(resolved, project, { action: 'record-review', moves: [{ kind: 'review', staged: stagedRelative, target, files: fingerprint(resolved, staged) }] });
    return { ok: true, action: 'record-review', review_id: reviewId, asset_id: assetId, version, result: record.result, method: record.method, coverage: record.coverage, message: '已冻结提交的审核证据；工具只登记，不代替实际阅读，也不自动声称人工审核。' };
  });
}

export function reviewItem({ project: root, item: itemId, reason, evidence, method, reviewer }) {
  return withLock(root, resolved => {
    const project = readProject(resolved); ensureNoErrors(registryErrors(resolved, project));
    const items = staleReviews(resolved, project);
    const item = items.find(entry => entry.review_item_id === itemId);
    if (!item) fail('复核项不在当前未处理列表中；请用 status 读取当前精确版本，不沿用过期编号');
    const record = normalizeReviewDisposition({ ...item, reason, evidence, method, reviewer }, { projectId: project.project_id, recordedAt: now() });
    (project.review_dispositions ??= []).push(record);
    operation(project, 'review-item', { review_item_id: itemId, asset_id: item.asset_id, version: item.version, dependency_id: item.dependency_id, referenced_version: item.referenced_version, current_version: item.current_version, reason, method, reviewer });
    project.review_items = staleReviews(resolved, project);
    commit(resolved, project, { action: 'review-item' });
    return { ok: true, action: 'review-item', review_item_id: itemId, review_items: project.review_items, message: '已记录本次精确依赖版本复核并保留历史引用；上游再次变更会产生新的复核项。' };
  });
}

export function projectStatus({ project: root }) {
  root = path.resolve(root);
  const project = readProject(root); ensureNoErrors(registryErrors(root, project));
  const assets = [], errors = [], pending = [], productionNotes = [];
  for (const entry of project.assets) {
    try {
      const directory = workingPath(root, entry.path, project, entry), working = readJSON(path.join(directory, 'asset.json'));
      let draft = !entry.versions.some(item => item.version === working.version);
      if (!draft) {
        const saved = readSnapshot(root, project, entry.asset_id, working.version);
        draft = JSON.stringify(fingerprint(root, directory)) !== JSON.stringify(saved.manifest.files);
      }
      const retired = project.schema_version === 2 && entry.lifecycle === 'retired';
      const row = { asset_id: entry.asset_id, type: entry.type, ...(project.schema_version === 2 ? { lifecycle: entry.lifecycle ?? 'active', retired } : {}), title: working.title, work_version: working.version, adopted_version: entry.adopted_version, unsaved_changes: draft, versions: entry.versions.length };
      assets.push(row);
      if (draft && !retired) pending.push({ asset_id: entry.asset_id, action: '完成工作稿并保存新版本', reason: '存在未保存工作稿' });
      if (!entry.adopted_version && !retired) pending.push({ asset_id: entry.asset_id, action: '完成内容审核并明确采用', reason: '尚无采用基准' });
      if (entry.adopted_version && entry.type === 'CH') {
        const snapshot = readSnapshot(root, project, entry.asset_id, entry.adopted_version);
        try { reviewForSnapshot(root, project, snapshot, { required: true }); }
        catch (error) { pending.push({ asset_id: entry.asset_id, action: '补齐精确版本的完整内容审核', reason: error.message }); }
      }
      if (entry.adopted_version && entry.type === 'REPORT') {
        const report = readSnapshot(root, project, entry.asset_id, entry.adopted_version).asset;
        const notes = Object.fromEntries(Object.entries(report.data).filter(([key]) => ['next_action', 'next_actions', 'pending_actions', 'production_status', 'media_status', 'status'].includes(key)));
        if (Object.keys(notes).length) productionNotes.push({ asset_id: entry.asset_id, version: entry.adopted_version, ...notes });
      }
    } catch (error) {
      errors.push(`${entry.asset_id}：${error.message}`);
      if (project.schema_version === 2) assets.push({ asset_id: entry.asset_id, type: entry.type, title: null, work_version: null, adopted_version: entry.adopted_version, unsaved_changes: null, versions: entry.versions.length, lifecycle: entry.lifecycle ?? 'active', retired: entry.lifecycle === 'retired', error: error.message });
    }
  }
  const reviewItems = staleReviews(root, project);
  for (const item of reviewItems) pending.push({ asset_id: item.asset_id, action: '复核上游变化，修订或记录保留历史', review_item_id: item.review_item_id, reason: item.reason });
  if (!project.assets.length) pending.push({ action: '先创建 WORLD、CHAR、PLOT 或 CH 工作资产', reason: '项目尚无资产' });
  if (pendingStatus(root)) pending.push({ action: '运行 recover 恢复中断事务，再核对原业务结果', reason: '存在未完成的提交日志' });
  return { ok: errors.length === 0, action: 'status', project: root, project_id: project.project_id, name: project.name, assets, adopted: assets.filter(item => item.adopted_version), drafts: assets.filter(item => !item.retired && (item.unsaved_changes || !item.adopted_version)), ...(project.schema_version === 2 ? { retired: assets.filter(item => item.retired) } : {}), pending, production_notes: productionNotes, review_items: reviewItems, resolved_reviews: (project.review_dispositions ?? []).length, errors, message: '只读状态已读取；pending 仅为机器可识别的结构待办，空列表不代表创作或媒体制作完成，请同时阅读制作报告。' };
}

export function adoptVersion({ project: root, asset: assetId, version, reason, review }) {
  if (!filled(reason)) fail('采用必须提供 --reason，记录具体依据');
  if (!VERSION.test(version ?? '')) fail('采用版本号必须为三段数字');
  return withLock(root, resolved => {
    const project = readProject(resolved);
    ensureNoErrors(registryErrors(resolved, project));
    const entry = findEntry(project, assetId);
    if (project.schema_version === 2 && entry.lifecycle === 'retired') fail('退役候选不能采用；请先 restore-asset 恢复');
    if (project.schema_version === 2 && !filled(review)) fail('v2 正式采用必须提供 --review 精确审核编号');
    const snapshot = readSnapshot(resolved, project, assetId, version);
    const inspected = inspectAsset(resolved, project, entry, snapshot.directory, { strict: true });
    ensureNoErrors(inspected.errors);
    for (const ref of inspected.refs) if (!wasAdopted(project, ref.asset_id, ref.version)) fail(`${referenceKey(ref)}：依赖版本从未采用，请先审核并采用上游版本`);
    const reviewEvidence = review ? reviewForSnapshot(resolved, project, snapshot, { reviewId: review, required: true }) : null;
    const previous = entry.adopted_version;
    entry.adopted_version = version;
    const evidence = operation(project, 'adopt', { asset_id: assetId, version, previous_version: previous, reason, manifest_sha256: snapshot.saved.manifest_sha256, ...(reviewEvidence ? { review_id: reviewEvidence.review_id } : {}) });
    (project.adoption_history ??= []).push({ asset_id: assetId, version, previous_version: previous, reason, at: evidence.at, operation_id: evidence.operation_id, manifest_sha256: snapshot.saved.manifest_sha256, ...(reviewEvidence ? { review_id: reviewEvidence.review_id } : {}) });
    project.review_items = staleReviews(resolved, project);
    commit(resolved, project, { action: 'adopt' });
    return { ok: true, action: 'adopt', asset_id: assetId, version, review_items: project.review_items, warnings: [...inspected.warnings, ...(reviewEvidence ? [] : ['本次沿用兼容采用方式，未绑定内容审核记录；采用成功不代表内容质量通过。'])], message: '指定历史版本已采用；工作稿及下游成果未被改写。' };
  });
}
export function exportProject({ project: root, out, episodes, chapters, requireReview }) {
  if (!filled(out)) fail('export 需要 --out 指定项目内新的导出目录');
  const normalized = out.replaceAll('\\', '/');
  return withLock(root, resolved => {
    const project = readProject(resolved);
    ensureNoErrors(registryErrors(resolved, project));
    requireReview = project.schema_version === 2 ? true : requireReview === true;
    const target = outputPath(resolved, normalized, project, 'export');
    if (fs.existsSync(target)) fail(`导出目录已存在，拒绝覆盖：${normalized}`);
    for (const entry of project.assets) {
      const work = entry.path.replaceAll('\\', '/').toLowerCase();
      const output = normalized.toLowerCase();
      if (work === output || work.startsWith(`${output}/`) || output.startsWith(`${work}/`)) fail('导出目录不能包含工作资产，也不能位于工作资产内部');
    }
    const selection = scopeSelection(resolved, project, { episodes, chapters });
    const snapshots = exportClosure(resolved, project, selection?.roots);
    const playback = playbackProjection(snapshots, selection);
    const selectedIds = new Set(snapshots.map(item => item.asset.asset_id));
    const reviewItems = staleReviews(resolved, project).filter(item => selectedIds.has(item.asset_id));
    const warnings = [...new Set([...(selection?.warnings ?? []), ...snapshots.flatMap(snapshot => snapshot.warnings)])];
    const contentReviews = [];
    for (const chapter of playback.chapters) {
      try { contentReviews.push(reviewForSnapshot(resolved, project, chapter, { required: true })); }
      catch (error) { if (requireReview) throw error; warnings.push(`${error.message}；本次沿用兼容导出，不能据此认定内容审核通过。`); }
    }
    const transaction = transactionBase(resolved);
    const stagedRelative = `${transaction.relative}/export`;
    const staged = safePath(resolved, stagedRelative);
    fs.mkdirSync(staged);
    const exported = now();
    const used = [];
    for (const snapshot of snapshots) {
      const { asset, saved, refs } = snapshot;
      const destinationRelative = copySnapshot(resolved, snapshot, staged, '导出');
      used.push({ asset_id: asset.asset_id, version: asset.version, type: asset.type, title: asset.title, source_kind: asset.source_kind, semantic_adoption_status: asset.adoption_status, current_adopted_version: snapshot.entry.adopted_version, manifest_sha256: saved.manifest_sha256, path: destinationRelative, refs });
    }
    const playbackRecord = Object.fromEntries(['chapters', 'episodes', 'scenes', 'shots'].map(kind => [kind, playback[kind].map(item => ({ asset_id: item.asset.asset_id, version: item.asset.version }))]));
    playbackRecord.uncovered_adopted_versions = playback.uncovered;
    const selectionRecord = selection ? selection.requested : { type: 'all', asset_ids: [] };
    writeSynced(path.join(staged, 'handoff.json'), jsonText({ schema_version: 1, project_id: project.project_id, project_name: project.name, exported_at: exported, scope: '文字生产与资产交接；媒体文件存在不代表实际观看或验收通过', selection: selectionRecord, require_review: requireReview, content_reviews: contentReviews.map(record => record.review_id), warnings, assets: used, content: snapshots.map(({ asset }) => asset), playback: playbackRecord, review_items: reviewItems }));
    writeSynced(path.join(staged, '来源与版本清单.json'), jsonText({ schema_version: 1, project_id: project.project_id, exported_at: exported, assets: used, adoption_history: (project.adoption_history ?? []).filter(event => used.some(item => item.asset_id === event.asset_id && item.version === event.version)) }));
    writeSynced(path.join(staged, '内容审核记录.json'), jsonText(contentReviews));
    writeSynced(path.join(staged, '交接说明.md'), `${handoffMarkdown(project, exported, snapshots, reviewItems, playback)}\n## 本次选择与内容审核\n\n${selection ? `按 ${selectionRecord.type} 选择：${selectionRecord.asset_ids.join('、')}。附属报告的其他来源章节只作为依赖证据，不扩展播放范围。` : '本次为全项目采用资产交接。'}\n\n审核门禁：${requireReview ? '要求所选播放章节具有精确快照的完整通过记录' : '兼容模式；结构成功不代表内容审核通过'}。\n\n${warnings.map(item => `- ${item}`).join('\n')}\n`);
    renderStagedViews(resolved, project, staged, 'handoff.json', warnings);
    const exportRecord = { path: normalized, exported_at: exported, selection: selectionRecord, require_review: requireReview, assets: used.map(({ asset_id, version, manifest_sha256 }) => ({ asset_id, version, manifest_sha256 })) };
    (project.exports ??= []).push(exportRecord);
    project.review_items = staleReviews(resolved, project);
    operation(project, 'export', exportRecord);
    commit(resolved, project, { action: 'export', moves: [{ kind: 'export', staged: stagedRelative, target: normalized, files: fingerprint(resolved, staged) }] });
    return { ok: true, action: 'export', output: target, assets: used.length, selection: selectionRecord, playback: playbackRecord, warnings: [...warnings, ...playback.uncovered.map(item => `${referenceKey(item)}：${item.reason}`)], review_items: reviewItems, message: '已导出所选采用快照、完整来源依赖及中文十一项镜头卡。' };
  });
}

export function resumeProject({ project: root, out, readingViews = false }) {
  if (!filled(out)) fail('resume 需要 --out 指定新的项目内续作包目录');
  if (typeof readingViews !== 'boolean') fail('resume 的 readingViews 必须为布尔值');
  const normalized = out.replaceAll('\\', '/');
  return withLock(root, resolved => {
    const project = readProject(resolved); ensureNoErrors(registryErrors(resolved, project));
    const target = outputPath(resolved, normalized, project, 'resume');
    if (fs.existsSync(target)) fail('续作包目标已存在，拒绝覆盖');
    for (const entry of project.assets) {
      const work = entry.path.replaceAll('\\', '/').toLowerCase(), output = normalized.toLowerCase();
      if (work === output || work.startsWith(`${output}/`) || output.startsWith(`${work}/`)) fail('续作包不能与工作资产目录相互包含');
    }
    const snapshots = exportClosure(resolved, project, null, { requireBridge: false });
    const status = projectStatus({ project: resolved });
    const warnings = [...new Set(snapshots.flatMap(snapshot => snapshot.warnings))];
    const transaction = transactionBase(resolved), stagedRelative = `${transaction.relative}/resume`;
    const staged = safePath(resolved, stagedRelative); fs.mkdirSync(staged);
    const reading = [], used = [];
    const order = ['WORLD', 'PLOT', 'CHAR', 'LOC', 'PROP', 'STATE', 'CH', 'REPORT', 'EP', 'SC', 'SHOT', 'PROMPT', 'MEDIA'];
    snapshots.sort((a, b) => order.indexOf(a.asset.type) - order.indexOf(b.asset.type) || referenceKey(a.asset).localeCompare(referenceKey(b.asset)));
    for (const snapshot of snapshots) {
      const { asset } = snapshot;
      const relative = copySnapshot(resolved, snapshot, staged, '续作');
      used.push({ asset_id: asset.asset_id, version: asset.version, type: asset.type, manifest_sha256: snapshot.saved.manifest_sha256, path: relative, current_adopted: snapshot.entry.adopted_version === asset.version });
      reading.push({ asset_id: asset.asset_id, version: asset.version, type: asset.type, title: asset.title, path: `${relative}/asset.json`, ...(asset.type === 'CH' ? { chapter_files: CHAPTER_FILES.map(filename => `${relative}/${filename}`) } : {}) });
    }
    const reviews = (project.content_reviews ?? []).filter(index => used.some(asset => asset.asset_id === index.asset_id && asset.version === index.version)).map(index => reviewRecord(resolved, project, index.review_id));
    const info = { schema_version: 1, project_id: project.project_id, project_name: project.name, created_at: now(), reading_views: readingViews, scope: '采用基准与续作待办；未采用工作稿只列状态，不混入正文基准；pending 为空不代表创作或媒体完成', assets: used, states: used.filter(asset => asset.type === 'STATE'), pending: status.pending, production_notes: status.production_notes, working_errors: status.errors, warnings, review_items: status.review_items, review_dispositions: project.review_dispositions ?? [], reading_list: reading, content_reviews: reviews };
    writeSynced(path.join(staged, '续作信息.json'), jsonText(info));
    const lines = [`# ${project.name}｜续作包`, '', '先阅读下列精确采用版本，再处理待办。文件打包成功不代表文学质量或媒体验收通过。未采用工作稿没有混入基准；只做小说时无需完成分集和分镜。', '', '## 读取清单', '', ...reading.flatMap(item => [`- [${referenceKey(item)} ${item.title}](${item.path})`, ...(item.chapter_files ?? []).map(filename => `  - [${path.basename(filename)}](${filename})`)]), '', '## 状态与待办', '', ...status.pending.map(item => `- ${item.asset_id ?? project.project_id}：${item.action}；${item.reason}`), ...status.errors.map(error => `- 工作稿问题：${error}`), '', '## 新对话启动请求', '', '请先读取本包续作信息.json和读取清单中的采用版本。按原项目的IP总控、小说生产与内容审核技能继续处理待办；区分实际来源和建议，不擅自更新采用基准，不把未查看素材说成已验收。', ''];
    if (warnings.length) lines.push('', '## 校验提示', '', ...warnings.map(warning => `- ${warning}`));
    lines.push('', '## 制作报告中的后续工作', '', '机器结构待办只反映可识别的结构状态，不能证明创作、参考素材或实际媒体已经完成。以下内容原样摘自采用报告，工具没有自动执行或关闭这些工作。', '', ...status.production_notes.flatMap(({ asset_id, version, ...notes }) => dataMarkdown(notes).map(line => `- ${asset_id}@${version}：${line}`)), '');
    writeSynced(path.join(staged, '续作说明.md'), lines.join('\n'));
    renderStagedViews(resolved, project, staged, '续作信息.json', warnings, readingViews);
    const record = { path: normalized, created_at: info.created_at, reading_views: readingViews, assets: used.map(({ asset_id, version, manifest_sha256 }) => ({ asset_id, version, manifest_sha256 })) };
    (project.resumes ??= []).push(record); operation(project, 'resume', record);
    commit(resolved, project, { action: 'resume', moves: [{ kind: 'resume', staged: stagedRelative, target: normalized, files: fingerprint(resolved, staged) }] });
    return { ok: true, action: 'resume', output: target, assets: used.length, reading_views: readingViews, pending: status.pending, warnings, message: '已生成采用基准、连续性状态、待办和读取清单；不要求先完成漫改。' };
  });
}

export { retireAsset, restoreAsset } from './lifecycle.mjs';
