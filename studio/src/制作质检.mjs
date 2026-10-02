import fs from 'node:fs';
import path from 'node:path';
import { readProject, readSnapshot, registryErrors } from './registry.mjs';
import { inspectAsset, inspectCandidateAsset, collectRefs } from './asset-validation.mjs';
import { playbackTimelineIssues } from './dependencies.mjs';
import { compileShotPrompts } from './提示词编译.mjs';
import { resolveContinuityState, selectContinuityEntities } from './连续性状态.mjs';
import { visualContractErrors } from './创作执行约束.mjs';
import { ASSET_ID, VERSION, CHAPTER_FILES, object, concrete, hash, jsonText, referenceKey } from './rules.mjs';

const CHECKER_VERSION = '1.1.1';
const PROMPT_FIELDS = ['image_prompt', 'end_frame_prompt', 'video_prompt', 'negative_prompt'];
const PROMPT_TEXT_FILES = ['镜头通用提示词.txt', '首帧提示词.txt', '尾帧提示词.txt', '视频提示词.txt'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)) ?? 'undefined');
const copy = value => structuredClone(value);
const refOf = asset => ({ asset_id: asset.asset_id, version: asset.version });
const loc = (asset, field, value) => ({ ...refOf(asset), field, ...(value === undefined ? {} : { value: copy(value) }) });
const usefulText = value => typeof value === 'string' && concrete(value) && !/^\s*[\[{]/.test(value) ? value.trim() : '';
const absent = value => value === undefined || value === null || typeof value === 'string' && !value.trim() || Array.isArray(value) && value.length === 0 || object(value) && Object.keys(value).length === 0;

function issueFactory(issues) {
  return (rule, description, locations = [], evidence = description, severity = 'blocker', repair = { kind: 'host_ai' }, certainty = 'certain') => {
    const identity = { rule, locations: locations.map(({ asset_id, version, field }) => ({ asset_id, version, field })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')) };
    const item = { id: `CHECK-${digest(identity).slice(0, 24)}`, rule, severity, status: 'open', description, evidence: typeof evidence === 'string' ? evidence : JSON.stringify(canonical(evidence)), locations, evidence_sha256: digest({ locations, evidence }), repair, certainty };
    // Multiple schema diagnostics for the same field still have distinct stable identities.
    if (issues.some(other => other.id === item.id && other.evidence !== item.evidence)) item.id = `CHECK-${digest({ ...identity, evidence: item.evidence }).slice(0, 24)}`;
    if (!issues.some(other => other.id === item.id)) issues.push(item);
    return item;
  };
}

function schemaField(message) {
  return String(message).match(/(?:data\.)?(episode_number|target_duration_seconds|scene_number|shot_number|start_seconds|duration_seconds|source_refs|chapter_refs|character_refs|reference_bindings|entry_state|exit_state|video_prompt|image_prompt|negative_prompt|episode|scene|location|events|refs)(?:\[[^\]]*\])?(?:\.[A-Za-z_]+)?/)?.[0] ?? 'asset';
}

function prepare(projectPath, request, add) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('project 需要实际项目目录');
  if (!object(request)) throw new Error('request 需要对象');
  for (const key of Object.keys(request)) if (!['assets', 'refs', 'complete_episodes'].includes(key)) throw new Error(`检查请求不接受字段 ${key}`);
  for (const key of ['assets', 'refs', 'complete_episodes']) if (request[key] !== undefined && !Array.isArray(request[key])) throw new Error(`${key} 必须为数组`);
  if (!(request.assets?.length || request.refs?.length || request.complete_episodes?.length)) throw new Error('需要 assets、refs 或 complete_episodes 中至少一个明确对象');
  const root = path.resolve(projectPath), project = readProject(root), cache = new Map(), candidates = new Map(), selected = new Map();
  for (const error of registryErrors(root, project)) add('schema.invalid', error, [], error);
  const exact = ref => {
    if (!object(ref) || !ASSET_ID.test(ref.asset_id ?? '') || !VERSION.test(ref.version ?? '')) throw new Error('引用需要有效 asset_id 和精确 version');
    if (!ref.asset_id.startsWith(`${project.project_id}-`)) throw new Error(`拒绝跨 IP 引用 ${ref.asset_id}`);
    return ref;
  };
  for (const [index, item] of (request.assets ?? []).entries()) {
    if (!object(item) || !object(item.asset) || !object(item.files)) { add('input.invalid_candidate', `assets[${index}] 需要完整 asset 与 files 对象`, [], `assets[${index}]`); continue; }
    try { exact(item.asset); } catch (error) { add('schema.invalid', error.message, [loc(item.asset, 'asset_id/version')], error.message); continue; }
    const asset = item.asset, key = referenceKey(asset);
    if (candidates.has(key) || [...candidates.values()].some(other => other.asset.asset_id === asset.asset_id)) { add('input.duplicate_candidate', '同批次不能多次提供同一资产', [loc(asset, 'version')]); continue; }
    if (asset.type === 'MEDIA') { add('input.media_candidate', '实际 MEDIA 必须使用已冻结文件版本，不接受文字候选冒充媒体', [loc(asset, 'type')]); continue; }
    if (item.base_version !== undefined && !VERSION.test(item.base_version)) add('schema.invalid', 'base_version 必须为精确版本', [loc(asset, 'base_version', item.base_version)]);
    candidates.set(key, item); selected.set(key, { asset, candidate: true, item });
    const files = { 'asset.json': { sha256: hash(jsonText(asset)), size: Buffer.byteLength(jsonText(asset)) } };
    for (const [filename, content] of Object.entries(item.files)) if (typeof content === 'string') files[filename.replaceAll('\\', '/')] = { sha256: hash(content), size: Buffer.byteLength(content) };
    const entry = project.assets.find(entry => entry.asset_id === asset.asset_id);
    if (entry?.versions.some(saved => saved.version === asset.version)) {
      const saved = readSnapshot(root, project, asset.asset_id, asset.version, cache);
      if (digest(saved.asset) !== digest(asset) || digest(saved.manifest.files) !== digest(files)) add('input.version_conflict', '候选内容与同号冻结版本不同，不能遮盖正式精确引用；请使用新版本', [loc(asset, 'version')], { candidate: digest({ asset, files }), frozen: saved.saved.manifest_sha256 });
      continue;
    }
    const snapshot = { asset, manifest: { files }, saved: { manifest_sha256: digest({ asset, files }) }, entry: { asset_id: asset.asset_id, type: asset.type, adopted_version: null }, candidate: true };
    cache.set(key, snapshot);
  }
  const resolveAsset = ref => {
    exact(ref); const key = referenceKey(ref);
    // Media always comes from an actual frozen snapshot.
    const snapshot = readSnapshot(root, project, ref.asset_id, ref.version, ref.asset_id.split('-')[1] === 'MEDIA' ? new Map() : cache);
    if (snapshot.asset.type !== ref.asset_id.split('-')[1]) throw new Error(`${key}：引用类型与资产身份不一致`);
    if (ref.event_id !== undefined && (snapshot.asset.type !== 'CH' || !snapshot.asset.data.events?.some(event => event.event_id === ref.event_id))) throw new Error(`${key}：来源事件 ${String(ref.event_id)} 不存在`);
    cache.set(key, snapshot); return snapshot;
  };
  for (const ref of [...(request.refs ?? []), ...(request.complete_episodes ?? [])]) {
    try {
      const snapshot = resolveAsset(ref), key = referenceKey(ref);
      if (!selected.has(key)) selected.set(key, snapshot);
    } catch (error) { add('schema.invalid', error.message, object(ref) ? [loc(ref, 'reference')] : [], error.message); }
  }
  const graph = new Map();
  for (const [key, item] of candidates) {
    const references = [], errors = [];
    collectRefs(item.asset, 'asset', references, errors, { skipIdentity: true });
    for (const [filename, content] of Object.entries(item.files)) if (filename.toLowerCase().endsWith('.json') && typeof content === 'string') {
      // Only the standard chapter documents define their root as the owning chapter's identity.
      const chapterDocument = item.asset.type === 'CH' && CHAPTER_FILES.includes(filename.replaceAll('\\', '/'));
      try { collectRefs(JSON.parse(content), filename, references, errors, { skipIdentity: chapterDocument }); } catch { errors.push(`${filename} 不是有效 JSON`); }
    }
    for (const error of errors) add('schema.invalid', error, [loc(item.asset, schemaField(error))], error);
    for (const { ref, location } of references) try { resolveAsset(ref); } catch (error) { add('schema.invalid', error.message, [loc(item.asset, location)], error.message); }
    graph.set(key, references.filter(({ ref }) => candidates.has(referenceKey(ref))).map(({ ref }) => referenceKey(ref)));
  }
  const done = new Set(), active = new Set();
  const visit = key => {
    if (active.has(key)) { add('schema.reference_cycle', '候选资产形成循环或自引用，不能进入正式生产链', [loc(candidates.get(key).asset, 'refs')], [...active, key]); return; }
    if (done.has(key)) return;
    active.add(key); for (const dependency of graph.get(key) ?? []) visit(dependency); active.delete(key); done.add(key);
  };
  for (const key of graph.keys()) visit(key);
  return { root, project, cache, candidates, selected, resolveAsset, request };
}

function promptCompilation(context, asset) {
  const data = asset.data ?? {};
  if (!object(data.compilation)) return { managed: false, reason: '没有编译来源的手写提示词保留，交宿主 AI 审查' };
  if ((data.shot_refs ?? []).some?.(ref => referenceKey(ref) !== referenceKey(data.shot ?? {}))) return { managed: false, reason: '多镜提示词不使用单镜编译器覆盖' };
  const target = Object.fromEntries(['platform', 'model', 'input_mode'].filter(key => usefulText(data[key])).map(key => [key, data[key]]));
  const request = { shot: data.shot, target, assets: data.asset_refs ?? [], reference_bindings: data.reference_bindings ?? [] };
  const result = compileShotPrompts({ project: context.root, request, resolveAsset: context.resolveAsset });
  const recorded = data.compilation.output_sha256;
  const hashesKnown = object(recorded) && PROMPT_FIELDS.every(key => typeof recorded[key] === 'string');
  const editedFields = hashesKnown ? PROMPT_FIELDS.filter(key => typeof data[key] !== 'string' || hash(data[key]) !== recorded[key]) : [];
  const selected = context.selected.get(referenceKey(asset)), candidate = context.candidates.get(referenceKey(asset));
  const files = candidate?.files ?? Object.fromEntries([...PROMPT_TEXT_FILES, '编译依据.json'].filter(name => Object.hasOwn(selected?.manifest?.files ?? {}, name)).map(name => [name, fs.readFileSync(path.join(selected.directory, name), 'utf8')]));
  const editedFiles = [], unknownFiles = [];
  for (const filename of PROMPT_TEXT_FILES) if (Object.hasOwn(files, filename)) {
    if (typeof data.compilation.file_sha256?.[filename] !== 'string') unknownFiles.push(filename);
    else if (typeof files[filename] !== 'string' || hash(files[filename]) !== data.compilation.file_sha256[filename]) editedFiles.push(filename);
  }
  if (Object.hasOwn(files, '编译依据.json')) {
    try {
      const evidence = JSON.parse(files['编译依据.json']);
      if (evidence.project_id !== context.project.project_id || digest(evidence.compilation) !== digest(data.compilation) || digest(evidence.inputs) !== data.compilation.input_sha256) editedFiles.push('编译依据.json');
    } catch { editedFiles.push('编译依据.json'); }
  }
  const edited = editedFields.length > 0 || editedFiles.length > 0;
  const changed = result.ok ? PROMPT_FIELDS.filter(key => data[key] !== result.prompt_data[key]) : [];
  const provenanceChanged = result.ok && (data.compilation.version !== result.compilation.version || typeof data.compilation.content_sha256 === 'string' && data.compilation.content_sha256 !== result.compilation.content_sha256);
  return { managed: true, result, hashesKnown, edited, editedFields, editedFiles, unknownFiles, changed, provenanceChanged };
}

function resolvePoint(context, asset, phase) {
  const continuity = asset.data?.continuity;
  if (!object(continuity) || !object(continuity[phase])) return null;
  const resolved = resolveContinuityState({ project: context.root, request: { point: continuity[phase], timeline: continuity.timeline }, resolveAsset: context.resolveAsset });
  if (asset.type !== 'SHOT') return resolved;
  // Match the compiler's SHOT visual seeds; general refs retain dependencies, not visibility.
  const seeds = [...(Array.isArray(asset.data.character_refs) ? asset.data.character_refs : []), ...(Array.isArray(asset.data.asset_visuals) ? asset.data.asset_visuals.map(item => item.asset) : [])];
  try { const location = context.resolveAsset(asset.data.scene).asset.data.location; if (location) seeds.unshift(location); } catch { /* schema diagnostics retain broken scene refs */ }
  const entities = new Map(), active = new Set(), visited = new Set();
  const visit = reference => {
    const visual = context.resolveAsset(reference).asset, key = referenceKey(visual);
    if (!['CHAR', 'LOC', 'PROP'].includes(visual.type)) throw new Error(`${key} 不是可见 CHAR/LOC/PROP 实体`);
    const previous = entities.get(visual.asset_id);
    if (previous && previous.version !== visual.version) throw new Error(`${visual.asset_id} 同时提供多个视觉版本，不能合并状态`);
    if (active.has(key)) throw new Error(`固定视觉组件形成循环：${[...active, key].join(' → ')}`);
    if (visited.has(key)) return;
    if (active.size >= 64) throw new Error('固定视觉组件嵌套超过64层，请缩短资产决策链');
    const shapeErrors = visualContractErrors(visual);
    if (shapeErrors.length) throw new Error(`${key}：${shapeErrors.join('；')}`);
    entities.set(visual.asset_id, refOf(visual)); active.add(key);
    for (const component of visual.data.visual_base?.components ?? []) visit(component.asset);
    active.delete(key); visited.add(key);
  };
  for (const seed of seeds) visit(seed);
  return selectContinuityEntities(resolved, [...entities.values()]);
}

function boundaryInfo(context, point) {
  if (!object(point)) return null;
  const state = context.resolveAsset(point.state).asset;
  if (point.phase === 'initial') return { state, position: -1, change: null };
  const index = state.data?.change_order?.indexOf(point.change_id);
  if (!Number.isInteger(index) || index < 0 || !['before', 'after'].includes(point.phase)) return null;
  return { state, position: index * 2 + (point.phase === 'after' ? 1 : 0), change: state.data.changes.find(change => change.change_id === point.change_id) };
}

function checkContext(context, add) {
  const { root, project, cache, candidates, selected } = context;
  const assets = [...selected.values()].map(item => item.asset), resolutions = new Map();
  for (const item of selected.values()) {
    const asset = item.asset;
    try {
      const candidate = candidates.get(referenceKey(asset));
      const inspected = candidate ? inspectCandidateAsset(root, project, asset, candidate.files, { cache, strict: true }) : inspectAsset(root, project, item.entry, item.directory, { cache, strict: true });
      for (const error of inspected.errors) add('schema.invalid', typeof error === 'string' ? error : error.message, [loc(asset, typeof error === 'object' ? error.field ?? 'asset' : schemaField(error))], error);
      for (const warning of inspected.warnings) add('schema.warning', warning, [loc(asset, 'asset')], warning, 'suggestion', { kind: 'host_ai' }, 'unknown');
    } catch (error) { add('schema.invalid', error.message, [loc(asset, 'asset')], error.message); }
    const data = asset.data;
    if (!object(data)) continue;
    if (asset.type === 'STATE') {
      const declared = ['timeline', 'initial_states', 'base_state', 'change_order'].some(field => Object.hasOwn(data, field)) || data.changes?.some?.(change => object(change) && (Object.hasOwn(change, 'entity') || Object.hasOwn(change, 'change_id')));
      if (!declared) add('continuity.unstructured_state', '旧 STATE 仅保留文字事件证据，尚不能自动求值', [loc(asset, 'data')], '不按 changes 数组顺序猜测状态', 'suggestion', { kind: 'host_ai' }, 'unknown');
      else {
        const last = Array.isArray(data.change_order) ? data.change_order.at(-1) : null;
        const point = { state: refOf(asset), ...(last ? { change_id: last, phase: 'after' } : { phase: 'initial' }) };
        const resolved = resolveContinuityState({ project: root, request: { point, timeline: data.timeline }, resolveAsset: context.resolveAsset });
        for (const issue of (resolved.issues ?? []).filter(issue => issue.code !== 'unresolved-state')) add(`continuity.${issue.code ?? 'invalid'}`, issue.message ?? 'STATE 结构状态无法求值', [loc(asset, issue.path ?? 'data')], issue);
        if (!resolved.complete) add('continuity.state_unknown', 'STATE 完整变更链仍有未决属性', [loc(asset, 'data')], resolved.unresolved ?? [], 'suggestion', { kind: 'host_ai' }, 'unknown');
      }
    }
    if (asset.type === 'EP' && data.target_duration_seconds !== undefined && data.target_duration_seconds !== null && (!Number.isFinite(data.target_duration_seconds) || data.target_duration_seconds <= 0)) add('script.invalid_target_duration', '分集目标时长必须为正数', [loc(asset, 'data.target_duration_seconds', data.target_duration_seconds)]);
    if (['EP', 'SC'].includes(asset.type)) {
      const fields = asset.type === 'EP' ? ['summary', 'script'] : ['script', 'action'];
      if (!fields.some(field => usefulText(data[field]))) add('script.content_unknown', '剧本内容尚不足以进行因果、动机与台词审核', [loc(asset, `data.${fields.join('/')}`)], '结构引用存在不能证明剧本已写完', 'suggestion', { kind: 'host_ai' }, 'unknown');
    }
    if (['EP', 'SC', 'SHOT'].includes(asset.type)) {
      if (!object(data.continuity)) add('continuity.unstructured', '未声明结构化连续性时点；文字状态由宿主 AI 回查', [loc(asset, 'data.continuity')], '不从自由文本或 STATE 数组顺序判断当前状态', 'suggestion', { kind: 'host_ai' }, 'unknown');
      else for (const phase of ['entry', 'exit']) {
        try {
          const resolved = resolvePoint(context, asset, phase);
          if (!resolved) { add('continuity.point_missing', '连续性时点尚未声明', [loc(asset, `data.continuity.${phase}`)], phase, 'suggestion', { kind: 'host_ai' }, 'unknown'); continue; }
          resolutions.set(`${referenceKey(asset)}:${phase}`, resolved);
          for (const issue of (resolved.issues ?? []).filter(issue => issue.code !== 'unresolved-state')) add(`continuity.${issue.code ?? 'invalid'}`, issue.message ?? '连续性状态引用错误', [loc(asset, `data.continuity.${phase}`)], issue);
          if (!resolved.complete) add('continuity.state_unknown', '结构化时点仍有未决状态，不能声称连续性通过', [loc(asset, `data.continuity.${phase}`)], resolved.unresolved ?? [], 'suggestion', { kind: 'host_ai' }, 'unknown');
        } catch (error) { add('continuity.invalid', error.message, [loc(asset, `data.continuity.${phase}`)], error.message); }
      }
      if (object(data.continuity)) try {
        const entry = boundaryInfo(context, data.continuity.entry), exit = boundaryInfo(context, data.continuity.exit);
        if (entry && exit && referenceKey(entry.state) === referenceKey(exit.state) && exit.position < entry.position) add('continuity.reversed_boundaries', '同一 STATE 的出口早于入口，不能倒序继承状态', [loc(asset, 'data.continuity.entry', data.continuity.entry), loc(asset, 'data.continuity.exit', data.continuity.exit)], { entry_order: entry.position, exit_order: exit.position });
        if (asset.type === 'SHOT' && entry && exit) {
          if (referenceKey(entry.state) !== referenceKey(exit.state)) add('continuity.cross_state_order_unknown', '镜头起止使用不同 STATE，保持明确状态链，跨链变化范围仍需 AI 核对', [loc(asset, 'data.continuity.entry'), loc(asset, 'data.continuity.exit')], '不把历史继承错误判为未来事件', 'suggestion', { kind: 'host_ai' }, 'unknown');
          else if (exit.position >= entry.position) {
            const crossed = exit.state.data.change_order.filter((_, index) => index * 2 + 1 > entry.position && index * 2 + 1 <= exit.position).map(id => exit.state.data.changes.find(change => change.change_id === id));
            const unsupported = crossed.filter(change => !data.source_refs?.some(ref => referenceKey(ref) === referenceKey(change.event_ref) && ref.event_id === change.event_ref.event_id));
            if (unsupported.length) add('continuity.exit_source_mismatch', '镜头起止间实际经过的状态变更事件不在本镜来源中，可能提前使用了状态', [loc(asset, 'data.continuity.entry', data.continuity.entry), loc(asset, 'data.continuity.exit', data.continuity.exit), loc(asset, 'data.source_refs', data.source_refs)], { changes: unsupported.map(change => ({ change_id: change.change_id, event_ref: change.event_ref })) }, 'revision', { kind: 'host_ai' });
          }
        }
      } catch { /* malformed references and point errors already have exact diagnostics */ }
    }
    if (asset.type === 'SHOT') {
      const compiled = compileShotPrompts({ project: root, request: { shot: asset }, resolveAsset: context.resolveAsset });
      if (!compiled.ok) for (const error of compiled.errors) {
        const fixedContract = /固定视觉|固定组件|components|locked/u.test(error);
        add(fixedContract ? 'visual.fixed_contract_invalid' : 'prompt.input_invalid', error, [loc(asset, fixedContract ? 'data.asset_visuals/visual_base' : schemaField(error))], error, !fixedContract && compiled.missing_fields?.length ? 'suggestion' : 'revision', { kind: 'host_ai' }, !fixedContract && compiled.missing_fields?.length ? 'unknown' : 'certain');
      }
    }
    if (asset.type === 'PROMPT') {
      try {
        const compiled = promptCompilation(context, asset);
        if (!compiled.managed) add('prompt.manual_review', compiled.reason, [loc(asset, 'data.video_prompt')], compiled.reason, 'suggestion', { kind: 'host_ai' }, 'unknown');
        else if (!compiled.result.ok) for (const error of compiled.result.errors) add('prompt.compile_invalid', error, [loc(asset, 'data.shot/compilation')], error, 'revision');
        else {
          if (!compiled.hashesKnown) add('prompt.provenance_unknown', '旧编译记录没有输出哈希，不能确认正文是否经过另行编辑', [loc(asset, 'data.compilation.output_sha256')], '可复算但不自动覆盖旧稿', 'suggestion', { kind: 'host_ai' }, 'unknown');
          if (compiled.unknownFiles.length) add('prompt.attachment_provenance_unknown', '旧编译附件没有输出哈希，不自动覆盖现存附件', compiled.unknownFiles.map(name => loc(asset, `files.${name}`)), compiled.unknownFiles, 'suggestion', { kind: 'host_ai' }, 'unknown');
          if (compiled.edited) add('prompt.edited_output', '正文或附件与登记的编译依据不同；保留修改稿供 AI 核查', [loc(asset, 'data.compilation.output_sha256/file_sha256')], { fields: compiled.editedFields, files: compiled.editedFiles }, 'revision', { kind: 'host_ai' });
          if (compiled.changed.length) add('prompt.derived_mismatch', '派生提示词与当前明确输入的复算正文不同', compiled.changed.map(field => loc(asset, `data.${field}`)), { changed: compiled.changed }, 'revision', { kind: compiled.hashesKnown && !compiled.edited && !compiled.unknownFiles.length ? 'deterministic' : 'host_ai', operation: 'recompile_prompt' });
          if (compiled.provenanceChanged) add('prompt.provenance_stale', '编译器版本或明确输入内容已变化，编译依据需要刷新', [loc(asset, 'data.compilation.content_sha256/version')], { previous: { version: data.compilation.version, content_sha256: data.compilation.content_sha256 }, current: { version: compiled.result.compilation.version, content_sha256: compiled.result.compilation.content_sha256 } }, 'revision', { kind: compiled.hashesKnown && !compiled.edited && !compiled.unknownFiles.length ? 'deterministic' : 'host_ai', operation: 'recompile_prompt' });
        }
      } catch (error) { add('prompt.compile_invalid', error.message, [loc(asset, 'data.shot')], error.message, 'revision'); }
    }
  }
  const playbackAssets = new Map(assets.map(asset => [referenceKey(asset), asset]));
  for (const asset of assets) if (['SHOT', 'SC'].includes(asset.type)) for (const field of ['episode', ...(asset.type === 'SHOT' ? ['scene'] : [])]) {
    try { const upstream = context.resolveAsset(asset.data?.[field]).asset; playbackAssets.set(referenceKey(upstream), upstream); } catch { /* schema already reports invalid hierarchy */ }
  }
  for (const issue of playbackTimelineIssues([...playbackAssets.values()])) add(issue.rule, issue.description, issue.locations ?? [], issue.evidence ?? issue.description);
  for (const reference of context.request.complete_episodes ?? []) {
    let episode;
    try { episode = context.resolveAsset(reference).asset; } catch { continue; }
    if (episode.type !== 'EP') { add('scope.invalid_episode', 'complete_episodes 只接受 EP 精确引用', [loc(episode, 'type')]); continue; }
    const shots = assets.filter(asset => asset.type === 'SHOT' && referenceKey(asset.data?.episode ?? {}) === referenceKey(episode));
    if (!shots.length) { add('storyboard.missing_shots', '已声明完整分集范围，但没有该版本的镜头', [loc(episode, 'complete_episodes')]); continue; }
    const expected = episode.data.target_duration_seconds;
    if (Number.isFinite(expected) && expected > 0 && shots.every(shot => Number.isFinite(shot.data.start_seconds) && Number.isFinite(shot.data.duration_seconds))) {
      const actual = Math.max(...shots.map(shot => shot.data.start_seconds + shot.data.duration_seconds));
      if (Math.abs(actual - expected) > 1e-8) add('storyboard.target_duration_mismatch', '完整分集的规划结束时间与目标时长不同', [loc(episode, 'data.target_duration_seconds', expected), ...shots.map(shot => loc(shot, 'data.start_seconds/duration_seconds', { start: shot.data.start_seconds, duration: shot.data.duration_seconds }))], { target_seconds: expected, planned_end_seconds: actual, measured_media: false }, 'revision', { kind: 'host_ai' });
    }
  }
  const shots = assets.filter(asset => asset.type === 'SHOT' && object(asset.data)), groups = new Map(), pairs = [];
  for (const shot of shots) { const key = referenceKey(shot.data.episode ?? {}); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(shot); }
  for (const group of groups.values()) {
    group.sort((a, b) => a.data.start_seconds - b.data.start_seconds || a.asset_id.localeCompare(b.asset_id, 'en'));
    for (let index = 1; index < group.length; index++) pairs.push([group[index - 1], group[index]]);
    const first = group[0], boundary = first.data.continuity;
    if (boundary?.link !== 'continuous') continue;
    const possible = shots.filter(other => referenceKey(other.data.episode ?? {}) !== referenceKey(first.data.episode ?? {}) && other.data.continuity?.timeline === boundary.timeline && digest(other.data.continuity?.exit) === digest(boundary.entry));
    if (possible.length === 1) pairs.push([possible[0], first]);
    else add('continuity.episode_order_unknown', '跨集连续镜头没有唯一精确的前镜状态边界，保留待核查', [loc(first, 'data.continuity.entry')], { matching_predecessors: possible.map(refOf), note: '不按资产编号或集号推断跨集故事相邻' }, 'suggestion', { kind: 'host_ai' }, 'unknown');
  }
  for (const [previous, next] of pairs) {
    const left = previous.data.continuity, right = next.data.continuity;
    if (!object(left) || !object(right)) continue;
    if (right.link === 'cut') continue;
    const sameScene = referenceKey(previous.data.scene ?? {}) === referenceKey(next.data.scene ?? {});
    const sameEpisode = referenceKey(previous.data.episode ?? {}) === referenceKey(next.data.episode ?? {});
    if ((!sameScene || !sameEpisode) && right.link !== 'continuous') { add('continuity.transition_unknown', '跨场或跨集衔接未声明连续，不自动比较故事状态', [loc(previous, 'data.continuity.exit'), loc(next, 'data.continuity.link')], '回忆、时间跳跃和普通转场需宿主 AI 判断', 'suggestion', { kind: 'host_ai' }, 'unknown'); continue; }
    if (!usefulText(left.timeline) || left.timeline !== right.timeline) { add('continuity.timeline_unknown', '相邻镜头没有相同的明确时间线，不自动比较', [loc(previous, 'data.continuity.timeline'), loc(next, 'data.continuity.timeline')], '不同时间线不能互相覆盖状态', 'suggestion', { kind: 'host_ai' }, 'unknown'); continue; }
    const before = resolutions.get(`${referenceKey(previous)}:exit`), after = resolutions.get(`${referenceKey(next)}:entry`);
    if (!before?.complete || !after?.complete) continue;
    const prior = new Map(before.states.map(state => [referenceKey(state.entity), state]));
    for (const state of after.states) {
      const old = prior.get(referenceKey(state.entity)); if (!old) continue;
      for (const [field, value] of Object.entries(state.values)) if (Object.hasOwn(old.values, field) && digest(value) !== digest(old.values[field])) add('continuity.state_conflict', '连续镜头出口与入口的已知结构状态冲突', [loc(previous, `data.continuity.exit:${referenceKey(state.entity)}.${field}`, old.values[field]), loc(next, `data.continuity.entry:${referenceKey(state.entity)}.${field}`, value)], { entity: state.entity, property: field, previous: old.values[field], next: value, previous_source: old.provenance?.[field], next_source: state.provenance?.[field] });
    }
  }
}

function publicResult(context, issues, action = 'check-production') {
  issues.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const inputs = context ? { checker: CHECKER_VERSION, request: context.request, snapshots: [...context.cache.values()].filter(item => !item.candidate).map(item => ({ ...refOf(item.asset), manifest_sha256: item.saved.manifest_sha256 })).sort((a, b) => referenceKey(a).localeCompare(referenceKey(b), 'en')) } : null;
  const result = { ok: !issues.some(issue => ['blocker', 'revision'].includes(issue.severity)), action, project_id: context?.project.project_id ?? null, input_fingerprint: inputs ? digest(inputs) : null, checker_version: CHECKER_VERSION, issues, warnings: issues.filter(issue => issue.severity === 'suggestion').map(issue => issue.description), errors: issues.filter(issue => ['blocker', 'revision'].includes(issue.severity)).map(issue => issue.description), coverage: { assets: context ? [...context.selected.values()].map(item => refOf(item.asset)) : [], complete_episodes: copy(context?.request.complete_episodes ?? []), semantic_review: '未执行：剧情、表演、轴线、自由文本连续性与媒体质量须由宿主 AI 实际检查；未自动评价颜值、面部几何或视频稳定性' }, repair_request: { assets: issues.filter(issue => issue.repair.kind === 'host_ai').flatMap(issue => issue.locations).filter(location => location.asset_id), issues: issues.filter(issue => issue.repair.kind === 'host_ai').map(issue => ({ id: issue.id, rule: issue.rule, description: issue.description, evidence: issue.evidence, locations: issue.locations })) }, files: {} };
  result.files['制作质检.json'] = jsonText({ ...result, files: undefined });
  return result;
}

function runCheck(project, request) {
  const issues = [], add = issueFactory(issues); let context;
  try { context = prepare(project, request, add); checkContext(context, add); } catch (error) { add('input.invalid', error.message, [], error.message); }
  return { result: publicResult(context, issues), context };
}

/** Deterministic diagnostics only. It neither saves candidates nor records a content review. */
export function checkProduction({ project, request } = {}) { return runCheck(project, copy(request)).result; }

function renderState(context, resolved) {
  if (!resolved?.complete || !resolved.states?.length) return '';
  const name = reference => { try { const asset = context.resolveAsset(reference).asset; return usefulText(asset.data?.name) || usefulText(asset.title); } catch { return ''; } };
  const valueText = value => Array.isArray(value) ? value.length ? value.map(valueText).filter(Boolean).join('、') : '无' : object(value) ? name(value) : typeof value === 'boolean' ? value ? '是' : '否' : ['string', 'number'].includes(typeof value) ? String(value) : '';
  const labels = { clothing: '服装', outfit: '服装', injuries: '伤势', injury: '伤势', holding: '持物', holder: '持有人', possession: '持物', possessions: '持物', location: '地点', emotion: '情绪', position: '位置', pose: '姿态', weather: '天气', lighting: '光影', appearance: '外观', weapon: '武器' };
  const parts = [];
  for (const state of resolved.states) {
    const entity = name(state.entity); if (!entity) return '';
    const values = Object.entries(state.values).map(([field, value]) => ({ field, text: valueText(value) }));
    if (!values.length || values.some(item => !item.text)) return '';
    parts.push(`${entity}：${values.map(({ field, text }) => `${labels[field] ?? field}为${text}`).join('，')}`);
  }
  return parts.join('；');
}

function applySafeRepairs(context, patches) {
  let changes = 0;
  const set = (item, field, value, reason, sources = []) => {
    if (digest(item.asset.data[field]) === digest(value)) return;
    patches.push({ asset: refOf(item.asset), field: `data.${field}`, before: item.asset.data[field] === undefined ? null : copy(item.asset.data[field]), after: copy(value), reason, sources });
    item.asset.data[field] = copy(value); changes++;
  };
  for (const item of context.candidates.values()) {
    const asset = item.asset, data = asset.data;
    if (!object(data) || asset.type !== 'SHOT') continue;
    if (absent(data.episode) && object(data.scene)) {
      try { const scene = context.resolveAsset(data.scene).asset; if (scene.type === 'SC' && object(scene.data.episode)) { context.resolveAsset(scene.data.episode); set(item, 'episode', scene.data.episode, '从明确所属 SC 继承唯一 EP 精确引用', [refOf(scene)]); } } catch { /* retain diagnostic; never guess another scene */ }
    }
    for (const [field, sourceFields, phase] of [['entry_state', ['first_frame_description', 'first_frame', 'first_frame_state', 'first_frame_prompt'], 'entry'], ['exit_state', ['end_frame_description', 'last_frame_description'], 'exit']]) if (absent(data[field])) {
      const from = sourceFields.find(key => usefulText(data[key]));
      if (from) set(item, field, data[from], `从本镜已明确 ${from} 补等价可见状态`, [refOf(asset)]);
      else try { const text = renderState(context, resolvePoint(context, asset, phase)); if (text) set(item, field, text, '将已解析完整结构状态转写为文字，不增加新状态', [data.continuity[phase].state]); } catch { /* unresolved values remain for host AI */ }
    }
    if (absent(data.video_prompt) && usefulText(data.dialogue) && usefulText(data.emotion)) {
      const result = compileShotPrompts({ project: context.root, request: { shot: asset }, resolveAsset: context.resolveAsset });
      if (result.ok) set(item, 'video_prompt', result.shot_data.video_prompt, '仅补空的通用派生正文；不合并编译器对白或情绪默认值', [refOf(asset)]);
    }
  }
  for (const item of context.candidates.values()) if (item.asset.type === 'PROMPT') {
    try {
      const compiled = promptCompilation(context, item.asset);
      if (!compiled.managed || !compiled.result?.ok || !compiled.hashesKnown || compiled.edited || compiled.unknownFiles.length || !(compiled.changed.length || compiled.provenanceChanged)) continue;
      for (const field of [...PROMPT_FIELDS, 'compilation']) set(item, field, compiled.result.prompt_data[field], '重新编译明确来源的托管单镜派生内容，原输出哈希已匹配', [item.asset.data.shot]);
      for (const [filename, content] of Object.entries(compiled.result.files)) if (item.files[filename] !== content) {
        patches.push({ asset: refOf(item.asset), field: `files.${filename}`, before_sha256: typeof item.files[filename] === 'string' ? hash(item.files[filename]) : null, after_sha256: hash(content), reason: '同步该次编译的派生附件' });
        item.files[filename] = content; changes++;
      }
    } catch { /* keep failed compilation as an unresolved issue */ }
  }
  return changes;
}

/** Repairs operate on cloned candidates and must be imported through the existing versioned workflow. */
export function repairProduction({ project, request } = {}) {
  const received = copy(request), maxPasses = received?.max_passes ?? 2;
  if (!object(received) || !Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 3) return { ...publicResult(null, [issueFactory([])('input.invalid', 'max_passes 必须为 1—3 的整数')], 'repair-production'), assets: copy(received?.assets ?? []), patches: [], passes: 0 };
  const expected = received.expected_fingerprint; delete received.expected_fingerprint; delete received.max_passes;
  let { result: current, context } = runCheck(project, received); const before = copy(current), patches = [];
  if (expected !== undefined && (typeof expected !== 'string' || expected !== current.input_fingerprint)) {
    const issues = [...current.issues]; issueFactory(issues)('repair.stale_input', '修复请求指纹与当前候选或引用快照不同，拒绝应用旧修复', [], { expected, actual: current.input_fingerprint });
    return { ...publicResult(context, issues, 'repair-production'), assets: copy(received.assets ?? []), patches, passes: 0, before, after: current, unresolved: issues };
  }
  let passes = 0;
  const seen = new Set();
  while (context && passes < maxPasses && !seen.has(current.input_fingerprint)) {
    seen.add(current.input_fingerprint);
    if (current.issues.some(issue => ['input.version_conflict', 'input.duplicate_candidate', 'schema.reference_cycle', 'input.invalid_candidate', 'input.invalid'].includes(issue.rule))) break;
    const changes = applySafeRepairs(context, patches); if (!changes) break;
    passes++;
    ({ result: current, context } = runCheck(project, received));
  }
  const result = { ...current, action: 'repair-production', assets: copy(received.assets ?? []), patches, passes, before, after: copy(current), unresolved: copy(current.issues), message: '仅返回候选修订；未保存、未审核、未采用。语义问题由宿主 AI 依据原文处理，修订导入使用新 batch_id。', files: {} };
  result.files['修复候选.json'] = jsonText({ assets: result.assets });
  result.files['制作质检.json'] = jsonText({ ...result, files: undefined });
  return result;
}
