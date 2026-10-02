import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildProductionContext } from '../src/生产上下文.mjs';
import { initProject, newAsset, saveVersion, recordReview, adoptVersion, CHAPTER_FILES } from '../src/project-service.mjs';
import { hash, jsonText } from '../src/rules.mjs';
import { fingerprint } from '../src/storage.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, jsonText(value));
function fixture(t) {
  const temporary = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'studio-production-context-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), temporary);
    assert.ok(path.basename(resolved).startsWith('studio-production-context-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const project = initProject({ root, id: 'IP994', name: '生产上下文隔离测试' }).project;
  const registry = () => read(path.join(project, 'project.json'));
  const work = id => path.join(project, registry().assets.find(item => item.asset_id === id).path);
  let reviewNumber = 0;
  const add = (type, data, { refs = [], adopt = true, files = {} } = {}) => {
    const id = newAsset({ project, type, title: `${type}隔离夹具` }).asset_id;
    const file = path.join(work(id), 'asset.json'), asset = read(file);
    asset.data = data; asset.refs = refs; write(file, asset);
    if (type === 'CH') {
      fs.writeFileSync(path.join(work(id), '正文.md'), '# 测试章节\n起初无刀。\n收到刀后收入空间。\n');
      for (const name of CHAPTER_FILES.slice(1)) write(path.join(work(id), name), { project_id: 'IP994', chapter_id: id, version: '1.0.0', entries: name === '新增设定.json' ? [] : ['章节整体摘要，不等于单个事件状态'] });
    }
    for (const [name, bytes] of Object.entries(files)) {
      const target = path.join(work(id), name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    saveVersion({ project, asset: id });
    if (adopt) {
      const relative = `production/review-${++reviewNumber}.json`;
      write(path.join(project, relative), { method: 'ai', reviewer: '隔离结构测试', scope: '仅测试夹具及结构', coverage: 'full', result: 'pass', issues: [], evidence: '隔离测试审核数据，不代表真实作品审核。' });
      const review = recordReview({ project, asset: id, version: '1.0.0', file: relative });
      adoptVersion({ project, asset: id, version: '1.0.0', reason: '隔离测试采用', review: review.review_id });
    }
    return { asset_id: id, version: '1.0.0' };
  };
  const context = request => buildProductionContext({ project, request: { stage: '分镜', ...request } });
  const source = (text = '第一行\r\n第二行\r\n第三行\r\n', file = 'sources/原稿.txt') => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), text);
    return { file, sha256: hash(fs.readFileSync(path.join(project, file))), start_line: 2, end_line: 2 };
  };
  return { project, work, add, context, source };
}
const events = [
  { event_id: 'E01', story_time: '当日清晨', summary: '主角尚未得到刀' },
  { event_id: 'E02', story_time: '当日下午', summary: '主角得到刀后收入空间' },
];

test('原稿必读匹配真实路径，大小写别名不误判，同字节副本不能充作已读', t => {
  const f = fixture(t), source = f.source('原文第一行\n原文第二行\n', 'sources/Original.txt');
  const required = { kind: 'source', ...source, file: 'SOURCES/ORIGINAL.TXT' };
  const request = { source_readings: [source], creative_brief: { goal: '回查所选原文', required_readings: [required] } };
  const copied = f.source('原文第一行\n原文第二行\n', 'sources/Copy.txt');
  const before = fingerprint(f.project, f.project);
  const alias = path.join(f.project, required.file);
  const sameFile = fs.existsSync(alias) && fs.realpathSync.native(alias) === fs.realpathSync.native(path.join(f.project, source.file));
  const result = f.context(request);
  assert.equal(result.ok, sameFile, result.errors.join('\n'));
  assert.equal(result.reading_requirements.complete, sameFile);
  const other = f.context({ ...request, creative_brief: { goal: '回查所选原文', required_readings: [{ kind: 'source', ...copied }] } });
  assert.equal(other.ok, false);
  assert.deepEqual(other.reading_requirements.items[0].included_ranges, []);
  assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('必须显式给出输入和有界预算，不默认全项目或接受浮动引用', t => {
  const f = fixture(t);
  assert.match(f.context({}).errors.join('\n'), /显式指定/);
  assert.match(f.context({ roots: {} }).errors.join('\n'), /数组/);
  assert.match(f.context({ roots: [{ asset_id: 'IP994-CHAR-001' }] }).errors.join('\n'), /精确/);
  assert.match(f.context({ roots: [{ asset_id: 'IP993-CHAR-001', version: '1.0.0' }] }).errors.join('\n'), /跨项目/);
  assert.match(f.context({ source_readings: [f.source()], max_chars: 1 }).errors.join('\n'), /max_chars/);
});

test('采用基准来自精确冻结版本，消费视图只映射已有字段且构建完全只读', t => {
  const f = fixture(t);
  const character = f.add('CHAR', { identity: '主角', visual_requirements: '青灰布袍', state_and_knowledge: '此时无刀', source_boundary: '衣色为设计补全', custom_note: '原样保留' });
  f.add('CHAR', { identity: '未请求的角色' });
  const file = path.join(f.work(character.asset_id), 'asset.json');
  const working = read(file); working.data.visual_requirements = '尚未保存的红衣'; write(file, working);
  const before = fingerprint(f.project, f.project);
  const result = f.context({ roots: [character] });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.context.adopted.length, 1);
  const item = result.context.adopted[0];
  assert.equal(item.content.data.visual_requirements, '青灰布袍');
  assert.deepEqual(item.consumer_view.fields.appearance, ['data.visual_requirements']);
  assert.ok(item.consumer_view.missing.includes('voice'));
  assert.ok(item.consumer_view.unmapped_paths.includes('data.custom_note'));
  assert.equal(Object.hasOwn(item.consumer_view, 'appearance'), false);
  assert.equal(result.input_fingerprint.length, 64);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.equal(f.context({ roots: [character] }).input_fingerprint, result.input_fingerprint);
});

test('未采用根被拒绝，候选递归依赖独立保留且不会冒充采用基准', t => {
  const f = fixture(t);
  const upstream = f.add('CHAR', { name: '上游候选' }, { adopt: false });
  const candidate = f.add('PROP', { name: '候选道具' }, { refs: [upstream], adopt: false });
  const rejected = f.context({ roots: [candidate] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join('\n'), /未曾采用/);
  const result = f.context({ candidates: [candidate] });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.context.adopted, []);
  assert.equal(result.context.candidates.length, 2);
  assert.ok(result.context.candidates.every(item => !item.adoption.ever_adopted && item.usage.includes('候选')));
});

test('CH事件范围保留精确版本，STATE只选该事件证据而不带入全章出口', t => {
  const f = fixture(t);
  const chapter = f.add('CH', { events, exit_state: '已经得到刀' });
  const first = { ...chapter, event_id: 'E01' }, second = { ...chapter, event_id: 'E02' };
  const state = f.add('STATE', {
    changes: [{ event_ref: first, before: '无刀', after: '仍无刀', effective_node: '苏醒', story_time: '清晨' }, { event_ref: second, before: '无刀', after: '刀收入空间', effective_node: '领奖', story_time: '下午' }],
    knowledge: [], possessions: [{ event_ref: second, holder: '主角', fact: '刀在空间' }], foreshadowing: [], endpoint: '章节出口已经得到刀',
  }, { refs: [chapter] });
  const result = f.context({ roots: [first, state] });
  assert.equal(result.ok, true, result.errors.join('\n'));
  const ch = result.context.adopted.find(item => item.type === 'CH');
  const st = result.context.adopted.find(item => item.type === 'STATE');
  assert.deepEqual(ch.content.data.events.map(event => event.event_id), ['E01']);
  assert.equal(ch.content.chapter_text.included, false);
  assert.equal(Object.hasOwn(ch.content, 'chapter_summary'), false);
  assert.equal(Object.hasOwn(ch.content.data, 'exit_state'), false);
  assert.equal(st.content.data.changes.length, 1);
  assert.deepEqual(st.content.data.possessions, []);
  assert.equal(Object.hasOwn(st.content.data, 'endpoint'), false);
  assert.match(st.content.scope, /不排序、不继承/);
  assert.ok(result.omitted.some(item => item.required === false));
  assert.equal(f.context({ roots: [{ ...chapter, event_id: 'E99' }] }).ok, false);
});

test('显式整章含冻结正文摘要，依赖章节只含摘要；候选整章不扩大采用事件范围', t => {
  const f = fixture(t), chapter = f.add('CH', { events });
  const report = f.add('REPORT', { summary: '依据章内容制片' }, { refs: [chapter] });
  const full = f.context({ roots: [chapter] });
  assert.equal(full.ok, true);
  assert.match(full.context.adopted[0].content.chapter_text.text, /起初无刀/);
  assert.ok(full.context.adopted[0].content.chapter_summary.entries.length);
  const dependent = f.context({ roots: [report] }).context.adopted.find(item => item.type === 'CH');
  assert.equal(dependent.content.chapter_text.included, false);
  assert.ok(dependent.content.chapter_summary);
  const mixed = f.context({ roots: [{ ...chapter, event_id: 'E01' }], candidates: [chapter] });
  assert.equal(mixed.context.adopted[0].content.chapter_text.included, false);
  assert.deepEqual(mixed.context.adopted[0].selection.event_ids, ['E01']);
  assert.equal(mixed.context.candidates[0].content.chapter_text.included, true);
});

test('显式SC和SHOT根派生直接事件范围，EP根不猜单镜时点', t => {
  const f = fixture(t), chapter = f.add('CH', { events });
  const first = { ...chapter, event_id: 'E01' }, second = { ...chapter, event_id: 'E02' };
  const location = f.add('LOC', { description: '石塔灯室' });
  const episode = f.add('EP', { episode_number: 1, chapter_refs: [chapter] });
  const scene = f.add('SC', { scene_number: 1, episode, location, source_refs: [first] });
  const shot = f.add('SHOT', { episode, scene, source_refs: [first], shot_number: 1, start_seconds: 0, duration_seconds: 4, story_time: '清晨', scene_description: '灯室', characters: '主角', action: '睁眼', emotion: '警觉', dialogue: '无', shot_size: '近景', camera_movement: '固定', lighting: '晨光', video_prompt: '灯室晨光，近景，主角睁眼。', visual_description: '主角空手睁眼' });
  const state = f.add('STATE', { changes: [first, second].map(event_ref => ({ event_ref, before: '无刀', after: event_ref.event_id === 'E01' ? '仍无刀' : '已有刀', effective_node: '事件完成', story_time: '当日' })), knowledge: [], possessions: [], foreshadowing: [] });
  for (const root of [scene, shot]) {
    const result = f.context({ roots: [root, state] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.context.adopted.find(item => item.type === 'STATE').content.data.changes.map(item => item.event_ref.event_id), ['E01']);
    assert.deepEqual(result.context.adopted.find(item => item.type === 'CH').content.data.events.map(item => item.event_id), ['E01']);
    assert.equal(result.context.scope.derived_event_scope[0].from.asset_id, root.asset_id);
  }
  const wide = f.context({ roots: [episode, state] });
  assert.deepEqual(wide.context.scope.event_scope, []);
  assert.equal(wide.context.adopted.find(item => item.type === 'STATE').content.data.changes.length, 2);
});

test('原稿选段校验完整文件哈希和含结束行的准确范围，并只作为未采用证据', t => {
  const f = fixture(t), source = f.source();
  const before = fingerprint(f.project, f.project);
  const result = f.context({ source_readings: [source] });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.context.source_readings[0].text, '第二行');
  assert.equal(result.context.source_readings[0].total_lines, 3);
  assert.match(result.context.source_readings[0].status, /未采用/);
  assert.deepEqual(result.context.adopted, []);
  assert.deepEqual(fingerprint(f.project, f.project), before);
  assert.notEqual(f.context({ source_readings: [{ ...source, start_line: 1 }] }).input_fingerprint, result.input_fingerprint);
  for (const change of [{ sha256: '0'.repeat(64) }, { start_line: 0 }, { end_line: 4 }, { end_line: undefined }, { file: '../outside.txt' }, { file: '.ip-system/pending.json' }]) {
    const rejected = f.context({ source_readings: [{ ...source, ...change }] });
    assert.equal(rejected.ok, false, JSON.stringify(change));
  }
});

test('拒绝系统、MEDIA、非文本扩展、伪装二进制、无效UTF-8和目录联接输入', t => {
  const f = fixture(t);
  for (const [file, bytes] of [
    ['production/画面.png', Buffer.from('text')], ['production/binary.txt', Buffer.from([0, 1, 2])],
    ['production/invalid.txt', Buffer.from([255, 254, 252])], ['assets/MEDIA/候选/a.txt', Buffer.from('text')],
  ]) {
    const source = f.source(bytes, file);
    assert.equal(f.context({ source_readings: [{ ...source, start_line: 1, end_line: 1 }] }).ok, false, file);
  }
  const source = f.source('可读正文\n');
  const link = path.join(f.project, 'production/source-link');
  fs.symlinkSync(path.join(f.project, 'sources'), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(f.context({ source_readings: [{ ...source, file: 'production/source-link/原稿.txt', start_line: 1, end_line: 1 }] }).errors.join('\n'), /符号链接|目录联接/);
});

test('原稿入口拒绝普通已登记资产工作目录，安全来源仍可读取', t => {
  const f = fixture(t), character = f.add('CHAR', { name: '主角' });
  const report = f.add('REPORT', { summary: '交接', files: [{ path: '附件/正文.md' }] }, { files: { '附件/正文.md': '尚未采用的新工作稿不能冒充冻结附件。\n' } });
  const reading = (ref, file) => {
    const directory = path.relative(f.project, f.work(ref.asset_id)).replaceAll('\\', '/');
    return { file: `${directory}/${file}`, sha256: hash(fs.readFileSync(path.join(f.work(ref.asset_id), file))), start_line: 1, end_line: 1 };
  };
  for (const source of [reading(character, 'asset.json'), reading(report, '附件/正文.md')]) {
    for (const file of [source.file, source.file.toUpperCase(), source.file.replaceAll('/', '\\')]) {
      const rejected = f.context({ source_readings: [{ ...source, file }] });
      assert.equal(rejected.ok, false);
      assert.match(rejected.errors.join('\n'), /已登记资产工作目录.*asset_readings/);
    }
  }
  const allowed = f.context({ source_readings: [f.source('原始来源首行\n安全来源第二行\n', 'sources/小说原文.txt')] });
  assert.equal(allowed.ok, true, allowed.errors.join('\n'));
  assert.equal(allowed.context.source_readings[0].text, '安全来源第二行');
  assert.equal(f.context({ roots: [report], asset_readings: [{ ...report, file: '附件/正文.md' }] }).ok, true);
});

test('预算计算包含JSON及限制标注，超限整项省略、返回不完整且不截正文', t => {
  const f = fixture(t), source = f.source('关键信息'.repeat(300));
  source.start_line = 1; source.end_line = 1;
  const request = { source_readings: [source] };
  const full = f.context(request);
  assert.equal(full.ok, true);
  assert.equal(full.budget.used_chars, JSON.stringify(full.context).length);
  const exact = f.context({ ...request, max_chars: full.budget.required_chars });
  assert.equal(exact.ok, true);
  for (const max_chars of [2, 600, full.budget.required_chars - 1]) {
    const limited = f.context({ ...request, max_chars });
    assert.equal(limited.ok, false);
    assert.equal(limited.budget.complete, false);
    assert.ok(JSON.stringify(limited.context).length <= max_chars);
    assert.ok(limited.omitted.some(item => item.required === true && item.input.includes('原稿.txt')));
    assert.match(limited.errors.join('\n'), /缩小原稿行范围/);
    assert.equal(limited.input_fingerprint, full.input_fingerprint);
    assert.equal(JSON.stringify(limited.context).includes('关键信息'), false);
  }
});

test('冻结快照损坏或候选来源版本不存在时拒绝构建', t => {
  const f = fixture(t), character = f.add('CHAR', { name: '主角' });
  assert.equal(f.context({ candidates: [{ ...character, version: '9.9.9' }] }).ok, false);
  const registry = read(path.join(f.project, 'project.json'));
  const entry = registry.assets.find(item => item.asset_id === character.asset_id);
  fs.appendFileSync(path.join(f.project, entry.versions[0].path, 'asset.json'), ' ');
  const damaged = f.context({ roots: [character] });
  assert.equal(damaged.ok, false);
  assert.match(damaged.errors.join('\n'), /校验值不一致/);
});

test('旧请求仍默认完整 data 依赖，附件目录不冒充正文且不抹去重复剧本', t => {
  const f = fixture(t), character = f.add('CHAR', { name: '主角', appearance: '青灰布袍' });
  const script = '铁锄刨开湿土，主角保持空手。';
  const report = f.add('REPORT', { summary: '交接', script, files: [{ path: '正文.md', role: '实际剧本' }] }, { refs: [character], files: { '正文.md': script } });
  const old = f.context({ roots: [report] }), explicitFull = f.context({ roots: [report], dependency_mode: 'full' });
  assert.equal(old.ok, true, old.errors.join('\n'));
  assert.deepEqual(old.context, explicitFull.context);
  assert.equal(old.input_fingerprint, explicitFull.input_fingerprint);
  const upstream = old.context.adopted.find(item => item.ref.asset_id === character.asset_id);
  assert.equal(upstream.content.data.appearance, '青灰布袍');
  const item = old.context.adopted.find(item => item.ref.asset_id === report.asset_id);
  assert.equal(item.content.data.script, script);
  assert.equal(item.content.registered_files[0].read_status, 'not_included');
  assert.ok(old.warnings.some(warning => warning.includes('asset_readings')));
  assert.deepEqual(old.context.asset_readings, []);
});

test('冻结附件支持完整文本和含末行选段，保留精确身份、哈希及可追溯覆盖', t => {
  const f = fixture(t), text = '\uFEFF第一行\r\n第二行\r\n第三行\r\n';
  const upstream = f.add('REPORT', { summary: '机制', files: [{ path: '补充/节点.md' }] }, { files: { '补充/节点.md': text } });
  const root = f.add('REPORT', { summary: '交接根' }, { refs: [upstream] });
  const request = { roots: [root], dependency_mode: 'references', asset_readings: [{ ...upstream, file: '补充/节点.md' }] };
  const before = fingerprint(f.project, f.project), full = f.context(request);
  assert.equal(full.ok, true, full.errors.join('\n'));
  const file = full.context.asset_readings[0];
  assert.deepEqual(file.ref, upstream);
  assert.equal(file.scope, 'full_file');
  assert.equal(file.text, text.slice(1));
  assert.equal(file.total_lines, 3);
  assert.equal(file.sha256, hash(Buffer.from(text)));
  assert.equal(file.manifest_sha256.length, 64);
  assert.match(file.snapshot_file, /snapshots\/IP994-REPORT-001\/1\.0\.0\/补充\/节点\.md$/);
  assert.match(file.evidence_scope, /不证明语义/);
  const dependency = full.context.adopted.find(item => item.ref.asset_id === upstream.asset_id);
  assert.equal(Object.hasOwn(dependency.content, 'data'), false);
  assert.equal(dependency.content.registered_files[0].read_status, 'included_full');
  const partial = f.context({ ...request, asset_readings: [{ ...upstream, file: '补充/节点.md', start_line: 2, end_line: 3 }] });
  assert.equal(partial.ok, true);
  assert.equal(partial.context.asset_readings[0].scope, 'lines');
  assert.equal(partial.context.asset_readings[0].text, '第二行\n第三行');
  assert.deepEqual(partial.context.adopted.find(item => item.ref.asset_id === upstream.asset_id).content.registered_files[0].ranges, [{ start_line: 2, end_line: 3, scope: 'lines' }]);
  assert.notEqual(partial.input_fingerprint, full.input_fingerprint);
  assert.equal(f.context({ ...request, max_chars: full.budget.required_chars }).input_fingerprint, full.input_fingerprint);
  assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('附件必须位于所选精确依赖闭包、已登记且路径和行范围合法', t => {
  const f = fixture(t);
  const root = f.add('REPORT', { summary: '交接', files: [{ path: '正文.md' }, { path: '登记但缺失.md' }] }, { files: { '正文.md': '首行\n末行\n', '仅manifest.md': '未列data.files' } });
  const outside = f.add('REPORT', { summary: '无依赖关系', files: [{ path: '正文.md' }] }, { files: { '正文.md': '其他作品资料' } });
  for (const reading of [
    { ...outside, file: '正文.md' }, { ...root, version: '9.9.9', file: '正文.md' },
    { ...root, file: '../正文.md' }, { ...root, file: '/正文.md' },
    { ...root, file: '仅manifest.md' }, { ...root, file: '登记但缺失.md' },
    { ...root, file: 'asset.json' }, { ...root, file: '_snapshot.json' },
    { ...root, file: '正文.md', start_line: 1 }, { ...root, file: '正文.md', end_line: 1 },
    { ...root, file: '正文.md', start_line: 0, end_line: 1 },
    { ...root, file: '正文.md', start_line: 2, end_line: 1 },
    { ...root, file: '正文.md', start_line: 1, end_line: 3 },
    { ...root, file: '正文.md', sha256: '0'.repeat(64) },
  ]) assert.equal(f.context({ roots: [root], asset_readings: [reading] }).ok, false, JSON.stringify(reading));
  assert.equal(f.context({ roots: [root], dependency_mode: 'latest' }).ok, false);
  assert.equal(f.context({ roots: [root], dependency_mode: null }).ok, false);
  assert.equal(f.context({ roots: [root], asset_readings: {} }).ok, false);
});

test('拒绝MEDIA、二进制、非UTF-8、非文本扩展及与manifest不符的冻结附件', t => {
  const f = fixture(t);
  const media = f.add('MEDIA', { files: [{ path: '媒体说明.txt', kind: 'other' }] }, { files: { '媒体说明.txt': '仍是MEDIA资产，不作为文字来源' } });
  assert.match(f.context({ roots: [media], asset_readings: [{ ...media, file: '媒体说明.txt' }] }).errors.join('\n'), /MEDIA/);
  assert.match(f.context({ roots: [media], data_selections: [{ ...media, paths: ['/files/0'] }] }).errors.join('\n'), /CH、STATE 或 MEDIA/);
  for (const [name, bytes, message] of [
    ['二进制.txt', Buffer.from([0, 1, 2]), /控制字符/],
    ['无效.txt', Buffer.from([255, 254, 252]), /UTF-8/],
    ['伪文本.png', Buffer.from('文字'), /文本文件类型/],
  ]) {
    const report = f.add('REPORT', { summary: '附件', files: [{ path: name }] }, { files: { [name]: bytes } });
    const result = f.context({ roots: [report], asset_readings: [{ ...report, file: name }] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), message);
  }
  const report = f.add('REPORT', { summary: '冻结附件', files: [{ path: '正文.md' }] }, { files: { '正文.md': '冻结原文' } });
  const entry = read(path.join(f.project, 'project.json')).assets.find(item => item.asset_id === report.asset_id);
  fs.appendFileSync(path.join(f.project, entry.versions[0].path, '正文.md'), '不应出现的修改');
  assert.match(f.context({ roots: [report], asset_readings: [{ ...report, file: '正文.md' }] }).errors.join('\n'), /校验值不一致/);
});

test('JSON Pointer只选显式资产原路径值，严格处理转义、数组索引及未知路径', t => {
  const f = fixture(t), character = f.add('CHAR', { name: '主角', entries: [{ phase: '开篇', weapon: '无刀' }, { phase: '终局', weapon: '神刀' }], '名字/旧': '旧名', '提示~词': '保持来源' });
  const paths = ['/entries/0', '/名字~1旧', '/提示~0词'];
  const request = { roots: [character], data_selections: [{ ...character, paths }] }, result = f.context(request);
  assert.equal(result.ok, true, result.errors.join('\n'));
  const item = result.context.adopted[0];
  assert.deepEqual(item.content.data, { '/entries/0': { phase: '开篇', weapon: '无刀' }, '/名字~1旧': '旧名', '/提示~0词': '保持来源' });
  assert.deepEqual(item.content.data_selection.paths, paths);
  assert.equal(item.content.data_selection.base, 'asset.data');
  assert.equal(Object.hasOwn(item, 'consumer_view'), false);
  assert.equal(JSON.stringify(result.context).includes('神刀'), false);
  assert.ok(result.omitted.some(item => item.required === false));
  assert.notEqual(f.context({ roots: [character], data_selections: [{ ...character, paths: ['/entries/1'] }] }).input_fingerprint, result.input_fingerprint);
  for (const paths of [['entries/0'], ['/entries/01'], ['/entries/-'], ['/entries/2'], ['/missing'], ['/名字~2旧'], ['/entries/*'], ['/constructor'], ['/__proto__'], [null], [], ['/name', '/name']]) {
    assert.equal(f.context({ roots: [character], data_selections: [{ ...character, paths }] }).ok, false, JSON.stringify(paths));
  }
  const dependent = f.add('REPORT', { summary: '交接' }, { refs: [character] });
  assert.match(f.context({ roots: [dependent], data_selections: [{ ...character, paths: ['/name'] }] }).errors.join('\n'), /显式 roots\/candidates/);
  const candidate = f.add('CHAR', { name: '候选人物' }, { adopt: false });
  const selectedCandidate = f.context({ candidates: [candidate], data_selections: [{ ...candidate, paths: ['/name'] }] });
  assert.equal(selectedCandidate.ok, true);
  assert.equal(selectedCandidate.context.candidates[0].adoption.ever_adopted, false);
  assert.equal(f.context({ roots: [character], data_selections: [{ ...character, paths }, { ...character, paths: ['/name'] }] }).ok, false);
});

test('引用模式和附件阅读不自动扩大事件范围；CH七文件可读取但禁止任意data裁剪', t => {
  const f = fixture(t), chapter = f.add('CH', { events, exit_state: '下午有刀' });
  const first = { ...chapter, event_id: 'E01' }, second = { ...chapter, event_id: 'E02' };
  const state = f.add('STATE', { changes: [first, second].map(event_ref => ({ event_ref, before: '无刀', after: event_ref.event_id === 'E01' ? '仍无刀' : '已有刀', effective_node: '事件完成', story_time: '当日' })), knowledge: [], possessions: [], foreshadowing: [] }, { refs: [chapter] });
  const location = f.add('LOC', { description: '林地' }), episode = f.add('EP', { episode_number: 1, chapter_refs: [chapter] });
  const scene = f.add('SC', { scene_number: 1, episode, location, source_refs: [first], script: '空手苏醒' });
  const request = { roots: [scene, state], dependency_mode: 'references', asset_readings: [{ ...chapter, file: '正文.md', start_line: 1, end_line: 2 }] };
  const result = f.context(request);
  assert.equal(result.ok, true, result.errors.join('\n'));
  const dependent = result.context.adopted.find(item => item.type === 'CH');
  assert.equal(dependent.selection.kind, 'dependency_reference');
  assert.equal(Object.hasOwn(dependent.content, 'data'), false);
  assert.equal(Object.hasOwn(dependent.content, 'chapter_text'), false);
  assert.deepEqual(result.context.scope.event_scope, [`${chapter.asset_id}@1.0.0#E01`]);
  assert.deepEqual(result.context.adopted.find(item => item.type === 'STATE').content.data.changes.map(change => change.event_ref.event_id), ['E01']);
  const otherAttachment = f.context({ ...request, asset_readings: [{ ...chapter, file: '出场人物.json' }] });
  assert.equal(otherAttachment.ok, true);
  assert.deepEqual(otherAttachment.context.scope.event_scope, result.context.scope.event_scope);
  assert.match(f.context({ roots: [chapter], data_selections: [{ ...chapter, paths: ['/events/0'] }] }).errors.join('\n'), /CH、STATE 或 MEDIA/);
  assert.match(f.context({ roots: [state], data_selections: [{ ...state, paths: ['/changes/0'] }] }).errors.join('\n'), /CH、STATE 或 MEDIA/);
});

test('单根大依赖可按引用加原数据路径控制预算，明确必读附件超限仍整项失败', t => {
  const f = fixture(t), dependency = f.add('CHAR', { name: '跨季人物', future: '后期资料'.repeat(16000) });
  const world = f.add('WORLD', { rules: [{ fact: '开篇无刀', source: '第一章' }, { fact: '后期神刀'.repeat(16000) }], files: [{ path: '节点.md' }] }, { refs: [dependency], files: { '节点.md': '第1章无刀。\n第2章得刀入空间。\n' } });
  assert.equal(f.context({ roots: [world] }).ok, false);
  assert.equal(f.context({ roots: [world], dependency_mode: 'references' }).ok, false);
  const request = { roots: [world], dependency_mode: 'references', data_selections: [{ ...world, paths: ['/rules/0'] }], asset_readings: [{ ...world, file: '节点.md' }] };
  const result = f.context(request);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.budget.used_chars < 24000);
  assert.equal(result.context.adopted.find(item => item.type === 'CHAR').content.data, undefined);
  assert.equal(JSON.stringify(result.context).includes('后期资料'), false);
  assert.equal(result.context.asset_readings[0].text, '第1章无刀。\n第2章得刀入空间。\n');
  const large = f.add('REPORT', { summary: '明确必读的大附件', files: [{ path: '完整附录.md' }] }, { files: { '完整附录.md': '必读证据'.repeat(10000) } });
  const fullRequest = { roots: [large], asset_readings: [{ ...large, file: '完整附录.md' }] };
  const complete = f.context({ ...fullRequest, max_chars: 100000 }), limited = f.context(fullRequest);
  assert.equal(complete.ok, true, complete.errors.join('\n'));
  assert.equal(limited.ok, false);
  assert.equal(limited.budget.complete, false);
  assert.equal(limited.input_fingerprint, complete.input_fingerprint);
  assert.equal(limited.context.asset_readings.length, 0);
  assert.ok(limited.omitted.some(item => item.category === 'asset_readings' && item.required && item.input.includes('完整附录.md')));
  assert.equal(limited.context.adopted[0].content.registered_files[0].read_status, 'not_included');
  assert.equal(JSON.stringify(limited.context).includes('必读证据'), false);
});
