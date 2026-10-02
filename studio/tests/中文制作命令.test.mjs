import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dispatch } from '../src/cli.mjs';
import { initProject, newAsset, saveVersion, recordReview, adoptVersion, CHAPTER_FILES } from '../src/project-service.mjs';
import { createAssetSkeleton, jsonText } from '../src/rules.mjs';
import { fingerprint } from '../src/storage.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, jsonText(value));
const precise = asset => ({ asset_id: asset.asset_id, version: asset.version });

function fixture(t, { schemaVersion = 2, basis = true } = {}) {
  const parent = path.resolve(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(parent, 'studio-chinese-cli-'));
  t.after(() => {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('studio-chinese-cli-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const project = initProject({ root: temporary, id: 'IP798', name: '中文命令隔离测试', schemaVersion }).project;
  const folder = schemaVersion === 2 ? 'production' : '00_项目管理';
  const registry = () => read(path.join(project, 'project.json'));
  const entry = id => registry().assets.find(item => item.asset_id === id);
  const work = id => path.join(project, entry(id).path);
  const input = (name, value) => {
    const relative = `${folder}/命令输入/${name}.json`;
    fs.mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
    write(path.join(project, relative), value);
    return relative;
  };
  const save = (type, data) => {
    const created = newAsset({ project, type, title: `${type}隔离来源` });
    const directory = work(created.asset_id), asset = read(path.join(directory, 'asset.json'));
    asset.data = data;
    write(path.join(directory, 'asset.json'), asset);
    if (type === 'CH') for (const name of CHAPTER_FILES) {
      if (name === '正文.md') fs.writeFileSync(path.join(directory, name), '窗前油灯晃动，随后恢复稳定。');
      else write(path.join(directory, name), name === '新增设定.json' ? [] : { entries: ['窗前油灯恢复稳定'] });
    }
    saveVersion({ project, asset: asset.asset_id });
    return precise(asset);
  };
  const f = { project, folder, registry, entry, work, input, save };
  if (basis) {
    f.basis = save('WORLD', { rules: ['石塔每晚只点一盏灯。'] });
    const file = input('隔离审核', { method: 'ai', reviewer: '中文命令测试夹具', scope: '仅隔离夹具结构与输入内容', coverage: 'full', result: 'pass', issues: [], evidence: '测试数据，不代表真实作品审核或用户意见。' });
    const review = recordReview({ project, asset: f.basis.asset_id, version: f.basis.version, file });
    adoptVersion({ project, asset: f.basis.asset_id, version: f.basis.version, review: review.review_id, reason: '隔离命令测试采用' });
  }
  return f;
}

function readRequests(f) {
  const chapter = f.save('CH', { events: [{ event_id: 'E01', story_time: '第一夜', summary: '油灯恢复稳定' }] });
  const event = { ...chapter, event_id: 'E01' };
  const location = f.save('LOC', { description: '石塔灯室' });
  const episode = f.save('EP', { episode_number: 1, chapter_refs: [chapter] });
  const scene = f.save('SC', { scene_number: 1, episode, location, source_refs: [event], script: '风停后油灯恢复稳定。' });
  const shot = createAssetSkeleton({ projectId: 'IP798', type: 'SHOT', sequence: 1, title: '窗前油灯' }).asset;
  shot.data = {
    episode, scene, source_refs: [event], character_refs: [],
    shot_number: 1, start_seconds: 0, duration_seconds: 5, story_time: '第一夜',
    scene_description: '石塔灯室的窗前木桌', subject: '一盏油灯', characters: '窗前油灯',
    entry_state: '木桌上油灯的火苗向右倾斜', exit_state: '同一盏油灯的火苗竖直稳定',
    action: '风逐渐停止，火苗恢复稳定', emotion: '平静', dialogue: '无',
    shot_size: '油灯近景', camera_movement: '固定机位', lighting: '灯火暖光',
    visual_description: '窗前木桌上的油灯', sound: '风声渐止', video_prompt: '待重新编译的旧稿'
  };
  return [
    { names: ['制作上下文', 'production-context'], file: f.input('上下文', { stage: '角色设计', roots: [f.basis] }), output: '制作上下文.json' },
    { names: ['预填资产', 'seed-production-asset'], file: f.input('资产预填', { type: 'CHAR', title: '守灯人', from: [f.basis] }), output: '候选资产.json' },
    { names: ['编译提示词', 'compile-prompts'], file: f.input('镜头编译', { shot }), output: '视频提示词.txt' }
  ];
}

test('三个准备命令的中英文入口给出相同真实结果，未指定输出时完全只读', async t => {
  const f = fixture(t), requests = readRequests(f);
  const before = fingerprint(f.project, f.project);
  for (const item of requests) {
    const chinese = await dispatch(item.names[0], { project: f.project, file: item.file });
    const english = await dispatch(item.names[1], { project: f.project, file: item.file });
    assert.equal(chinese.ok, true, JSON.stringify(chinese.errors));
    assert.deepEqual(chinese, english);
    if (item.names[0] === '制作上下文') assert.equal(chinese.context.adopted[0].ref.asset_id, f.basis.asset_id);
    if (item.names[0] === '预填资产') assert.deepEqual(chinese.asset.refs, [f.basis]);
    if (item.names[0] === '编译提示词') {
      assert.match(chinese.prompt_data.video_prompt, /火苗恢复稳定/);
      assert.doesNotMatch(chinese.prompt_data.video_prompt, /待重新编译的旧稿/);
    }
    assert.deepEqual(fingerprint(f.project, f.project), before);
  }
});

test('创建、查询、导入的六个中英文入口共用真实回执且重复调用不升版或自动采用', async t => {
  const f = fixture(t);
  const planFile = f.input('制作计划', { request_id: '中文入口任务', title: '守灯人设计', goal: '按已选世界规则完成一个人物文字候选', inputs: { roots: [f.basis] }, stages: [{ id: '人物设计', name: '完成守灯人设计', skill: 'comic-image-assets', expected_types: ['CHAR'] }], assumptions: ['仅文字候选'] });
  const first = await dispatch('创建制作任务', { project: f.project, file: planFile });
  const repeated = await dispatch('create-production-task', { project: f.project, file: planFile });
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(first.reused, false);
  assert.equal(repeated.reused, true);
  assert.deepEqual(first.task, repeated.task);
  assert.equal(f.entry(first.task.asset_id).adopted_version, null);
  assert.equal(f.entry(first.task.asset_id).versions.length, 1);
  const statusInput = f.input('查询任务', { task: first.task });
  const beforeStatus = fingerprint(f.project, f.project);
  const chineseStatus = await dispatch('制作任务状态', { project: f.project, asset: first.task.asset_id, version: first.task.version });
  const englishStatus = await dispatch('production-task-status', { project: f.project, file: statusInput });
  assert.deepEqual(chineseStatus, englishStatus);
  assert.equal(chineseStatus.stages[0].status, '待生成');
  assert.deepEqual(fingerprint(f.project, f.project), beforeStatus);

  const { asset } = createAssetSkeleton({ projectId: 'IP798', type: 'CHAR', sequence: 1, title: '守灯人' });
  asset.refs = [f.basis]; asset.data = { name: '守灯人', appearance: '灰布短衫、黑色短发' };
  const batchFile = f.input('人物成果', { task: first.task, stage_id: '人物设计', batch_id: '人物首批', assets: [{ asset, files: { '设计依据.md': '灰布短衫为本次普通视觉设计补全。\n' } }], summary: '完成人物文字候选，尚未内容审核和采用' });
  const reviewCount = f.registry().content_reviews.length;
  const imported = await dispatch('登记制作成果', { project: f.project, file: batchFile });
  assert.equal(imported.ok, true, JSON.stringify(imported.errors));
  assert.equal(imported.reused, false);
  const afterImport = fingerprint(f.project, f.project);
  const replay = await dispatch('import-production-results', { project: f.project, file: batchFile });
  assert.equal(replay.ok, true);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.outputs, imported.outputs);
  assert.deepEqual(fingerprint(f.project, f.project), afterImport);
  assert.equal(f.entry(asset.asset_id).versions.length, 1);
  assert.equal(f.entry(asset.asset_id).adopted_version, null);
  assert.equal(f.registry().content_reviews.length, reviewCount);
  assert.equal(imported.status.stages[0].status, '待审核采用');
  assert.equal(fs.readFileSync(path.join(f.work(asset.asset_id), '设计依据.md'), 'utf8'), '灰布短衫为本次普通视觉设计补全。\n');
});

test('准备命令导出中文文件到新目录，拒绝覆盖、越界及已登记资产目录', async t => {
  const f = fixture(t), requests = readRequests(f);
  const registryBefore = fs.readFileSync(path.join(f.project, 'project.json'));
  for (const item of requests) for (const [index, name] of item.names.entries()) {
    const out = `production/制作准备/${item.names[0]}-${index}`;
    const result = await dispatch(name, { project: f.project, file: item.file, out });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.output, path.join(f.project, out));
    assert.equal(read(path.join(result.output, '执行结果.json')).action, item.names[1]);
    assert.ok(fs.statSync(path.join(result.output, item.output)).isFile());
    const original = fingerprint(f.project, result.output);
    await assert.rejects(dispatch(name, { project: f.project, file: item.file, out }), /已存在|拒绝覆盖/);
    assert.deepEqual(fingerprint(f.project, result.output), original);
  }
  const first = requests[0];
  for (const out of ['../越界', 'production/制作准备/../../越界', '.ip-system/覆盖', f.entry(f.basis.asset_id).path]) {
    await assert.rejects(dispatch(first.names[0], { project: f.project, file: first.file, out }), /路径|目录|非法/);
  }
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), registryBefore);
  assert.equal(fs.existsSync(path.join(f.project, '越界')), false);
});

test('旧布局制作输出沿用中文管理目录，不接受新布局路径', async t => {
  const f = fixture(t, { schemaVersion: 1 });
  const file = f.input('旧布局上下文', { stage: '角色设计', roots: [f.basis] });
  const before = fs.readFileSync(path.join(f.project, 'project.json'));
  const result = await dispatch('制作上下文', { project: f.project, file, out: '00_项目管理/制作准备/角色输入' });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(path.join(result.output, '制作上下文.json')));
  await assert.rejects(dispatch('production-context', { project: f.project, file, out: 'production/制作准备/角色输入' }), /00_项目管理/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), before);
});

test('原上下文和编译入口未通过时仍不导出不完整派生文件', async t => {
  const f = fixture(t), requests = readRequests(f);
  const incompleteContext = f.input('超预算上下文', { stage: '角色设计', roots: [f.basis], max_chars: 2 });
  const compilerRequest = read(path.join(f.project, requests.find(item => item.names[0] === '编译提示词').file));
  delete compilerRequest.shot.data.entry_state;
  const incompleteShot = f.input('缺首帧编译', compilerRequest);
  const before = fingerprint(f.project, f.project);
  for (const [command, file] of [['制作上下文', incompleteContext], ['编译提示词', incompleteShot]]) {
    const out = `production/制作准备/失败-${command}`;
    const result = await dispatch(command, { project: f.project, file, out });
    assert.equal(result.ok, false);
    assert.equal(result.output, undefined);
    assert.equal(fs.existsSync(path.join(f.project, out)), false);
  }
  assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('连续状态中英文入口解析真实精确边界，旧自由文本诊断可导出且不改项目', async t => {
  const f = fixture(t);
  const character = f.save('CHAR', { name: '守灯人' });
  const chapter = f.save('CH', { events: [{ event_id: 'E01', story_time: '第一夜', summary: '守灯人袖口被门钩划破' }] });
  const event = { ...chapter, event_id: 'E01' };
  const state = f.save('STATE', {
    timeline: '主线', initial_states: [{ entity: character, values: { clothing: '完整灰布短衫' } }], change_order: ['袖口划破'],
    changes: [{ change_id: '袖口划破', entity: character, event_ref: event, story_time: '第一夜', effective_node: '经过木门后', before: { clothing: '完整灰布短衫' }, after: { clothing: '袖口破损灰布短衫' } }],
    knowledge: [], possessions: [], foreshadowing: []
  });
  const legacy = f.save('STATE', { changes: [{ event_ref: event, story_time: '第一夜', effective_node: '经过木门后', before: '旧自由文字', after: '袖口破损' }], knowledge: [], possessions: [], foreshadowing: [] });
  const file = f.input('明确状态边界', { point: { state, change_id: '袖口划破', phase: 'after' }, entities: [character] });
  const unknownFile = f.input('旧自由文本状态', { point: { state: legacy, phase: 'initial' }, entities: [character] });
  const before = fingerprint(f.project, f.project);
  const chinese = await dispatch('解析连续状态', { project: f.project, file });
  const english = await dispatch('resolve-continuity-state', { project: f.project, file });
  assert.deepEqual(chinese, english);
  assert.equal(chinese.ok, true, JSON.stringify(chinese.issues));
  assert.equal(chinese.complete, true);
  assert.deepEqual(chinese.states[0].entity, character);
  assert.equal(chinese.states[0].values.clothing, '袖口破损灰布短衫');
  assert.deepEqual(chinese.states[0].provenance.clothing.event_ref, event);
  const unknown = await dispatch('解析连续状态', { project: f.project, file: unknownFile });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.complete, false);
  assert.ok(unknown.issues.length > 0);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  const registryBefore = fs.readFileSync(path.join(f.project, 'project.json'));
  const out = 'production/制作准备/状态待核实';
  const exported = await dispatch('resolve-continuity-state', { project: f.project, file: unknownFile, out });
  assert.equal(exported.ok, false);
  assert.equal(read(path.join(exported.output, '执行结果.json')).complete, false);
  await assert.rejects(dispatch('解析连续状态', { project: f.project, file: unknownFile, out }), /已存在|拒绝覆盖/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), registryBefore);
});

test('制作检查与修复中英文入口接通候选复查和正常导入，保留人工正文且不自动审核', async t => {
  const f = fixture(t), requests = readRequests(f);
  const shot = read(path.join(f.project, requests.find(item => item.names[0] === '编译提示词').file)).shot;
  const episode = structuredClone(shot.data.episode);
  const handwritten = '固定油灯近景，风逐渐停止后火苗恢复稳定。';
  shot.data.video_prompt = handwritten;
  delete shot.data.episode;
  const request = { assets: [{ asset: shot, files: {} }] };
  const file = f.input('修复前检查', request);
  const beforeCheck = fingerprint(f.project, f.project);
  const checked = await dispatch('检查制作成果', { project: f.project, file });
  const checkedEnglish = await dispatch('check-production', { project: f.project, file });
  assert.equal(checked.ok, false);
  assert.ok(checked.issues.length > 0);
  assert.deepEqual(checkedEnglish, checked);
  assert.deepEqual(fingerprint(f.project, f.project), beforeCheck);
  const repairFile = f.input('有依据修复', { ...request, expected_fingerprint: checked.input_fingerprint, max_passes: 3 });
  const beforeRepair = fingerprint(f.project, f.project);
  const repaired = await dispatch('修复制作成果', { project: f.project, file: repairFile });
  const repairedEnglish = await dispatch('repair-production', { project: f.project, file: repairFile });
  assert.deepEqual(repairedEnglish, repaired);
  assert.equal(repaired.ok, true, JSON.stringify(repaired.issues));
  assert.deepEqual(repaired.assets[0].asset.data.episode, episode);
  assert.equal(repaired.assets[0].asset.data.video_prompt, handwritten);
  assert.equal(repaired.assets[0].asset.version, shot.version);
  assert.ok(repaired.patches.length > 0);
  assert.deepEqual(fingerprint(f.project, f.project), beforeRepair);
  assert.equal(read(path.join(f.project, repairFile)).assets[0].asset.data.episode, undefined);
  const recheckFile = f.input('修复后复查', { assets: repaired.assets });
  const rechecked = await dispatch('检查制作成果', { project: f.project, file: recheckFile });
  assert.equal(rechecked.ok, true, JSON.stringify(rechecked.issues));

  const planFile = f.input('修复后登记计划', { request_id: '修复后登记', title: '空镜文字候选', goal: '保存已修复的单个镜头候选', inputs: { roots: [f.basis] }, stages: [{ id: '镜头', name: '空镜设计', skill: 'jimeng-video-prompts', expected_types: ['SHOT'] }] });
  const plan = await dispatch('创建制作任务', { project: f.project, file: planFile });
  const reviewsBefore = f.registry().content_reviews.length;
  const batch = f.input('修复后的成果批次', { task: plan.task, stage_id: '镜头', batch_id: '空镜修复成果', assets: repaired.assets, summary: '从明确场次补回所属集，保留人工正文；尚未实际内容审核' });
  const imported = await dispatch('登记制作成果', { project: f.project, file: batch });
  assert.equal(imported.ok, true, JSON.stringify(imported.errors));
  assert.equal(f.entry(shot.asset_id).versions.length, 1);
  assert.equal(f.entry(shot.asset_id).adopted_version, null);
  assert.equal(f.registry().content_reviews.length, reviewsBefore);
});

test('质检与修复未通过仍可留诊断，真实CLI保留失败退出及未解决内容', async t => {
  const f = fixture(t), requests = readRequests(f);
  const first = read(path.join(f.project, requests.find(item => item.names[0] === '编译提示词').file)).shot;
  first.data.video_prompt = '固定近景，观察油灯的火苗由倾斜恢复稳定。';
  const second = structuredClone(first);
  second.asset_id = 'IP798-SHOT-002'; second.data.shot_number = 2; second.data.start_seconds = 3;
  const file = f.input('播放重叠检查', { assets: [{ asset: first, files: {} }, { asset: second, files: {} }] });
  const before = fingerprint(f.project, f.project);
  const checked = await dispatch('check-production', { project: f.project, file });
  assert.equal(checked.ok, false);
  assert.ok(checked.issues.some(issue => issue.severity === 'blocker'));
  const repaired = await dispatch('repair-production', { project: f.project, file });
  assert.equal(repaired.ok, false);
  assert.equal(repaired.assets[1].asset.data.start_seconds, 3);
  assert.ok(repaired.unresolved.length > 0);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  const registryBefore = fs.readFileSync(path.join(f.project, 'project.json'));
  for (const command of ['检查制作成果', '修复制作成果']) {
    const out = `production/制作准备/未通过-${command}`;
    const result = await dispatch(command, { project: f.project, file, out });
    assert.equal(result.ok, false);
    assert.equal(read(path.join(result.output, '执行结果.json')).ok, false);
    assert.ok(fs.existsSync(path.join(result.output, '制作质检.json')));
    if (command === '修复制作成果') assert.equal(read(path.join(result.output, '修复候选.json')).assets[1].asset.data.start_seconds, 3);
    await assert.rejects(dispatch(command, { project: f.project, file, out }), /已存在|拒绝覆盖/);
    await assert.rejects(dispatch(command, { project: f.project, file, out: '../越界诊断' }), /目录|路径/);
  }
  const executable = fileURLToPath(new URL('../bin/studio.mjs', import.meta.url));
  const execution = spawnSync(process.execPath, [executable, '检查制作成果', '--project', f.project, '--file', file, '--out', 'production/制作准备/命令行失败诊断'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(execution.status, 1, execution.stderr);
  assert.match(execution.stdout, /诊断文件已生成；检查仍未通过/);
  assert.match(execution.stdout, /检查问题/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), registryBefore);
});

test('统一可执行入口能跨进程显示帮助并用中文命令读取空项目及空任务状态', t => {
  const f = fixture(t, { basis: false });
  const executable = fileURLToPath(new URL('../bin/studio.mjs', import.meta.url));
  const run = args => execFileSync(process.execPath, [executable, ...args], { encoding: 'utf8', timeout: 15000 });
  const before = fingerprint(f.project, f.project);
  const help = run(['--help']);
  assert.match(help, /创建制作任务/); assert.match(help, /studio\/bin\/studio\.mjs/);
  assert.doesNotMatch(help, /工作室\.mjs|中文菜单/);
  const status = JSON.parse(run(['status', '--project', f.project, '--json']));
  assert.equal(status.ok, true);
  assert.deepEqual(status.assets, []);
  const tasks = JSON.parse(run(['制作任务状态', '--project', f.project, '--json']));
  assert.equal(tasks.ok, true);
  assert.deepEqual(tasks.tasks, []);
  assert.deepEqual(fingerprint(f.project, f.project), before);
});
