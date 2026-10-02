import fs from 'node:fs';
import path from 'node:path';
import { ASSET_ID, VERSION, TYPES, CHAPTER_FILES, object, filled, meaningful, fail, hash, jsonText, referenceKey, createAssetSkeleton } from './rules.mjs';
import { safePath, writeSynced, fingerprint, compareFiles } from './storage.mjs';
import { assetDirectory, workingPath } from './layout.mjs';
import { readProject, registryErrors, readSnapshot, operation } from './registry.mjs';
import { inspectAsset, collectRefs } from './asset-validation.mjs';
import { ensureNoErrors, wasAdopted } from './dependencies.mjs';
import { reviewForSnapshot } from './reviews.mjs';
import { withLock, transactionBase, commit } from './transactions.mjs';
import { stageAssetSnapshot } from './project-service.mjs';
import { buildProductionContext } from './生产上下文.mjs';
import { checkProduction } from './制作质检.mjs';

const DEFAULT_STAGES = [
  { id: '故事理解', name: '理解选定章节并整理故事资产', skill: 'comic-studio', expected_types: ['CH', 'WORLD', 'PLOT', 'CHAR', 'LOC', 'PROP', 'STATE'] },
  { id: '分集剧本', name: '改编分集和场次剧本', skill: 'comic-studio', expected_types: ['EP', 'SC'] },
  { id: '镜头设计', name: '设计镜头、声音和可见首尾状态', skill: 'jimeng-video-prompts', expected_types: ['SHOT'] },
  { id: '提示词', name: '编译并检查下游提示词', skill: 'jimeng-video-prompts', expected_types: ['PROMPT'] },
];
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const refOf = asset => ({ asset_id: asset.asset_id, version: asset.version });
function load(root) { const project = readProject(root); ensureNoErrors(registryErrors(root, project)); return project; }
function exact(ref, project) {
  if (!object(ref) || !ASSET_ID.test(ref.asset_id ?? '') || !ref.asset_id.startsWith(`${project.project_id}-`) || !VERSION.test(ref.version ?? '')) fail('需要同一项目内的精确资产 ID 和版本');
  return ref;
}
function readRef(root, project, ref) {
  exact(ref, project);
  const snapshot = readSnapshot(root, project, ref.asset_id, ref.version);
  if (ref.event_id !== undefined && (snapshot.asset.type !== 'CH' || !snapshot.asset.data.events?.some(event => event.event_id === ref.event_id))) fail(`${referenceKey(ref)}：event_id 不存在`);
  return snapshot;
}
function requestObject(request, allowed) {
  if (!object(request)) fail('请求必须为对象');
  for (const key of Object.keys(request)) if (!allowed.includes(key)) fail(`请求不接受字段 ${key}`);
}
function freshSkeleton(project, type, title, sequence) {
  const highest = Math.max(0, ...project.assets.filter(entry => entry.type === type).map(entry => Number(entry.asset_id.split('-')[2])));
  const result = createAssetSkeleton({ projectId: project.project_id, type, title, sequence: sequence ?? highest + 1 });
  if (project.assets.some(entry => entry.asset_id === result.asset.asset_id)) fail('拟用资产编号已经登记；请重新预填或显式选择未用编号');
  return result;
}

/** Fills references only; creative decisions stay with the host AI and remain visible. */
export function seedProductionAsset({ project: root, request }) {
  requestObject(request, ['type', 'title', 'sequence', 'from']);
  root = path.resolve(root); const project = load(root);
  if (['MEDIA', 'REPORT'].includes(request.type)) fail('制作预填支持故事与提示词资产；媒体和报告沿用对应入口');
  if (!Array.isArray(request.from) || !request.from.length) fail('from 需要至少一个明确的上游版本');
  const sources = request.from.map(ref => ({ ref, snapshot: readRef(root, project, ref) }));
  const { asset, files } = freshSkeleton(project, request.type, request.title ?? '', request.sequence);
  const inherited = [], data = asset.data;
  const set = (field, value, from) => { data[field] = structuredClone(value); inherited.push({ field: `data.${field}`, from }); };
  const one = type => { const entries = sources.filter(item => item.snapshot.asset.type === type); if (entries.length > 1) fail(`${request.type} 预填只接受一个 ${type} 上游；请按场次/镜头拆开`); return entries[0]; };
  const chapters = sources.filter(item => item.snapshot.asset.type === 'CH');
  asset.refs = request.from.map(ref => structuredClone(ref));
  if (request.type === 'EP') set('chapter_refs', chapters.map(item => refOf(item.snapshot.asset)), 'from 中的章节精确版本');
  if (request.type === 'SC') {
    const episode = one('EP'), location = one('LOC');
    if (episode) set('episode', refOf(episode.snapshot.asset), referenceKey(episode.ref));
    if (location) set('location', refOf(location.snapshot.asset), referenceKey(location.ref));
    set('source_refs', chapters.filter(item => item.ref.event_id).map(item => item.ref), 'from 中明确选定的章节事件');
    set('characters', sources.filter(item => item.snapshot.asset.type === 'CHAR').map(item => refOf(item.snapshot.asset)), 'from 中的人物');
  }
  if (request.type === 'SHOT') {
    const scene = one('SC');
    if (scene) {
      const d = scene.snapshot.asset.data, key = referenceKey(scene.ref);
      set('scene', refOf(scene.snapshot.asset), key);
      for (const field of ['episode', 'story_time']) if (d[field]) set(field, d[field], `${key}.data.${field}`);
      set('source_refs', chapters.some(item => item.ref.event_id) ? chapters.filter(item => item.ref.event_id).map(item => item.ref) : d.source_refs ?? [], `${key}.data.source_refs；可用 from 事件收窄`);
      const characters = [...new Map([...(Array.isArray(d.characters) ? d.characters : []), ...scene.snapshot.asset.refs, ...request.from].filter(item => object(item) && item.asset_id?.split('-')[1] === 'CHAR').map(ref => [referenceKey(ref), refOf(ref)])).values()];
      set('character_refs', characters, `${key}.data.characters`);
      if (d.location) {
        const location = readRef(root, project, d.location);
        set('scene_description', location.asset.data.description || location.asset.title, `${referenceKey(d.location)}.data.description/title`);
      }
    }
  }
  if (request.type === 'PROMPT') { const shot = one('SHOT'); if (shot) set('shot', refOf(shot.snapshot.asset), referenceKey(shot.ref)); }
  return { ok: true, action: 'seed-production-asset', project_id: project.project_id, asset, files, inherited, missing_fields: Object.entries(data).filter(([, value]) => !meaningful(value)).map(([key]) => `data.${key}`), warnings: ['仅预填上游事实和引用。宿主 AI 需补全创作内容；未保存、未审核、未采用。场次起止状态不会复制成每一个镜头的起止状态。'] };
}

function planSnapshot(root, project, task) {
  const snapshot = readRef(root, project, task);
  if (snapshot.asset.type !== 'REPORT' || snapshot.asset.data.production_task?.schema_version !== 1) fail('task 必须指向制作计划 REPORT 的精确版本');
  return snapshot;
}
function sameTask(record, task) { return record.task?.asset_id === task.asset_id && record.task?.version === task.version; }
function planStatus(root, project, task) {
  const snapshot = planSnapshot(root, project, task), plan = snapshot.asset.data.production_task;
  const input = buildProductionContext({ project: root, request: { stage: '制作计划', ...plan.inputs } });
  const inputErrors = [...input.errors];
  if (input.ok && input.input_fingerprint !== plan.input_fingerprint) inputErrors.push('计划输入与创建时不一致；请用新的 request_id 建立修订计划');
  const stages = [], upstream = [plan.input_fingerprint];
  for (const stage of plan.stages) {
    const records = (project.operations ?? []).filter(item => sameTask(item, task) && item.stage_id === stage.id);
    const batches = records.filter(item => item.action === 'production-result');
    const latest = new Map(), origins = new Map();
    for (const record of batches) for (const ref of record.outputs) { latest.set(ref.asset_id, ref); origins.set(ref.asset_id, record); }
    const outputs = [], problems = [];
    for (const ref of latest.values()) {
      try {
        const saved = readRef(root, project, ref);
        if (ref.manifest_sha256 !== saved.saved.manifest_sha256) fail('回执与快照校验值不一致');
        let review = null;
        try { review = reviewForSnapshot(root, project, saved, { required: true }); } catch (error) { problems.push(`${referenceKey(ref)}：${error.message}`); }
        const adopted = wasAdopted(project, ref.asset_id, ref.version);
        if (!adopted) problems.push(`${referenceKey(ref)}：尚未正式采用`);
        outputs.push({ ...ref, review_id: review?.review_id ?? null, adopted });
      } catch (error) { problems.push(`${referenceKey(ref)}：${error.message}`); }
    }
    const partial = records.filter(item => item.action === 'production-import' && !batches.some(batch => batch.batch_id === item.batch_id) && (!origins.has(item.output.asset_id) || records.indexOf(origins.get(item.output.asset_id)) < records.indexOf(item)));
    const upstream_fingerprint = digest(upstream);
    const stale = [...origins.values()].some(batch => batch.upstream_fingerprint !== upstream_fingerprint);
    const quality = latest.size ? checkProduction({ project: root, request: { refs: [...latest.values()].map(refOf) } }) : null;
    const blocked = stages.some(item => item.status !== '已完成');
    const status = inputErrors.length ? '输入已变化' : blocked ? '等待上游' : stale ? '上游已变化' : partial.length ? '导入未完成' : !batches.length ? '待生成' : quality && !quality.ok ? '需修订' : problems.length ? '待审核采用' : '已完成';
    stages.push({ ...stage, status, outputs, partial_outputs: partial.map(item => item.output), problems, upstream_fingerprint, ...(quality ? { quality: { ok: quality.ok, input_fingerprint: quality.input_fingerprint, issues: quality.issues, coverage: quality.coverage } } : {}) });
    upstream.push([...latest.values()].map(ref => [ref.asset_id, ref.version, ref.manifest_sha256]));
  }
  return { ok: !inputErrors.length, action: 'production-task-status', project_id: project.project_id, task: refOf(snapshot.asset), title: snapshot.asset.title, goal: plan.goal, assumptions: plan.assumptions, stages, next_stage: stages.find(stage => stage.status !== '已完成')?.id ?? null, errors: inputErrors, message: '阶段完成需成果快照、真实完整审核和采用记录；保存回执不代替内容检查。' };
}
export function productionTaskStatus({ project: root, asset, version, request }) {
  root = path.resolve(root); const project = load(root);
  if (request || asset) return planStatus(root, project, request?.task ?? { asset_id: asset, version });
  const tasks = (project.operations ?? []).filter(item => item.action === 'production-task').map(item => planStatus(root, project, item.task));
  return { ok: tasks.every(task => task.ok), action: 'production-task-status', project_id: project.project_id, tasks, message: tasks.length ? '制作任务如下。' : '尚未创建制作任务；项目资产和采用基准保持不变。' };
}

// Import text/structured artifacts only. Real media still uses its existing provenance workflow.
function payloadFiles(root, item) {
  if (!object(item.files)) fail('每项 files 必须明确提供完整附件对象；没有附件时使用 {}');
  const seen = new Set(), result = {};
  for (const [name, content] of Object.entries(item.files)) {
    if (typeof content !== 'string' || content.includes('\0')) fail(`附件 ${name} 必须为 UTF-8 文本`);
    const normalized = name.replaceAll('\\', '/'), key = normalized.toLowerCase();
    if (!['.md', '.txt', '.json', '.csv', '.tsv', '.srt', '.vtt', '.yaml', '.yml'].includes(path.posix.extname(key))) fail(`附件 ${name} 不是支持的文本类型；真实媒体沿用现有登记入口`);
    safePath(root, normalized);
    if (normalized.split('/').some(part => ['asset.json', '_snapshot.json'].includes(part.toLowerCase())) || seen.has(key)) fail(`附件路径重复或使用了保留文件：${name}`);
    for (const previous of seen) if (key.startsWith(`${previous}/`) || previous.startsWith(`${key}/`)) fail('附件路径不能互相包含');
    seen.add(key); result[normalized] = content;
  }
  return result;
}
function normalizedItems(root, project, items, stage, task) {
  if (!Array.isArray(items) || !items.length) fail('assets 需要至少一个实际成果');
  const ids = new Set();
  const list = items.map(item => {
    requestObject(item, ['asset', 'files', 'base_version']);
    const a = exact(item.asset, project);
    if (!object(a.data) || a.type !== a.asset_id.split('-')[1] || a.project_id !== project.project_id || a.type === 'MEDIA') fail('成果身份、类型或 data 无效；媒体文件须通过现有媒体入口登记');
    if (!stage.expected_types.includes(a.type)) fail(`${stage.id} 不接收 ${a.type}；请按实际阶段登记`);
    if (ids.has(a.asset_id)) fail('一个批次不能多次修改同一资产');
    ids.add(a.asset_id);
    if (item.base_version !== undefined && !VERSION.test(item.base_version)) fail('base_version 必须为精确版本');
    return { ...item, files: payloadFiles(root, item) };
  });
  const byKey = new Map(list.map(item => [referenceKey(item.asset), item]));
  const sorted = [], done = new Set(), active = new Set();
  function visit(item) {
    const key = referenceKey(item.asset);
    if (done.has(key)) return;
    if (active.has(key)) fail('成果相互循环引用；请先保存镜头，再派生提示词');
    active.add(key);
    const refs = [], errors = [];
    collectRefs(item.asset, 'asset', refs, errors, { skipIdentity: true });
    for (const [name, content] of Object.entries(item.files)) if (name.toLowerCase().endsWith('.json')) {
      let value; try { value = JSON.parse(content); } catch { fail(`附件 ${name} 不是有效 JSON`); }
      const chapterDocument = item.asset.type === 'CH' && CHAPTER_FILES.includes(name);
      collectRefs(value, name, refs, errors, { skipIdentity: chapterDocument });
    }
    ensureNoErrors(errors);
    for (const { ref } of refs) { exact(ref, project); if (referenceKey(ref) === referenceKey(task)) fail('故事成果不能反向引用制作任务 REPORT；任务只记录执行计划'); const dependency = byKey.get(referenceKey(ref)); if (dependency) visit(dependency); else readRef(root, project, ref); }
    active.delete(key); done.add(key); sorted.push(item);
  }
  list.forEach(visit); return sorted;
}
function saveItem(root, project, item, details) {
  const asset = item.asset;
  let entry = project.assets.find(candidate => candidate.asset_id === asset.asset_id);
  let before, base;
  if (entry) {
    if (entry.lifecycle === 'retired') fail('退役候选须先恢复');
    if (!item.base_version) fail('修订已有资产必须明确 base_version；不会覆盖未保存工作稿');
    base = readSnapshot(root, project, asset.asset_id, item.base_version);
    before = fingerprint(root, workingPath(root, entry.path, project, entry));
    compareFiles(before, base.manifest.files, '修订前工作稿与指定基准');
    const absent = Object.keys(base.manifest.files).filter(name => name !== 'asset.json' && !Object.hasOwn(item.files, name));
    if (absent.length) fail(`本入口不删除附件；请保留完整文件：${absent.join('、')}`);
    if (entry.versions.some(saved => saved.version === asset.version)) fail('成果版本已存在，不能覆盖；请递增版本');
  } else {
    if (item.base_version) fail('新资产不能声明 base_version');
    entry = { asset_id: asset.asset_id, type: asset.type, path: assetDirectory(project, asset.type, asset.asset_id), aliases: [], versions: [], adopted_version: null };
    if (fs.existsSync(workingPath(root, entry.path, project, entry))) fail('工作目录已存在但未登记，拒绝覆盖');
    project.assets.push(entry);
  }
  const transaction = transactionBase(root), stagedRelative = `${transaction.relative}/新工作稿`, staged = safePath(root, stagedRelative);
  fs.mkdirSync(staged);
  writeSynced(path.join(staged, 'asset.json'), jsonText(asset));
  for (const [name, content] of Object.entries(item.files)) { const file = safePath(staged, name); fs.mkdirSync(path.dirname(file), { recursive: true }); writeSynced(file, content); }
  const inspected = inspectAsset(root, project, entry, staged, { strict: true }); ensureNoErrors(inspected.errors);
  const saved = stageAssetSnapshot(root, project, entry, staged, { reason: details.reason, transaction });
  const move = { kind: base ? 'working-revision' : 'working-asset', staged: stagedRelative, target: entry.path, files: fingerprint(root, staged), ...(base ? { before_files: before, base_version: item.base_version, backup: `${transaction.relative}/原工作稿/${asset.asset_id}` } : {}) };
  const output = { ...refOf(asset), manifest_sha256: entry.versions.at(-1).manifest_sha256 };
  operation(project, details.action, { ...details.record, output });
  commit(root, project, { action: details.action, moves: [saved.move, move] });
  return output;
}

export function createProductionTask({ project: root, request }) {
  requestObject(request, ['request_id', 'title', 'goal', 'inputs', 'stages', 'assumptions']);
  if (!filled(request.goal)) fail('goal 需要明确创作目标');
  const requestHash = digest(request), requestId = request.request_id ?? requestHash;
  if (!filled(requestId)) fail('request_id 不能为空');
  return withLock(root, resolved => {
    let project = load(resolved);
    const previous = (project.operations ?? []).find(item => item.action === 'production-task' && item.request_id === requestId);
    if (previous) {
      if (previous.request_hash !== requestHash) fail('相同 request_id 已绑定不同计划，拒绝替换');
      const result = planStatus(resolved, project, previous.task); return { ...result, action: 'create-production-task', reused: true };
    }
    const stages = request.stages ?? DEFAULT_STAGES;
    if (!Array.isArray(stages) || !stages.length || new Set(stages.map(stage => stage.id)).size !== stages.length) fail('stages 必须为不重复的非空阶段列表');
    for (const stage of stages) if (!filled(stage.id) || !filled(stage.name) || !['comic-studio', 'jimeng-video-prompts', 'comic-image-assets', 'comic-audio'].includes(stage.skill) || !Array.isArray(stage.expected_types) || !stage.expected_types.length || stage.expected_types.some(type => !TYPES.includes(type) || type === 'MEDIA')) fail('阶段需要名称、现有 Skill 和允许的成果类型（不含 MEDIA）');
    if (!Array.isArray(request.assumptions ?? []) || (request.assumptions ?? []).some(item => !filled(item))) fail('assumptions 应为已声明假设的文字数组');
    requestObject(request.inputs, ['roots', 'candidates', 'source_readings']);
    const context = buildProductionContext({ project: resolved, request: { stage: '制作计划', ...request.inputs } });
    if (!context.ok) fail(`计划输入检查未通过：${context.errors.join('；')}。请缩小章节或事件范围。`);
    const { asset, files } = freshSkeleton(project, 'REPORT', request.title ?? request.goal);
    asset.refs = [...(request.inputs.roots ?? []), ...(request.inputs.candidates ?? [])];
    asset.data = { scope: request.goal, summary: '制作阶段计划；执行进度由操作回执和真实成果派生。', findings: [], evidence: [], production_task: { schema_version: 1, goal: request.goal, inputs: request.inputs, input_fingerprint: context.input_fingerprint, stages, assumptions: request.assumptions ?? [] } };
    const task = refOf(asset);
    saveItem(resolved, project, { asset, files }, { action: 'production-task', reason: '创建制作计划', record: { task, request_id: requestId, request_hash: requestHash } });
    project = load(resolved);
    return { ...planStatus(resolved, project, task), action: 'create-production-task', reused: false };
  });
}

export function importProductionResults({ project: root, request }) {
  requestObject(request, ['task', 'stage_id', 'batch_id', 'assets', 'summary']);
  if (!filled(request.batch_id) || !filled(request.stage_id) || !filled(request.summary)) fail('需要 batch_id、stage_id 和真实成果摘要 summary');
  return withLock(root, resolved => {
    let project = load(resolved);
    const status = planStatus(resolved, project, request.task), stage = status.stages.find(item => item.id === request.stage_id);
    ensureNoErrors(status.errors);
    if (!stage) fail('stage_id 不在制作计划内');
    const payloadHash = digest(request);
    const receipts = (project.operations ?? []).filter(item => sameTask(item, request.task) && item.stage_id === stage.id && item.batch_id === request.batch_id && ['production-import', 'production-result'].includes(item.action));
    if (receipts.some(item => item.payload_hash !== payloadHash)) fail('相同 batch_id 已绑定不同成果；修订请使用新批次和明确新版本');
    const finished = receipts.find(item => item.action === 'production-result');
    if (finished) {
      for (const ref of finished.outputs) if (readRef(resolved, project, ref).saved.manifest_sha256 !== ref.manifest_sha256) fail('历史成果回执校验失败');
      return { ok: true, action: 'import-production-results', reused: true, outputs: finished.outputs, status };
    }
    if (receipts.some(item => item.upstream_fingerprint !== stage.upstream_fingerprint)) fail('未完成批次的上游已变化，不能把旧成果标成新依据；请审核修订已保存成果并使用新批次');
    if (stage.status === '等待上游') fail('前序阶段尚未完成真实审核及采用，不能登记本阶段');
    const items = normalizedItems(resolved, project, request.assets, stage, request.task), outputs = [];
    const revisedIds = new Set(items.map(item => item.asset.asset_id));
    const quality = checkProduction({ project: resolved, request: { assets: items, refs: stage.outputs.filter(ref => !revisedIds.has(ref.asset_id)).map(refOf) } });
    if (!quality.ok) return { ok: false, action: 'import-production-results', outputs, quality, errors: ['制作质检未通过；请先修复确定的问题，再用新成果批次登记。'], warnings: ['本次检查未新增成果；如原批次已有部分保存，原结果继续保留。'] };
    try {
      for (const item of items) {
        const previous = receipts.find(record => record.action === 'production-import' && referenceKey(record.output) === referenceKey(item.asset));
        if (previous) {
          if (readRef(resolved, project, previous.output).saved.manifest_sha256 !== previous.output.manifest_sha256) fail('已登记成果快照与回执不一致');
          outputs.push(previous.output); continue;
        }
        project = load(resolved);
        outputs.push(saveItem(resolved, project, item, { action: 'production-import', reason: request.summary, record: { task: refOf(request.task), stage_id: stage.id, batch_id: request.batch_id, payload_hash: payloadHash, upstream_fingerprint: stage.upstream_fingerprint } }));
      }
      project = load(resolved);
      operation(project, 'production-result', { task: refOf(request.task), stage_id: stage.id, batch_id: request.batch_id, payload_hash: payloadHash, upstream_fingerprint: stage.upstream_fingerprint, outputs, summary: request.summary });
      commit(resolved, project, { action: 'production-result' });
      return { ok: true, action: 'import-production-results', reused: false, outputs, quality, status: planStatus(resolved, load(resolved), request.task), message: '成果已保存为冻结版本；接下来由 AI 实际审核，按原有规则采用。' };
    } catch (error) {
      return { ok: false, action: 'import-production-results', outputs, errors: [error.message], warnings: ['已完成的成果保留；相同请求可续跑。修改成果内容须使用新的 batch_id，已保存的版本不能覆盖。'] };
    }
  });
}
