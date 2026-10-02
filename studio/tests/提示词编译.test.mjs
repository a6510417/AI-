import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, newAsset, saveVersion, adoptVersion, recordReview, CHAPTER_FILES } from '../src/project-service.mjs';
import { createAssetSkeleton } from '../src/rules.mjs';
import { compileShotPrompts } from '../src/提示词编译.mjs';

const PROJECT_ID = 'IP876';
const id = (type, sequence = 1) => `${PROJECT_ID}-${type}-${String(sequence).padStart(3, '0')}`;
const ref = (type, version = '1.0.0', sequence = 1) => ({ asset_id: id(type, sequence), version });
const eventRef = () => ({ ...ref('CH'), event_id: '交钥匙' });
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);

test('结构化状态按精确边界进入首尾帧，跨STATE继承不混入后续变化', t => {
  const { project, shot, save } = fixture(t);
  const state = save('STATE', {
    timeline: '主线', initial_states: [{ entity: ref('CHAR'), values: { clothing: '灰布短衫', injury: '无' } }],
    change_order: ['擦伤', '换衣'], changes: [
      { change_id: '换衣', entity: ref('CHAR'), event_ref: eventRef(), story_time: '更晚', effective_node: '回到居所', before: { clothing: '灰布短衫' }, after: { clothing: '红色斗篷' } },
      { change_id: '擦伤', entity: ref('CHAR'), event_ref: eventRef(), story_time: '第一夜', effective_node: '交钥匙后', before: { injury: '无' }, after: { injury: '右手新擦伤' } }
    ], knowledge: [], possessions: [], foreshadowing: []
  });
  const point = (phase, change_id) => ({ state: { asset_id: state.asset_id, version: state.version }, phase, ...(change_id ? { change_id } : {}) });
  shot.data.continuity = { timeline: '主线', entry: point('initial'), exit: point('after', '擦伤') };
  let result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.match(result.prompt_data.image_prompt, /入口连续性状态/);
  assert.doesNotMatch(result.prompt_data.image_prompt, /右手新擦伤|红色斗篷/);
  assert.match(result.prompt_data.end_frame_prompt, /右手新擦伤/);
  assert.doesNotMatch(result.prompt_data.end_frame_prompt, /红色斗篷/);
  assert.match(result.prompt_data.video_prompt, /入口连续性状态[\s\S]*出口连续性状态/);
  assert.ok(result.inputs.assets.some(item => item.asset_id === state.asset_id));
  assert.match(result.compilation.output_sha256.video_prompt, /^[a-f0-9]{64}$/);
  const next = save('STATE', { timeline: '主线', base_state: point('after', '擦伤'), change_order: [], changes: [], knowledge: [], possessions: [], foreshadowing: [] });
  const nextPoint = { state: { asset_id: next.asset_id, version: next.version }, phase: 'initial' };
  shot.data.continuity = { timeline: '主线', entry: nextPoint, exit: nextPoint };
  result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.match(result.prompt_data.image_prompt, /右手新擦伤/);
  assert.doesNotMatch(result.prompt_data.image_prompt, /红色斗篷/);
  assert.deepEqual(result.inputs.continuity.entry.states.find(item => item.entity.asset_id === id('CHAR')).provenance.injury.state, { asset_id: state.asset_id, version: state.version });
  assert.equal(result.prompt_data.asset_refs.some(item => ['EP', 'SHOT'].includes(item.asset_id.split('-')[1])), false);
});

test('结构状态空数组明确转写为无，首尾帧和视频保留无持物与无伤势', t => {
  const { project, shot, save } = fixture(t);
  const state = save('STATE', {
    timeline: '主线', initial_states: [{ entity: ref('CHAR'), values: { holding: [ref('PROP')], injuries: [] } }],
    change_order: ['交钥匙'], changes: [{ change_id: '交钥匙', entity: ref('CHAR'), event_ref: eventRef(), story_time: '第一夜', effective_node: '交接后', before: { holding: [ref('PROP')] }, after: { holding: [] } }],
    knowledge: [], possessions: [], foreshadowing: []
  });
  shot.data.continuity = { timeline: '主线', entry: { state: { asset_id: state.asset_id, version: state.version }, phase: 'initial' }, exit: { state: { asset_id: state.asset_id, version: state.version }, phase: 'after', change_id: '交钥匙' } };
  const before = fs.readFileSync(path.join(project, 'project.json'));
  const result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.compilation.version, '1.3.1');
  assert.match(result.prompt_data.image_prompt, /入口连续性状态：[^\n]*持物：铜钥匙；伤势：无/);
  assert.match(result.prompt_data.end_frame_prompt, /出口连续性状态：[^\n]*持物：无；伤势：无/);
  assert.match(result.prompt_data.video_prompt, /出口连续性状态：[^\n]*持物：无；伤势：无/);
  for (const filename of ['镜头通用提示词.txt', '首帧提示词.txt', '尾帧提示词.txt', '视频提示词.txt']) assert.match(result.files[filename], /伤势：无/);
  assert.deepEqual(result.inputs.continuity.exit.states[0].values.holding, []);
  assert.deepEqual(fs.readFileSync(path.join(project, 'project.json')), before);
});

test('画外人物的未决状态不阻断本镜，镜内未知仍拒绝编译', t => {
  const { project, shot, save } = fixture(t);
  const outside = save('CHAR', { name: '画外人', appearance: '未来章节的人物' });
  const state = save('STATE', { timeline: '主线', initial_states: [
    { entity: ref('CHAR'), values: { clothing: '灰布短衫' } },
    { entity: { asset_id: outside.asset_id, version: outside.version }, values: { clothing: null } }
  ], change_order: [], changes: [], knowledge: [], possessions: [], foreshadowing: [] });
  const point = { state: { asset_id: state.asset_id, version: state.version }, phase: 'initial' };
  shot.data.continuity = { timeline: '主线', entry: point, exit: point };
  let result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.inputs.continuity.entry.scope.source_complete, false);
  assert.doesNotMatch(result.prompt_data.video_prompt, /画外人|clothing.*null/);
  shot.data.character_refs.push({ asset_id: outside.asset_id, version: outside.version });
  shot.data.asset_visuals.push({ asset: { asset_id: outside.asset_id, version: outside.version }, description: '短发中年人' });
  result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.files, {});
});

function fixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-prompt-compile-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const project = initProject({ root: temporaryRoot, id: PROJECT_ID, name: '编译测试' }).project;
  const working = assetId => path.join(project, json(path.join(project, 'project.json')).assets.find(entry => entry.asset_id === assetId).path);
  const save = (type, data, files = {}) => {
    const created = newAsset({ project, type, title: `${type}测试` });
    const directory = working(created.asset_id), asset = json(path.join(directory, 'asset.json'));
    asset.data = data;
    write(path.join(directory, 'asset.json'), asset);
    if (type === 'CH') for (const name of CHAPTER_FILES) {
      if (name.endsWith('.md')) fs.writeFileSync(path.join(directory, name), '守灯人交出钥匙，来客接稳后才松手。');
      else write(path.join(directory, name), { entries: ['守灯人交出钥匙'] });
    }
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
      fs.writeFileSync(path.join(directory, relative), content);
    }
    saveVersion({ project, asset: created.asset_id });
    return asset;
  };
  save('CH', { chapter_number: 1, events: [{ event_id: '交钥匙', story_time: '第一夜', summary: '守灯人把钥匙交给来客' }] });
  save('LOC', { description: '石塔灯室', architecture: '左侧石窗', visual_requirements: ['门在两人身后'] });
  save('CHAR', { name: '守灯人', appearance: '黑色短发，眉尾有旧疤；后章穿婚礼红袍，未来觉醒千丈法相', visual_requirements: ['跨章汇总：第三夜左臂痊愈'], consistency_rules: ['旧疤位于自身左眉尾'], negative_constraints: ['不可多出额头徽记'], image_prompt: '不应继承的跨章婚礼红袍' });
  save('PROP', { name: '铜钥匙', visual_description: '一把短柄旧铜钥匙', initial_holder: '未验证的初始持有人' });
  save('STATE', { changes: [{ event_ref: eventRef(), before: '守灯人持钥匙', after: '来客持钥匙', effective_node: '交接完成', story_time: '第一夜' }], knowledge: [], possessions: [], foreshadowing: [] });
  save('EP', { episode_number: 1, chapter_refs: [ref('CH')], script: '不该进入编译摘要的全篇剧本'.repeat(1000) });
  save('SC', { scene_number: 1, episode: ref('EP'), location: ref('LOC'), source_refs: [eventRef()], script: '守灯人与来客交接钥匙' });
  const shot = createAssetSkeleton({ projectId: PROJECT_ID, type: 'SHOT', sequence: 1, title: '交接钥匙' }).asset;
  shot.data = {
    episode: ref('EP'), scene: ref('SC'), source_refs: [eventRef()], character_refs: [ref('CHAR')],
    asset_visuals: [
      { asset: ref('CHAR'), description: '黑色短发，眉尾有旧疤，本镜穿灰布短衫', constraints: ['旧疤位于自身左眉尾'], negative_constraints: ['不可多出额头徽记'] },
      { asset: ref('LOC'), description: '门在两人身后，左侧为石窗' },
      { asset: ref('PROP'), description: '一把短柄旧铜钥匙' }
    ],
    shot_number: 1, start_seconds: 0, duration_seconds: 8, story_time: '第一夜',
    scene_description: '石塔灯室的窗前', characters: '守灯人与来客',
    entry_state: { hands: ['守灯人右手持钥匙', '来客右手伸出但尚未接触'], support: '两人站稳' },
    exit_state: { possession: '来客独自持同一把钥匙，守灯人空手' },
    action: '来客先接稳钥匙，守灯人随后松手', emotion: '克制', dialogue: '无',
    shot_size: '双手近景', camera_movement: '固定机位', lighting: '灯火暖光',
    visual_description: '交接前双方双手可见', visual_requirements: ['守灯人左臂包扎尚未痊愈'],
    negative_constraints: ['不增加第二把钥匙'], sound: { effects: ['轻微金属碰响'], ambience: '窗外风声' },
    video_prompt: '故意放入过时提示词，不可继续拼入'
  };
  return { project, shot, save, working };
}

test('继承精确资产、时点与起止状态，图片只取起态，编译全过程只读', t => {
  const { project, shot } = fixture(t);
  const before = fs.readFileSync(path.join(project, 'project.json'));
  const request = { shot, assets: [ref('PROP'), ref('STATE')], target: { platform: '即梦', model: 'Seedance 2.5', input_mode: '文生视频' } };
  const original = structuredClone(request);
  const result = compileShotPrompts({ project, request });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.deepEqual(request, original);
  assert.deepEqual(fs.readFileSync(path.join(project, 'project.json')), before);
  for (const inherited of [/旧疤/, /门在两人身后/, /短柄旧铜钥匙/]) assert.match(result.prompt_data.image_prompt, inherited);
  assert.match(result.prompt_data.image_prompt, /左臂包扎尚未痊愈/);
  assert.match(result.prompt_data.image_prompt, /旧疤位于自身左眉尾/);
  assert.match(result.prompt_data.negative_prompt, /不可多出额头徽记/);
  assert.match(result.prompt_data.image_prompt, /尚未接触/);
  assert.doesNotMatch(result.prompt_data.image_prompt, /先接稳|随后松手|金属碰响/);
  assert.match(result.prompt_data.video_prompt, /先接稳钥匙/);
  assert.match(result.prompt_data.video_prompt, /守灯人空手/);
  assert.match(result.prompt_data.video_prompt, /窗外风声/);
  assert.doesNotMatch(result.prompt_data.video_prompt, /过时提示词|婚礼红袍|未验证的初始持有人|千丈法相|左臂痊愈/);
  assert.deepEqual(result.prompt_data.shot, ref('SHOT'));
  assert.ok(result.prompt_data.asset_refs.some(item => item.asset_id === id('PROP')));
  assert.match(result.warnings.join('\n'), /尚未选择结构化连续性边界/);
  assert.equal(result.compilation.shot_mode, 'candidate');
  for (const prompt of [result.prompt_data.image_prompt, result.prompt_data.video_prompt]) assert.doesNotMatch(prompt, /asset_id|event_ref|IP876-|\{"|--duration|@Image/);
  assert.match(result.prompt_data.end_frame_prompt, /来客独自持同一把钥匙，守灯人空手/);
  assert.doesNotMatch(result.prompt_data.end_frame_prompt, /先接稳|随后松手|尚未接触|金属碰响/);
  assert.deepEqual(Object.keys(result.files), ['镜头通用提示词.txt', '首帧提示词.txt', '尾帧提示词.txt', '视频提示词.txt', '编译依据.json']);
});

test('首帧具体描述优先，不能把动作或退出状态补作缺失起态', t => {
  const { project, shot } = fixture(t);
  shot.data.first_frame_description = '钥匙静止在守灯人右掌，来客双手在画面下缘';
  let result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true);
  assert.match(result.prompt_data.image_prompt, /双手在画面下缘/);
  assert.doesNotMatch(result.prompt_data.image_prompt, /两人站稳/);
  delete shot.data.first_frame_description;
  delete shot.data.entry_state;
  result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, false);
  assert.match(result.missing_fields.join('\n'), /first_frame_description/);
  assert.deepEqual(result.files, {});
  shot.data.entry_state = { event_ref: eventRef(), knowledge: '有人知道秘密' };
  assert.equal(compileShotPrompts({ project, request: { shot } }).ok, false);
});

test('尾帧优先明确终态描述，没有可见终态时不给动作过程静帧', t => {
  const { project, shot } = fixture(t);
  shot.data.end_frame_description = '来客右手静握铜钥匙，守灯人双手垂在身侧';
  let result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true);
  assert.match(result.prompt_data.end_frame_prompt, /双手垂在身侧/);
  assert.doesNotMatch(result.prompt_data.end_frame_prompt, /先接稳|随后松手|来客独自持同一把/);
  delete shot.data.exit_state;
  result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true);
  assert.equal(result.shot_data.exit_state, shot.data.end_frame_description);
  shot.data.last_frame_description = shot.data.end_frame_description;
  delete shot.data.end_frame_description;
  assert.equal(compileShotPrompts({ project, request: { shot } }).ok, true);
  delete shot.data.last_frame_description;
  result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, false);
  assert.match(result.missing_fields.join('\n'), /exit_state/);
  assert.deepEqual(result.files, {});
});

test('缺主体、镜头参数或必要时点返回缺项，不生成占位稿', t => {
  const { project, shot } = fixture(t);
  for (const [field, bad] of [['characters', '无'], ['camera_movement', '待填'], ['story_time', ''], ['duration_seconds', 0], ['exit_state', {}]]) {
    const candidate = structuredClone(shot); candidate.data[field] = bad;
    const result = compileShotPrompts({ project, request: { shot: candidate } });
    assert.equal(result.ok, false, field);
    assert.ok(result.missing_fields.some(item => item.includes(field)), result.missing_fields.join(','));
  }
});

test('类型、版本、跨IP和事件引用错误被拒绝，不猜当前采用版', t => {
  const { project, shot } = fixture(t);
  for (const request of [
    { shot: { asset_id: id('CHAR'), version: '1.0.0' } },
    { shot: { asset_id: id('SHOT') } },
    { shot, assets: [{ asset_id: 'IP999-CHAR-001', version: '1.0.0' }] },
    { shot, assets: [ref('CHAR', '9.9.9')] },
    { shot, assets: [ref('EP')] },
    { shot: { ...shot, data: { ...shot.data, character_refs: [ref('PROP')] } } },
    { shot: { ...shot, data: { ...shot.data, source_refs: [{ ...eventRef(), event_id: '不存在事件' }] } } }
  ]) assert.equal(compileShotPrompts({ project, request }).ok, false);
});

test('稳定指纹覆盖真实输入变化，忽略候选旧video_prompt，不混入时间或未定义值', t => {
  const { project, shot } = fixture(t);
  const request = { shot, assets: [ref('PROP')] };
  const first = compileShotPrompts({ project, request });
  assert.equal(first.ok, true);
  assert.deepEqual(compileShotPrompts({ project, request }), first);
  shot.data.video_prompt = '另一个不应成为输入的旧稿';
  assert.equal(compileShotPrompts({ project, request }).compilation.input_sha256, first.compilation.input_sha256);
  shot.data.lighting = '天光冷色';
  assert.notEqual(compileShotPrompts({ project, request }).compilation.input_sha256, first.compilation.input_sha256);
  assert.doesNotMatch(JSON.stringify(first.compilation), /created_at|compiled_at|undefined/);
  const reordered = { assets: request.assets, shot: { data: structuredClone(first.inputs.shot.asset.data), ...Object.fromEntries(Object.entries(shot).filter(([key]) => key !== 'data')) } };
  assert.equal(compileShotPrompts({ project, request: reordered }).compilation.input_sha256, first.compilation.input_sha256);
});

test('MEDIA精确文件、用途和哈希校验，实际平台标签不虚构', t => {
  const { project, shot, save } = fixture(t);
  const files = [{ path: '素材/起态.png', kind: 'image', usage_id: 'FIRST' }];
  save('MEDIA', { files, description: '测试夹具' }, { '素材/起态.png': '测试字节，非图像验收', '未登记.png': '附件' });
  const binding = { media: ref('MEDIA'), file_path: '素材/起态.png', expected_usage_id: 'FIRST', role: '角色外观，不借用背景', allowed: ['脸型和黑色短发'], forbidden: ['不借用图片中的红披风', '不带入参考背景门楼'] };
  const good = compileShotPrompts({ project, request: { shot, reference_bindings: [binding] } });
  assert.equal(good.ok, true, good.errors.join('\n'));
  assert.match(good.prompt_data.video_prompt, /参考素材1：仅负责角色外观/);
  assert.match(good.prompt_data.video_prompt, /允许沿用：脸型和黑色短发/);
  assert.match(good.prompt_data.video_prompt, /禁止借用：不借用图片中的红披风；不带入参考背景门楼/);
  assert.match(good.warnings.join('\n'), /不证明已看图、已上传/);
  for (const bad of [
    { ...binding, file_path: '未登记.png' }, { ...binding, file_path: '../起态.png' },
    { ...binding, expected_usage_id: 'WRONG' }, { ...binding, media: ref('CHAR') },
    { ...binding, media: ref('MEDIA', '1.1.0') }, { ...binding, forbidden: ['不借背景', { unknown: '不能丢掉的限制' }] }
  ]) assert.equal(compileShotPrompts({ project, request: { shot, reference_bindings: [bad] } }).ok, false);
  const snapshotFile = path.join(project, '.ip-system/snapshots', id('MEDIA'), '1.0.0/素材/起态.png');
  fs.writeFileSync(snapshotFile, '已被篡改的夹具');
  const damaged = compileShotPrompts({ project, request: { shot, reference_bindings: [binding] } });
  assert.equal(damaged.ok, false);
  assert.match(damaged.errors.join('\n'), /校验值不一致/);
});

test('支持已冻结SHOT精确读取，并保留未采用快照的真实状态', t => {
  const { project, shot, save } = fixture(t);
  save('SHOT', shot.data);
  const result = compileShotPrompts({ project, request: { shot: ref('SHOT') } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.compilation.shot_mode, 'snapshot');
  assert.match(result.inputs.shot.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.inputs.shot.asset.adoption_status, '建议');
  assert.doesNotMatch(result.prompt_data.video_prompt, /过时提示词/);
});

test('未知硬约束结构保持可见缺口，不把JSON对象贴进正文', t => {
  const { project, shot } = fixture(t);
  shot.data.visual_requirements = { unsupported_constraint: '衣服绝对不能变白' };
  const result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, false);
  assert.match(result.warnings.join('\n'), /visual_requirements.*未当作已传递要求/);
  assert.equal(result.inputs.shot.asset.data.visual_requirements.unsupported_constraint, '衣服绝对不能变白');
  assert.deepEqual(result.files, {});
});

test('本镜一致性与排除要求进入正文，混合未知硬要求不能被部分转写掩盖', t => {
  const { project, shot } = fixture(t);
  shot.data.consistency_rules = ['钥匙与门锁保持同一铜色'];
  shot.data.forbidden = ['不能让钥匙穿过手掌'];
  let result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  for (const prompt of [result.prompt_data.image_prompt, result.prompt_data.end_frame_prompt, result.prompt_data.video_prompt]) {
    assert.match(prompt, /钥匙与门锁保持同一铜色/);
    assert.match(prompt, /不能让钥匙穿过手掌/);
  }
  for (const fieldName of ['visual_requirements', 'consistency_rules', 'negative_prompt', 'forbidden']) {
    const candidate = structuredClone(shot);
    candidate.data[fieldName] = [{ description: '已知要求', unsupported: '不能悄悄丢失的要求' }];
    result = compileShotPrompts({ project, request: { shot: candidate } });
    assert.equal(result.ok, false, fieldName);
    assert.ok(result.missing_fields.some(item => item.includes(fieldName)));
    assert.deepEqual(result.files, {});
  }
});

test('没有本镜选择不能猜测跨章外观，明确静态visual_base才允许默认', t => {
  const { project, shot, working } = fixture(t);
  shot.data.asset_visuals = shot.data.asset_visuals.filter(item => item.asset.asset_id !== id('CHAR'));
  let result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, false);
  assert.match(result.missing_fields.join('\n'), /asset_visuals.*CHAR/);
  assert.deepEqual(result.files, {});
  const assetFile = path.join(working(id('CHAR')), 'asset.json'), character = json(assetFile);
  character.version = '1.1.0';
  character.data.visual_base = { description: '明确静态基准：青年黑发，左眉尾旧疤', constraints: ['自身左右不得镜像'] };
  write(assetFile, character); saveVersion({ project, asset: id('CHAR') });
  shot.data.character_refs = [ref('CHAR', '1.1.0')];
  result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.match(result.prompt_data.image_prompt, /青年黑发/);
  assert.doesNotMatch(result.prompt_data.image_prompt, /婚礼红袍|千丈法相|左臂痊愈/);
  assert.match(result.compilation.assumptions.join('\n'), /visual_base/);
  const source = result.inputs.assets.find(item => item.asset_id === id('CHAR'));
  assert.equal(source.selected_visual.source, 'asset_base');
  assert.ok(source.consumed_fields.includes('data.visual_base'));
  shot.data.asset_visuals.push({ asset: ref('CHAR', '1.1.0'), description: '本镜主动选择戴遮面斗笠，只见左侧眉尾旧疤' });
  result = compileShotPrompts({ project, request: { shot } });
  assert.equal(result.ok, true);
  assert.match(result.prompt_data.image_prompt, /遮面斗笠/);
  assert.doesNotMatch(result.prompt_data.image_prompt, /明确静态基准/);
});

test('输入摘要只保存精确证据索引与实际选取文字，不带章节剧本或跨章档案', t => {
  const { project, shot } = fixture(t);
  const result = compileShotPrompts({ project, request: { shot, assets: [ref('STATE')] } });
  assert.equal(result.ok, true);
  for (const input of result.inputs.assets) {
    assert.equal(Object.hasOwn(input, 'data'), false);
    assert.match(input.manifest_sha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(input.consumed_fields));
    assert.equal(input.was_adopted, false);
    assert.equal(input.current_adopted, false);
  }
  const evidence = result.files['编译依据.json'];
  assert.doesNotMatch(evidence, /不该进入编译摘要的全篇剧本|千丈法相|跨章汇总|未验证的初始持有人/);
  assert.ok(evidence.length < 18000, evidence.length);
  assert.match(result.warnings.join('\n'), /未曾采用/);
  assert.ok(result.inputs.assets.find(item => item.type === 'EP').consumed_fields.includes('data.chapter_refs'));
});

test('采用状态来自实际历史与指针，声明标签不能把候选冒充采用版', t => {
  const { project, shot, working } = fixture(t);
  const adopt = version => {
    const file = `审核-${version}.json`;
    write(path.join(project, file), { method: 'ai', reviewer: '测试审查者', scope: '角色文字', coverage: 'full', result: 'pass', issues: [], evidence: '测试夹具已检查，不代表真实项目审核' });
    const review = recordReview({ project, asset: id('CHAR'), version, file });
    adoptVersion({ project, asset: id('CHAR'), version, review: review.review_id, reason: '测试采用记录' });
  };
  adopt('1.0.0');
  let result = compileShotPrompts({ project, request: { shot } });
  let item = result.inputs.assets.find(asset => asset.asset_id === id('CHAR'));
  assert.equal(item.was_adopted, true); assert.equal(item.current_adopted, true);
  const filename = path.join(working(id('CHAR')), 'asset.json'), character = json(filename);
  character.version = '1.1.0'; character.adoption_status = '已采用原创';
  write(filename, character); saveVersion({ project, asset: id('CHAR') });
  const candidate = structuredClone(shot);
  candidate.data.character_refs = [ref('CHAR', '1.1.0')];
  candidate.data.asset_visuals.find(selection => selection.asset.asset_id === id('CHAR')).asset.version = '1.1.0';
  result = compileShotPrompts({ project, request: { shot: candidate } });
  item = result.inputs.assets.find(asset => asset.asset_id === id('CHAR'));
  assert.equal(item.was_adopted, false); assert.equal(item.current_adopted, false);
  adopt('1.1.0');
  result = compileShotPrompts({ project, request: { shot } });
  item = result.inputs.assets.find(asset => asset.asset_id === id('CHAR'));
  assert.equal(item.was_adopted, true); assert.equal(item.current_adopted, false);
  assert.match(result.warnings.join('\n'), /曾采用历史版/);
});
