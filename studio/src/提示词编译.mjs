import path from 'node:path';
import { readProject, readSnapshot } from './registry.mjs';
import { collectRefs } from './asset-validation.mjs';
import { wasAdopted } from './dependencies.mjs';
import { resolveContinuityState, continuityShapeErrors, selectContinuityEntities } from './连续性状态.mjs';
import { ASSET_ID, VERSION, SOURCE_KINDS, ADOPTION_STATUSES, object, concrete, meaningful, referenceKey, referenceBindingErrors, hash } from './rules.mjs';
import { visualContractErrors } from './创作执行约束.mjs';

const COMPILER_VERSION = '1.3.1';
const ASSET_INPUT_TYPES = ['CHAR', 'LOC', 'PROP', 'STATE'];
const VISIBLE_KEYS = {
  description: '描述', visual_description: '可见特征', visual_requirements: '画面要求',
  appearance: '外观', visual_anchor: '辨识特征', face: '面部', hair: '发型', body: '体型',
  clothing: '服装', clothing_default: '基础服装', outfit: '服装', accessories: '饰物',
  pose: '姿态', posture: '姿态', position: '位置', positions: '站位', hands: '双手',
  holding: '持物', holder: '持有人', possession: '持物', possessions: '持物',
  injuries: '伤势', injury: '伤势', support: '支撑', environment: '环境',
  weather: '天气', lighting: '光影', location: '地点', characters: '人物', props: '道具',
  name: '名称', state: '状态', visible_state: '可见状态', material: '材质', color: '颜色',
  requirement: '要求', text: '内容',
  count: '数量', constraints: '保持要求', must_keep: '必留要求', negative_constraints: '排除要求'
};
const clone = value => structuredClone(value);
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
const stableJSON = value => JSON.stringify(stable(value));
const textValue = value => typeof value === 'string' && concrete(value) && !/^\s*[\[{]/.test(value)
  && !ASSET_ID.test(value.trim()) ? value.trim() : '';
const unique = values => [...new Set(values.filter(Boolean))];
const textList = value => typeof value === 'string' ? textValue(value) : Array.isArray(value) && value.every(item => textValue(item)) ? unique(value.map(textValue)).join('；') : '';
const hasTextInput = value => value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);

// Only known visual fields are rendered. Metadata, unknown objects and references stay in the evidence.
function visibleText(value) {
  if (typeof value === 'string') return textValue(value);
  if (Array.isArray(value)) return unique(value.map(visibleText)).join('；');
  if (!object(value)) return '';
  return Object.keys(value).sort().filter(key => VISIBLE_KEYS[key]).map(key => {
    const item = key === 'count' && Number.isFinite(value[key]) ? String(value[key]) : visibleText(value[key]);
    return item ? `${VISIBLE_KEYS[key]}：${item}` : '';
  }).filter(Boolean).join('；');
}

function fullyVisible(value) {
  if (typeof value === 'string') return Boolean(textValue(value));
  if (Array.isArray(value)) return value.length > 0 && value.every(fullyVisible);
  if (!object(value)) return false;
  const entries = Object.entries(value).filter(([, item]) => meaningful(item));
  return entries.length > 0 && entries.every(([key, item]) => VISIBLE_KEYS[key] && (key === 'count' && Number.isFinite(item) || fullyVisible(item)));
}

function selectedText(data, keys) {
  return unique(keys.map(key => visibleText(data[key]))).join('；');
}

function lines(parts) { return parts.filter(Boolean).join('\n'); }
function field(label, value) { return value ? `${label}：${value}。` : ''; }

/** Read-only compilation: no model call, save, adoption, upload or inferred latest version. */
export function compileShotPrompts({ project: projectPath, request, resolveAsset } = {}) {
  const errors = [], warnings = [], missingFields = [], assumptions = [], cache = new Map(), snapshots = new Map(), consumedFields = new Map();
  const fail = message => { throw new Error(message); };
  const missing = key => { if (!missingFields.includes(key)) missingFields.push(key); };
  let project, shot, shotMode, shotHash;
  try {
    if (typeof projectPath !== 'string' || !projectPath.trim()) fail('project 需要实际项目目录');
    const root = path.resolve(projectPath);
    project = readProject(root);
    const adoptedState = snapshot => ({ was_adopted: !snapshot.candidate && wasAdopted(project, snapshot.asset.asset_id, snapshot.asset.version), current_adopted: !snapshot.candidate && snapshot.entry?.adopted_version === snapshot.asset.version && wasAdopted(project, snapshot.asset.asset_id, snapshot.asset.version) });
    const consume = (asset, ...fields) => {
      const key = referenceKey(asset), paths = consumedFields.get(key) ?? new Set();
      fields.forEach(fieldPath => paths.add(fieldPath)); consumedFields.set(key, paths);
    };
    if (!object(request) || !object(request.shot)) fail('request.shot 需要完整 SHOT 候选或精确版本引用');
    const checkRef = (ref, allowed, label) => {
      if (!object(ref) || !ASSET_ID.test(ref.asset_id ?? '') || !VERSION.test(ref.version ?? '')) fail(`${label} 需要有效 asset_id 和精确 version`);
      if (!ref.asset_id.startsWith(`${project.project_id}-`)) fail(`${label}：拒绝跨 IP 引用 ${ref.asset_id}`);
      if (allowed && !allowed.includes(ref.asset_id.split('-')[1])) fail(`${label} 需要 ${allowed.join('/')} 类型引用`);
      return ref;
    };
    const get = (ref, allowed, label) => {
      checkRef(ref, allowed, label);
      const snapshot = resolveAsset ? resolveAsset(ref) : readSnapshot(root, project, ref.asset_id, ref.version, cache);
      if (!snapshot?.asset || snapshot.asset.project_id !== project.project_id || referenceKey(snapshot.asset) !== referenceKey(ref)) fail(`${label} 的解析结果与精确引用不一致`);
      if (allowed && !allowed.includes(snapshot.asset.type)) fail(`${label} 的快照类型不匹配`);
      if (ref.event_id !== undefined && (snapshot.asset.type !== 'CH' || !snapshot.asset.data.events?.some(event => event.event_id === ref.event_id))) fail(`${label}：来源事件 ${String(ref.event_id)} 不存在于该章节版本`);
      if (!snapshots.has(referenceKey(ref))) {
        const adopted = adoptedState(snapshot);
        if (!adopted.was_adopted) warnings.push(`${referenceKey(ref)} 未曾采用；本次按明确指定的候选快照编译，不能因 asset.adoption_status 称其已采用。`);
        else if (!adopted.current_adopted) warnings.push(`${referenceKey(ref)} 是曾采用历史版，当前采用指针未指向它；保留本次明确版本，不自动换成新版。`);
      }
      if (ref.event_id !== undefined) consume(snapshot.asset, `data.events[event_id=${ref.event_id}]`);
      snapshots.set(referenceKey(ref), snapshot);
      return snapshot;
    };
    checkRef(request.shot, ['SHOT'], 'shot');
    if (Object.hasOwn(request.shot, 'data')) {
      shot = clone(request.shot); shotMode = 'candidate';
      if (shot.schema_version !== 1 || shot.project_id !== project.project_id || shot.type !== 'SHOT' || !object(shot.data)
        || !Array.isArray(shot.refs) || !SOURCE_KINDS.includes(shot.source_kind) || !ADOPTION_STATUSES.includes(shot.adoption_status)) fail('SHOT 候选身份、来源、采用性质、refs 或 data 不符合现有资产结构');
      warnings.push('SHOT 是本次候选，尚未因编译而保存或采用；先保存该版本 SHOT，再保存引用它的 PROMPT。');
    } else {
      const snapshot = get(request.shot, ['SHOT'], 'shot');
      shot = clone(snapshot.asset); shotMode = snapshot.candidate ? 'candidate' : 'snapshot'; shotHash = snapshot.saved?.manifest_sha256;
    }
    const data = shot.data;
    if (!object(data)) fail('SHOT.data 需要对象');
    const continuityErrors = continuityShapeErrors(shot);
    if (continuityErrors.length) fail(continuityErrors.join('；'));
    const allRefs = [], refErrors = [];
    collectRefs(shot.refs, 'SHOT.refs', allRefs, refErrors);
    collectRefs(data, 'SHOT.data', allRefs, refErrors);
    if (refErrors.length) fail(refErrors.join('；'));
    for (const { ref, location } of allRefs) get(ref, null, location);

    const episode = get(data.episode, ['EP'], 'SHOT.data.episode').asset;
    const scene = get(data.scene, ['SC'], 'SHOT.data.scene').asset;
    checkRef(scene.data.episode, ['EP'], 'SC.data.episode');
    if (referenceKey(scene.data.episode) !== referenceKey(data.episode)) fail('SHOT 的 EP 与所属 SC 的 EP 不一致');
    const location = get(scene.data.location, ['LOC'], 'SC.data.location').asset;
    consume(episode, 'data.chapter_refs'); consume(scene, 'data.episode', 'data.location', 'data.source_refs');
    if (!Array.isArray(data.source_refs) || !data.source_refs.length) missing('shot.data.source_refs');
    else for (const ref of data.source_refs) {
      if (!textValue(ref?.event_id)) fail('SHOT.data.source_refs 需要真实 event_id');
      get(ref, ['CH'], 'SHOT.data.source_refs');
      if (!scene.data.source_refs?.some(item => referenceKey(item) === referenceKey(ref) && item.event_id === ref.event_id)) fail('镜头来源事件未列入所属 SC 来源');
      if (!episode.data.chapter_refs?.some(item => referenceKey(item) === referenceKey(ref))) fail('镜头来源章节不属于所属 EP 的 chapter_refs');
    }
    if (data.character_refs !== undefined && !Array.isArray(data.character_refs)) fail('SHOT.data.character_refs 需要数组');
    const visualAssets = new Map([[referenceKey(location), location]]);
    const addVisual = asset => {
      if ([...visualAssets.values()].some(item => item.asset_id === asset.asset_id && item.version !== asset.version)) fail(`${asset.asset_id} 同时提供多个视觉版本；请在 SHOT 中明确本镜使用的版本`);
      visualAssets.set(referenceKey(asset), asset);
    };
    for (const ref of data.character_refs ?? []) {
      const asset = get(ref, ['CHAR'], 'SHOT.data.character_refs').asset;
      addVisual(asset);
    }
    if (request.assets !== undefined && !Array.isArray(request.assets)) fail('request.assets 需要精确资产引用数组');
    for (const ref of request.assets ?? []) {
      const asset = get(ref, ASSET_INPUT_TYPES, 'request.assets').asset;
      addVisual(asset);
    }
    const selectedVisuals = new Map(), inheritedBindings = [], componentRoles = new Map();
    if (data.asset_visuals !== undefined && !Array.isArray(data.asset_visuals)) fail('SHOT.data.asset_visuals 需要本镜视觉选择数组');
    for (const [index, selection] of (data.asset_visuals ?? []).entries()) {
      if (!object(selection)) fail(`SHOT.data.asset_visuals[${index}] 需要对象`);
      const asset = get(selection.asset, ['CHAR', 'LOC', 'PROP'], `SHOT.data.asset_visuals[${index}].asset`).asset;
      const key = referenceKey(asset);
      if (selectedVisuals.has(key)) fail(`${key} 的本镜视觉说明重复，请保留一个明确选择`);
      addVisual(asset);
      if (selection.state_description !== undefined && !textValue(selection.state_description)) missing(`shot.data.asset_visuals[${index}].state_description`);
      for (const fieldName of ['constraints', 'negative_constraints']) if (hasTextInput(selection[fieldName]) && !textList(selection[fieldName])) missing(`shot.data.asset_visuals[${index}].${fieldName} 的明确文字或文字数组`);
      selectedVisuals.set(key, { source: 'shot', source_path: `data.asset_visuals[${index}]`, description: textValue(selection.description), constraints: textList(selection.constraints), negative_constraints: textList(selection.negative_constraints), ...(selection.state_description !== undefined ? { state_description: textValue(selection.state_description) } : {}) });
    }
    // Fixed designs compose existing exact asset versions; there is no parallel asset registry.
    const inherited = new Set(), protectedComponents = new Set(), activeVisuals = new Set();
    const inherit = (asset, component = false) => {
      const key = referenceKey(asset);
      if (activeVisuals.has(key)) fail(`固定视觉组件形成循环：${[...activeVisuals, key].join(' → ')}`);
      if (asset.type === 'STATE' || inherited.has(key) && (!component || protectedComponents.has(key))) return;
      if (activeVisuals.size >= 64) fail('固定视觉组件嵌套超过64层，请缩短资产决策链');
      const shapeErrors = visualContractErrors(asset);
      if (shapeErrors.length) fail(`${key}：${shapeErrors.join('；')}`);
      activeVisuals.add(key);
      const base = asset.data.visual_base, selection = selectedVisuals.get(key);
      if (component && !textValue(base?.description)) missing(`${key}.data.visual_base.description（固定组件没有可继承的设计）`);
      if (object(base) && textValue(base.description) && (!selection || base.locked === true || component)) {
        for (const fieldName of ['constraints', 'negative_constraints']) if (hasTextInput(base[fieldName]) && !textList(base[fieldName])) missing(`${referenceKey(asset)}.data.visual_base.${fieldName} 的明确文字或文字数组`);
        if ((base.locked === true || component) && selection?.description && selection.description !== textValue(base.description)) fail(`${key} 固定视觉已声明 locked 或被固定组件引用；SHOT.asset_visuals.description 不能重新定义设计，请引用同版基准并用 state_description 单独说明动态状态`);
        selectedVisuals.set(key, { source: base.locked === true || component ? 'locked_base' : 'asset_base', source_path: 'data.visual_base', description: textValue(base.description), constraints: unique([textList(base.constraints), selection?.constraints]).join('；'), negative_constraints: unique([textList(base.negative_constraints), selection?.negative_constraints]).join('；'), ...(selection?.state_description ? { state_description: selection.state_description } : {}), ...(base.locked === true || component ? { lock_scope: '固定设计执行策略；不是审核、确认图或采用证据' } : {}) });
        consume(asset, 'data.visual_base');
        assumptions.push(`${referenceKey(asset)} 使用明确声明的 visual_base 静态基准；本镜变化仍须由起止状态给出。`);
      } else if (!selection && ['CHAR', 'PROP'].includes(asset.type)) {
        missing(`shot.data.asset_visuals 中 ${referenceKey(asset)} 的本镜已选 description`);
        warnings.push(`${referenceKey(asset)} 未选本镜视觉说明；旧 appearance、visual_requirements、visual_description 及通用提示词可能跨章，不自动继承。`);
      } else if (!selection) warnings.push(`${referenceKey(asset)} 未选本镜地点视觉说明；仅使用 SHOT.scene_description，不自动复制地点的跨时期描述。`);
      if (Array.isArray(base?.reference_bindings)) inheritedBindings.push(...base.reference_bindings);
      for (const [index, item] of (base?.components ?? []).entries()) {
        let child;
        try { child = get(item.asset, ['CHAR', 'LOC', 'PROP'], `${key}.data.visual_base.components[${index}].asset`).asset; }
        catch (error) { missing(`${key}.data.visual_base.components[${index}] 的精确组件 ${referenceKey(item.asset)}`); warnings.push(error.message); continue; }
        addVisual(child);
        const roles = componentRoles.get(referenceKey(child)) ?? [];
        componentRoles.set(referenceKey(child), unique([...roles, textValue(item.role)]));
        inherit(child, true);
      }
      activeVisuals.delete(key); inherited.add(key); if (component) protectedComponents.add(key);
    };
    for (const asset of visualAssets.values()) inherit(asset);
    // A component can acquire protection from its parent after SHOT selections are read.
    for (const selection of selectedVisuals.values()) if (!selection.description) missing(`shot.${selection.source_path}.description`);
    if ([...selectedVisuals.values()].some(selection => selection.state_description)) warnings.push('state_description 仅作为明确动态说明附加；是否与固定设计、原文或时点冲突仍须实际语义审核。');
    // Only explicitly declared STATE boundaries are evaluated; prose order is never a timeline.
    const continuity = {};
    if (data.continuity) {
      for (const boundary of ['entry', 'exit']) {
        const allStates = resolveContinuityState({ project: root, request: { point: data.continuity[boundary] }, resolveAsset: ref => get(ref, null, `连续性${boundary}`) });
        const resolved = selectContinuityEntities(allStates, [...visualAssets.values()].filter(asset => asset.type !== 'STATE').map(asset => ({ asset_id: asset.asset_id, version: asset.version })));
        if (!resolved.ok || !resolved.complete) fail(`连续性${boundary}无法完整求值：${(resolved.issues ?? []).map(issue => issue.message ?? issue.description).join('；') || (resolved.unresolved ?? []).map(item => item.reason).join('；') || '存在未决状态'}`);
        if (resolved.timeline !== data.continuity.timeline) fail(`连续性${boundary}与本镜 timeline 不一致`);
        const visualIds = new Set([...visualAssets.values()].filter(asset => asset.type !== 'STATE').map(asset => asset.asset_id));
        const states = resolved.states.filter(item => visualIds.has(item.entity.asset_id));
        for (const state of states) {
          const matching = [...visualAssets.values()].find(asset => asset.asset_id === state.entity.asset_id);
          if (matching.version !== state.entity.version) fail(`${state.entity.asset_id}：连续性状态与本镜视觉资产版本不一致`);
        }
        continuity[boundary] = { timeline: resolved.timeline, input_fingerprint: resolved.input_fingerprint, scope: resolved.scope, states };
        warnings.push(...(resolved.warnings ?? []));
      }
    } else if ([...visualAssets.values()].some(asset => asset.type === 'STATE')) warnings.push('STATE 尚未选择结构化连续性边界，仅保留事件证据；本镜状态须由 AI 回查，不按数组顺序推断。');

    const target = request.target ?? {};
    if (!object(target)) fail('target 需要对象');
    for (const key of ['platform', 'model', 'input_mode']) if (target[key] !== undefined && !textValue(target[key])) fail(`target.${key} 需要具体文字，不能使用空值或占位`);
    if (request.reference_bindings !== undefined && !Array.isArray(request.reference_bindings)) fail('reference_bindings 必须为数组');
    const bindings = [...new Map([...inheritedBindings, ...(request.reference_bindings ?? [])].map(binding => [stableJSON(binding), binding])).values()];
    const bindingErrors = referenceBindingErrors(bindings);
    if (bindingErrors.length) fail(bindingErrors.join('；'));
    const bindingEvidence = [];
    for (const [index, binding] of bindings.entries()) {
      const snapshot = get(binding.media, ['MEDIA'], `reference_bindings[${index}].media`);
      const relative = binding.file_path.replaceAll('\\', '/');
      const mediaFile = snapshot.asset.data.files?.find(file => object(file) && typeof file.path === 'string' && file.path.replaceAll('\\', '/') === relative);
      if (!mediaFile) fail(`reference_bindings[${index}].file_path 未登记在所指 MEDIA 的 data.files`);
      if (!Object.hasOwn(snapshot.manifest.files, relative)) fail(`reference_bindings[${index}].file_path 与指定 MEDIA 快照文件清单的实际拼写不匹配`);
      if (binding.expected_usage_id !== undefined && mediaFile.usage_id !== binding.expected_usage_id) fail(`reference_bindings[${index}].expected_usage_id 与所指文件 usage_id 不一致`);
      if (binding.expected_usage_id === undefined) warnings.push(`参考 ${index + 1} 未启用用途匹配；文件校验不代表图片用途或内容已验收。`);
      if (!textValue(binding.role)) warnings.push(`参考 ${index + 1} 未提供职责；保留文件依据，正文不猜测它是首帧、身份或动作参考。`);
      for (const fieldName of ['allowed', 'forbidden', 'constraints']) if (hasTextInput(binding[fieldName]) && !textList(binding[fieldName])) missing(`reference_bindings[${index}].${fieldName} 的明确文字或文字数组`);
      consume(snapshot.asset, `data.files[path=${relative}]`);
      bindingEvidence.push({ ...clone(binding), file_path: relative, file: clone(snapshot.manifest.files[relative]), kind: mediaFile.kind });
    }
    if (bindings.length) warnings.push('参考文件存在及版本校验通过，不证明已看图、已上传或当前平台已接受输入。');
    if (Object.keys(target).length) warnings.push('目标信息仅组织中文交付正文；未核实平台参数、账号入口或参考标签，不构造商业请求。');
    else assumptions.push('未指定目标，输出通用中文正文，不假定视频模型或参数。');

    const requiredText = ['story_time', 'action', 'shot_size', 'camera_movement', 'lighting'];
    for (const key of requiredText) if (!textValue(data[key])) missing(`shot.data.${key}`);
    for (const key of ['shot_number', 'start_seconds', 'duration_seconds']) {
      const valid = key === 'shot_number' ? Number.isInteger(data[key]) && data[key] > 0 : Number.isFinite(data[key]) && (key === 'start_seconds' ? data[key] >= 0 : data[key] > 0);
      if (!valid) missing(`shot.data.${key}`);
    }
    const subject = textValue(data.subject) || (['无', '无角色', '无人'].includes(textValue(data.characters)) ? '' : textValue(data.characters));
    if (!subject) missing('shot.data.characters 或 subject（具体画面主体）');
    const setting = textValue(data.scene_description) || selectedVisuals.get(referenceKey(location))?.description || '';
    if (!setting) missing('shot.data.scene_description');
    else if (!textValue(data.scene_description)) assumptions.push('场景描述从 SC.location 对应的本镜已选说明或明确静态基准继承。');
    const firstFrame = ['first_frame_description', 'first_frame', 'first_frame_state', 'first_frame_prompt', 'entry_state'].map(key => visibleText(data[key])).find(Boolean) || '';
    if (!firstFrame) missing('shot.data.first_frame_description 或明确可见的 entry_state');
    const entryState = visibleText(data.entry_state) || firstFrame;
    const lastFrame = ['end_frame_description', 'last_frame_description', 'exit_state'].map(key => visibleText(data[key])).find(Boolean) || '';
    const exitState = visibleText(data.exit_state) || lastFrame;
    if (!lastFrame) missing('shot.data.end_frame_description、last_frame_description 或明确可见的 exit_state');
    if (data.dialogue !== undefined && data.dialogue !== '' && !textValue(data.dialogue)) missing('shot.data.dialogue 的具体台词文字（无对白时写“无”）');
    if (!textValue(data.dialogue)) assumptions.push('镜头未声明可用对白，暂按无对白组织；这项默认须由故事审查确认。');
    const dialogue = textValue(data.dialogue) || '无';
    const emotion = textValue(data.emotion) || '无额外情绪要求';
    if (hasTextInput(data.director_intent) && !textValue(data.director_intent)) missing('shot.data.director_intent 的明确导演意图');
    if (!textValue(data.emotion)) assumptions.push('镜头未声明情绪，不补写哭泣、伤势或情节。');
    const hardRequirements = ['visual_requirements', 'constraints', 'must_keep', 'continuity_requirements', 'consistency_rules', 'negative_constraints', 'negative_prompt', 'forbidden'];
    for (const asset of [shot]) {
      for (const key of [...hardRequirements, 'visual_description', 'appearance', 'visual_anchor']) {
        if (meaningful(asset.data[key]) && (!visibleText(asset.data[key]) || hardRequirements.includes(key) && !fullyVisible(asset.data[key]))) {
          warnings.push(`${referenceKey(asset)}.data.${key} 没有可安全转写的已知文字结构；原值保留于编译依据，未当作已传递要求。`);
          if (hardRequirements.includes(key)) missing(`${referenceKey(asset)}.data.${key} 的明确文字要求`);
        }
      }
    }
    const constraints = unique([
      selectedText(data, ['visual_requirements', 'constraints', 'must_keep', 'continuity_requirements', 'consistency_rules']),
      ...[...selectedVisuals.values()].map(selection => selection.constraints)
    ]).join('；');
    const negative = unique([
      selectedText(data, ['negative_constraints', 'negative_prompt', 'forbidden']),
      ...[...selectedVisuals.values()].map(selection => selection.negative_constraints)
    ]).join('；') || '无额外项';
    const visualDescription = asset => {
      const selection = selectedVisuals.get(referenceKey(asset));
      return unique([selection?.description, selection?.state_description ? `本镜动态状态：${selection.state_description}` : '']).join('；');
    };
    const appearance = [...visualAssets.values()].filter(asset => asset.type === 'CHAR').map(asset => {
      const description = visualDescription(asset), roles = componentRoles.get(referenceKey(asset));
      consume(asset, textValue(asset.data.name) ? 'data.name' : 'title');
      return description ? `${textValue(asset.data.name) || textValue(asset.title) || '人物'}${roles?.length ? `（${roles.join('、')}）` : ''}：${description}` : '';
    }).filter(Boolean).join('；');
    const props = [...visualAssets.values()].filter(asset => asset.type === 'PROP').map(asset => {
      const description = visualDescription(asset), roles = componentRoles.get(referenceKey(asset));
      consume(asset, textValue(asset.data.name) ? 'data.name' : 'title');
      return description ? `${textValue(asset.data.name) || textValue(asset.title) || '道具'}${roles?.length ? `（${roles.join('、')}）` : ''}：${description}` : '';
    }).filter(Boolean).join('；');
    const mainSceneRoles = componentRoles.get(referenceKey(location));
    if (mainSceneRoles?.length && visualDescription(location)) consume(location, textValue(location.data.name) ? 'data.name' : 'title');
    const sceneLook = visualDescription(location) ? `${mainSceneRoles?.length ? `${textValue(location.data.name) || textValue(location.title) || '场景'}（${mainSceneRoles.join('、')}）：` : ''}${visualDescription(location)}` : '';
    const environmentLook = [...visualAssets.values()].filter(asset => asset.type === 'LOC' && referenceKey(asset) !== referenceKey(location)).map(asset => {
      const description = visualDescription(asset), roles = componentRoles.get(referenceKey(asset));
      consume(asset, textValue(asset.data.name) ? 'data.name' : 'title');
      return description ? `${textValue(asset.data.name) || textValue(asset.title) || '环境'}${roles?.length ? `（${roles.join('、')}）` : ''}：${description}` : '';
    }).filter(Boolean).join('；');
    const sound = textValue(data.sound) || (Array.isArray(data.sound) ? visibleText(data.sound) : object(data.sound) ? unique(['voice', 'effects', 'ambience', 'music', 'description'].map(key => visibleText(data.sound[key]))).join('；') : '');
    if (meaningful(data.sound) && !sound) missing('shot.data.sound 的明确声音文字');
    const sourceShot = clone(shot);
    delete sourceShot.data.video_prompt;
    const inputs = {
      shot: { asset_id: shot.asset_id, version: shot.version, mode: shotMode, ...(shotHash ? { manifest_sha256: shotHash, ...adoptedState(snapshots.get(referenceKey(shot))) } : { was_adopted: false, current_adopted: false }), asset: sourceShot },
      assets: [...snapshots.values()].filter(snapshot => snapshot.asset.type !== 'SHOT').sort((a, b) => referenceKey(a.asset).localeCompare(referenceKey(b.asset), 'en')).map(snapshot => ({ asset_id: snapshot.asset.asset_id, version: snapshot.asset.version, type: snapshot.asset.type, title: snapshot.asset.title, source_kind: snapshot.asset.source_kind, manifest_sha256: snapshot.saved?.manifest_sha256 ?? null, ...adoptedState(snapshot), consumed_fields: [...(consumedFields.get(referenceKey(snapshot.asset)) ?? [])].sort(), ...(selectedVisuals.has(referenceKey(snapshot.asset)) ? { selected_visual: clone(selectedVisuals.get(referenceKey(snapshot.asset))) } : {}), ...(componentRoles.has(referenceKey(snapshot.asset)) ? { component_roles: componentRoles.get(referenceKey(snapshot.asset)) } : {}) })),
      target: clone(target), reference_bindings: bindingEvidence, ...(data.continuity ? { continuity } : {})
    };
    const compilation = {
      compiler: '镜头提示词编译', version: COMPILER_VERSION,
      input_sha256: hash(stableJSON(inputs)), shot_mode: shotMode,
      content_sha256: hash(stableJSON({ shot: sourceShot, assets: [...snapshots.values()].filter(snapshot => snapshot.asset.type !== 'SHOT').map(snapshot => snapshot.asset).sort((a, b) => referenceKey(a).localeCompare(referenceKey(b))), target, reference_bindings: bindings })),
      assumptions, missing_fields: missingFields, semantic_review: '未执行：须核对身份、时点、状态覆盖、动作与声音的语义一致性',
      state_resolution: data.continuity ? '已求值明确的STATE边界；自然语言与结构化状态仍需语义核对' : '未声明结构化边界，仅保留事件证据', target_mode: Object.keys(target).length ? '指定目标的中文交付稿，入口未核实' : '通用中文',
      warnings: unique(warnings)
    };
    if (missingFields.length) return { ok: false, action: 'compile-prompts', project_id: project.project_id, inputs, compilation, missing_fields: missingFields, errors: missingFields.map(key => `缺少 ${key}`), warnings: unique(warnings), files: {} };

    const assetLook = lines([field('人物视觉基准（服装、伤势和持物以本镜明确状态为准）', appearance), field('本场固定视觉特征', sceneLook), field('补充环境固定特征', environmentLook), field('道具形制', props)]);
    const renderStateValue = value => value === null ? '未明确' : Array.isArray(value) ? value.length ? value.map(renderStateValue).join('、') : '无' : object(value) && value.asset_id ? textValue(get(value, null, '状态属性引用').asset.data.name) || textValue(get(value, null, '状态属性引用').asset.title) || referenceKey(value) : String(value);
    const stateLabels = { ...VISIBLE_KEYS, emotion: '情绪', damage: '损坏', health: '健康状态', time: '时间', visible: '可见性', status: '状态', owner: '归属', wetness: '湿润程度', dirt: '污迹', blood: '血迹' };
    const stateText = boundary => (continuity[boundary]?.states ?? []).map(item => { const entity = get(item.entity, null, '连续性对象').asset; return `${entity.data.name || entity.title}：${Object.entries(item.values).map(([key, value]) => `${stateLabels[key] ?? key}：${renderStateValue(value)}`).join('；')}`; }).join('\n');
    const startContinuity = stateText('entry'), endContinuity = stateText('exit');
    const referenceDirections = bindings.map((binding, index) => {
      const directions = [textValue(binding.role) ? `仅负责${textValue(binding.role)}` : '', field('允许沿用', textList(binding.allowed)), field('禁止借用', textList(binding.forbidden)), field('保持要求', textList(binding.constraints))].filter(Boolean);
      return directions.length ? `参考素材${index + 1}：${directions.join('；')}` : '';
    }).filter(Boolean);
    const common = [field('画面主体', subject), field('故事时点', data.story_time), field('场景', setting), assetLook, ...referenceDirections];
    const imagePrompt = lines([...common, field('唯一画面时刻', firstFrame), field('入口连续性状态', startContinuity), field('取景', data.shot_size), field('观察方向', textValue(data.photography?.view)), field('光影', data.lighting), field('本镜可见硬要求', constraints), negative === '无额外项' ? '' : field('应排除的画面', negative)]);
    const endFramePrompt = lines([...common, field('唯一画面时刻（镜头结束）', lastFrame), field('出口连续性状态', endContinuity), field('取景', data.shot_size), field('观察方向', textValue(data.photography?.end_view) || textValue(data.photography?.view)), field('光影', data.lighting), field('本镜可见硬要求', constraints), negative === '无额外项' ? '' : field('应排除的画面', negative)]);
    const genericVideo = lines([...common, field('导演意图', textValue(data.director_intent)), field('起始状态', entryState), field('入口连续性状态', startContinuity), field('动作过程', data.action), field('结束状态', exitState), field('出口连续性状态', endContinuity), field('情绪方向', emotion), field('景别', data.shot_size), field('摄影', data.camera_movement), field('光影', data.lighting), dialogue === '无' ? '本镜无对白。' : field('对白', dialogue), field('声音', sound), field('本镜保持要求', constraints), negative === '无额外项' ? '' : field('项目排除要求', negative)]);
    const videoPrompt = genericVideo;
    compilation.output_sha256 = Object.fromEntries(Object.entries({ image_prompt: imagePrompt, end_frame_prompt: endFramePrompt, video_prompt: videoPrompt, negative_prompt: negative }).map(([key, value]) => [key, hash(value)]));
    compilation.file_sha256 = Object.fromEntries(Object.entries({ '镜头通用提示词.txt': genericVideo, '首帧提示词.txt': imagePrompt, '尾帧提示词.txt': endFramePrompt, '视频提示词.txt': videoPrompt }).map(([key, value]) => [key, hash(`${value}\n`)]));
    const shotData = { ...clone(data), scene_description: setting, characters: textValue(data.characters) || subject, emotion, dialogue, entry_state: meaningful(data.entry_state) ? clone(data.entry_state) : entryState, exit_state: meaningful(data.exit_state) ? clone(data.exit_state) : exitState, visual_description: textValue(data.visual_description) || firstFrame, video_prompt: genericVideo };
    const promptData = { shot: { asset_id: shot.asset_id, version: shot.version }, asset_refs: [...visualAssets.values()].map(asset => ({ asset_id: asset.asset_id, version: asset.version })), image_prompt: imagePrompt, end_frame_prompt: endFramePrompt, video_prompt: videoPrompt, negative_prompt: negative, optimization: '从精确资产版本与镜头起止状态编译；未继承旧镜头视频提示词或人物通用图片提示词。', platform: target.platform ?? '', model: target.model ?? '', input_mode: target.input_mode ?? '', reference_bindings: clone(bindings), compilation: clone(compilation) };
    const evidence = { project_id: project.project_id, inputs, compilation };
    return { ok: true, action: 'compile-prompts', project_id: project.project_id, shot_data: shotData, prompt_data: promptData, inputs, compilation, warnings: unique(warnings), errors: [], missing_fields: [], files: { '镜头通用提示词.txt': `${genericVideo}\n`, '首帧提示词.txt': `${imagePrompt}\n`, '尾帧提示词.txt': `${endFramePrompt}\n`, '视频提示词.txt': `${videoPrompt}\n`, '编译依据.json': `${JSON.stringify(stable(evidence), null, 2)}\n` } };
  } catch (error) {
    errors.push(error.message);
    return { ok: false, action: 'compile-prompts', ...(project ? { project_id: project.project_id } : {}), errors, missing_fields: missingFields, warnings: unique(warnings), files: {} };
  }
}
