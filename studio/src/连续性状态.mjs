import fs from 'node:fs';
import path from 'node:path';
import { ASSET_ID, VERSION, filled, hash, meaningful, object } from './rules.mjs';
import { readProject, readSnapshot, registryErrors } from './registry.mjs';
import { PROJECT_HASHES, safePath } from './storage.mjs';

const own = (value, key) => Object.hasOwn(value, key);
const text = value => typeof value === 'string' && value.trim().length > 0;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const entityTypes = ['CHAR', 'LOC', 'PROP'];
const keyOf = ref => `${ref.asset_id}@${ref.version}`;
const refOf = value => ({ asset_id: value.asset_id, version: value.version });
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const copy = value => JSON.parse(JSON.stringify(value));
const same = (left, right) => stable(left) === stable(right);
const known = value => value !== null && (Array.isArray(value) ? value.every(known)
  : typeof value === 'string' ? filled(value) && !/^(?:未知|未确定|尚未确定|未明确|待确认|待确定|不详)[。.!！?？]*$/.test(value.trim()) : true);
const plain = value => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function exactRef(value, types, projectId, event = false) {
  return plain(value) && ASSET_ID.test(value.asset_id) && VERSION.test(value.version)
    && (!types || types.includes(value.asset_id.split('-')[1]))
    && (!projectId || value.asset_id.startsWith(`${projectId}-`))
    && (!event || text(value.event_id))
    && Object.keys(value).every(key => ['asset_id', 'version', ...(event ? ['event_id'] : [])].includes(key));
}
function propertyErrors(value, label, projectId) {
  if (!plain(value)) return [`${label} 必须为属性对象`];
  const errors = [];
  const scalar = item => item === null || typeof item === 'string' || typeof item === 'boolean'
    || (typeof item === 'number' && Number.isFinite(item)) || exactRef(item, null, projectId);
  for (const [key, item] of Object.entries(value)) {
    if (!text(key) || forbidden.has(key)) errors.push(`${label}.${key}：属性名无效或为原型保留键`);
    if (!(scalar(item) || (Array.isArray(item) && item.every(scalar)))) errors.push(`${label}.${key}：仅支持原子值、精确资产引用或它们的一维数组，不接受未知嵌套对象`);
  }
  return errors;
}
function pointErrors(point, label, projectId) {
  const errors = [];
  if (!plain(point)) return [`${label} 必须为状态边界对象`];
  if (!exactRef(point.state, ['STATE'], projectId)) errors.push(`${label}.state 必须为本项目 STATE 的精确版本引用`);
  if (!['initial', 'before', 'after'].includes(point.phase)) errors.push(`${label}.phase 必须为 initial、before 或 after`);
  if (point.phase === 'initial') {
    if (own(point, 'change_id')) errors.push(`${label}.initial 不接受 change_id`);
  } else if (!text(point.change_id)) errors.push(`${label}.change_id 必须指定精确变更节点`);
  if (Object.keys(point).some(key => !['state', 'phase', 'change_id'].includes(key))) errors.push(`${label} 包含未知字段；时间线由 continuity.timeline 或 request.timeline 声明`);
  return errors;
}
function structured(data) {
  return ['timeline', 'initial_states', 'base_state', 'change_order'].some(key => own(data, key))
    || (Array.isArray(data.changes) && data.changes.some(change => object(change) && ['entity', 'change_id'].some(key => own(change, key))));
}

/** Optional machine-readable declarations only. Existing prose remains valid legacy evidence. */
export function continuityShapeErrors(asset) {
  if (!object(asset) || !object(asset.data)) return [];
  const { data, project_id: projectId, type } = asset;
  const errors = [];
  if (type === 'STATE' && structured(data)) {
    if (!text(data.timeline)) errors.push('STATE.data.timeline：结构化状态必须声明非空时间线');
    if (own(data, 'base_state')) errors.push(...pointErrors(data.base_state, 'STATE.data.base_state', projectId));
    if (own(data, 'initial_states')) {
      if (!Array.isArray(data.initial_states)) errors.push('STATE.data.initial_states 必须为数组');
      else {
        const seen = new Set();
        data.initial_states.forEach((initial, index) => {
          const label = `STATE.data.initial_states[${index}]`;
          if (!plain(initial)) { errors.push(`${label} 必须为 entity/values 对象`); return; }
          if (!exactRef(initial.entity, entityTypes, projectId)) errors.push(`${label}.entity 必须为本项目 CHAR/LOC/PROP 的精确版本引用`);
          else if (seen.has(initial.entity.asset_id)) errors.push(`${label}.entity 初始实体重复；不能跨版本自动合并`);
          else seen.add(initial.entity.asset_id);
          errors.push(...propertyErrors(initial.values, `${label}.values`, projectId));
          if (Object.keys(initial).some(key => !['entity', 'values'].includes(key))) errors.push(`${label} 包含未知字段`);
        });
      }
    }
    if (!Array.isArray(data.change_order) || data.change_order.some(id => !text(id))) errors.push('STATE.data.change_order 必须显式给出非空 change_id 的数组，不能用 changes 数组顺序或 story_time 推断');
    else if (new Set(data.change_order).size !== data.change_order.length) errors.push('STATE.data.change_order 包含重复节点');
    if (!Array.isArray(data.changes)) errors.push('STATE.data.changes 必须为数组');
    else {
      const ids = new Set();
      data.changes.forEach((change, index) => {
        if (!plain(change) || !['entity', 'change_id'].some(key => own(change, key))) return;
        const label = `STATE.data.changes[${index}]`;
        if (!text(change.change_id)) errors.push(`${label}.change_id 必须为非空字符串`);
        else if (ids.has(change.change_id)) errors.push(`${label}.change_id 重复节点 ${change.change_id}`);
        else ids.add(change.change_id);
        if (!exactRef(change.entity, entityTypes, projectId)) errors.push(`${label}.entity 必须为本项目 CHAR/LOC/PROP 的精确版本引用`);
        if (!exactRef(change.event_ref, ['CH'], projectId, true)) errors.push(`${label}.event_ref 必须为本项目 CH 精确版本及事件引用`);
        if (!meaningful(change.effective_node)) errors.push(`${label}.effective_node 必须明确边界含义`);
        if (!meaningful(change.story_time)) errors.push(`${label}.story_time 必须保留叙事时间证据，但不能用于排序`);
        errors.push(...propertyErrors(change.before, `${label}.before`, projectId), ...propertyErrors(change.after, `${label}.after`, projectId));
      });
      if (Array.isArray(data.change_order)) {
        for (const id of data.change_order) if (!ids.has(id)) errors.push(`STATE.data.change_order：节点 ${id} 不存在结构化变更`);
        for (const id of ids) if (!data.change_order.includes(id)) errors.push(`STATE.data.change_order：节点 ${id} 缺少显式顺序`);
      }
    }
  }
  if (['EP', 'SC', 'SHOT'].includes(type) && own(data, 'continuity')) {
    const label = `${type}.data.continuity`, continuity = data.continuity;
    if (!plain(continuity)) errors.push(`${label} 必须为 timeline/entry/exit 对象`);
    else {
      if (!text(continuity.timeline)) errors.push(`${label}.timeline 必须为非空字符串`);
      errors.push(...pointErrors(continuity.entry, `${label}.entry`, projectId), ...pointErrors(continuity.exit, `${label}.exit`, projectId));
      if (own(continuity, 'link') && !['continuous', 'cut'].includes(continuity.link)) errors.push(`${label}.link 仅允许 continuous 或 cut`);
      if (Object.keys(continuity).some(key => !['timeline', 'entry', 'exit', 'link'].includes(key))) errors.push(`${label} 包含未知字段`);
    }
  }
  return errors;
}

/** Read-only evaluation of an explicitly ordered STATE chain at one exact boundary. */
export function resolveContinuityState({ project: projectRoot, request, resolveAsset } = {}) {
  const result = { ok: false, action: 'resolve-continuity-state', project_id: null, point: null, timeline: null,
    states: [], inputs: [], input_fingerprint: null, issues: [], unresolved: [], warnings: [], complete: false };
  const issue = (code, message, location = {}) => result.issues.push({ code, severity: 'error', ...location, message });
  const loaded = new Map(), snapshotCache = new Map(), visiting = new Set();
  let root, project;
  let fingerprintRequest = { point: null, timeline: null, entities: null };
  function load(ref) {
    if (!exactRef(ref, null, project.project_id)) throw new Error('需要本项目精确资产引用');
    const key = keyOf(ref);
    if (loaded.has(key)) return loaded.get(key).asset;
    const snapshot = resolveAsset ? resolveAsset(copy(ref)) : readSnapshot(root, project, ref.asset_id, ref.version, snapshotCache);
    if (!snapshot || typeof snapshot.then === 'function' || !object(snapshot.asset)) throw new Error(`${key}：resolveAsset 必须同步返回包含 asset 的快照`);
    const asset = snapshot.asset;
    if (asset.asset_id !== ref.asset_id || asset.version !== ref.version || asset.project_id !== project.project_id || asset.type !== ref.asset_id.split('-')[1]) throw new Error(`${key}：返回的资产身份不一致`);
    const adopted = (project.adoption_history ?? []).some(item => item.asset_id === ref.asset_id && item.version === ref.version && filled(item.reason) && filled(item.at));
    const manifestHash = snapshot.saved?.manifest_sha256 ?? snapshot.manifest_sha256 ?? null;
    if (manifestHash !== null && !/^[a-f0-9]{64}$/.test(manifestHash)) throw new Error(`${key}：无效的快照来源校验值`);
    const metadata = { ...refOf(asset), type: asset.type, manifest_sha256: manifestHash, content_sha256: hash(stable(asset)),
      was_adopted: adopted && snapshot.was_adopted !== false,
      current_adopted: adopted && (snapshot.current_adopted ?? (snapshot.entry?.adopted_version === ref.version)) === true, candidate: snapshot.candidate === true };
    if (metadata.candidate) { metadata.was_adopted = false; metadata.current_adopted = false; }
    loaded.set(key, { asset, metadata });
    return asset;
  }
  function properties(value) {
    for (const item of Object.values(value)) for (const part of Array.isArray(item) ? item : [item]) if (object(part)) load(part);
  }
  function ensureEntity(states, entity, location) {
    load(entity);
    const previous = [...states.values()].find(state => state.entity.asset_id === entity.asset_id);
    if (previous && previous.entity.version !== entity.version) {
      issue('entity-version-conflict', `实体 ${entity.asset_id} 已按 ${previous.entity.version} 求值，不能自动合并 ${entity.version}`, location);
      return null;
    }
    const key = keyOf(entity);
    if (!states.has(key)) states.set(key, { entity: copy(entity), values: {}, provenance: {} });
    return states.get(key);
  }
  function evaluate(point, depth = 0) {
    const states = new Map(), key = keyOf(point.state), location = { ...point.state };
    if (depth > 128) { issue('state-depth', 'STATE 基准链超过 128 层，请缩小范围或建立有来源的明确初值', location); return { states, timeline: null }; }
    if (visiting.has(key)) { issue('base-cycle', `STATE 基准链形成循环：${key}`, location); return { states, timeline: null }; }
    visiting.add(key);
    try {
      const asset = load(point.state), data = asset.data;
      if (!object(data)) throw new Error(`${key}：STATE.data 不是对象`);
      const shapeErrors = continuityShapeErrors(asset);
      if (shapeErrors.length) { shapeErrors.forEach(message => issue('continuity-shape', message, location)); return { states, timeline: data.timeline ?? null }; }
      if (!structured(data)) {
        result.unresolved.push({ ...location, path: 'data', reason: '旧 STATE 只有未结构化证据；未声明实体、初值、时间线及变更顺序，不能求值', evidence: copy(data) });
        return { states, timeline: null };
      }
      if (data.base_state) {
        const inherited = evaluate(data.base_state, depth + 1);
        if (inherited.timeline !== data.timeline) issue('timeline-conflict', `基准时间线 ${inherited.timeline ?? '未知'} 与当前时间线 ${data.timeline} 不一致`, { ...location, path: 'data.base_state' });
        for (const [stateKey, state] of inherited.states) states.set(stateKey, copy(state));
      }
      for (const [index, initial] of (data.initial_states ?? []).entries()) {
        const at = { ...location, path: `data.initial_states[${index}]` }, state = ensureEntity(states, initial.entity, at);
        properties(initial.values);
        if (!state) continue;
        for (const [field, value] of Object.entries(initial.values)) {
          if (own(state.values, field) && !same(state.values[field], value)) issue('initial-conflict', `初值 ${field} 与基准状态冲突；请使用有顺序的变更，不能无声覆盖`, at);
          else if (!own(state.values, field)) { state.values[field] = copy(value); state.provenance[field] = { state: copy(point.state), phase: 'initial' }; }
        }
      }
      const changes = new Map();
      data.changes.forEach((change, index) => {
        if (!plain(change) || !text(change.change_id) || !exactRef(change.entity, entityTypes, project.project_id)) {
          result.unresolved.push({ ...location, path: `data.changes[${index}]`, reason: '旧变更缺少实体或可排序节点；保留为未结构化证据，不猜测它在目标边界前后', evidence: copy(change) });
        } else changes.set(change.change_id, change);
      });
      if (point.phase === 'initial') return { states, timeline: data.timeline };
      const target = data.change_order.indexOf(point.change_id);
      if (target < 0) { issue('point-not-found', `目标节点 ${point.change_id} 未出现在 STATE 的显式顺序中，不能推断未来状态`, location); return { states, timeline: data.timeline }; }
      for (let index = 0; index <= target; index++) {
        const change = changes.get(data.change_order[index]);
        const at = { ...location, path: `data.changes.${change.change_id}`, change_id: change.change_id };
        const chapter = load(refOf(change.event_ref));
        if (!Array.isArray(chapter.data?.events) || chapter.data.events.filter(event => event.event_id === change.event_ref.event_id).length !== 1) {
          issue('source-event-missing', `来源事件 ${keyOf(change.event_ref)}/${change.event_ref.event_id} 不存在或不唯一`, at); continue;
        }
        const state = ensureEntity(states, change.entity, at);
        properties(change.before);
        if (!state) continue;
        let matches = true;
        for (const [field, value] of Object.entries(change.before)) {
          if (!own(state.values, field) || !known(state.values[field])) { issue('before-unknown', `变更前属性 ${field} 未知；before 不能冒充已确认初值，请声明 initial_states 或 base_state`, at); matches = false; }
          else if (!same(state.values[field], value)) { issue('before-conflict', `变更前属性 ${field} 与继承状态不一致`, at); matches = false; }
        }
        if (index === target && point.phase === 'before') break;
        properties(change.after);
        for (const [field, value] of Object.entries(change.after)) {
          if (own(state.values, field) && known(state.values[field]) && !same(state.values[field], value) && !own(change.before, field)) {
            issue('before-missing', `after 改变已知属性 ${field} 时必须在 before 中断言原值，不能绕过冲突检查`, at); matches = false;
          }
        }
        if (!matches) continue;
        for (const [field, value] of Object.entries(change.after)) {
          state.values[field] = copy(value);
          state.provenance[field] = { state: copy(point.state), change_id: change.change_id, phase: 'after', event_ref: copy(change.event_ref) };
        }
      }
      return { states, timeline: data.timeline };
    } finally { visiting.delete(key); }
  }
  try {
    root = path.resolve(projectRoot);
    project = readProject(root);
    result.project_id = project.project_id;
    const registryIssues = registryErrors(root, project);
    if (registryIssues.length) throw new Error(registryIssues.join('；'));
    if (!plain(request)) throw new Error('request 必须显式指定 point，不默认读取全项目');
    const errors = pointErrors(request.point, 'request.point', project.project_id);
    if (Object.keys(request).some(key => !['point', 'entities', 'timeline'].includes(key))) errors.push('request 包含未知字段，仅接受 point、entities、timeline');
    if (own(request, 'timeline') && !text(request.timeline)) errors.push('request.timeline 必须为非空字符串');
    if (own(request, 'entities') && (!Array.isArray(request.entities) || !request.entities.length || request.entities.some(ref => !exactRef(ref, entityTypes, project.project_id)))) errors.push('request.entities 声明时必须为非空精确 CHAR/LOC/PROP 引用数组');
    if (Array.isArray(request.entities) && new Set(request.entities.map(ref => ref?.asset_id)).size !== request.entities.length) errors.push('request.entities 不能重复实体或混合其多个版本');
    if (errors.length) throw new Error(errors.join('；'));
    result.point = copy(request.point);
    fingerprintRequest = { point: result.point, timeline: request.timeline ?? null, entities: request.entities ? copy(request.entities) : null };
    const evaluated = evaluate(request.point);
    result.timeline = evaluated.timeline;
    if (request.timeline && evaluated.timeline !== request.timeline) issue('timeline-conflict', `请求时间线 ${request.timeline} 与 STATE 时间线 ${evaluated.timeline ?? '未知'} 不一致`);
    const selected = request.entities ?? [...evaluated.states.values()].map(state => state.entity);
    for (const ref of selected) {
      const state = evaluated.states.get(keyOf(ref));
      if (!state || !Object.keys(state.values).length) result.unresolved.push({ entity: copy(ref), reason: '请求边界没有该实体的已知属性，不使用静态角色卡或章末状态补猜' });
      else {
        result.states.push(copy(state));
        for (const [field, value] of Object.entries(state.values)) if (!known(value)) {
          result.unresolved.push({ entity: copy(ref), path: `values.${field}`, reason: 'null、空白、占位或未知文字代表未确定，不能等同于无伤、无持物或已确认不存在；空数组才明确表示无集合项', evidence: copy(value) });
        }
      }
    }
    if (!result.states.length && !result.unresolved.length) result.unresolved.push({ reason: '目标边界没有可求值的实体属性；空结果不代表连续性已确认' });
    for (const { asset, metadata } of loaded.values()) if (hash(stable(asset)) !== metadata.content_sha256) issue('input-changed', `求值期间输入 ${keyOf(asset)} 发生变化，请重新读取`, refOf(asset));
    if (hash(fs.readFileSync(safePath(root, 'project.json'))) !== PROJECT_HASHES.get(project)) issue('project-changed', '求值期间项目清单发生变化，请重新读取后再求值');
  } catch (error) { issue('continuity-resolution', error.message); }
  result.inputs = [...loaded.values()].map(item => item.metadata).sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
  if (result.inputs.some(input => !input.was_adopted)) result.warnings.push('结果包含未采用候选证据，求值成功不代表正式采用或内容审核通过。');
  if (result.unresolved.length) issue('unresolved-state', '存在无法自动求值的状态证据或缺失属性，详见 unresolved');
  result.input_fingerprint = hash(stable({ schema_version: 1, action: result.action, project_id: result.project_id, ...fingerprintRequest, inputs: result.inputs }));
  result.states.sort((left, right) => keyOf(left.entity).localeCompare(keyOf(right.entity)));
  result.complete = result.issues.length === 0 && result.unresolved.length === 0;
  result.ok = result.complete;
  return result;
}

/** Project a resolved chain onto explicit on-screen entities without erasing global contradictions. */
export function selectContinuityEntities(result, entities) {
  const selected = copy(result);
  selected.states = [];
  selected.unresolved = [];
  selected.issues = (result.issues ?? []).filter(issue => issue.code !== 'unresolved-state').map(copy);
  const issue = (code, message, details = {}) => selected.issues.push({ code, severity: 'error', ...details, message });
  const requested = new Map();
  if (!Array.isArray(entities)) issue('continuity-selection', '连续性消费范围必须为明确的 CHAR/LOC/PROP 精确引用数组');
  else for (const entity of entities) {
    if (!exactRef(entity, entityTypes, result.project_id)) { issue('continuity-selection', '连续性消费范围包含无效、跨项目或非精确实体引用'); continue; }
    const previous = requested.get(entity.asset_id);
    if (previous && previous.version !== entity.version) issue('entity-version-conflict', `消费范围同时请求 ${entity.asset_id} 的不同版本，不能自动合并`, { entity: copy(entity) });
    else requested.set(entity.asset_id, copy(entity));
  }
  const mismatched = new Set();
  function matches(entity) {
    if (!object(entity) || !requested.has(entity.asset_id)) return false;
    const requestedEntity = requested.get(entity.asset_id);
    if (entity.version !== requestedEntity.version) {
      const key = `${entity.asset_id}@${entity.version}`;
      if (!mismatched.has(key)) issue('entity-version-conflict', `声明状态 ${key} 与本次消费的精确版本 ${requestedEntity.version} 不一致`, { entity: copy(entity), requested_entity: copy(requestedEntity) });
      mismatched.add(key);
      return false;
    }
    return true;
  }
  for (const state of result.states ?? []) if (matches(state.entity)) selected.states.push(copy(state));
  for (const unresolved of result.unresolved ?? []) {
    // Evidence without an entity has no safe local scope. Keep it even when no visual entity matches.
    if (!object(unresolved.entity) || !text(unresolved.entity.asset_id)) selected.unresolved.push(copy(unresolved));
    else if (requested.has(unresolved.entity.asset_id)) {
      matches(unresolved.entity);
      selected.unresolved.push(copy(unresolved));
    }
  }
  if (!selected.states.length) selected.unresolved.push({ reason: '本次消费的实体没有已声明的可求值状态，不能把全局状态或空结果当作本镜连续性已确认' });
  if (selected.unresolved.length) issue('unresolved-state', '本次消费范围仍有无法自动求值的状态证据或缺失属性，详见 unresolved');
  const scopedEntities = [...requested.values()].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
  selected.scope = { kind: 'entities', entities: scopedEntities, source_input_fingerprint: result.input_fingerprint, source_complete: result.complete };
  selected.input_fingerprint = hash(stable({ schema_version: 1, action: 'select-continuity-entities', source_input_fingerprint: result.input_fingerprint, entities: scopedEntities }));
  selected.complete = selected.issues.length === 0 && selected.unresolved.length === 0;
  selected.ok = selected.complete;
  return selected;
}
