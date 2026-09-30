import { object, filled, fail, referenceKey, eventKey, reviewItemId, dispositionMatches, ASSET_ID as ID } from './rules.mjs';
import { findEntry, readSnapshot } from './registry.mjs';
import { inspectAsset, collectRefs } from './asset-validation.mjs';
export const ensureNoErrors = errors => { if (errors.length) fail(errors.join('\n')); };
export function wasAdopted(project, assetId, version) {
  return (project.adoption_history ?? []).some(event => event.asset_id === assetId && event.version === version && filled(event.reason) && filled(event.at));
}
export function staleReviews(root, project) {
  const result = [];
  const cache = new Map();
  const inspections = new Map();
  const inspect = (assetId, version) => {
    const key = `${assetId}@${version}`;
    if (inspections.has(key)) return inspections.get(key);
    const snapshot = readSnapshot(root, project, assetId, version, cache);
    const inspection = inspectAsset(root, project, snapshot.entry, snapshot.directory, { strict: true, cache });
    ensureNoErrors(inspection.errors);
    inspections.set(key, inspection);
    return inspection;
  };
  for (const entry of project.assets.filter(item => item.adopted_version)) {
    const visited = new Set();
    const follow = (assetId, version, via) => {
      const key = `${assetId}@${version}`;
      if (visited.has(key)) return;
      visited.add(key);
      for (const ref of inspect(assetId, version).refs) {
        const upstream = findEntry(project, ref.asset_id);
        if (upstream.adopted_version && upstream.adopted_version !== ref.version) result.push({ asset_id: entry.asset_id, version: entry.adopted_version, dependency_id: ref.asset_id, referenced_version: ref.version, current_version: upstream.adopted_version, via, reason: via.length ? '间接上游采用版本已变化；沿依赖链复核，保留固定历史引用' : '上游采用版本已变化；保留固定历史引用，需复核是否更新' });
        follow(ref.asset_id, ref.version, [...via, referenceKey(ref)]);
      }
    };
    follow(entry.asset_id, entry.adopted_version, []);
  }
  return [...new Map(result.map(item => [reviewItemId(item), { ...item, review_item_id: reviewItemId(item) }])).values()]
    .filter(item => !(project.review_dispositions ?? []).some(record => dispositionMatches(item, record)));
}
export function exportClosure(root, project, roots = null, { requireBridge = true } = {}) {
  const selected = new Map(), cache = new Map();
  function visit(assetId, version) {
    const key = `${assetId}@${version}`;
    if (selected.has(key)) return;
    if (!wasAdopted(project, assetId, version)) fail(`${key}：未曾采用的草稿不能进入交接包`);
    const snapshot = readSnapshot(root, project, assetId, version, cache);
    const inspected = inspectAsset(root, project, snapshot.entry, snapshot.directory, { strict: true, cache });
    ensureNoErrors(inspected.errors);
    selected.set(key, { ...snapshot, refs: inspected.refs, warnings: inspected.warnings });
    for (const ref of inspected.refs) visit(ref.asset_id, ref.version);
  }
  for (const ref of roots ?? project.assets.filter(item => item.adopted_version).map(item => ({ asset_id: item.asset_id, version: item.adopted_version }))) visit(ref.asset_id, ref.version);
  const snapshots = [...selected.values()];
  if (requireBridge) for (const type of ['CH', 'EP', 'SC', 'SHOT']) if (!snapshots.some(item => item.asset.type === type)) fail(`无法导出：缺少已采用的 ${type} 内容，请完成章节、分集、场次及镜头桥接`);
  return snapshots.sort((a, b) => referenceKey(a.asset).localeCompare(referenceKey(b.asset), 'en'));
}
export function scopeSelection(root, project, { episodes, chapters }) {
  if (episodes && chapters) fail('--episodes 与 --chapters 不能同时使用');
  if (!episodes && !chapters) return null;
  const type = episodes ? 'EP' : 'CH';
  const supplied = episodes ?? chapters;
  const ids = (Array.isArray(supplied) ? supplied : String(supplied).split(',')).map(value => String(value).trim());
  if (!ids.length || ids.some(id => !ID.test(id)) || new Set(ids).size !== ids.length) fail('范围参数需要逗号分隔且不重复的完整资产 ID');
  for (const id of ids) { const entry = findEntry(project, id); if (entry.type !== type || !entry.adopted_version) fail(`${id}：范围必须指向已采用的 ${type}`); }
  const cache = new Map();
  const current = project.assets.filter(entry => entry.adopted_version).map(entry => readSnapshot(root, project, entry.asset_id, entry.adopted_version, cache));
  const episodeIds = new Set(type === 'EP' ? ids : []);
  if (type === 'CH') {
    for (const item of current.filter(item => item.asset.type === 'EP')) if (item.asset.data.chapter_refs?.some(ref => ids.includes(ref.asset_id))) episodeIds.add(item.asset.asset_id);
    for (const shot of current.filter(item => item.asset.type === 'SHOT')) {
      const ref = shot.asset.data.episode; const ep = readSnapshot(root, project, ref.asset_id, ref.version, cache);
      if (ep.asset.data.chapter_refs?.some(chapter => ids.includes(chapter.asset_id))) episodeIds.add(ref.asset_id);
    }
    if (!episodeIds.size) fail('所选章节尚无已采用剧集，请先完成桥接；纯小说续作请使用 resume');
  }
  const core = current.filter(item => item.asset.type === 'EP' ? episodeIds.has(item.asset.asset_id) : ['SC', 'SHOT'].includes(item.asset.type) && episodeIds.has(item.asset.data.episode?.asset_id));
  const chapterIds = new Set(type === 'CH' ? ids : []);
  for (const item of core) {
    if (item.asset.type === 'EP') for (const ref of item.asset.data.chapter_refs ?? []) chapterIds.add(ref.asset_id);
    if (item.asset.type === 'SHOT') {
      const ep = readSnapshot(root, project, item.asset.data.episode.asset_id, item.asset.data.episode.version, cache);
      for (const ref of ep.asset.data.chapter_refs ?? []) chapterIds.add(ref.asset_id);
    }
  }
  core.push(...current.filter(item => item.asset.type === 'CH' && chapterIds.has(item.asset.asset_id)));
  const roots = core.map(item => ({ asset_id: item.asset.asset_id, version: item.asset.version }));
  const base = exportClosure(root, project, roots);
  const coreIds = new Set(core.map(item => item.asset.asset_id));
  const baseIds = new Set(base.map(item => item.asset.asset_id));
  const warnings = [];
  // Related reports may bring extra source chapters as evidence. They do not expand
  // the playback tree or make those evidence chapters require an adaptation.
  const candidates = current.filter(item => ['PROMPT', 'MEDIA', 'REPORT'].includes(item.asset.type));
  const examined = new Set();
  let changed = true;
  while (changed) { changed = false; for (const item of candidates) {
    if (examined.has(item.asset.asset_id)) continue;
    const collected = [], refErrors = [];
    collectRefs(item.asset.refs, 'refs', collected, refErrors); collectRefs(item.asset.data, 'data', collected, refErrors);
    if (!collected.some(({ ref }) => baseIds.has(ref.asset_id))) continue;
    examined.add(item.asset.asset_id);
    const dependency = exportClosure(root, project, [{ asset_id: item.asset.asset_id, version: item.asset.version }], { requireBridge: false });
    const crossesEpisode = dependency.some(dep => dep.asset.type === 'EP' ? !episodeIds.has(dep.asset.asset_id) : ['SC', 'SHOT'].includes(dep.asset.type) && !episodeIds.has(dep.asset.data.episode?.asset_id));
    if (crossesEpisode) { warnings.push(`${referenceKey(item.asset)} 同时依赖范围外的制作节点，本次未把它纳入；请拆分该交接资产或扩大所选剧集。`); continue; }
    roots.push({ asset_id: item.asset.asset_id, version: item.asset.version });
    baseIds.add(item.asset.asset_id); changed = true;
  } }
  return { roots, episodeIds, coreIds, requested: { type, asset_ids: ids }, warnings };
}
export function playbackProjection(snapshots, selection = null) {
  // Historical shots referenced by prompts remain dependencies, not extra playback slots.
  const shots = snapshots.filter(item => item.asset.type === 'SHOT' && item.entry.adopted_version === item.asset.version && (!selection || selection.episodeIds.has(item.asset.data.episode.asset_id)));
  const sceneKeys = new Set(shots.map(item => referenceKey(item.asset.data.scene)));
  const episodeKeys = new Set(shots.map(item => referenceKey(item.asset.data.episode)));
  const scenes = snapshots.filter(item => item.asset.type === 'SC' && sceneKeys.has(referenceKey(item.asset)));
  const episodes = snapshots.filter(item => item.asset.type === 'EP' && episodeKeys.has(referenceKey(item.asset)));
  const chapterKeys = new Set(episodes.flatMap(item => item.asset.data.chapter_refs.map(referenceKey)));
  const chapters = snapshots.filter(item => item.asset.type === 'CH' && chapterKeys.has(referenceKey(item.asset)));
  const playback = { chapters, episodes, scenes, shots };
  // A new version of the same asset may retain a completed historical bridge.
  // Entirely new chapters/episodes/scenes cannot hide behind another completed chain.
  for (const item of snapshots) {
    if (selection && !selection.coreIds.has(item.asset.asset_id)) continue;
    if (item.asset.type === 'CH' && !chapters.some(other => other.asset.asset_id === item.asset.asset_id)) fail(`${referenceKey(item.asset)}：该章节尚无完整的已采用分集、场次和镜头链路`);
    if (item.asset.type === 'EP' && !episodes.some(other => other.asset.asset_id === item.asset.asset_id)) fail(`${referenceKey(item.asset)}：该剧集尚无完整的已采用场次和镜头链路`);
    if (item.asset.type === 'SC' && !scenes.some(other => other.asset.asset_id === item.asset.asset_id)) fail(`${referenceKey(item.asset)}：该场次尚无已采用 SHOT 镜头`);
  }
  const numbers = new Set();
  const timelines = new Map();
  const nodeVersions = new Map();
  for (const { asset } of [...episodes, ...scenes, ...shots]) {
    if (nodeVersions.has(asset.asset_id) && nodeVersions.get(asset.asset_id) !== asset.version) fail(`${asset.asset_id}：当前镜头混用了该制作节点的多个版本；请对齐当前镜头的所属集/场次版本。历史依赖仍可保留。`);
    nodeVersions.set(asset.asset_id, asset.version);
    const d = asset.data;
    const numberKey = asset.type === 'EP' ? `EP:${d.episode_number}` : asset.type === 'SC' ? `SC:${referenceKey(d.episode)}:${d.scene_number}` : `SHOT:${referenceKey(d.episode)}:${d.shot_number}`;
    if (numberKey && numbers.has(numberKey)) fail(`同一播放层级内编号重复：${numberKey}`);
    if (numberKey) numbers.add(numberKey);
    if (asset.type === 'SHOT') {
      const epKey = referenceKey(d.episode);
      if (!timelines.has(epKey)) timelines.set(epKey, []);
      timelines.get(epKey).push(asset);
    }
  }
  for (const [episode, shots] of timelines) {
    shots.sort((a, b) => a.data.start_seconds - b.data.start_seconds);
    for (let index = 1; index < shots.length; index++) if (shots[index].data.start_seconds < shots[index - 1].data.start_seconds + shots[index - 1].data.duration_seconds - 1e-8) fail(`${episode}：镜头播放时间重叠 ${shots[index - 1].asset_id} / ${shots[index].asset_id}`);
  }
  const covered = new Set([...chapters, ...episodes, ...scenes, ...shots].map(item => referenceKey(item.asset)));
  const uncovered = snapshots.filter(item => ['CH', 'EP', 'SC'].includes(item.asset.type) && (!selection || selection.coreIds.has(item.asset.asset_id)) && item.entry.adopted_version === item.asset.version && !covered.has(referenceKey(item.asset))).map(item => ({ asset_id: item.asset.asset_id, version: item.asset.version, type: item.asset.type, reason: '当前采用新版未进入本次镜头链；本次交接保留相同资产的历史已完成版本' }));
  return { ...playback, uncovered };
}
