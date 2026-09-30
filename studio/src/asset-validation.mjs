import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM, CHAPTER_FILES, SOURCE_KINDS, ADOPTION_STATUSES, SHOT_TEXT_FIELDS, ASSET_ID as ID, VERSION, object, filled, meaningful, concrete, nonemptyString, fail, referenceKey, eventKey, referenceBindingErrors, mediaFileErrors } from './rules.mjs';
import { relativeFiles, readJSON, readText, safePath } from './storage.mjs';
import { readSnapshot } from './registry.mjs';
export function collectRefs(value, location, refs, errors, { skipIdentity = false } = {}) {
  if (Array.isArray(value)) return value.forEach((item, index) => collectRefs(item, `${location}[${index}]`, refs, errors));
  if (!object(value)) return;
  if (Object.hasOwn(value, 'asset_id') && !skipIdentity) {
    if (!ID.test(value.asset_id) || typeof value.version !== 'string' || !VERSION.test(value.version)) errors.push(`${location}：正式引用需要有效 asset_id 和 version`);
    else refs.push({ ref: value, location });
    // A reference can carry metadata with other references; never hide those dependencies.
  }
  for (const [key, item] of Object.entries(value)) {
    if (skipIdentity && ['asset_id', 'project_id', 'version'].includes(key)) continue;
    if (key === 'refs' || key.endsWith('_refs')) {
      if (!Array.isArray(item)) errors.push(`${location}.${key}：正式引用列表必须为数组`);
      else item.forEach((ref, index) => { if (!object(ref) || !ID.test(ref.asset_id ?? '') || !VERSION.test(ref.version ?? '')) errors.push(`${location}.${key}[${index}]：正式引用需要有效 asset_id 和 version`); });
    }
    collectRefs(item, `${location}.${key}`, refs, errors);
  }
}
export function inspectAsset(root, project, entry, directory, { strict = false, legacy = false, cache = new Map() } = {}) {
  const errors = [], warnings = [], refs = [];
  let asset;
  const label = `${entry.asset_id}/${path.relative(root, directory).replaceAll('\\', '/')}`;
  const incomplete = message => (strict ? errors : warnings).push(`${label}：${message}`);
  const must = (condition, message) => { if (!condition) incomplete(message); };
  const historical = path.relative(root, directory).replaceAll('\\', '/').startsWith(`${SYSTEM}/snapshots/`);
  const requireShape = (condition, message) => { if (!condition) ((!legacy && (strict || !historical)) ? errors : warnings).push(`${label}：${message}`); };
  try {
    // Enumerating rejects links even in files not otherwise used by this version.
    relativeFiles(root, directory);
    asset = readJSON(path.join(directory, 'asset.json'));
    if (!object(asset) || asset.schema_version !== 1 || asset.project_id !== project.project_id || asset.asset_id !== entry.asset_id || asset.type !== entry.type) fail(`${label}/asset.json：身份字段与项目登记不一致`);
    if (!VERSION.test(asset.version)) fail(`${label}/asset.json：version 必须为三段数字`);
    if (!SOURCE_KINDS.includes(asset.source_kind)) fail(`${label}/asset.json：来源性质不在协议枚举中`);
    if (!ADOPTION_STATUSES.includes(asset.adoption_status)) fail(`${label}/asset.json：采用语义不在协议枚举中`);
    if (!Array.isArray(asset.refs)) fail(`${label}/asset.json：refs 应为数组`);
    asset.refs.forEach((ref, index) => { if (!object(ref) || !ID.test(ref.asset_id ?? '') || !VERSION.test(ref.version ?? '')) errors.push(`${label}/refs[${index}]：正式引用需要有效 asset_id 和 version`); });
    if (!object(asset.data)) fail(`${label}/asset.json：data 应为对象`);
    must(filled(asset.title), 'title 待补全');
    must(meaningful(asset.data), 'data 内容待补全');
    collectRefs(asset.refs, `${label}/refs`, refs, errors);
    collectRefs(asset.data, `${label}/data`, refs, errors);
    const data = asset.data;
    const requireRef = (ref, type, field, event = false) => {
      must(object(ref) && ref.asset_id?.split('-')[1] === type && VERSION.test(ref.version ?? ''), `${field} 需要 ${type} 版本引用`);
      if (event) must(filled(ref?.event_id), `${field} 需要 event_id`);
    };
    const sourceRefs = () => {
      must(Array.isArray(data.source_refs) && data.source_refs.length > 0, 'source_refs 需要章节事件来源');
      if (Array.isArray(data.source_refs)) data.source_refs.forEach((ref, index) => requireRef(ref, 'CH', `source_refs[${index}]`, true));
    };
    if (entry.type === 'CH') {
      for (const filename of CHAPTER_FILES) {
        const file = path.join(directory, filename);
        if (!fs.existsSync(file)) { errors.push(`${label}/${filename}：章节七文件缺失`); continue; }
        if (filename.endsWith('.md')) { must(filled(readText(file)), '正文.md 待补全'); continue; }
        const content = readJSON(file);
        if (!object(content) && !Array.isArray(content)) { errors.push(`${label}/${filename}：需要 JSON 对象或数组`); continue; }
        if (object(content)) {
          for (const key of ['asset_id', 'project_id', 'version']) {
            if (content[key] !== undefined && content[key] !== asset[key]) errors.push(`${label}/${filename}：${key} 与章节版本不一致`);
          }
          if (content.chapter_id !== undefined && content.chapter_id !== asset.asset_id) errors.push(`${label}/${filename}：chapter_id 与章节 asset_id 不一致`);
        }
        collectRefs(content, `${label}/${filename}`, refs, errors, { skipIdentity: object(content) });
        if (filename !== '新增设定.json') must(meaningful(content), `${filename} 内容待补全（身份字段不能代替内容）`);
      }
      must(Array.isArray(data.events) && data.events.length > 0, 'events 需要故事事件');
      const eventIds = new Set();
      for (const [index, event] of (Array.isArray(data.events) ? data.events : []).entries()) {
        must(object(event) && filled(event.event_id) && filled(event.story_time) && filled(event.summary), `events[${index}] 缺少事件 ID、故事时间或摘要`);
        if (eventIds.has(event?.event_id)) errors.push(`${label}：重复 event_id ${event.event_id}`);
        eventIds.add(event?.event_id);
      }
    }
    if (entry.type === 'EP') {
      must(Number.isInteger(data.episode_number) && data.episode_number > 0, 'episode_number 应为正整数');
      must(Array.isArray(data.chapter_refs) && data.chapter_refs.length > 0, 'chapter_refs 需要来源章节');
      if (Array.isArray(data.chapter_refs)) data.chapter_refs.forEach((ref, index) => requireRef(ref, 'CH', `chapter_refs[${index}]`));
    }
    if (entry.type === 'SC') {
      must(Number.isInteger(data.scene_number) && data.scene_number > 0, 'scene_number 应为正整数');
      requireRef(data.episode, 'EP', 'episode');
      requireRef(data.location, 'LOC', 'location');
      sourceRefs();
    }
    if (entry.type === 'SHOT') {
      requireRef(data.episode, 'EP', 'episode');
      requireRef(data.scene, 'SC', 'scene');
      sourceRefs();
      must(Number.isInteger(data.shot_number) && data.shot_number > 0, 'shot_number 应为正整数');
      must(Number.isFinite(data.start_seconds) && data.start_seconds >= 0, 'start_seconds 应为非负数');
      must(Number.isFinite(data.duration_seconds) && data.duration_seconds > 0, 'duration_seconds 应为正数');
      for (const field of SHOT_TEXT_FIELDS) must(concrete(data[field]), `${field} 文字待补全，不能使用 undefined、null、同上或待填`);
    }
    if (entry.type === 'PROMPT' && meaningful(data)) {
      requireShape(object(data.shot) && data.shot.asset_id?.split('-')[1] === 'SHOT' && VERSION.test(data.shot.version ?? ''), 'shot 需要 SHOT 版本引用');
      for (const field of ['image_prompt', 'video_prompt', 'prompt', 'negative_prompt']) {
        if (typeof data[field] === 'string' && data[field].trim() && !concrete(data[field])) requireShape(false, `${field} 不能含 undefined、null、同上或待填`);
      }
      requireShape([data.image_prompt, data.video_prompt, data.prompt].some(concrete), '提示词需要至少一条可复制的 image_prompt、video_prompt 或 prompt 正文');
      requireShape(concrete(data.negative_prompt), 'negative_prompt 需要本镜排除项；没有额外排除时写“无额外项”');
    }
    if (entry.type === 'PROMPT' && Object.hasOwn(data, 'reference_bindings')) {
      for (const message of referenceBindingErrors(data.reference_bindings)) requireShape(false, message);
      for (const [index, binding] of (Array.isArray(data.reference_bindings) ? data.reference_bindings : []).entries()) {
        if (referenceBindingErrors([binding]).length) continue;
        const field = `data.reference_bindings[${index}]`;
        let media;
        try { media = readSnapshot(root, project, binding.media.asset_id, binding.media.version, cache); }
        catch (error) { errors.push(`${label}/${field}.media：${error.message}`); continue; }
        const relative = binding.file_path.replaceAll('\\', '/');
        const file = (Array.isArray(media.asset.data?.files) ? media.asset.data.files : []).find(item => object(item) && typeof item.path === 'string' && item.path.replaceAll('\\', '/') === relative);
        requireShape(Boolean(file), `${field}.file_path 未登记在 ${referenceKey(binding.media)} 的 data.files：${relative}`);
        if (!file) continue;
        requireShape(Object.hasOwn(media.manifest.files, relative), `${field}.file_path 与指定 MEDIA 快照文件清单的实际拼写不匹配：${relative}`);
        if (!Object.hasOwn(media.manifest.files, relative)) continue;
        try {
          const actual = safePath(media.directory, relative);
          if (!fs.existsSync(actual) || !fs.statSync(actual).isFile()) fail('指定文件不存在或不是普通文件');
        } catch (error) { requireShape(false, `${field}.file_path：${error.message}`); continue; }
        if (Object.hasOwn(binding, 'expected_usage_id')) {
          requireShape(nonemptyString(file.usage_id), `${field}.expected_usage_id 要求所指 MEDIA 文件登记非空 usage_id`);
          if (nonemptyString(file.usage_id)) requireShape(file.usage_id === binding.expected_usage_id, `${field}.expected_usage_id 与所指文件 usage_id 不一致（要求 ${JSON.stringify(binding.expected_usage_id)}，登记 ${JSON.stringify(file.usage_id)}）`);
        } else warnings.push(`${label}/${field}：未启用用途匹配（未声明 expected_usage_id）；文件校验不代表图片用途或内容已验收。`);
      }
    }
    if (entry.type === 'PLOT' && (meaningful(data) || filled(data.reading_mode) || filled(data.engine) || (Array.isArray(data.relationship_debts) && data.relationship_debts.length > 0))) {
      requireShape(['追读向', '短剧口播', '氛围短篇'].includes(data.reading_mode), 'reading_mode 只能是追读向、短剧口播或氛围短篇');
      requireShape(filled(data.engine), 'engine 需要一个可重复的主引擎');
      requireShape(Array.isArray(data.relationship_debts), 'relationship_debts 必须为数组，没有欠账时写 []');
      for (const [index, debt] of (Array.isArray(data.relationship_debts) ? data.relationship_debts : []).entries()) {
        requireShape(object(debt) && filled(debt.who) && filled(debt.owes) && filled(debt.what), `relationship_debts[${index}] 需要 who、owes、what`);
      }
    }
    if (entry.type === 'STATE') {
      must(Array.isArray(data.changes) && data.changes.length > 0, 'changes 需要状态变化记录');
      for (const [index, change] of (Array.isArray(data.changes) ? data.changes : []).entries()) {
        requireRef(change?.event_ref, 'CH', `changes[${index}].event_ref`, true);
        for (const field of ['before', 'after', 'effective_node', 'story_time']) must(meaningful(change?.[field]), `changes[${index}].${field} 待补全`);
      }
      for (const field of ['knowledge', 'possessions', 'foreshadowing']) {
        if (data[field] === undefined && !meaningful(data)) continue;
        if (!Array.isArray(data[field])) { requireShape(false, `${field} 必须为数组，没有记录时写 []`); continue; }
        for (const [index, item] of data[field].entries()) {
          requireShape(object(item) && filled(item.fact), `${field}[${index}].fact 需要具体事实`);
          const ref = item?.event_ref;
          requireShape(object(ref) && ref.asset_id?.split('-')[1] === 'CH' && VERSION.test(ref.version ?? '') && filled(ref.event_id), `${field}[${index}].event_ref 需要带 event_id 的 CH 版本引用`);
          if (field === 'knowledge') requireShape(filled(item?.who) && ['知道', '怀疑', '误信', '未知'].includes(item?.status), `${field}[${index}] 需要 who，且 status 只能是知道、怀疑、误信或未知`);
          if (field === 'possessions') requireShape(filled(item?.holder), `${field}[${index}].holder 需要当前持有者`);
          if (field === 'foreshadowing') requireShape(['已埋', '推进', '已回收', '未回收'].includes(item?.status), `${field}[${index}].status 只能是已埋、推进、已回收或未回收`);
        }
      }
    }
    if (entry.type === 'MEDIA') {
      for (const message of mediaFileErrors(data.files ?? [])) requireShape(false, message);
      must(Array.isArray(data.files) && data.files.length > 0, 'MEDIA.data.files 需要实际媒体文件清单，file_path 或状态文字不能代替文件');
      if (data.files !== undefined && !Array.isArray(data.files)) errors.push(`${label}/data.files：必须为数组`);
      const mediaPaths = new Set();
      for (const [index, file] of (Array.isArray(data.files) ? data.files : []).entries()) {
        if (object(file) && Object.hasOwn(file, 'usage_id')) requireShape(nonemptyString(file.usage_id), `data.files[${index}].usage_id 声明时必须为非空字符串`);
        try {
          if (!object(file) || !['image', 'video', 'audio', 'other'].includes(file.kind)) fail('kind 必须为 image、video、audio 或 other');
          const actual = safePath(directory, file.path);
          const key = file.path.replaceAll('\\', '/').toLowerCase();
          if (['_snapshot.json', 'asset.json'].includes(path.basename(actual).toLowerCase())) fail('媒体清单不能把资产元数据或快照清单当媒体');
          if (mediaPaths.has(key)) fail('媒体文件路径重复');
          mediaPaths.add(key);
          if (!fs.existsSync(actual) || !fs.statSync(actual).isFile()) fail('媒体文件不存在或不是普通文件');
        } catch (error) { errors.push(`${label}/data.files[${index}]：${error.message}`); }
      }
    }
    for (const { ref, location } of refs) {
      if (!ref.asset_id.startsWith(`${project.project_id}-`)) { errors.push(`${location}：拒绝跨 IP 引用 ${ref.asset_id}`); continue; }
      try {
        const upstream = readSnapshot(root, project, ref.asset_id, ref.version, cache);
        if (ref.event_id !== undefined && (upstream.asset.type !== 'CH' || !upstream.asset.data.events?.some(event => event.event_id === ref.event_id))) errors.push(`${location}：来源事件 ${String(ref.event_id)} 不存在于该章节版本`);
      } catch (error) { errors.push(`${location}：${error.message}`); }
    }
    // Verify that bridge links describe one coherent hierarchy, independent of render order.
    if (entry.type === 'SC' && data.episode?.asset_id && Array.isArray(data.source_refs)) {
      try {
        const ep = readSnapshot(root, project, data.episode.asset_id, data.episode.version, cache).asset;
        const chapters = new Set((ep.data.chapter_refs ?? []).map(referenceKey));
        for (const ref of data.source_refs) if (!chapters.has(referenceKey(ref))) errors.push(`${label}：场次来源章节不属于所属 EP 的 chapter_refs`);
      } catch { /* the reference error above is the actionable location */ }
    }
    if (entry.type === 'SHOT' && data.scene?.asset_id && Array.isArray(data.source_refs)) {
      try {
        const scene = readSnapshot(root, project, data.scene.asset_id, data.scene.version, cache).asset;
        if (referenceKey(data.episode ?? {}) !== referenceKey(scene.data.episode ?? {})) errors.push(`${label}：镜头 EP 与所属 SC 的 EP 不一致`);
        const events = new Set((scene.data.source_refs ?? []).map(eventKey));
        for (const ref of data.source_refs) if (!events.has(eventKey(ref))) errors.push(`${label}：镜头来源事件未列入所属 SC 来源`);
      } catch { /* invalid refs were already reported */ }
    }
  } catch (error) { errors.push(error.message); }
  const uniqueRefs = [...new Map(refs.map(item => [`${referenceKey(item.ref)}#${item.ref.event_id ?? ''}`, item.ref])).values()];
  return { asset, errors, warnings, refs: uniqueRefs };
}
