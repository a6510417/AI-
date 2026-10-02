import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, newAsset, saveVersion, recordReview, adoptVersion, CHAPTER_FILES } from '../src/project-service.mjs';
import { createProductionTask, seedProductionAsset, importProductionResults, productionTaskStatus } from '../src/生产流程.mjs';
import { createAssetSkeleton, jsonText, hash } from '../src/rules.mjs';
import { fingerprint } from '../src/storage.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, jsonText(value));
const stage = (id, expected_types) => ({ id, name: `${id}成果`, skill: 'comic-studio', expected_types });
const ref = asset => ({ asset_id: asset.asset_id, version: asset.version });
function fixture(t, schemaVersion = 2) {
  const tmp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tmp, 'studio-production-flow-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), tmp);
    assert.ok(path.basename(resolved).startsWith('studio-production-flow-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const project = initProject({ root, id: 'IP995', name: '生产流程隔离测试', schemaVersion }).project;
  const registry = () => read(path.join(project, 'project.json'));
  const entry = id => registry().assets.find(item => item.asset_id === id);
  const work = id => path.join(project, entry(id).path);
  let reviewIndex = 0;
  const review = (asset, extra = {}) => {
    const folder = schemaVersion === 2 ? 'production' : '00_项目管理';
    const file = `${folder}/review-${++reviewIndex}.json`;
    write(path.join(project, file), { method: 'ai', reviewer: '隔离流程回归夹具', scope: '只核验隔离测试数据', coverage: 'full', result: 'pass', issues: [], evidence: '测试审核链，不代表真实作品或人工审核。', ...extra });
    return recordReview({ project, asset: asset.asset_id, version: asset.version, file }).review_id;
  };
  const accept = asset => adoptVersion({ project, asset: asset.asset_id, version: asset.version, reason: '隔离测试采用', review: review(asset) });
  const stored = (type, data, { refs = [], adopted = true } = {}) => {
    const id = newAsset({ project, type, title: `${type}来源夹具` }).asset_id;
    const file = path.join(work(id), 'asset.json'), asset = read(file); asset.data = data; asset.refs = refs;
    write(file, asset);
    if (type === 'CH') for (const name of CHAPTER_FILES) {
      if (name === '正文.md') fs.writeFileSync(path.join(work(id), name), '来客敲门，守灯人将钥匙交给来客。');
      else write(path.join(work(id), name), name === '新增设定.json' ? [] : { entries: ['来客与守灯人交接'] });
    }
    saveVersion({ project, asset: id }); if (adopted) accept(asset);
    return ref(asset);
  };
  const basis = stored('WORLD', { rules: ['钥匙只有一把'] });
  const plan = (stages = [stage('设计', ['CHAR', 'LOC', 'PROP'])], extra = {}) => ({ request_id: '测试任务', title: '第一集隔离制作', goal: '从已选来源制作第一集文字资产', inputs: { roots: [basis] }, stages, assumptions: ['只产出文字候选'], ...extra });
  const create = request => createProductionTask({ project, request: request ?? plan() });
  const payload = (type, sequence, data, { version = '1.0.0', refs = [], files = {}, base_version } = {}) => {
    const asset = createAssetSkeleton({ projectId: 'IP995', type, sequence, version, title: `${type}生产候选` }).asset;
    asset.data = data; asset.refs = refs;
    return { asset, files, ...(base_version ? { base_version } : {}) };
  };
  const batch = (task, assets, extra = {}) => ({ task, stage_id: '设计', batch_id: '批次一', summary: '已完成本批次实际文字候选', assets, ...extra });
  const status = task => productionTaskStatus({ project, request: { task } });
  const run = request => importProductionResults({ project, request });
  return { project, registry, entry, work, stored, review, accept, basis, plan, create, payload, batch, status, run };
}

test('创建REPORT任务幂等、冻结计划及阶段信息，status只读且不虚构审核采用', t => {
  const f = fixture(t), request = f.plan();
  const created = f.create(request);
  assert.equal(created.reused, false);
  assert.equal(created.next_stage, '设计');
  assert.equal(created.stages[0].status, '待生成');
  assert.equal(f.entry(created.task.asset_id).adopted_version, null);
  assert.equal(f.registry().content_reviews.length, 1);
  const before = fingerprint(f.project, f.project);
  const reused = f.create(request);
  assert.equal(reused.reused, true);
  assert.deepEqual(reused.task, created.task);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.equal(productionTaskStatus({ project: f.project }).tasks.length, 1);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.throws(() => f.create({ ...request, goal: '不同任务' }), /不同计划/);
});

test('文本成果不能伪装图片附件，拒绝前不新增登记或覆盖文件', t => {
  const f = fixture(t), task = f.create().task;
  const item = f.payload('CHAR', 1, { name: '守灯人' }, { files: { '定妆.png': '这不是实际图片' } });
  const before = fingerprint(f.project, f.project);
  assert.throws(() => f.run(f.batch(task, [item])), /不是支持的文本类型/);
  assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('JSON附件大小写与根引用均在整批保存前校验，拒绝时不新增版本或回执', t => {
  const f = fixture(t), task = f.create().task, before = fingerprint(f.project, f.project);
  for (const extension of ['json', 'JSON', 'JsOn']) for (const content of [
    '{无效JSON',
    jsonText({ source: { asset_id: 'IP999-CHAR-001', version: '1.0.0' } }),
    jsonText({ asset_id: 'IP999-CHAR-001', version: '1.0.0' }),
    jsonText({ source: { asset_id: 'IP995-CHAR-001', version: '1.0.0' } }),
    jsonText({ asset_id: 'IP995-CHAR-001', version: '1.0.0' })
  ]) {
    const good = f.payload('CHAR', 2, { name: '本批次不应先保存的人物' });
    const bad = f.payload('CHAR', 1, { name: '守灯人' }, { files: { [`来源.${extension}`]: content } });
    assert.throws(() => f.run(f.batch(task, [good, bad])), /不是有效 JSON|同一项目|循环引用/);
    assert.deepEqual(fingerprint(f.project, f.project), before);
    assert.equal(f.entry(good.asset.asset_id), undefined); assert.equal(f.entry(bad.asset.asset_id), undefined);
  }
  const valid = f.payload('CHAR', 1, { name: '守灯人' }, { files: { '来源.JsOn': jsonText(f.basis) } });
  assert.equal(f.run(f.batch(task, [valid])).ok, true);
  assert.equal(f.entry(valid.asset.asset_id).versions.length, 1);
});

test('标准章节附件根身份沿用已有协议，不被导入当成自引用', t => {
  const f = fixture(t), task = f.create(f.plan([stage('设计', ['CH'])])).task;
  const item = f.payload('CH', 1, { chapter_number: 1, events: [{ event_id: 'E01', story_time: '第一夜', summary: '来客敲门' }] });
  for (const name of CHAPTER_FILES) item.files[name] = name.endsWith('.md') ? '来客在第一夜敲门。' : jsonText({ project_id: 'IP995', asset_id: item.asset.asset_id, chapter_id: item.asset.asset_id, version: item.asset.version, entries: ['来客敲门'] });
  const result = f.run(f.batch(task, [item]));
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(f.entry(item.asset.asset_id).versions.length, 1);
});

test('计划拒绝无输入、错误精确引用和超预算，expected_types只是允许类型', t => {
  const f = fixture(t);
  assert.throws(() => f.create(f.plan(undefined, { inputs: {} })), /输入检查未通过/);
  assert.throws(() => f.create(f.plan(undefined, { inputs: { roots: [{ ...f.basis, version: '9.9.9' }] } })), /输入检查未通过/);
  const huge = f.stored('CHAR', { appearance: '长篇原文'.repeat(7000) });
  assert.throws(() => f.create(f.plan(undefined, { inputs: { roots: [huge] } })), /预算|缩小/);
  const task = f.create().task;
  const item = f.payload('CHAR', 2, { name: '来客' });
  assert.equal(f.run(f.batch(task, [item])).ok, true);
  f.accept(item.asset);
  assert.equal(f.status(task).stages[0].status, '已完成');
});

test('预填仅继承精确引用且只读，SHOT不继承整场起止状态并采用明确人物', t => {
  const f = fixture(t);
  const character = f.stored('CHAR', { name: '来客' });
  const chapter = f.stored('CH', { events: [{ event_id: 'E01', story_time: '第一夜', summary: '交钥匙' }] });
  const event = { ...chapter, event_id: 'E01' }, location = f.stored('LOC', { description: '灯室' });
  const episode = f.stored('EP', { episode_number: 1, chapter_refs: [chapter] });
  const scene = f.stored('SC', { scene_number: 1, episode, location, source_refs: [event], story_time: '第一夜', script: '交钥匙', entry_state: '来客门外', exit_state: '来客出门' }, { refs: [character] });
  const before = fingerprint(f.project, f.project);
  const seeded = seedProductionAsset({ project: f.project, request: { type: 'SHOT', title: '交接镜头', from: [scene, character] } });
  assert.deepEqual(seeded.asset.data.scene, scene);
  assert.deepEqual(seeded.asset.data.episode, episode);
  assert.deepEqual(seeded.asset.data.source_refs, [event]);
  assert.deepEqual(seeded.asset.data.character_refs, [character]);
  assert.equal(seeded.asset.data.entry_state, '');
  assert.equal(seeded.asset.data.exit_state, '');
  assert.deepEqual(seedProductionAsset({ project: f.project, request: { type: 'SHOT', from: [scene] } }).asset.data.character_refs, [character]);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.throws(() => seedProductionAsset({ project: f.project, request: { type: 'MEDIA', from: [scene] } }), /媒体/);
});

test('成果导入幂等但不代替完整审核采用，后续阶段被真实门禁阻断', t => {
  const f = fixture(t), task = f.create(f.plan([stage('设计', ['CHAR']), stage('后续', ['PROP'])])).task;
  const character = f.payload('CHAR', 1, { name: '来客' }), request = f.batch(task, [character]);
  const imported = f.run(request);
  assert.equal(imported.ok, true);
  assert.equal(imported.status.stages[0].status, '待审核采用');
  assert.equal(imported.status.stages[1].status, '等待上游');
  assert.equal(f.entry(character.asset.asset_id).adopted_version, null);
  const before = fingerprint(f.project, f.project);
  assert.equal(f.run(request).reused, true);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.throws(() => f.run({ ...request, summary: '同批次偷换内容' }), /相同 batch_id/);
  const next = f.payload('PROP', 1, { name: '铜钥匙' });
  assert.throws(() => f.run(f.batch(task, [next], { stage_id: '后续', batch_id: '后续一' })), /前序阶段/);
  f.review(character.asset, { coverage: 'partial' });
  assert.equal(f.status(task).stages[0].status, '待审核采用');
  f.accept(character.asset);
  assert.equal(f.status(task).stages[0].status, '已完成');
  assert.equal(f.status(task).stages[1].status, '待生成');
  assert.equal(f.run(f.batch(task, [next], { stage_id: '后续', batch_id: '后续一' })).ok, true);
});

test('后续不通过审核重新阻断已采用成果，新的完整通过才恢复', t => {
  const f = fixture(t), task = f.create().task, item = f.payload('CHAR', 1, { name: '来客' });
  f.run(f.batch(task, [item])); f.accept(item.asset);
  assert.equal(f.status(task).stages[0].status, '已完成');
  f.review(item.asset, { coverage: 'partial', result: 'revise', issues: [{ id: '服装', severity: 'revision', status: 'open', description: '服装需要修订', evidence: '隔离测试中的明确问题' }] });
  assert.equal(f.status(task).stages[0].status, '待审核采用');
  f.review(item.asset, { coverage: 'partial' });
  assert.equal(f.status(task).stages[0].status, '待审核采用');
  f.review(item.asset);
  assert.equal(f.status(task).stages[0].status, '已完成');
});

test('批次内按EP/SC依赖排序保存，即使调用者先给SC，仍需分别审核采用', t => {
  const f = fixture(t), chapter = f.stored('CH', { events: [{ event_id: 'E01', story_time: '夜', summary: '敲门' }] });
  const location = f.stored('LOC', { description: '灯室' });
  const task = f.create(f.plan([stage('设计', ['EP', 'SC'])])).task;
  const episode = f.payload('EP', 1, { episode_number: 1, chapter_refs: [chapter] });
  const scene = f.payload('SC', 1, { scene_number: 1, episode: ref(episode.asset), location, source_refs: [{ ...chapter, event_id: 'E01' }] });
  const imported = f.run(f.batch(task, [scene, episode]));
  assert.equal(imported.ok, true, imported.errors?.join('\n'));
  assert.deepEqual(imported.outputs.map(item => item.asset_id), [episode.asset.asset_id, scene.asset.asset_id]);
  f.accept(episode.asset); f.accept(scene.asset);
  assert.equal(f.status(task).stages[0].status, '已完成');
});

test('修订必须基于干净精确工作稿并完整保留附件，不改旧快照', t => {
  const f = fixture(t), task = f.create().task;
  const original = f.payload('CHAR', 1, { name: '来客', appearance: '青衣' }, { files: { '说明.md': '衣色为设计补全' } });
  f.run(f.batch(task, [original])); f.accept(original.asset);
  const revised = f.payload('CHAR', 1, { name: '来客', appearance: '灰衣' }, { version: '1.0.1', base_version: '1.0.0' });
  const missing = f.run(f.batch(task, [revised], { batch_id: '缺附件' }));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /保留完整文件/);
  revised.files = { '说明.md': '衣色为设计补全' };
  const file = path.join(f.work(original.asset.asset_id), '说明.md');
  fs.appendFileSync(file, '\n并行未保存工作稿');
  const dirty = f.run(f.batch(task, [revised], { batch_id: '脏工作稿' }));
  assert.equal(dirty.ok, false);
  assert.match(dirty.errors.join('\n'), /修订前工作稿/);
  assert.match(fs.readFileSync(file, 'utf8'), /并行未保存/);
  fs.writeFileSync(file, original.files['说明.md']);
  const imported = f.run(f.batch(task, [revised], { batch_id: '修订一' }));
  assert.equal(imported.ok, true, imported.errors?.join('\n'));
  const entry = f.entry(original.asset.asset_id);
  assert.equal(entry.versions.length, 2);
  assert.equal(entry.adopted_version, '1.0.0');
  assert.equal(read(path.join(f.project, entry.versions[0].path, 'asset.json')).data.appearance, '青衣');
  assert.equal(read(path.join(f.work(original.asset.asset_id), 'asset.json')).data.appearance, '灰衣');
  assert.equal(f.status(task).stages[0].status, '待审核采用');
  f.accept(revised.asset);
  assert.equal(f.status(task).stages[0].status, '已完成');
});

test('瞬时写入失败保留部分成果，同一请求恢复后重试不重复保存', t => {
  const f = fixture(t), task = f.create().task;
  const first = f.payload('CHAR', 1, { name: '守灯人' }), second = f.payload('CHAR', 2, { name: '来客' });
  const request = f.batch(task, [first, second]);
  const rename = fs.renameSync;
  let failed = false, result;
  fs.renameSync = (from, to) => {
    if (!failed && path.resolve(String(to)) === path.join(f.project, 'assets', 'CHAR', second.asset.asset_id)) { failed = true; throw new Error('隔离模拟：第二成果工作目录移动中断'); }
    return rename(from, to);
  };
  try { result = f.run(request); } finally { fs.renameSync = rename; }
  assert.equal(failed, true);
  assert.equal(result.ok, false);
  assert.equal(result.outputs.length, 1);
  assert.ok(fs.existsSync(path.join(f.project, '.ip-system/pending.json')));
  const retried = f.run(request);
  assert.equal(retried.ok, true, retried.errors?.join('\n'));
  assert.equal(retried.outputs.length, 2);
  for (const item of [first, second]) assert.equal(f.entry(item.asset.asset_id).versions.length, 1);
  assert.equal(f.registry().operations.filter(item => item.action === 'production-result').length, 1);
  assert.equal(fs.existsSync(path.join(f.project, '.ip-system/pending.json')), false);
  assert.equal(f.run(request).reused, true);
});

test('上游新版本使后续陈旧，针对新上游的新批次可恢复阶段完成', t => {
  const f = fixture(t), task = f.create(f.plan([stage('设计', ['CHAR']), stage('后续', ['PROP'])])).task;
  const first = f.payload('CHAR', 1, { name: '守灯人' });
  f.run(f.batch(task, [first])); f.accept(first.asset);
  const prop = f.payload('PROP', 1, { name: '旧铜钥匙' }, { refs: [ref(first.asset)] });
  f.run(f.batch(task, [prop], { stage_id: '后续', batch_id: '后续一' })); f.accept(prop.asset);
  assert.equal(f.status(task).next_stage, null);
  const nextCharacter = f.payload('CHAR', 1, { name: '守灯人', appearance: '补全灰衣' }, { version: '1.0.1', base_version: '1.0.0' });
  f.run(f.batch(task, [nextCharacter], { batch_id: '人物修订' })); f.accept(nextCharacter.asset);
  assert.equal(f.status(task).stages[1].status, '上游已变化');
  const nextProp = f.payload('PROP', 1, { name: '旧铜钥匙', description: '仍由守灯人持有' }, { version: '1.0.1', base_version: '1.0.0', refs: [ref(nextCharacter.asset)] });
  const rebuilt = f.run(f.batch(task, [nextProp], { stage_id: '后续', batch_id: '后续修订' }));
  assert.equal(rebuilt.ok, true, rebuilt.errors?.join('\n'));
  f.accept(nextProp.asset);
  assert.equal(f.status(task).stages[1].status, '已完成');
});

test('整批内容预检失败不留下部分成果，修正后原版本可正式登记', t => {
  const f = fixture(t), task = f.create().task;
  const first = f.payload('CHAR', 1, { name: '守灯人' });
  const invalid = f.payload('PROP', 1, {});
  const before = fingerprint(f.project, f.project);
  const incomplete = f.run(f.batch(task, [first, invalid]));
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.outputs.length, 0);
  assert.equal(incomplete.quality.ok, false);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.equal(f.status(task).stages[0].status, '待生成');
  assert.equal(fs.existsSync(path.join(f.project, '.ip-system/pending.json')), false);
  const nextFirst = f.payload('CHAR', 1, { name: '守灯人', appearance: '灰衣' });
  const corrected = f.payload('PROP', 1, { name: '唯一铜钥匙' });
  const done = f.run(f.batch(task, [nextFirst, corrected], { batch_id: '内容修订' }));
  assert.equal(done.ok, true, done.errors?.join('\n'));
  f.accept(nextFirst.asset); f.accept(corrected.asset);
  assert.equal(f.status(task).stages[0].status, '已完成');
  assert.deepEqual(f.status(task).stages[0].partial_outputs, []);
});

test('计划原稿哈希变化被status识别并阻止继续导入，不自动改写原输入', t => {
  const f = fixture(t), filename = path.join(f.project, 'sources/选段.txt');
  fs.writeFileSync(filename, '守灯人独自站在门边。\n');
  const reading = { file: 'sources/选段.txt', sha256: hash(fs.readFileSync(filename)), start_line: 1, end_line: 1 };
  const task = f.create(f.plan(undefined, { inputs: { source_readings: [reading] } })).task;
  fs.writeFileSync(filename, '来客已经站到门内。\n');
  const changed = f.status(task);
  assert.equal(changed.ok, false);
  assert.equal(changed.stages[0].status, '输入已变化');
  assert.match(changed.errors.join('\n'), /sha256 不一致/);
  const item = f.payload('CHAR', 1, { name: '守灯人' });
  assert.throws(() => f.run(f.batch(task, [item])), /sha256 不一致/);
  assert.equal(f.entry(item.asset.asset_id), undefined);
});

test('未完成批次逐项绑定上游指纹，上游修订后旧批次不得续跑洗成新依据', t => {
  const f = fixture(t), task = f.create(f.plan([stage('设计', ['CHAR']), stage('后续', ['PROP'])])).task;
  const character = f.payload('CHAR', 1, { name: '守灯人' });
  f.run(f.batch(task, [character])); f.accept(character.asset);
  const good = f.payload('PROP', 1, { name: '铜钥匙' }, { refs: [ref(character.asset)] });
  const bad = f.payload('PROP', 2, { name: '门锁' });
  const request = f.batch(task, [good, bad], { stage_id: '后续', batch_id: '后续部分完成' });
  const rename = fs.renameSync;
  let failed = false, partial;
  fs.renameSync = (from, to) => {
    if (!failed && path.resolve(String(to)) === path.join(f.project, 'assets', 'PROP', bad.asset.asset_id)) { failed = true; throw new Error('隔离模拟：第二成果移动中断'); }
    return rename(from, to);
  };
  try { partial = f.run(request); } finally { fs.renameSync = rename; }
  assert.equal(failed, true);
  assert.equal(partial.ok, false);
  assert.equal(partial.outputs.length, 1);
  const receipt = f.registry().operations.find(item => item.action === 'production-import' && item.batch_id === request.batch_id);
  assert.equal(receipt.upstream_fingerprint, f.status(task).stages[1].upstream_fingerprint);
  const revised = f.payload('CHAR', 1, { name: '守灯人', appearance: '灰衣' }, { version: '1.0.1', base_version: '1.0.0' });
  f.run(f.batch(task, [revised], { batch_id: '上游修订' })); f.accept(revised.asset);
  assert.notEqual(receipt.upstream_fingerprint, f.status(task).stages[1].upstream_fingerprint);
  const before = fingerprint(f.project, f.project);
  assert.throws(() => f.run(request), /未完成批次的上游已变化/);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.equal(f.registry().operations.some(item => item.action === 'production-result' && item.batch_id === request.batch_id), false);
  assert.equal(f.entry(good.asset.asset_id).versions.length, 1);
});

test('计划阶段不可用同请求改写，新增计划可明确使用另一阶段顺序', t => {
  const f = fixture(t), first = f.plan();
  f.create(first);
  assert.throws(() => f.create({ ...first, stages: [stage('重排阶段', ['CHAR'])] }), /不同计划/);
  const second = f.create({ ...first, request_id: '第二任务', stages: [stage('只做人物', ['CHAR'])] });
  assert.equal(second.next_stage, '只做人物');
  assert.equal(productionTaskStatus({ project: f.project }).tasks.length, 2);
});

test('后批次镜头与既有阶段成果重叠时整批拒绝，不改前批快照或审核', t => {
  const f = fixture(t);
  const chapter = f.stored('CH', { events: [{ event_id: 'E01', story_time: '夜', summary: '守灯人交钥匙' }] });
  const location = f.stored('LOC', { description: '灯室' });
  const episode = f.stored('EP', { episode_number: 1, chapter_refs: [chapter], summary: '来客收到钥匙' });
  const source = { ...chapter, event_id: 'E01' };
  const scene = f.stored('SC', { scene_number: 1, episode, location, source_refs: [source], script: '交钥匙' });
  const data = { episode, scene, source_refs: [source], shot_number: 1, start_seconds: 0, duration_seconds: 8, story_time: '夜', scene_description: '灯室窗前', characters: '守灯人和来客', action: '来客接稳钥匙后守灯人松手', emotion: '克制', dialogue: '无', shot_size: '手部近景', camera_movement: '固定', lighting: '暖光', entry_state: '守灯人右手拿钥匙', exit_state: '来客右手拿钥匙', visual_description: '双方双手可见', video_prompt: '钥匙由守灯人右手交到来客右手' };
  const task = f.create(f.plan([stage('设计', ['SHOT'])])).task;
  const first = f.payload('SHOT', 1, data);
  assert.equal(f.run(f.batch(task, [first])).ok, true);
  const second = f.payload('SHOT', 2, { ...data, shot_number: 2, start_seconds: 7 });
  const before = fingerprint(f.project, f.project);
  const rejected = f.run(f.batch(task, [second], { batch_id: '第二镜' }));
  assert.equal(rejected.ok, false);
  assert.ok(rejected.quality.issues.some(issue => issue.rule === 'storyboard.timeline_overlap'));
  assert.deepEqual(fingerprint(f.project, f.project), before);
  second.asset.data.start_seconds = 8;
  const imported = f.run(f.batch(task, [second], { batch_id: '第二镜修正' }));
  assert.equal(imported.ok, true, imported.errors?.join('\n'));
  assert.equal(f.status(task).stages[0].status, '待审核采用');
});

test('v1旧目录仍可创建、导入和真实审核采用，未偷换布局', t => {
  const f = fixture(t, 1), task = f.create().task, item = f.payload('CHAR', 1, { name: '来客' });
  assert.equal(f.run(f.batch(task, [item])).ok, true);
  f.accept(item.asset);
  assert.equal(f.status(task).stages[0].status, '已完成');
  assert.equal(f.registry().schema_version, 1);
  assert.match(f.entry(item.asset.asset_id).path, /^02_人物资产\//);
});
