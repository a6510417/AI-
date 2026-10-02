import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, newAsset, saveVersion, CHAPTER_FILES } from '../src/project-service.mjs';
import { createAssetSkeleton, hash, jsonText } from '../src/rules.mjs';
import { fingerprint } from '../src/storage.mjs';
import { buildProductionContext } from '../src/生产上下文.mjs';
import { compileShotPrompts } from '../src/提示词编译.mjs';
import { checkProduction, repairProduction } from '../src/制作质检.mjs';

const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const ref = asset => ({ asset_id: asset.asset_id, version: asset.version });
const clone = value => structuredClone(value);

function fixture(t) {
  const temporary = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temporary, 'comic-creative-chain-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), temporary); assert.ok(path.basename(root).startsWith('comic-creative-chain-')); fs.rmSync(root, { recursive: true, force: true }); });
  const project = initProject({ root, id: 'IP887', name: '工业化创作链隔离夹具' }).project;
  const working = id => path.join(project, read(path.join(project, 'project.json')).assets.find(item => item.asset_id === id).path);
  const save = (type, data, files = {}) => {
    const made = newAsset({ project, type, title: `${type}隔离夹具` }), asset = read(path.join(working(made.asset_id), 'asset.json'));
    asset.data = data;
    fs.writeFileSync(path.join(working(asset.asset_id), 'asset.json'), jsonText(asset));
    if (type === 'CH') for (const name of CHAPTER_FILES) fs.writeFileSync(path.join(working(asset.asset_id), name), name.endsWith('.md') ? '网吧里给手机充电。\n漏电触电。\n意识断裂。\n异世界苏醒。\n' : jsonText({ entries: ['隔离测试摘要，不是原文'] }));
    for (const [name, content] of Object.entries(files)) { const target = path.join(working(asset.asset_id), name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
    saveVersion({ project, asset: asset.asset_id });
    return asset;
  };
  const chapter = save('CH', { chapter_number: 1, events: [{ event_id: '魂穿', story_time: '开篇', summary: '现代人触电后异世界苏醒' }] });
  const location = save('LOC', { description: '张家屋内', visual_base: { description: '朴素木屋，一扇左窗' } });
  const costume = save('PROP', { name: '轻战常服', subtype: '服装', visual_base: { description: '墨青黑织物常服，暖赭只在衣摆内层', locked: true, negative_constraints: ['无护肩甲、无金属链'] } });
  const bracer = save('PROP', { name: '轻型束腕', subtype: '配饰', visual_base: { description: '贴臂织物束腕，外侧薄软革，最多两条固定带', locked: true, constraints: ['拳腕前臂力量线连续'], negative_constraints: ['无厚甲、无交叉绑带'] } });
  const character = save('CHAR', { name: '张天昊', visual_base: { description: '俊秀机敏少年，眉鼻下颌属于同一面部几何，高束长马尾', locked: true, constraints: ['降低成熟度，不降低颜值'], components: [{ asset: ref(costume), role: '常服' }, { asset: ref(bracer), role: '束腕' }] } });
  const episode = save('EP', { episode_number: 1, chapter_refs: [ref(chapter)], summary: '异世界苏醒' });
  const eventRef = { ...ref(chapter), event_id: '魂穿' };
  const scene = save('SC', { scene_number: 1, episode: ref(episode), location: ref(location), source_refs: [eventRef], script: '少年从床上坐起' });
  const shot = createAssetSkeleton({ projectId: 'IP887', type: 'SHOT', sequence: 1, title: '异世界苏醒' }).asset;
  shot.data = { episode: ref(episode), scene: ref(scene), source_refs: [eventRef], character_refs: [ref(character)], shot_number: 1, start_seconds: 0, duration_seconds: 8, story_time: '魂穿后', scene_description: '张家朴素木屋', characters: '张天昊', action: '少年睁眼后撑床坐起', emotion: '警觉', dialogue: '无', shot_size: '中近景', camera_movement: '缓慢推进', lighting: '侧窗冷光', visual_description: '少年躺在床上，右掌静放身侧', entry_state: '少年躺在床上', exit_state: '少年撑床坐起', video_prompt: '待编译前的完整通用稿' };
  const compile = request => compileShotPrompts({ project, request: { shot, ...request } });
  const source = { file: 'sources/原文.txt', sha256: hash('第一行\n第二行\n第三行\n第四行\n'), start_line: 1, end_line: 4 };
  fs.mkdirSync(path.join(project, 'sources'), { recursive: true }); fs.writeFileSync(path.join(project, source.file), '第一行\n第二行\n第三行\n第四行\n');
  const brief = { goal: '识别低文字权重、高视觉价值的开篇', adaptation_permissions: ['A', 'F', 'H', 'M'], director_intent: '用触电与意识断裂建立穿越反差', required_readings: [{ kind: 'source', ...source }] };
  return { project, working, save, chapter, character, costume, bracer, shot, compile, source, brief };
}

test('creative_brief 不把摘要当正文，必要阅读缺口明确阻断并保持只读', t => {
  const f = fixture(t), before = fingerprint(f.project, f.project);
  const result = buildProductionContext({ project: f.project, request: { stage: '视觉机会识别', candidates: [{ ...ref(f.chapter), event_id: '魂穿' }], creative_brief: f.brief } });
  assert.equal(result.ok, false); assert.equal(result.budget.complete, false);
  assert.equal(result.reading_requirements.complete, false); assert.match(result.errors.join('\n'), /摘要.*不能替代/);
  assert.deepEqual(result.context.creative_brief, f.brief); assert.ok(result.omitted.some(item => item.input.includes('required_readings')));
  assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('必要原文按完整哈希与选段并集核对，范围空洞和不同哈希不算覆盖', t => {
  const f = fixture(t), base = { stage: '视觉机会识别', creative_brief: f.brief };
  const readings = [{ ...f.source, end_line: 2 }, { ...f.source, start_line: 3 }];
  let result = buildProductionContext({ project: f.project, request: { ...base, source_readings: readings } });
  assert.equal(result.ok, true, result.errors.join('\n')); assert.equal(result.reading_requirements.complete, true);
  const first = result.input_fingerprint;
  const changed = clone(base); changed.creative_brief.director_intent = '先建立人物机敏，再断裂意识';
  assert.notEqual(buildProductionContext({ project: f.project, request: { ...changed, source_readings: readings } }).input_fingerprint, first);
  readings[1].start_line = 4;
  result = buildProductionContext({ project: f.project, request: { ...base, source_readings: readings } });
  assert.equal(result.ok, false); assert.equal(result.reading_requirements.complete, false);
  const wrong = clone(base); wrong.creative_brief.required_readings[0].sha256 = '0'.repeat(64);
  assert.equal(buildProductionContext({ project: f.project, request: { ...wrong, source_readings: [f.source] } }).ok, false);
});

test('冻结原文要求整文件或选段，摘要与附件目录不能满足；隐式完整正文按真实文本核对', t => {
  const f = fixture(t), body = fs.readFileSync(path.join(f.working(f.chapter.asset_id), '正文.md'));
  const brief = { goal: '回查原著开篇', required_readings: [{ kind: 'asset', asset: ref(f.chapter), file: '正文.md', sha256: hash(body) }] };
  const base = { stage: '改编', candidates: [{ ...ref(f.chapter), event_id: '魂穿' }], creative_brief: brief };
  assert.equal(buildProductionContext({ project: f.project, request: base }).ok, false);
  let result = buildProductionContext({ project: f.project, request: { ...base, asset_readings: [{ ...ref(f.chapter), file: '正文.md', start_line: 1, end_line: 2 }, { ...ref(f.chapter), file: '正文.md', start_line: 3, end_line: 4 }] } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  result = buildProductionContext({ project: f.project, request: { ...base, candidates: [ref(f.chapter)] } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  result = buildProductionContext({ project: f.project, request: { ...base, candidates: [ref(f.chapter)], max_chars: 800 } });
  assert.equal(result.ok, false); assert.equal(result.reading_requirements.complete, false);
});

test('必要阅读声明不授予新创作权限，非法分类、范围和字段拒绝', t => {
  const f = fixture(t);
  for (const change of [brief => { brief.adaptation_permissions = ['O']; }, brief => { brief.required_readings[0].sha256 = 'bad'; }, brief => { brief.required_readings[0].end_line = 0; }, brief => { brief.permission_to_rewrite_core = true; }]) {
    const brief = clone(f.brief); change(brief);
    assert.equal(buildProductionContext({ project: f.project, request: { stage: '改编', source_readings: [f.source], creative_brief: brief } }).ok, false);
  }
});

test('固定设计与组件跨镜复用，衣服和束腕引用精确版，不误称已采用或质量合格', t => {
  const f = fixture(t), before = fingerprint(f.project, f.project), result = f.compile();
  assert.equal(result.ok, true, result.errors.join('\n'));
  for (const prompt of [result.prompt_data.image_prompt, result.prompt_data.end_frame_prompt, result.prompt_data.video_prompt]) {
    assert.match(prompt, /俊秀机敏少年/); assert.match(prompt, /墨青黑织物常服/); assert.match(prompt, /最多两条固定带/); assert.match(prompt, /无护肩甲、无金属链/);
  }
  assert.ok(result.prompt_data.asset_refs.some(item => item.asset_id === f.costume.asset_id && item.version === '1.0.0'));
  assert.ok(result.inputs.assets.find(item => item.asset_id === f.costume.asset_id).component_roles.includes('常服'));
  assert.equal(result.inputs.assets.find(item => item.asset_id === f.character.asset_id).was_adopted, false);
  assert.match(result.inputs.assets.find(item => item.asset_id === f.character.asset_id).selected_visual.lock_scope, /不是审核/);
  const next = clone(f.shot); next.data.shot_number = 2; next.data.start_seconds = 8; next.data.action = '少年握拳后转向窗外';
  const nextResult = f.compile({ shot: next });
  assert.match(nextResult.prompt_data.video_prompt, /墨青黑织物常服/); assert.notEqual(nextResult.compilation.input_sha256, result.compilation.input_sha256);
  assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('locked不能被SHOT重设计，动态说明和本镜附加排除不抹去固定约束', t => {
  const f = fixture(t);
  f.shot.data.asset_visuals = [{ asset: ref(f.character), description: '成熟霸总，改成散发' }];
  let result = f.compile(); assert.equal(result.ok, false); assert.match(result.errors.join('\n'), /不能重新定义/); assert.deepEqual(result.files, {});
  f.shot.data.asset_visuals = [{ asset: ref(f.character), state_description: '眉心轻皱，右掌撑床', constraints: ['眼睛看向左窗'], negative_constraints: ['无笑容'] }];
  result = f.compile(); assert.equal(result.ok, true, result.errors.join('\n'));
  assert.match(result.prompt_data.video_prompt, /俊秀机敏少年/); assert.match(result.prompt_data.video_prompt, /右掌撑床/); assert.match(result.prompt_data.video_prompt, /降低成熟度/); assert.match(result.prompt_data.negative_prompt, /无厚甲/); assert.match(result.prompt_data.negative_prompt, /无笑容/);
  assert.match(result.warnings.join('\n'), /语义审核/);
  f.shot.data.asset_visuals[0].state_description = { design: '不能把未知对象悄悄丢掉' };
  assert.equal(f.compile().ok, false);
});

test('固定组件不能在SHOT重新设计或混用版本，不从最新采用猜替代', t => {
  const f = fixture(t);
  f.shot.data.asset_visuals = [{ asset: ref(f.costume), description: '红袍重甲' }];
  assert.equal(f.compile().ok, false);
  const file = path.join(f.working(f.costume.asset_id), 'asset.json'), next = read(file); next.version = '1.1.0'; next.data.visual_base.description = '后期正式红衣'; fs.writeFileSync(file, jsonText(next)); saveVersion({ project: f.project, asset: next.asset_id });
  f.shot.data.asset_visuals = [{ asset: ref(next), description: next.data.visual_base.description }];
  const result = f.compile(); assert.equal(result.ok, false); assert.match(result.errors.join('\n'), /多个视觉版本/);
  delete f.shot.data.asset_visuals;
  assert.match(f.compile().prompt_data.video_prompt, /墨青黑织物常服/); assert.doesNotMatch(f.compile().prompt_data.video_prompt, /后期正式红衣/);
});

test('固定组件引用保护未声明locked的旧静态基准，不受显式输入顺序影响', t => {
  const f = fixture(t), unlocked = f.save('PROP', { name: '固定玉佩', visual_base: { description: '一枚浅玉短绳方佩' } });
  const filename = path.join(f.working(f.character.asset_id), 'asset.json'), character = read(filename);
  character.version = '1.1.0'; character.data.visual_base.components.push({ asset: ref(unlocked), role: '固定玉佩' });
  fs.writeFileSync(filename, jsonText(character)); saveVersion({ project: f.project, asset: character.asset_id });
  f.shot.data.character_refs = [ref(character)];
  f.shot.data.asset_visuals = [{ asset: ref(unlocked), description: '改成大号金属腰牌' }];
  const result = f.compile({ assets: [ref(unlocked)] });
  assert.equal(result.ok, false); assert.match(result.errors.join('\n'), /固定组件引用.*不能重新定义/);
});

test('未locked固定组件的SHOT可省略description，只附加动态状态仍继承固定设计', t => {
  const f = fixture(t), pendant = f.save('PROP', { name: '固定玉佩', visual_base: { description: '一枚浅玉短绳方佩' } });
  const filename = path.join(f.working(f.character.asset_id), 'asset.json'), character = read(filename);
  character.version = '1.1.0'; character.data.visual_base.components.push({ asset: ref(pendant), role: '固定玉佩' });
  fs.writeFileSync(filename, jsonText(character)); saveVersion({ project: f.project, asset: character.asset_id });
  f.shot.data.character_refs = [ref(character)];
  f.shot.data.asset_visuals = [{ asset: ref(pendant), state_description: '短绳随坐起动作轻晃' }];
  const result = f.compile(); assert.equal(result.ok, true, result.errors.join('\n'));
  for (const prompt of [result.prompt_data.image_prompt, result.prompt_data.end_frame_prompt, result.prompt_data.video_prompt]) {
    assert.match(prompt, /一枚浅玉短绳方佩/); assert.match(prompt, /短绳随坐起动作轻晃/);
  }
  assert.deepEqual(result.missing_fields, []);
});

test('CHAR固定组件职责进入首尾与视频，旧托管PROMPT只修候选且保留人工修改', t => {
  const f = fixture(t), geometry = f.save('CHAR', { name: '头部几何母版', visual_base: { description: '同一眉鼻下颌几何' } });
  const mainScene = read(path.join(f.working(f.shot.data.scene.asset_id), 'asset.json')), mainLocation = read(path.join(f.working(mainScene.data.location.asset_id), 'asset.json'));
  const filename = path.join(f.working(f.character.asset_id), 'asset.json'), character = read(filename), role = '仅作面部几何参照，不是出场者', mainRole = '仅作主场景空间关系参照';
  character.version = '1.1.0'; character.data.visual_base.components.push({ asset: ref(geometry), role });
  character.data.visual_base.components.push({ asset: ref(mainLocation), role: mainRole });
  fs.writeFileSync(filename, jsonText(character)); saveVersion({ project: f.project, asset: character.asset_id });
  f.shot.data.character_refs = [ref(character)]; f.save('SHOT', f.shot.data);
  const compiled = f.compile({ shot: ref(f.shot) }); assert.equal(compiled.ok, true, compiled.errors.join('\n'));
  for (const prompt of [compiled.prompt_data.image_prompt, compiled.prompt_data.end_frame_prompt, compiled.prompt_data.video_prompt]) {
    assert.match(prompt, /头部几何母版（仅作面部几何参照，不是出场者）：同一眉鼻下颌几何/);
    assert.match(prompt, /本场固定视觉特征：LOC隔离夹具（仅作主场景空间关系参照）：朴素木屋，一扇左窗/);
    assert.equal(prompt.split('朴素木屋，一扇左窗').length - 1, 1);
  }
  assert.equal(compiled.compilation.version, '1.3.1');
  // Reconstruct the previous 1.3.0 output: its evidence had roles, while CHAR prose omitted them.
  const old = clone(compiled), suffix = `（${role}）`, mainPrefix = `${mainLocation.title}（${mainRole}）：`;
  for (const key of ['image_prompt', 'end_frame_prompt', 'video_prompt', 'negative_prompt']) {
    old.prompt_data[key] = old.prompt_data[key].replaceAll(suffix, '').replaceAll(mainPrefix, '');
    old.compilation.output_sha256[key] = hash(old.prompt_data[key]);
  }
  for (const name of ['镜头通用提示词.txt', '首帧提示词.txt', '尾帧提示词.txt', '视频提示词.txt']) {
    old.files[name] = old.files[name].replaceAll(suffix, '').replaceAll(mainPrefix, ''); old.compilation.file_sha256[name] = hash(old.files[name]);
  }
  old.compilation.version = '1.3.0'; old.prompt_data.compilation = clone(old.compilation);
  const evidence = JSON.parse(old.files['编译依据.json']); evidence.compilation = clone(old.compilation); old.files['编译依据.json'] = jsonText(evidence);
  const prompt = createAssetSkeleton({ projectId: 'IP887', type: 'PROMPT', sequence: 1, title: '旧1.3.0托管稿' }).asset; prompt.data = old.prompt_data;
  const request = { assets: [{ asset: prompt, files: old.files }] }, original = clone(request), before = fingerprint(f.project, f.project);
  const checked = checkProduction({ project: f.project, request });
  assert.ok(checked.issues.some(item => item.rule === 'prompt.provenance_stale'));
  assert.ok(checked.issues.some(item => item.rule === 'prompt.derived_mismatch'));
  const repaired = repairProduction({ project: f.project, request });
  assert.equal(repaired.ok, true, repaired.errors.join('\n')); assert.equal(repaired.assets[0].asset.data.compilation.version, '1.3.1'); assert.match(repaired.assets[0].asset.data.video_prompt, /仅作面部几何参照，不是出场者/);
  assert.deepEqual(request, original); assert.deepEqual(fingerprint(f.project, f.project), before);
  const edited = clone(request); edited.assets[0].asset.data.video_prompt = '人工改写的镜头正文，保留真实改稿';
  const retained = repairProduction({ project: f.project, request: edited });
  assert.equal(retained.assets[0].asset.data.video_prompt, edited.assets[0].asset.data.video_prompt); assert.ok(retained.issues.some(item => item.rule === 'prompt.edited_output'));
});

for (const parentType of ['CHAR', 'LOC']) test(`${parentType} 引用的固定LOC环境组件及职责传入首尾帧和视频，主场景不重复`, t => {
  const f = fixture(t), environment = f.save('LOC', { name: '窗边灯台', visual_base: { description: '左窗下的矮木灯台，灯罩有一处暖橙缺口', locked: true } });
  const sceneRef = f.shot.data.scene, sceneFile = path.join(f.working(sceneRef.asset_id), 'asset.json'), scene = read(sceneFile);
  const parentId = parentType === 'CHAR' ? f.character.asset_id : scene.data.location.asset_id;
  const parentFile = path.join(f.working(parentId), 'asset.json'), parent = read(parentFile);
  parent.version = '1.1.0'; parent.data.visual_base.components = [...(parent.data.visual_base.components ?? []), { asset: ref(environment), role: '窗边固定环境' }];
  fs.writeFileSync(parentFile, jsonText(parent)); saveVersion({ project: f.project, asset: parent.asset_id });
  if (parentType === 'CHAR') f.shot.data.character_refs = [ref(parent)];
  else {
    scene.version = '1.1.0'; scene.data.location = ref(parent);
    fs.writeFileSync(sceneFile, jsonText(scene)); saveVersion({ project: f.project, asset: scene.asset_id });
    f.shot.data.scene = ref(scene);
  }
  const result = f.compile(); assert.equal(result.ok, true, result.errors.join('\n'));
  for (const prompt of [result.prompt_data.image_prompt, result.prompt_data.end_frame_prompt, result.prompt_data.video_prompt]) {
    assert.match(prompt, /补充环境固定特征：窗边灯台（窗边固定环境）：左窗下的矮木灯台，灯罩有一处暖橙缺口/);
    assert.equal(prompt.split('朴素木屋，一扇左窗').length - 1, 1);
  }
  assert.ok(result.prompt_data.asset_refs.some(item => item.asset_id === environment.asset_id && item.version === '1.0.0'));
  assert.ok(result.inputs.assets.find(item => item.asset_id === environment.asset_id).component_roles.includes('窗边固定环境'));
});

test('未知固定组件明确缺项，不导出半份提示词；组件循环不被重复跳过掩盖', t => {
  const f = fixture(t), original = f.character;
  const mock = refValue => {
    const registry = read(path.join(f.project, 'project.json')), entry = registry.assets.find(item => item.asset_id === refValue.asset_id), directory = path.join(f.project, '.ip-system/snapshots', refValue.asset_id, refValue.version), asset = read(path.join(directory, 'asset.json'));
    if (asset.asset_id === original.asset_id) asset.data.visual_base.components = [{ asset: { asset_id: 'IP887-PROP-999', version: '1.0.0' }, role: '未知配饰' }];
    return { asset, saved: entry.versions.find(item => item.version === refValue.version), manifest: read(path.join(directory, '_snapshot.json')), entry };
  };
  let result = compileShotPrompts({ project: f.project, request: { shot: f.shot }, resolveAsset: mock });
  assert.equal(result.ok, false); assert.match(result.missing_fields.join('\n'), /精确组件/); assert.deepEqual(result.files, {});
  const cycle = reference => { const snapshot = mock(reference); if (snapshot.asset.asset_id === original.asset_id) snapshot.asset.data.visual_base.components = [{ asset: ref(original), role: '自循环' }]; return snapshot; };
  result = compileShotPrompts({ project: f.project, request: { shot: f.shot }, resolveAsset: cycle });
  assert.equal(result.ok, false); assert.match(result.errors.join('\n'), /组件形成循环/);
});

test('固定参考继承精确媒体文件、职责与用途并传入首尾帧和视频', t => {
  const f = fixture(t), media = f.save('MEDIA', { files: [{ path: '基准.png', kind: 'image', usage_id: 'FACE' }] }, { '基准.png': '隔离夹具字节，不代表图片验收' });
  const file = path.join(f.working(f.character.asset_id), 'asset.json'), next = read(file);
  next.version = '1.1.0'; next.data.visual_base.reference_bindings = [{ media: ref(media), file_path: '基准.png', expected_usage_id: 'FACE', role: '面部几何', allowed: ['眉鼻下颌几何'], forbidden: ['不借用背景和服装'] }];
  fs.writeFileSync(file, jsonText(next)); saveVersion({ project: f.project, asset: next.asset_id });
  f.shot.data.character_refs = [ref(next)];
  const result = f.compile(); assert.equal(result.ok, true, result.errors.join('\n'));
  for (const text of [result.prompt_data.image_prompt, result.prompt_data.end_frame_prompt, result.prompt_data.video_prompt]) assert.match(text, /仅负责面部几何[\s\S]*不借用背景和服装/);
  assert.equal(result.prompt_data.reference_bindings.length, 1);
  assert.equal(f.compile({ reference_bindings: next.data.visual_base.reference_bindings }).prompt_data.reference_bindings.length, 1);
  assert.ok(result.inputs.assets.some(item => item.asset_id === media.asset_id && item.manifest_sha256));
  assert.match(result.warnings.join('\n'), /不证明已看图/);
});

test('继承组件的PROMPT复算保持稳定，组件已保存新版不替换精确历史版', t => {
  const f = fixture(t); f.save('SHOT', f.shot.data);
  const result = f.compile({ shot: ref(f.shot) }); assert.equal(result.ok, true, result.errors.join('\n'));
  const prompt = createAssetSkeleton({ projectId: 'IP887', type: 'PROMPT', sequence: 1, title: '固定组件托管稿' }).asset;
  prompt.data = result.prompt_data;
  const request = { assets: [{ asset: prompt, files: result.files }] };
  let checked = checkProduction({ project: f.project, request });
  assert.equal(checked.ok, true, checked.errors.join('\n'));
  assert.equal(checked.issues.some(item => item.rule === 'prompt.derived_mismatch'), false);
  const filename = path.join(f.working(f.bracer.asset_id), 'asset.json'), next = read(filename); next.version = '1.1.0'; next.data.visual_base.description = '新版束腕候选'; fs.writeFileSync(filename, jsonText(next)); saveVersion({ project: f.project, asset: next.asset_id });
  checked = checkProduction({ project: f.project, request });
  assert.equal(checked.ok, true, checked.errors.join('\n'));
  const repaired = repairProduction({ project: f.project, request });
  assert.equal(repaired.patches.length, 0); assert.match(repaired.assets[0].asset.data.video_prompt, /最多两条固定带/); assert.doesNotMatch(repaired.assets[0].asset.data.video_prompt, /新版束腕候选/);
});

test('固定参考路径、职责和媒体版本错误在保存或编译时阻断', t => {
  const f = fixture(t);
  const wrong = clone(f.character); wrong.data.visual_base.reference_bindings = [{ media: ref(f.costume), file_path: '图.png', role: '身份' }];
  const checked = checkProduction({ project: f.project, request: { assets: [{ asset: { ...wrong, version: '1.1.0' }, files: {} }] } });
  assert.equal(checked.ok, false); assert.match(checked.errors.join('\n'), /MEDIA.*版本引用/);
  const noRole = clone(f.character); noRole.data.visual_base.reference_bindings = [{ media: { asset_id: 'IP887-MEDIA-001', version: '1.0.0' }, file_path: '图.png' }];
  assert.equal(checkProduction({ project: f.project, request: { assets: [{ asset: { ...noRole, version: '1.1.0' }, files: {} }] } }).ok, false);
});

test('固定设计冲突在制作检查中阻断，自动修复不重设计角色也不伪造视听审核', t => {
  const f = fixture(t); f.shot.data.asset_visuals = [{ asset: ref(f.character), description: '擅自改成成年重甲刀客' }];
  const request = { assets: [{ asset: f.shot, files: {} }] }, checked = checkProduction({ project: f.project, request });
  assert.equal(checked.ok, false); assert.ok(checked.issues.some(item => item.rule === 'visual.fixed_contract_invalid'));
  const repaired = repairProduction({ project: f.project, request });
  assert.equal(repaired.ok, false); assert.equal(repaired.assets[0].asset.data.asset_visuals[0].description, '擅自改成成年重甲刀客');
  assert.match(repaired.coverage.semantic_review, /未自动评价颜值.*视频稳定性/);
});

test('5～10秒高视觉价值导演选择传入视频，不将单次魂穿表现登记成能力', t => {
  const f = fixture(t); f.shot.data.director_intent = '保留网吧充电、电流异常、触电、意识断裂，再以眼睁开转入异世界；数字碎片仅是一次性转场';
  const result = f.compile(); assert.equal(result.ok, true);
  assert.match(result.prompt_data.video_prompt, /导演意图：保留网吧充电/); assert.match(result.prompt_data.video_prompt, /数字碎片仅是一次性转场/);
  assert.equal(result.prompt_data.asset_refs.some(item => item.asset_id.split('-')[1] === 'WORLD'), false);
  assert.match(result.compilation.semantic_review, /未执行/);
});
