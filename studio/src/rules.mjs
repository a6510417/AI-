import crypto from 'node:crypto';

// Pure workflow helpers. Filesystem checks and durable writes belong to project-service.mjs.
export const ASSET_TYPES = Object.freeze(['WORLD', 'CHAR', 'LOC', 'PROP', 'PLOT', 'STATE', 'CH', 'EP', 'SC', 'SHOT', 'PROMPT', 'MEDIA', 'REPORT']);
const TYPE_PART = ASSET_TYPES.join('|');
export const ASSET_ID = new RegExp(`^IP\\d+-(${TYPE_PART})-\\d{3,}$`);
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH = /^[a-f0-9]{64}$/;
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const PLACEHOLDER = /^(?:〔待填|\[待填|待填|TODO\b|TBD\b|undefined\b|null\b|同上|见上|同前|待补|待写|占位)/i;
export const filled = value => typeof value === 'string' && value.trim().length > 0 && !PLACEHOLDER.test(value.trim());
export const nonemptyString = value => typeof value === 'string' && value.trim().length > 0;
const copy = value => JSON.parse(JSON.stringify(value));
export const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;
export const fail = message => { throw new Error(message); };

function text(value, field) {
  if (!filled(value)) fail(`${field} 必须填写具体内容，不能留空或使用待填占位`);
  return value.trim();
}
function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${field} 必须为带时区的 ISO 时间`);
  const calendarDay = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23) fail(`${field} 包含不存在的日期或时间`);
  return value;
}
function projectIdentity(projectId) {
  if (typeof projectId !== 'string' || !/^IP\d+$/.test(projectId)) fail('project_id 必须为 IP 加数字');
  return projectId;
}
function assetIdentity(assetId, version, projectId, label = '资产') {
  if (typeof assetId !== 'string' || !ASSET_ID.test(assetId)) fail(`${label} asset_id 格式无效`);
  if (projectId && !assetId.startsWith(`${projectId}-`)) fail(`${label} 不能跨 IP`);
  if (typeof version !== 'string' || !VERSION.test(version)) fail(`${label} version 必须为三段数字`);
  return { asset_id: assetId, version };
}
function enumValue(value, values, aliases, field) {
  const normalized = typeof value === 'string' ? value.trim() : value;
  const translated = aliases[normalized] ?? normalized;
  if (!values.includes(translated)) fail(`${field} 仅允许 ${values.join('、')}`);
  return translated;
}
function methodOf(input) {
  if (Object.hasOwn(input, 'reviewer_kind')) fail('请使用 method 字段，不接受 reviewer_kind');
  return enumValue(input.method, ['ai', 'human'], { AI: 'ai', 人工: 'human' }, 'method');
}
function equalityWhenProvided(input, key, expected) {
  if (input[key] !== undefined && input[key] !== expected) fail(`${key} 与指定的确切资产／版本或记录上下文不一致`);
}

/** Produce editable drafts, never fabricated references, events, media, or approvals. */
export function createAssetSkeleton({ projectId, type, sequence, title = '', version = '1.0.0' }) {
  projectIdentity(projectId);
  if (!ASSET_TYPES.includes(type)) fail(`type 仅允许 ${ASSET_TYPES.join('、')}`);
  if (!((typeof sequence === 'number' && Number.isSafeInteger(sequence)) || (typeof sequence === 'string' && /^\d+$/.test(sequence))) || !Number.isSafeInteger(Number(sequence)) || Number(sequence) <= 0) fail('sequence 必须为正整数');
  if (typeof title !== 'string') fail('title 必须为字符串');
  const assetId = `${projectId}-${type}-${String(sequence).padStart(3, '0')}`;
  assetIdentity(assetId, version, projectId);
  const dataByType = {
    WORLD: { premise: '', rules: [], geography: [], factions: [], abilities: [], era: '', constraints: [] },
    CHAR: { name: '', identity: '', age: null, motivation: '', flaw: '', growth: '', knowledge: [], relationships: [], appearance: '', image_prompt: '', video_prompt: '', consistency_rules: [] },
    LOC: { description: '', architecture: '', space: '', time: '', weather: '', lighting: '', atmosphere: '', image_prompt: '', video_prompt: '' },
    PROP: { name: '', description: '', initial_holder: '', initial_location: '', transfer_rules: [], visual_description: '' },
    PLOT: { premise: '', audience: '', theme: '', reading_mode: '', engine: '', relationship_debts: [], arcs: [], chapters: [], foreshadowing: [], must_keep: [] },
    STATE: { changes: [], world_state: '', character_state: '', plot_state: '', knowledge: [], possessions: [], foreshadowing: [] },
    CH: { chapter_number: null, events: [], entry_state: '', exit_state: '' },
    EP: { episode_number: null, chapter_refs: [], summary: '', target_duration_seconds: null, five_beats: { opening: '', conflict: '', escalation: '', climax: '', aftermath: '' }, entry_state: '', exit_state: '' },
    SC: { scene_number: null, episode: null, location: null, source_refs: [], story_time: '', characters: [], action: '', script: '', entry_state: '', exit_state: '' },
    SHOT: { episode: null, scene: null, source_refs: [], shot_number: null, start_seconds: null, duration_seconds: null, story_time: '', scene_description: '', characters: '', character_refs: [], action: '', emotion: '', dialogue: '', shot_size: '', camera_movement: '', lighting: '', video_prompt: '', visual_description: '', entry_state: '', exit_state: '', duration_basis: '', photography: { view: '', focus: '', movement: '', rhythm: '' }, sound: '' },
    PROMPT: { shot: null, image_prompt: '', video_prompt: '', negative_prompt: '', optimization: '', platform: '', model: '', input_mode: '', media_refs: [] },
    MEDIA: { files: [], description: '', purpose: '', source_refs: [], generation_record: '' },
    REPORT: { scope: '', summary: '', findings: [], evidence: [] },
  };
  const asset = { schema_version: 1, project_id: projectId, asset_id: assetId, type, title, version, source_kind: '原创创作', adoption_status: '建议', refs: [], data: copy(dataByType[type]) };
  const files = {};
  if (type === 'CH') {
    files['正文.md'] = '';
    const identity = { schema_version: 1, project_id: projectId, chapter_id: assetId, version };
    files['摘要.json'] = jsonText({ ...identity, summary: '', events: [], continuation_notes: [] });
    files['出场人物.json'] = jsonText({ ...identity, entries: [] });
    files['场景.json'] = jsonText({ ...identity, entries: [] });
    files['情绪节点.json'] = jsonText({ ...identity, entries: [] });
    files['新增设定.json'] = jsonText({ ...identity, candidates: [] });
    files['漫改建议.json'] = jsonText({ ...identity, suggestions: [] });
  }
  return { asset, files };
}

/** Shape/path checks only: the caller must inspect each file inside the asset root. */
export function mediaFileErrors(files, { requireFiles = false } = {}) {
  const errors = [];
  if (!Array.isArray(files)) return ['MEDIA.data.files 必须为数组'];
  if (requireFiles && !files.length) errors.push('MEDIA.data.files 至少需要一个实际文件');
  const seen = new Set();
  files.forEach((file, index) => {
    const prefix = `MEDIA.data.files[${index}]`;
    if (!object(file)) { errors.push(`${prefix} 必须包含 path 和 kind`); return; }
    if (Object.hasOwn(file, 'usage_id') && !nonemptyString(file.usage_id)) errors.push(`${prefix}.usage_id 声明时必须为非空字符串`);
    if (!['image', 'video', 'audio', 'other'].includes(file.kind)) errors.push(`${prefix}.kind 仅允许 image、video、audio、other`);
    if (!filled(file.path)) { errors.push(`${prefix}.path 必须为资产目录内的相对文件路径`); return; }
    const relative = file.path.replaceAll('\\', '/');
    const parts = relative.split('/');
    if (/^[\/]/.test(relative) || /[:\x00-\x1f<>"|?*]/.test(relative) || parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) errors.push(`${prefix}.path 必须为资产目录内的安全相对路径`);
    const canonical = relative.toLowerCase();
    if (seen.has(canonical)) errors.push(`${prefix}.path 文件重复`);
    seen.add(canonical);
    if (['asset.json', '_snapshot.json'].includes(parts.at(-1).toLowerCase())) errors.push(`${prefix}.path 不能把资产元数据当成媒体文件`);
  });
  return errors;
}

/** Optional binding metadata; file existence, frozen manifests and usage matching are checked by the caller. */
export function referenceBindingErrors(bindings) {
  if (!Array.isArray(bindings)) return ['PROMPT.data.reference_bindings 必须为数组'];
  const errors = [];
  bindings.forEach((binding, index) => {
    const prefix = `PROMPT.data.reference_bindings[${index}]`;
    if (!object(binding)) { errors.push(`${prefix} 必须为包含 media 和 file_path 的对象`); return; }
    if (!object(binding.media) || typeof binding.media.asset_id !== 'string' || !ASSET_ID.test(binding.media.asset_id) || binding.media.asset_id.split('-')[1] !== 'MEDIA' || typeof binding.media.version !== 'string' || !VERSION.test(binding.media.version)) errors.push(`${prefix}.media 需要 MEDIA 的确切版本引用`);
    if (!nonemptyString(binding.file_path)) errors.push(`${prefix}.file_path 必须为资产目录内的非空相对文件路径`);
    else {
      const relative = binding.file_path.replaceAll('\\', '/');
      const parts = relative.split('/');
      if (/^[\/]/.test(relative) || /[:\x00-\x1f<>"|?*]/.test(relative) || parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) errors.push(`${prefix}.file_path 必须为资产目录内的安全相对路径`);
      if (['asset.json', '_snapshot.json'].includes(parts.at(-1).toLowerCase())) errors.push(`${prefix}.file_path 不能把资产元数据当成媒体文件`);
    }
    if (Object.hasOwn(binding, 'expected_usage_id') && !nonemptyString(binding.expected_usage_id)) errors.push(`${prefix}.expected_usage_id 声明时必须为非空字符串`);
  });
  return errors;
}

/** The caller verifies the saved snapshot and supplies its immutable identity/hash. */
export function normalizeReviewRecord(input, { reviewId, projectId, assetId, version, manifestSha256, recordedAt }) {
  if (!object(input)) fail('审核记录输入必须为 JSON 对象');
  projectIdentity(projectId);
  assetIdentity(assetId, version, projectId, '被审资产');
  if (!HASH.test(manifestSha256 ?? '')) fail('审核必须绑定已保存快照的 manifest_sha256');
  if (typeof reviewId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reviewId)) fail('review_id 必须为安全的唯一记录标识');
  timestamp(recordedAt, 'recorded_at');
  for (const [key, expected] of Object.entries({ review_id: reviewId, project_id: projectId, asset_id: assetId, version, manifest_sha256: manifestSha256, recorded_at: recordedAt })) equalityWhenProvided(input, key, expected);
  if (input.schema_version !== undefined && input.schema_version !== 1) fail('审核 schema_version 必须为 1');
  if (Object.hasOwn(input, 'conclusion')) fail('请使用 result 字段，不接受 conclusion');
  const result = enumValue(input.result, ['pass', 'revise', 'unverified'], { 通过: 'pass', 需修订: 'revise', 待核实: 'unverified', 不适用: 'unverified' }, 'result');
  const coverage = enumValue(input.coverage ?? 'partial', ['full', 'partial'], {}, 'coverage');
  if (!Array.isArray(input.issues)) fail('issues 必须为数组，没有问题时填写 []');
  const ids = new Set();
  const issues = input.issues.map((issue, index) => {
    if (!object(issue)) fail(`issues[${index}] 必须为问题对象`);
    const id = text(issue.id, `issues[${index}].id`);
    if (ids.has(id)) fail(`issues[${index}].id 重复：${id}`);
    ids.add(id);
    return {
      id,
      severity: enumValue(issue.severity, ['blocker', 'revision', 'suggestion'], { 阻塞交接: 'blocker', 应修订: 'revision', 可选润色: 'suggestion' }, `issues[${index}].severity`),
      status: enumValue(issue.status, ['open', 'resolved'], { 待处理: 'open', 已交修改稿: 'open', 已实际应用待复查: 'open', 复查通过: 'resolved' }, `issues[${index}].status`),
      description: text(issue.description, `issues[${index}].description`),
      evidence: text(issue.evidence, `issues[${index}].evidence`),
    };
  });
  if (result === 'pass' && issues.some(issue => issue.status === 'open' && ['blocker', 'revision'].includes(issue.severity))) fail('通过结论不能包含尚未解决的阻塞或应修订问题');
  const record = {
    schema_version: 1, review_id: reviewId, project_id: projectId, asset_id: assetId, version, manifest_sha256: manifestSha256,
    recorded_at: recordedAt, method: methodOf(input), reviewer: text(input.reviewer, 'reviewer'), scope: text(input.scope, 'scope'), coverage, result, issues, evidence: text(input.evidence, 'evidence'),
  };
  if (input.reviewed_at !== undefined) record.reviewed_at = timestamp(input.reviewed_at, 'reviewed_at');
  return record;
}

/** Explicit opt-in gate; it never treats a save/adopt success as a content review. */
export function assertReviewPasses(record, { assetId, version, manifestSha256 }) {
  if (!object(record)) fail('缺少可验证的审核记录');
  const normalized = normalizeReviewRecord(record, { reviewId: record.review_id, projectId: record.project_id, assetId, version, manifestSha256, recordedAt: record.recorded_at });
  if (normalized.coverage !== 'full') fail('正式采用／发布审核需要 full 完整范围，局部审查不能代替全章审核');
  if (normalized.result !== 'pass') fail('审核结论尚未通过，不能作为正式采用／发布依据');
  return normalized;
}

function reviewItemIdentity(item, projectId) {
  if (!object(item)) fail('复核项必须为对象');
  const inferredProject = projectId ?? String(item.asset_id ?? '').split('-')[0];
  projectIdentity(inferredProject);
  assetIdentity(item.asset_id, item.version, inferredProject, '下游');
  assetIdentity(item.dependency_id, item.referenced_version, inferredProject, '固定上游');
  assetIdentity(item.dependency_id, item.current_version, inferredProject, '当前上游');
  if (item.referenced_version === item.current_version) fail('固定版本与当前版本相同，不构成上游变更复核项');
  if (!Array.isArray(item.via ?? [])) fail('via 必须为按依赖路径排序的 ID@version 数组');
  const via = (item.via ?? []).map((node, index) => {
    if (typeof node !== 'string') fail(`via[${index}] 必须为 ID@version`);
    const parts = node.split('@');
    if (parts.length !== 2) fail(`via[${index}] 必须为 ID@version`);
    assetIdentity(parts[0], parts[1], inferredProject, `via[${index}]`);
    return node;
  });
  return { asset_id: item.asset_id, version: item.version, dependency_id: item.dependency_id, referenced_version: item.referenced_version, current_version: item.current_version, via };
}

/** Stable across refreshes; changing either endpoint or any intermediate version reopens it. */
export function reviewItemId(item) {
  const identity = reviewItemIdentity(item);
  return `RI-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

export function normalizeReviewDisposition(input, { projectId, recordedAt }) {
  if (!object(input)) fail('复核结论输入必须为对象');
  projectIdentity(projectId);
  const identity = reviewItemIdentity(input, projectId);
  const itemId = reviewItemId(identity);
  equalityWhenProvided(input, 'project_id', projectId);
  equalityWhenProvided(input, 'review_item_id', itemId);
  equalityWhenProvided(input, 'recorded_at', recordedAt);
  if (input.schema_version !== undefined && input.schema_version !== 1) fail('复核结论 schema_version 必须为 1');
  if (input.decision !== undefined && !['keep-history', '保留历史引用'].includes(input.decision)) fail('decision 仅允许 keep-history；更新引用应保存并采用新版资产');
  return {
    schema_version: 1, project_id: projectId, review_item_id: itemId, ...identity, decision: 'keep-history',
    reason: text(input.reason, 'reason'), evidence: text(input.evidence, 'evidence'), method: methodOf(input), reviewer: text(input.reviewer, 'reviewer'), recorded_at: timestamp(recordedAt, 'recorded_at'),
  };
}

export function dispositionMatches(item, disposition) {
  try {
    if (!object(disposition)) return false;
    const normalized = normalizeReviewDisposition(disposition, { projectId: disposition.project_id, recordedAt: disposition.recorded_at });
    return reviewItemId(item) === normalized.review_item_id;
  } catch { return false; }
}

export const DIRECTORIES = ['00_项目管理', '01_世界观资产', '02_人物资产', '03_小说资产', '04_漫剧资产', '05_视觉资产', '06_AI生成记录', '07_发布资产'];
export const CHAPTER_FILES = ['正文.md', '摘要.json', '出场人物.json', '场景.json', '情绪节点.json', '新增设定.json', '漫改建议.json'];
export const TYPES = [...ASSET_TYPES];
export const SOURCE_KINDS = ['原文事实', '梗概信息', '分析推断', '改编建议', '用户设定', '参考图观察', '原创创作'];
export const ADOPTION_STATUSES = ['沿用来源', '已采用改编', '建议', '待核实', '已采用原创'];
export const SHOT_TEXT_FIELDS = ['story_time', 'scene_description', 'characters', 'action', 'emotion', 'dialogue', 'shot_size', 'camera_movement', 'lighting', 'video_prompt', 'visual_description'];
export const SHOT_LABELS = { scene_description: '场景', characters: '角色', action: '动作', emotion: '情绪', dialogue: '对白', shot_size: '景别', camera_movement: '镜头运动', lighting: '光影', video_prompt: '视频提示词' };

export const now = () => new Date().toISOString();
export const hash = input => crypto.createHash('sha256').update(input).digest('hex');
export const concrete = value => filled(value) && !/\b(?:undefined|null)\b|同上|见上|同前|〔待填|\[待填|待补|待写/.test(value);
export const meaningful = value => typeof value === 'string' ? filled(value) : typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean' ? true : Array.isArray(value) ? value.some(meaningful) : object(value) ? Object.entries(value).some(([key, item]) => !['schema_version', 'project_id', 'asset_id', 'chapter_id', 'version'].includes(key) && meaningful(item)) : false;
export const referenceKey = ref => `${ref.asset_id}@${ref.version}`;
export const eventKey = ref => `${referenceKey(ref)}#${ref.event_id}`;

export const SYSTEM = '.ip-system';
