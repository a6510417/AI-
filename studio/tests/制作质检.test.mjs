import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, newAsset, saveVersion, CHAPTER_FILES } from '../src/project-service.mjs';
import { createAssetSkeleton, hash, jsonText, referenceKey } from '../src/rules.mjs';
import { fingerprint } from '../src/storage.mjs';
import { checkProduction, repairProduction } from '../src/制作质检.mjs';
import { compileShotPrompts } from '../src/提示词编译.mjs';

const PROJECT_ID = 'IP884';
const ref = (type, sequence = 1, version = '1.0.0') => ({ asset_id: `${PROJECT_ID}-${type}-${String(sequence).padStart(3, '0')}`, version });
const event = event_id => ({ ...ref('CH'), event_id });
const clone = value => structuredClone(value);
const candidate = (type, data, sequence = 1) => {
  const asset = createAssetSkeleton({ projectId: PROJECT_ID, type, sequence, title: `${type}隔离测试` }).asset;
  asset.data = { ...asset.data, ...data };
  const files = type === 'CH' ? Object.fromEntries(CHAPTER_FILES.map(name => [name, name.endsWith('.md') ? '守灯人将铜钥匙交给来客，来客收到后站稳。' : jsonText({ entries: ['真实测试来源内容'] })])) : {};
  return { asset, files };
};

function fixture(t) {
  const temporary = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temporary, 'comic-production-check-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), temporary); assert.ok(path.basename(root).startsWith('comic-production-check-')); fs.rmSync(root, { recursive: true, force: true }); });
  const project = initProject({ root, id: PROJECT_ID, name: '制作质检隔离测试' }).project;
  const chapter = candidate('CH', { chapter_number: 1, events: [{ event_id: '交接', story_time: '第一夜', summary: '交接钥匙' }, { event_id: '收起', story_time: '第一夜稍后', summary: '收起钥匙' }] });
  const character = candidate('CHAR', { name: '守灯人', appearance: '跨章汇总：后章出现红袍，不应复制' });
  const prop = candidate('PROP', { name: '铜钥匙', description: '一把铜钥匙' });
  const location = candidate('LOC', { description: '石塔灯室' });
  const episode = candidate('EP', { episode_number: 1, chapter_refs: [ref('CH')], summary: '来客接到钥匙' });
  const scene = candidate('SC', { scene_number: 1, episode: ref('EP'), location: ref('LOC'), source_refs: [event('交接'), event('收起')], script: '来客接过钥匙，守灯人空手。' });
  const shot = candidate('SHOT', { episode: ref('EP'), scene: ref('SC'), source_refs: [event('交接')], character_refs: [ref('CHAR')], shot_number: 1, start_seconds: 0, duration_seconds: 8, story_time: '第一夜', scene_description: '灯室窗前', characters: '守灯人与来客', action: '来客接稳后守灯人松手', emotion: '克制', dialogue: '无', shot_size: '双手近景', camera_movement: '固定机位', lighting: '暖光', video_prompt: '保留的手写通用视频稿', entry_state: '铜钥匙在守灯人右掌，来客尚未接触', exit_state: '铜钥匙在来客右掌，守灯人空手', asset_visuals: [{ asset: ref('CHAR'), description: '灰衣黑发青年，左眉尾有旧疤' }, { asset: ref('PROP'), description: '单把短柄铜钥匙' }], negative_constraints: ['不增加第二把钥匙'] });
  const assets = [chapter, character, prop, location, episode, scene, shot];
  shot.asset.data.visual_description = '交接前双方双手完整可见';
  const request = () => ({ assets: clone(assets) });
  const resolver = list => reference => {
    const item = list.find(item => referenceKey(item.asset) === referenceKey(reference));
    if (!item) throw new Error('fixture 引用未找到');
    return { asset: item.asset, manifest: { files: {} }, saved: { manifest_sha256: hash(jsonText(item)) }, entry: { adopted_version: null }, candidate: true };
  };
  const prompt = () => {
    const result = compileShotPrompts({ project, request: { shot: shot.asset }, resolveAsset: resolver(assets) });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const item = candidate('PROMPT', result.prompt_data); item.files = result.files;
    return item;
  };
  return { project, assets, chapter, character, prop, location, episode, scene, shot, request, resolver, prompt };
}

test('候选图检查稳定且只读，不伪装已做语义审核', t => {
  const f = fixture(t), request = f.request(), original = clone(request), before = fingerprint(f.project, f.project);
  const result = checkProduction({ project: f.project, request });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(request, original); assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.deepEqual(checkProduction({ project: f.project, request }), result);
  assert.ok(result.issues.some(issue => issue.rule === 'continuity.unstructured' && issue.certainty === 'unknown'));
  assert.match(result.coverage.semantic_review, /未执行/);
  assert.ok(result.issues.every(issue => /^CHECK-[a-f0-9]{24}$/.test(issue.id)));
});

test('沿用同一schema拒绝跨IP、无效事件、环路、附件越界与非法时长', t => {
  const f = fixture(t);
  for (const mutate of [
    request => { request.assets.at(-1).asset.data.duration_seconds = 0; },
    request => { request.assets.at(-1).asset.data.source_refs[0].event_id = '不存在'; },
    request => { request.assets.at(-1).asset.data.character_refs = [{ asset_id: 'IP999-CHAR-001', version: '1.0.0' }]; },
    request => { request.assets.at(-1).asset.refs.push(ref('SHOT')); },
    request => { request.assets.at(-1).files['../越界.txt'] = '不能写'; },
    request => { request.assets.at(-1).files['参考.json'] = jsonText({ source: { asset_id: 'IP999-CHAR-001', version: '1.0.0' } }); }
  ]) {
    const request = f.request(); mutate(request);
    const result = checkProduction({ project: f.project, request });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.severity === 'blocker'), result.errors.join('\n'));
  }
});

test('JSON附件后缀大小写一致检查，非法内容、跨IP与根级自引用都不能绕过', t => {
  const f = fixture(t), before = fingerprint(f.project, f.project);
  for (const extension of ['json', 'JSON', 'JsOn']) for (const content of [
    '{无效JSON',
    jsonText({ source: { asset_id: 'IP999-CHAR-001', version: '1.0.0' } }),
    jsonText({ asset_id: 'IP999-CHAR-001', version: '1.0.0' }),
    jsonText({ source: ref('CHAR') }),
    jsonText(ref('CHAR'))
  ]) {
    const item = clone(f.character); item.files[`来源.${extension}`] = content;
    const request = { assets: [item] }, original = clone(request);
    const checked = checkProduction({ project: f.project, request });
    assert.equal(checked.ok, false, `${extension}: ${content}`);
    assert.ok(checked.issues.some(issue => issue.severity === 'blocker'));
    assert.deepEqual(request, original);
    assert.deepEqual(fingerprint(f.project, f.project), before);
  }
});

test('标准章节JSON仍识别所属章节根身份，任意来源附件根引用正常校验', t => {
  const f = fixture(t), request = f.request(), chapter = request.assets[0];
  for (const name of CHAPTER_FILES.filter(name => name.endsWith('.json'))) chapter.files[name] = jsonText({ project_id: PROJECT_ID, asset_id: ref('CH').asset_id, chapter_id: ref('CH').asset_id, version: '1.0.0', entries: ['交接事件的实际测试说明'] });
  request.assets.find(item => item.asset.type === 'PROP').files['人物来源.JSON'] = jsonText(ref('CHAR'));
  let result = checkProduction({ project: f.project, request });
  assert.equal(result.ok, true, result.errors.join('\n'));
  chapter.files['摘要.json'] = jsonText({ asset_id: 'IP999-CH-001', version: '1.0.0', entries: ['错误章节身份'] });
  result = checkProduction({ project: f.project, request });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => /与章节版本不一致/.test(error)));
});

test('跨镜重复编号和时间重叠提前报出，修复不调整切点', t => {
  const f = fixture(t), request = f.request(), second = clone(f.shot);
  second.asset.asset_id = ref('SHOT', 2).asset_id; second.asset.data.start_seconds = 7;
  request.assets.push(second);
  const checked = checkProduction({ project: f.project, request });
  assert.ok(checked.issues.some(issue => issue.rule === 'storyboard.duplicate_number'));
  assert.ok(checked.issues.some(issue => issue.rule === 'storyboard.timeline_overlap'));
  const repaired = repairProduction({ project: f.project, request: { ...request, expected_fingerprint: checked.input_fingerprint } });
  assert.equal(repaired.ok, false); assert.equal(repaired.assets.at(-1).asset.data.start_seconds, 7);
  assert.equal(repaired.patches.length, 0);
});

test('只有显式完整分集范围才核对缺镜与目标时长，局部范围不判缺全集', t => {
  const f = fixture(t); f.episode.asset.data.target_duration_seconds = 20;
  let result = checkProduction({ project: f.project, request: f.request() });
  assert.equal(result.ok, true, result.errors.join('\n'));
  result = checkProduction({ project: f.project, request: { ...f.request(), complete_episodes: [ref('EP')] } });
  assert.ok(result.issues.some(issue => issue.rule === 'storyboard.target_duration_mismatch'));
  const noShots = f.request(); noShots.assets = noShots.assets.filter(item => item.asset.type !== 'SHOT');
  result = checkProduction({ project: f.project, request: { ...noShots, complete_episodes: [ref('EP')] } });
  assert.ok(result.issues.some(issue => issue.rule === 'storyboard.missing_shots'));
});

test('旧SHOT缺新视觉选择或结构状态只列制作缺口，不升级旧schema', t => {
  const f = fixture(t); delete f.shot.asset.data.asset_visuals; delete f.shot.asset.data.entry_state; delete f.shot.asset.data.exit_state;
  const result = checkProduction({ project: f.project, request: f.request() });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.issues.some(issue => issue.rule === 'prompt.input_invalid' && issue.severity === 'suggestion'));
});

test('修复只补明确来源字段与空派生视频稿，不覆盖已有剧情或填无对白', t => {
  const f = fixture(t), request = f.request(), shot = request.assets.at(-1).asset;
  delete shot.data.episode; delete shot.data.entry_state; delete shot.data.exit_state;
  shot.data.first_frame_description = '铜钥匙静卧守灯人右掌，来客尚未触碰';
  shot.data.end_frame_description = '来客右手握住铜钥匙，守灯人右手空着';
  shot.data.video_prompt = '';
  const original = clone(request), before = fingerprint(f.project, f.project);
  const result = repairProduction({ project: f.project, request });
  assert.equal(result.ok, true, result.errors.join('\n'));
  const fixed = result.assets.at(-1).asset.data;
  assert.deepEqual(fixed.episode, ref('EP')); assert.equal(fixed.entry_state, shot.data.first_frame_description); assert.equal(fixed.exit_state, shot.data.end_frame_description);
  assert.match(fixed.video_prompt, /来客接稳后守灯人松手/);
  assert.equal(fixed.dialogue, '无'); assert.equal(fixed.action, shot.data.action);
  assert.equal(result.before.ok, false); assert.equal(result.after.ok, true);
  assert.deepEqual(request, original); assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.ok(result.patches.every(patch => !['data.dialogue', 'data.emotion'].includes(patch.field)));
  assert.equal(repairProduction({ project: f.project, request: { assets: result.assets } }).patches.length, 0);
  delete request.assets.at(-1).asset.data.dialogue;
  const missingDialogue = repairProduction({ project: f.project, request });
  assert.equal(Object.hasOwn(missingDialogue.assets.at(-1).asset.data, 'dialogue'), false);
});

test('已有冲突EP不自动替换，过期修复指纹及无效轮数拒绝', t => {
  const f = fixture(t), request = f.request(), checked = checkProduction({ project: f.project, request });
  request.assets.at(-1).asset.data.lighting = '新冷光';
  const result = repairProduction({ project: f.project, request: { ...request, expected_fingerprint: checked.input_fingerprint } });
  assert.equal(result.ok, false); assert.equal(result.patches.length, 0);
  assert.ok(result.issues.some(issue => issue.rule === 'repair.stale_input'));
  assert.equal(repairProduction({ project: f.project, request: { ...request, max_passes: 4 } }).ok, false);
  request.assets.at(-1).asset.data.episode = ref('EP', 2);
  const wrong = repairProduction({ project: f.project, request });
  assert.deepEqual(wrong.assets.at(-1).asset.data.episode, ref('EP', 2));
});

test('托管单镜PROMPT派生过期可重编译，人工编辑和多镜稿不得覆盖', t => {
  const f = fixture(t), managed = f.prompt();
  f.shot.asset.data.lighting = '明确改为晨间冷光';
  let request = { assets: [...clone(f.assets), clone(managed)] };
  let result = checkProduction({ project: f.project, request });
  assert.ok(result.issues.some(issue => issue.rule === 'prompt.derived_mismatch'));
  let repaired = repairProduction({ project: f.project, request });
  assert.equal(repaired.ok, true, repaired.errors.join('\n'));
  assert.match(repaired.assets.at(-1).asset.data.video_prompt, /晨间冷光/);
  assert.ok(repaired.patches.some(patch => patch.field === 'data.video_prompt'));
  request.assets.at(-1).asset.data.video_prompt = '宿主 AI 实际改写的正文，必须保留';
  repaired = repairProduction({ project: f.project, request });
  assert.equal(repaired.assets.at(-1).asset.data.video_prompt, '宿主 AI 实际改写的正文，必须保留');
  assert.ok(repaired.issues.some(issue => issue.rule === 'prompt.edited_output'));
  request = { assets: [...clone(f.assets), clone(managed)] };
  const second = clone(f.shot); second.asset.asset_id = ref('SHOT', 2).asset_id; second.asset.data.shot_number = 2; second.asset.data.start_seconds = 8;
  request.assets.push(second); request.assets.find(item => item.asset.type === 'PROMPT').asset.data.shot_refs = [ref('SHOT'), ref('SHOT', 2)];
  repaired = repairProduction({ project: f.project, request });
  assert.ok(repaired.issues.some(issue => issue.rule === 'prompt.manual_review'));
  assert.equal(repaired.assets.find(item => item.asset.type === 'PROMPT').asset.data.video_prompt, managed.asset.data.video_prompt);
});

test('冻结版本冲突不能被候选resolver遮盖，检查不取最新版本', t => {
  const f = fixture(t), created = newAsset({ project: f.project, type: 'LOC', title: '冻结地点' });
  const registry = JSON.parse(fs.readFileSync(path.join(f.project, 'project.json'))), entry = registry.assets.find(entry => entry.asset_id === created.asset_id);
  const assetFile = path.join(f.project, entry.path, 'asset.json'), stored = JSON.parse(fs.readFileSync(assetFile));
  stored.data.description = '原石塔'; fs.writeFileSync(assetFile, jsonText(stored)); saveVersion({ project: f.project, asset: stored.asset_id });
  const request = f.request(); request.assets.find(item => item.asset.type === 'LOC').asset.data.description = '被候选改成新宫殿'; request.refs = [ref('LOC')];
  const result = repairProduction({ project: f.project, request });
  assert.equal(result.ok, false); assert.ok(result.issues.some(issue => issue.rule === 'input.version_conflict'));
  assert.equal(result.patches.length, 0);
});

test('人工改过正文附件或编译依据不被自动重编译覆盖，缺旧附件哈希同样保守', t => {
  const f = fixture(t), managed = f.prompt();
  f.shot.asset.data.lighting = '明确改为晨间冷光';
  for (const [filename, replacement] of [['视频提示词.txt', '人工加过节奏的新正文\n'], ['编译依据.json', jsonText({ project_id: PROJECT_ID, inputs: { edited: true }, compilation: managed.asset.data.compilation })]]) {
    const edited = clone(managed); edited.files[filename] = replacement;
    const result = repairProduction({ project: f.project, request: { assets: [...clone(f.assets), edited] } });
    assert.equal(result.assets.at(-1).files[filename], replacement);
    assert.equal(result.assets.at(-1).asset.data.video_prompt, managed.asset.data.video_prompt);
    assert.ok(result.issues.some(issue => issue.rule === 'prompt.edited_output'));
  }
  const legacy = clone(managed); delete legacy.asset.data.compilation.file_sha256;
  const evidence = JSON.parse(legacy.files['编译依据.json']); evidence.compilation = clone(legacy.asset.data.compilation); legacy.files['编译依据.json'] = jsonText(evidence);
  const result = repairProduction({ project: f.project, request: { assets: [...clone(f.assets), legacy] } });
  assert.equal(result.assets.at(-1).files['视频提示词.txt'], managed.files['视频提示词.txt']);
  assert.ok(result.issues.some(issue => issue.rule === 'prompt.attachment_provenance_unknown'));
});

test('源内容或编译版本变化即使正文相同也刷新依据，模式指纹不作为过期依据', t => {
  const f = fixture(t), managed = f.prompt(), originalText = managed.asset.data.video_prompt;
  f.character.asset.data.audit_note = '新增审计依据，不影响本镜所选外观';
  const request = { assets: [...clone(f.assets), clone(managed)] };
  let result = checkProduction({ project: f.project, request });
  assert.ok(result.issues.some(issue => issue.rule === 'prompt.provenance_stale'));
  assert.equal(result.issues.some(issue => issue.rule === 'prompt.derived_mismatch'), false);
  result = repairProduction({ project: f.project, request });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.assets.at(-1).asset.data.video_prompt, originalText);
  assert.notEqual(result.assets.at(-1).asset.data.compilation.content_sha256, managed.asset.data.compilation.content_sha256);
  assert.ok(result.patches.some(patch => patch.field === 'data.compilation'));
  const oldVersion = clone(result.assets); oldVersion.at(-1).asset.data.compilation.version = '0.0.1';
  const evidence = JSON.parse(oldVersion.at(-1).files['编译依据.json']); evidence.compilation.version = '0.0.1'; oldVersion.at(-1).files['编译依据.json'] = jsonText(evidence);
  assert.ok(checkProduction({ project: f.project, request: { assets: oldVersion } }).issues.some(issue => issue.rule === 'prompt.provenance_stale'));
  const changedMode = clone(result.assets), modePrompt = changedMode.at(-1), modeEvidence = JSON.parse(modePrompt.files['编译依据.json']);
  modeEvidence.inputs.shot.mode = 'snapshot';
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  modePrompt.asset.data.compilation.input_sha256 = hash(JSON.stringify(canonical(modeEvidence.inputs)));
  modeEvidence.compilation = clone(modePrompt.asset.data.compilation); modePrompt.files['编译依据.json'] = jsonText(modeEvidence);
  const modeOnly = checkProduction({ project: f.project, request: { assets: changedMode } });
  assert.equal(modeOnly.issues.some(issue => ['prompt.provenance_stale', 'prompt.derived_mismatch', 'prompt.edited_output'].includes(issue.rule)), false);
});

function structuredState(f) {
  const state = candidate('STATE', {
    timeline: '现实第一夜', initial_states: [{ entity: ref('CHAR'), values: { clothing: '灰布衣', holding: '铜钥匙', positions: ['左', '右'] } }],
    change_order: ['交钥匙', '换外衣'], changes: [
      { change_id: '交钥匙', entity: ref('CHAR'), before: { holding: '铜钥匙' }, after: { holding: '空手' }, event_ref: event('交接'), story_time: '第一夜', effective_node: '钥匙交接后' },
      { change_id: '换外衣', entity: ref('CHAR'), before: { clothing: '灰布衣', positions: ['左', '右'] }, after: { clothing: '黑外衣', positions: ['右', '左'] }, event_ref: event('收起'), story_time: '第一夜稍后', effective_node: '换装后' }
    ], knowledge: [], possessions: [], foreshadowing: []
  });
  f.assets.push(state);
  const point = (phase, change_id) => ({ state: ref('STATE'), phase, ...(change_id ? { change_id } : {}) });
  f.shot.asset.data.continuity = { timeline: state.asset.data.timeline, entry: point('initial'), exit: point('after', '交钥匙') };
  return { state, point };
}

test('显式STATE独立求值抓before冲突，镜头同STATE倒序与未来出口不能放过', t => {
  const f = fixture(t), { state, point } = structuredState(f);
  assert.equal(checkProduction({ project: f.project, request: f.request() }).ok, true);
  state.asset.data.changes[0].before.holding = '本来没有的长剑';
  const noShots = f.request(); noShots.assets = noShots.assets.filter(item => item.asset.type !== 'SHOT');
  let result = checkProduction({ project: f.project, request: noShots });
  assert.ok(result.issues.some(issue => issue.rule.includes('before') && issue.severity === 'blocker'), result.errors.join('\n'));
  state.asset.data.changes[0].before.holding = '铜钥匙';
  f.shot.asset.data.continuity.entry = point('after', '交钥匙'); f.shot.asset.data.continuity.exit = point('initial');
  result = checkProduction({ project: f.project, request: f.request() });
  assert.ok(result.issues.some(issue => issue.rule === 'continuity.reversed_boundaries'));
  f.shot.asset.data.continuity.entry = point('initial'); f.shot.asset.data.continuity.exit = point('after', '换外衣');
  result = checkProduction({ project: f.project, request: f.request() });
  assert.ok(result.issues.some(issue => issue.rule === 'continuity.exit_source_mismatch'));
});

test('同场连续已知状态冲突准确定位，cut允许明确转场而不改自然语言', t => {
  const f = fixture(t), { point } = structuredState(f), second = clone(f.shot);
  second.asset.asset_id = ref('SHOT', 2).asset_id; second.asset.data.shot_number = 2; second.asset.data.start_seconds = 8;
  second.asset.data.continuity.entry = point('initial'); f.assets.push(second);
  let result = checkProduction({ project: f.project, request: f.request() });
  const conflict = result.issues.find(issue => issue.rule === 'continuity.state_conflict');
  assert.ok(conflict, result.errors.join('\n')); assert.match(conflict.locations[0].field, /holding/);
  const repaired = repairProduction({ project: f.project, request: f.request() });
  assert.deepEqual(repaired.assets.find(item => item.asset.asset_id === second.asset.asset_id).asset.data.continuity, second.asset.data.continuity);
  second.asset.data.continuity.link = 'cut';
  result = checkProduction({ project: f.project, request: f.request() });
  assert.equal(result.issues.some(issue => issue.rule === 'continuity.state_conflict'), false);
});

test('后续事件镜头可合法继承同一个历史出口，不能误判提前使用状态', t => {
  const f = fixture(t), { point } = structuredState(f);
  f.shot.asset.data.source_refs = [event('收起')];
  f.shot.asset.data.continuity.entry = point('after', '交钥匙'); f.shot.asset.data.continuity.exit = point('after', '交钥匙');
  let result = checkProduction({ project: f.project, request: f.request() });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.issues.some(issue => issue.rule === 'continuity.exit_source_mismatch'), false);
  f.shot.asset.data.continuity.exit = point('after', '换外衣');
  result = checkProduction({ project: f.project, request: f.request() });
  assert.equal(result.ok, true, result.errors.join('\n'));
  f.shot.asset.data.source_refs = [event('交接')];
  result = checkProduction({ project: f.project, request: f.request() });
  assert.ok(result.issues.some(issue => issue.rule === 'continuity.exit_source_mismatch'));
});

test('属性数组保留明确顺序，不擅自排序掩盖结构状态冲突', t => {
  const f = fixture(t), { point } = structuredState(f), second = clone(f.shot);
  second.asset.asset_id = ref('SHOT', 2).asset_id; second.asset.data.shot_number = 2; second.asset.data.start_seconds = 8;
  second.asset.data.source_refs = [event('收起')]; second.asset.data.continuity.entry = point('after', '换外衣'); second.asset.data.continuity.exit = point('after', '换外衣');
  f.assets.push(second);
  const result = checkProduction({ project: f.project, request: f.request() });
  assert.ok(result.issues.some(issue => issue.rule === 'continuity.state_conflict' && issue.locations.some(location => location.field.endsWith('.positions'))));
});

test('结构化已知状态可补空边界文字，跨集没有唯一前镜不得按编号猜相邻', t => {
  const f = fixture(t), { point } = structuredState(f);
  f.shot.asset.data.entry_state = ''; f.shot.asset.data.exit_state = '';
  let result = repairProduction({ project: f.project, request: f.request() });
  const fixed = result.assets.find(item => item.asset.type === 'SHOT').asset.data;
  assert.match(fixed.entry_state, /灰布衣/); assert.match(fixed.exit_state, /空手/);
  assert.doesNotMatch(fixed.exit_state, /asset_id|IP884-|\{"/);
  const episode = clone(f.episode); episode.asset.asset_id = ref('EP', 2).asset_id; episode.asset.data.episode_number = 2;
  const scene = clone(f.scene); scene.asset.asset_id = ref('SC', 2).asset_id; scene.asset.data.episode = ref('EP', 2);
  const shot = clone(f.shot); shot.asset.asset_id = ref('SHOT', 2).asset_id; shot.asset.data.episode = ref('EP', 2); shot.asset.data.scene = ref('SC', 2); shot.asset.data.continuity.entry = point('initial'); shot.asset.data.continuity.link = 'continuous';
  f.assets.push(episode, scene, shot);
  result = checkProduction({ project: f.project, request: f.request() });
  assert.ok(result.issues.some(issue => issue.rule === 'continuity.episode_order_unknown'));
  assert.equal(result.issues.some(issue => issue.rule === 'continuity.state_conflict'), false);
});

test('本镜投影不被画外未知人物阻断，但确定状态错误仍保留', t => {
  const f = fixture(t), { state } = structuredState(f), offscreen = candidate('CHAR', { name: '画外人物' }, 2);
  f.assets.push(offscreen);
  state.asset.data.initial_states.push({ entity: ref('CHAR', 2), values: { clothing: null } });
  f.shot.asset.data.entry_state = ''; f.shot.asset.data.exit_state = '';
  let result = repairProduction({ project: f.project, request: f.request() });
  assert.equal(result.ok, true, result.errors.join('\n'));
  const shot = result.assets.find(item => item.asset.type === 'SHOT').asset;
  assert.match(shot.data.entry_state, /灰布衣/);
  assert.doesNotMatch(shot.data.entry_state, /画外人物/);
  assert.equal(result.issues.some(issue => issue.rule === 'continuity.state_unknown' && issue.locations.some(location => location.asset_id === shot.asset_id)), false);
  state.asset.data.changes[0].before.holding = '错误已知值';
  result = checkProduction({ project: f.project, request: f.request() });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.rule.includes('before') && issue.severity === 'blocker'));
});

function fixedComponentState(f) {
  const clothing = candidate('PROP', { name: '轻战常服', description: '墨青织物常服', visual_base: { description: '墨青织物常服', components: [{ asset: ref('PROP', 3), role: '袖口轻束腕' }] } }, 2);
  const cuff = candidate('PROP', { name: '轻束腕', description: '薄织物轻束腕', visual_base: { description: '薄织物轻束腕' } }, 3);
  f.character.asset.data.visual_base = { description: f.shot.asset.data.asset_visuals[0].description, locked: true, components: [{ asset: ref('PROP', 2), role: '常服' }] };
  const state = candidate('STATE', {
    timeline: '现实第一夜', initial_states: [
      { entity: ref('CHAR'), values: { pose: '站稳' } },
      { entity: ref('LOC'), values: { lighting: '暖光' } },
      { entity: ref('PROP'), values: { holder: '守灯人' } },
      { entity: ref('PROP', 2), values: { damage: '完好' } },
      { entity: ref('PROP', 3), values: { damage: '完好' } }
    ], change_order: ['束腕受损'], changes: [
      { change_id: '束腕受损', entity: ref('PROP', 3), before: { damage: '完好' }, after: { damage: '破损' }, event_ref: event('交接'), story_time: '第一夜', effective_node: '交接后' }
    ], knowledge: [], possessions: [], foreshadowing: []
  });
  f.assets.push(clothing, cuff, state);
  const point = (phase, change_id) => ({ state: ref('STATE'), phase, ...(change_id ? { change_id } : {}) });
  f.shot.asset.data.continuity = { timeline: state.asset.data.timeline, entry: point('initial'), exit: point('initial') };
  return { clothing, cuff, state, point };
}

test('递归固定组件的跨镜状态冲突与编译器实际实体集一致且只读', t => {
  const f = fixture(t), { point } = fixedComponentState(f), second = clone(f.shot);
  second.asset.asset_id = ref('SHOT', 2).asset_id; second.asset.data.shot_number = 2; second.asset.data.start_seconds = 8;
  second.asset.data.continuity.entry = point('after', '束腕受损'); second.asset.data.continuity.exit = point('after', '束腕受损');
  f.assets.push(second);
  for (const [shot, damage] of [[f.shot, '完好'], [second, '破损']]) {
    const compiled = compileShotPrompts({ project: f.project, request: { shot: shot.asset }, resolveAsset: f.resolver(f.assets) });
    assert.equal(compiled.ok, true, compiled.errors.join('\n'));
    assert.equal(compiled.inputs.continuity.entry.states.find(item => item.entity.asset_id === ref('PROP', 3).asset_id).values.damage, damage);
  }
  const request = f.request(), original = clone(request), before = fingerprint(f.project, f.project);
  const result = checkProduction({ project: f.project, request });
  const conflict = result.issues.find(issue => issue.rule === 'continuity.state_conflict' && issue.locations.some(location => location.field.includes(`${ref('PROP', 3).asset_id}@1.0.0.damage`)));
  assert.ok(conflict, `固定子组件损伤冲突被漏检：${JSON.stringify({ ok: result.ok, conflicts: result.issues.filter(issue => issue.rule === 'continuity.state_conflict') })}`);
  assert.equal(result.ok, false);
  assert.deepEqual(request, original); assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('主LOC与显式PROP的固定子组件同样参与连续镜头比较', t => {
  for (const seed of ['LOC', 'PROP']) {
    const f = fixture(t), { point } = fixedComponentState(f);
    f.character.asset.data.visual_base.components = [];
    const parent = seed === 'LOC' ? f.location : f.prop;
    parent.asset.data.visual_base = { description: seed === 'LOC' ? '石塔灯室' : f.shot.asset.data.asset_visuals[1].description, components: [{ asset: ref('PROP', 2), role: '本镜固定物件组合' }] };
    const second = clone(f.shot);
    second.asset.asset_id = ref('SHOT', 2).asset_id; second.asset.data.shot_number = 2; second.asset.data.start_seconds = 8;
    second.asset.data.continuity.entry = point('after', '束腕受损'); second.asset.data.continuity.exit = point('after', '束腕受损');
    f.assets.push(second);
    const compiled = compileShotPrompts({ project: f.project, request: { shot: second.asset }, resolveAsset: f.resolver(f.assets) });
    assert.equal(compiled.ok, true, compiled.errors.join('\n'));
    const checked = checkProduction({ project: f.project, request: f.request() });
    assert.ok(checked.issues.some(issue => issue.rule === 'continuity.state_conflict' && issue.locations.some(location => location.field.includes(ref('PROP', 3).asset_id))), `${seed} 子组件未参与比较`);
  }
});

test('递归固定组件未决属性不能被滤掉或安全修复成完整状态', t => {
  const f = fixture(t), { state } = fixedComponentState(f);
  state.asset.data.initial_states.find(item => item.entity.asset_id === ref('PROP', 3).asset_id).values.damage = null;
  state.asset.data.change_order = []; state.asset.data.changes = [];
  f.shot.asset.data.entry_state = ''; f.shot.asset.data.exit_state = '';
  const request = f.request(), original = clone(request), before = fingerprint(f.project, f.project);
  const checked = checkProduction({ project: f.project, request });
  assert.ok(checked.issues.some(issue => issue.rule === 'continuity.state_unknown' && issue.locations.some(location => location.asset_id === f.shot.asset.asset_id) && issue.evidence.includes(ref('PROP', 3).asset_id)));
  const repaired = repairProduction({ project: f.project, request });
  const shot = repaired.assets.find(item => item.asset.type === 'SHOT').asset;
  assert.equal(repaired.ok, false);
  assert.equal(shot.data.entry_state, ''); assert.equal(shot.data.exit_state, '');
  assert.equal(repaired.patches.some(patch => ['data.entry_state', 'data.exit_state'].includes(patch.field)), false);
  assert.deepEqual(request, original); assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('完整固定组件状态安全转写到空镜头边界且保留实际起止变化', t => {
  const f = fixture(t), { point } = fixedComponentState(f);
  f.shot.asset.data.continuity.exit = point('after', '束腕受损');
  f.shot.asset.data.entry_state = ''; f.shot.asset.data.exit_state = '';
  const request = f.request(), original = clone(request), before = fingerprint(f.project, f.project);
  const repaired = repairProduction({ project: f.project, request });
  assert.equal(repaired.ok, true, repaired.errors.join('\n'));
  const shot = repaired.assets.find(item => item.asset.type === 'SHOT').asset;
  assert.match(shot.data.entry_state, /轻战常服.*完好.*轻束腕.*完好/);
  assert.match(shot.data.exit_state, /轻战常服.*完好.*轻束腕.*破损/);
  assert.deepEqual(shot.data.continuity, f.shot.asset.data.continuity);
  assert.deepEqual(request, original); assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('仅SHOT.refs中的资料人物仍校验依赖但不扩散画内状态', t => {
  const f = fixture(t), { state } = fixedComponentState(f), offscreen = candidate('CHAR', { name: '画外资料人物' }, 2);
  f.assets.push(offscreen); f.shot.asset.refs.push(ref('CHAR', 2));
  state.asset.data.initial_states.push({ entity: ref('CHAR', 2), values: { injury: null } });
  f.shot.asset.data.entry_state = ''; f.shot.asset.data.exit_state = '';
  const repaired = repairProduction({ project: f.project, request: f.request() });
  assert.equal(repaired.ok, true, repaired.errors.join('\n'));
  assert.equal(repaired.issues.some(issue => issue.rule === 'continuity.state_unknown' && issue.locations.some(location => location.asset_id === f.shot.asset.asset_id)), false);
  const shot = repaired.assets.find(item => item.asset.type === 'SHOT').asset;
  assert.deepEqual(shot.refs, f.shot.asset.refs);
  assert.match(shot.data.entry_state, /轻束腕/); assert.doesNotMatch(shot.data.entry_state, /画外资料人物/);
  const invalid = f.request(); invalid.assets.find(item => item.asset.type === 'SHOT').asset.refs.push({ asset_id: 'IP999-CHAR-001', version: '1.0.0' });
  assert.equal(checkProduction({ project: f.project, request: invalid }).ok, false);
});

test('固定组件循环与混版仍阻断状态投影和边界安全转写', t => {
  for (const invalid of ['cycle', 'mixed-version']) {
    const f = fixture(t), { cuff } = fixedComponentState(f);
    if (invalid === 'cycle') cuff.asset.data.visual_base.components = [{ asset: ref('CHAR'), role: '非法反向人物依赖' }];
    else {
      const created = newAsset({ project: f.project, type: 'PROP', sequence: 3, title: '另一版束腕' });
      const registry = JSON.parse(fs.readFileSync(path.join(f.project, 'project.json'))), entry = registry.assets.find(item => item.asset_id === created.asset_id);
      const assetFile = path.join(f.project, entry.path, 'asset.json'), stored = clone(cuff.asset);
      stored.version = '1.1.0'; fs.writeFileSync(assetFile, jsonText(stored)); saveVersion({ project: f.project, asset: stored.asset_id });
      f.shot.asset.data.asset_visuals.push({ asset: ref('PROP', 3, '1.1.0'), description: stored.data.visual_base.description });
    }
    f.shot.asset.data.entry_state = ''; f.shot.asset.data.exit_state = '';
    const request = f.request(), original = clone(request), before = fingerprint(f.project, f.project);
    const repaired = repairProduction({ project: f.project, request });
    assert.equal(repaired.ok, false);
    assert.ok(repaired.issues.some(issue => issue.rule === 'continuity.invalid' && /循环|多个视觉版本/.test(issue.description)), invalid);
    assert.equal(repaired.patches.some(patch => ['data.entry_state', 'data.exit_state'].includes(patch.field)), false);
    assert.deepEqual(request, original); assert.deepEqual(fingerprint(f.project, f.project), before);
  }
});
