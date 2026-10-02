import { ASSET_ID, VERSION, object, concrete, filled, referenceKey, referenceBindingErrors } from './rules.mjs';

const exactRef = value => object(value) && ASSET_ID.test(value.asset_id ?? '') && VERSION.test(value.version ?? '');
const textList = value => concrete(value) || Array.isArray(value) && value.every(concrete);
const hashValue = value => /^[a-f0-9]{64}$/.test(value ?? '');
const range = value => Number.isSafeInteger(value.start_line) && Number.isSafeInteger(value.end_line) && value.start_line > 0 && value.end_line >= value.start_line;

/** These declarations express execution intent, never proof of reading, review or adoption. */
export function creativeBriefErrors(brief, projectId) {
  if (!object(brief)) return ['creative_brief 必须为对象'];
  const errors = [], keys = ['goal', 'adaptation_permissions', 'director_intent', 'required_readings'];
  if (Object.keys(brief).some(key => !keys.includes(key))) errors.push('creative_brief 含未知字段');
  if (!concrete(brief.goal)) errors.push('creative_brief.goal 需要具体目标');
  if (brief.director_intent !== undefined && !concrete(brief.director_intent)) errors.push('creative_brief.director_intent 需要具体导演意图');
  if (brief.adaptation_permissions !== undefined && (!Array.isArray(brief.adaptation_permissions) || brief.adaptation_permissions.some(value => !/^[A-N]$/.test(value)) || new Set(brief.adaptation_permissions).size !== brief.adaptation_permissions.length)) errors.push('creative_brief.adaptation_permissions 需要不重复的 A～N 分类数组；分类本身不授予改变核心事实的权限');
  if (brief.required_readings !== undefined && !Array.isArray(brief.required_readings)) errors.push('creative_brief.required_readings 必须为数组');
  for (const [index, item] of (Array.isArray(brief.required_readings) ? brief.required_readings : []).entries()) {
    const label = `creative_brief.required_readings[${index}]`;
    if (!object(item) || !['source', 'asset'].includes(item.kind)) { errors.push(`${label}.kind 只能为 source 或 asset`); continue; }
    if (Object.keys(item).some(key => !['kind', 'asset', 'file', 'sha256', 'start_line', 'end_line'].includes(key))) errors.push(`${label} 含未知字段`);
    if (!filled(item.file) || !hashValue(item.sha256)) errors.push(`${label} 需要 file 和完整文件 sha256`);
    if (item.kind === 'source' && (Object.hasOwn(item, 'asset') || !range(item))) errors.push(`${label} 原稿要求不带 asset，并提供 start_line/end_line`);
    if (item.kind === 'asset') {
      if (!exactRef(item.asset) || Object.keys(item.asset ?? {}).some(key => !['asset_id', 'version'].includes(key)) || !item.asset?.asset_id.startsWith(`${projectId}-`)) errors.push(`${label}.asset 需要同项目精确 asset_id/version`);
      if ((Object.hasOwn(item, 'start_line') || Object.hasOwn(item, 'end_line')) && !range(item)) errors.push(`${label} 行范围须同时提供有效 start_line/end_line`);
    }
  }
  return errors;
}

function covered(ranges, start, end) {
  let next = start;
  for (const item of ranges.slice().sort((a, b) => a.start_line - b.start_line)) {
    if (item.start_line > next) break;
    if (item.end_line >= next) next = item.end_line + 1;
    if (next > end) return true;
  }
  return false;
}

/** Evaluate only text present in this context, including unions of explicitly selected ranges. */
export function readingRequirements(context, brief, { sameSourceFile = (left, right) => left === right } = {}) {
  const items = (brief.required_readings ?? []).map((required, index) => {
    const file = required.file.replaceAll('\\', '/');
    const readings = required.kind === 'source' ? (context.source_readings ?? []).filter(item => item.sha256 === required.sha256 && sameSourceFile(item.file, file))
      : (context.asset_readings ?? []).filter(item => referenceKey(item.ref) === referenceKey(required.asset) && item.file === file && item.sha256 === required.sha256);
    if (required.kind === 'asset' && file === '正文.md') for (const item of [...(context.adopted ?? []), ...(context.candidates ?? [])]) {
      const body = item.content?.chapter_text;
      if (referenceKey(item.ref) !== referenceKey(required.asset) || body?.sha256 !== required.sha256 || typeof body.text !== 'string') continue;
      const bodyLines = body.text.split(/\r\n|\n|\r/); if (/\r\n$|\n$|\r$/u.test(body.text)) bodyLines.pop();
      readings.push({ start_line: 1, end_line: bodyLines.length, total_lines: bodyLines.length });
    }
    const end = required.end_line ?? readings[0]?.total_lines;
    const complete = Number.isSafeInteger(end) && end > 0 && covered(readings, required.start_line ?? 1, end);
    return { index, required: structuredClone(required), included_ranges: readings.map(({ start_line, end_line }) => ({ start_line, end_line })), complete,
      evidence_scope: '仅检查匹配完整文件哈希的所需文本是否装入；不证明真实原著、AI已理解或语义审核通过。' };
  });
  return { complete: items.every(item => item.complete), items };
}

export function visualContractErrors(asset) {
  const errors = [], base = asset.data?.visual_base;
  if (base !== undefined) {
    if (!object(base)) return ['data.visual_base 必须为对象'];
    const extended = ['locked', 'components', 'reference_bindings'].some(key => Object.hasOwn(base, key));
    if (extended && !concrete(base.description)) errors.push('data.visual_base.description 需要固定视觉的具体描述');
    if (base.locked !== undefined && typeof base.locked !== 'boolean') errors.push('data.visual_base.locked 必须为布尔值，不能用采用或审核状态代替');
    for (const field of ['constraints', 'negative_constraints']) if (extended && base[field] !== undefined && !textList(base[field])) errors.push(`data.visual_base.${field} 需要具体文字或文字数组`);
    if (base.components !== undefined && !Array.isArray(base.components)) errors.push('data.visual_base.components 必须为数组');
    const ids = new Set();
    for (const [index, component] of (Array.isArray(base.components) ? base.components : []).entries()) {
      const label = `data.visual_base.components[${index}]`;
      if (!object(component) || !exactRef(component.asset) || !['CHAR', 'LOC', 'PROP'].includes(component.asset.asset_id.split('-')[1]) || Object.keys(component.asset).some(key => !['asset_id', 'version'].includes(key))) { errors.push(`${label}.asset 需要 CHAR/LOC/PROP 的精确版本引用`); continue; }
      if (!concrete(component.role)) errors.push(`${label}.role 需要组件职责`);
      if (ids.has(component.asset.asset_id)) errors.push(`${label} 同一组件资产不能重复或混用多个版本`);
      ids.add(component.asset.asset_id);
    }
    if (base.reference_bindings !== undefined) {
      errors.push(...referenceBindingErrors(base.reference_bindings).map(message => message.replaceAll('PROMPT.data.reference_bindings', 'data.visual_base.reference_bindings')));
      for (const [index, binding] of (Array.isArray(base.reference_bindings) ? base.reference_bindings : []).entries()) if (!concrete(binding?.role)) errors.push(`data.visual_base.reference_bindings[${index}].role 需要明确参考职责`);
    }
  }
  if (asset.type === 'SHOT' && Array.isArray(asset.data?.asset_visuals)) for (const [index, selection] of asset.data.asset_visuals.entries()) {
    if (object(selection) && Object.hasOwn(selection, 'state_description') && !concrete(selection.state_description)) errors.push(`data.asset_visuals[${index}].state_description 需要具体动态状态文字`);
  }
  return errors;
}
