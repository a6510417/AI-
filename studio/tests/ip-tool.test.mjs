import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject, validateProject, saveVersion, adoptVersion, exportProject, DIRECTORIES, CHAPTER_FILES } from '../src/project-service.mjs';

const cli = fileURLToPath(new URL('../bin/studio.mjs', import.meta.url));
const text = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJSON = (filename, value) => fs.writeFileSync(filename, text(value));
const ref = (type, version = '1.0.0', extra = {}) => ({ asset_id: `IP900-${type}-001`, version, ...extra });
const event = () => ref('CH', '1.0.0', { event_id: 'E01' });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '原创IP_中文 测试_'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = initProject({ root, id: 'IP900', name: '测试 故事', schemaVersion: 1 }).project;
  return { root, project };
}
function assetPath(project, type, number = '001') {
  const directory = ['WORLD', 'LOC', 'PROP'].includes(type) ? DIRECTORIES[1] : type === 'CHAR' ? DIRECTORIES[2] : ['CH', 'STATE', 'PLOT'].includes(type) ? DIRECTORIES[3] : DIRECTORIES[4];
  return path.join(project, directory, `${type}${number}`);
}
function createAsset(project, type, data, { refs = [], number = '001', version = '1.0.0' } = {}) {
  const directory = assetPath(project, type, number);
  fs.mkdirSync(directory, { recursive: true });
  const asset = { schema_version: 1, project_id: 'IP900', asset_id: `IP900-${type}-${number}`, type, title: `${type} 测试资产`, version, source_kind: '原创创作', adoption_status: '建议', refs, data };
  writeJSON(path.join(directory, 'asset.json'), asset);
  if (type === 'CH') {
    fs.writeFileSync(path.join(directory, '正文.md'), '# 第一章\n阿青把药包交给船夫。船夫托稳药包后，阿青才松手。\n');
    for (const filename of CHAPTER_FILES.slice(1)) writeJSON(path.join(directory, filename), filename === '新增设定.json' ? [] : { entries: ['测试章节完整内容'] });
  }
  return { directory, asset };
}
function save(project, type, number = '001') {
  return saveVersion({ project, path: path.relative(project, assetPath(project, type, number)).replaceAll('\\', '/') });
}
function adopt(project, type, version = '1.0.0', number = '001') {
  return adoptVersion({ project, asset: `IP900-${type}-${number}`, version, reason: '已检查本次测试文本及来源，采用这个精确版本' });
}
function changeAsset(project, type, fn, number = '001') {
  const filename = path.join(assetPath(project, type, number), 'asset.json');
  const asset = json(filename); fn(asset); writeJSON(filename, asset); return asset;
}
function changeProject(project, fn) {
  const filename = path.join(project, 'project.json');
  const value = json(filename); fn(value); writeJSON(filename, value); return value;
}
function bridge(project, { adoptAll = true } = {}) {
  const chapterData = { events: [{ event_id: 'E01', story_time: '雨夜，离岸前', summary: '托稳后才松手' }] };
  const content = [
    ['WORLD', { rules: ['药包不能复制'] }],
    ['LOC', { description: '雨夜码头' }],
    ['CH', chapterData, [ref('WORLD')]],
    ['EP', { episode_number: 1, chapter_refs: [ref('CH')] }],
    ['SC', { scene_number: 1, episode: ref('EP'), location: ref('LOC'), source_refs: [event()], summary: '船夫伸手托住药包。' }],
    ['SHOT', { episode: ref('EP'), scene: ref('SC'), source_refs: [event()], shot_number: 1, start_seconds: 0, duration_seconds: 8, story_time: '雨夜，离岸前', scene_description: '冷雨中的码头', characters: '阿青、船夫', action: '船夫托稳药包，阿青才松手', emotion: '紧张到释然', dialogue: '无', shot_size: '双手近景', camera_movement: '固定', lighting: '灯笼暖光', video_prompt: '冷雨码头，船夫托稳纸包，阿青才松手，固定双手近景，灯笼暖光。', visual_description: '药包唯一，手部交接全程可见' }],
    ['PROMPT', { shot: ref('SHOT'), image_prompt: '托药包的双手定格', negative_prompt: '避免多余药包', optimization: '交接保持在画' }],
  ];
  for (const [type, data, refs = []] of content) { createAsset(project, type, data, { refs }); save(project, type); if (adoptAll) adopt(project, type); }
}

test('中文路径初始化、空白模板、重复项目和重复 ID 不覆盖', t => {
  const { root, project } = fixture(t);
  const report = validateProject({ project });
  assert.equal(report.ok, true); assert.equal(report.stats.assets, 0);
  for (const directory of DIRECTORIES) assert.equal(fs.statSync(path.join(project, directory)).isDirectory(), true);
  for (const filename of CHAPTER_FILES) assert.equal(fs.existsSync(path.join(project, DIRECTORIES[0], '空白模板', filename)), true);
  assert.throws(() => initProject({ root, id: 'IP900', name: '测试 故事' }), /拒绝覆盖/);
  assert.throws(() => initProject({ root, id: 'IP900', name: '不同名' }), /项目 ID/);
  assert.throws(() => initProject({ root, id: 'IP901', name: '../错误' }), /名称/);
});

test('逐层保存采用、完整依赖导出、工作稿隔离和拒绝覆盖', t => {
  const { project } = fixture(t); bridge(project);
  const initial = validateProject({ project, strict: true }); assert.equal(initial.ok, true, initial.errors.join('\n'));
  changeAsset(project, 'SHOT', asset => { asset.data.action = '工作稿待讨论，未采用'; asset.data.video_prompt = '未经采用的新提示词'; });
  const result = exportProject({ project, out: '07_发布资产/交接 包一' });
  const handoff = json(path.join(result.output, 'handoff.json'));
  assert.equal(handoff.assets.length, 7);
  assert.equal(handoff.content.find(asset => asset.type === 'SHOT').data.action, '船夫托稳药包，阿青才松手');
  assert.match(fs.readFileSync(path.join(result.output, '交接说明.md'), 'utf8'), /11\. \*\*视频提示词\*\*/);
  assert.equal(fs.existsSync(path.join(result.output, 'assets/IP900-CH-001/1.0.0/正文.md')), true);
  assert.throws(() => exportProject({ project, out: '07_发布资产/交接 包一' }), /拒绝覆盖/);
  assert.throws(() => save(project, 'SHOT'), /不可覆盖/);
  assert.ok(validateProject({ project }).warnings.some(item => /工作稿与同号历史/.test(item)));
  assert.equal(json(path.join(project, 'project.json')).exports[0].assets.length, 7);
});

test('真实版本修订保留未采用草稿，新版本不会自动采用', t => {
  const { project } = fixture(t);
  createAsset(project, 'WORLD', { rule: '错误初稿' }); save(project, 'WORLD');
  changeAsset(project, 'WORLD', asset => { asset.version = '1.0.1'; asset.data.rule = '审核修正'; }); save(project, 'WORLD');
  let registry = json(path.join(project, 'project.json'));
  assert.equal(registry.assets[0].adopted_version, null);
  adopt(project, 'WORLD', '1.0.1'); registry = json(path.join(project, 'project.json'));
  assert.equal(registry.assets[0].versions.length, 2);
  assert.equal(registry.assets[0].adopted_version, '1.0.1');
  assert.equal(registry.adoption_history.some(item => item.version === '1.0.0'), false);
  assert.equal(json(path.join(project, '.ip-system/snapshots/IP900-WORLD-001/1.0.0/asset.json')).data.rule, '错误初稿');
});

test('上游新版采用生成复核项，交接保留历史采用依赖且完整复制', t => {
  const { project } = fixture(t); bridge(project);
  changeAsset(project, 'WORLD', asset => { asset.version = '1.1.0'; asset.data.rules.push('新版增加的规则'); });
  save(project, 'WORLD'); const adoption = adopt(project, 'WORLD', '1.1.0');
  assert.ok(adoption.review_items.some(item => item.asset_id === 'IP900-CH-001' && item.referenced_version === '1.0.0'));
  const exported = exportProject({ project, out: '07_发布资产/历史固定' });
  const assets = json(path.join(exported.output, 'handoff.json')).assets;
  assert.ok(assets.some(item => item.asset_id === 'IP900-WORLD-001' && item.version === '1.0.0'));
  assert.ok(assets.some(item => item.asset_id === 'IP900-WORLD-001' && item.version === '1.1.0'));
  assert.equal(json(path.join(exported.output, 'assets/IP900-CH-001/1.0.0/asset.json')).refs[0].version, '1.0.0');
});

test('上游修改的复核提示沿章节、分集、场次、镜头传播到提示词', t => {
  const { project } = fixture(t); bridge(project);
  changeAsset(project, 'WORLD', asset => { asset.version = '1.0.1'; asset.data.rules.push('世界规则修订'); }); save(project, 'WORLD');
  const result = adopt(project, 'WORLD', '1.0.1');
  for (const type of ['CH', 'EP', 'SC', 'SHOT', 'PROMPT']) assert.ok(result.review_items.some(item => item.asset_id === `IP900-${type}-001` && item.dependency_id === 'IP900-WORLD-001'), `${type} 应收到复核提示`);
  assert.ok(result.review_items.find(item => item.asset_id === 'IP900-PROMPT-001').via.length > 0);
  assert.equal(json(path.join(project, '.ip-system/snapshots/IP900-CH-001/1.0.0/asset.json')).refs[0].version, '1.0.0');
});

test('未曾采用的上游不能成为采用基准，未采用工作资产不导出', t => {
  const { project } = fixture(t); bridge(project);
  createAsset(project, 'PROP', { name: '未经采用道具' }); save(project, 'PROP');
  createAsset(project, 'CHAR', { name: '仅为草稿的角色' }, { refs: [ref('PROP')] }); save(project, 'CHAR');
  assert.throws(() => adopt(project, 'CHAR'), /依赖版本从未采用/);
  const exported = exportProject({ project, out: '07_发布资产/排除草稿' });
  assert.equal(json(path.join(exported.output, 'handoff.json')).assets.some(item => item.type === 'PROP' || item.type === 'CHAR'), false);
});

test('重复资产 ID、跨 IP 引用、缺版本和缺失版本均报告具体位置', t => {
  const { project } = fixture(t);
  createAsset(project, 'WORLD', { rules: ['固定规则'] }); save(project, 'WORLD');
  createAsset(project, 'CHAR', { name: '阿青' }, { refs: [{ asset_id: 'IP901-WORLD-001', version: '1.0.0' }] });
  assert.throws(() => save(project, 'CHAR'), /拒绝跨 IP/);
  changeAsset(project, 'CHAR', asset => { asset.refs = [{ asset_id: 'IP900-WORLD-001' }]; });
  assert.throws(() => save(project, 'CHAR'), /asset_id 和 version/);
  changeAsset(project, 'CHAR', asset => { asset.refs = [ref('WORLD', '9.9.9')]; });
  assert.throws(() => save(project, 'CHAR'), /版本不存在/);
  changeProject(project, value => { value.assets.push(structuredClone(value.assets[0])); });
  assert.ok(validateProject({ project }).errors.some(item => /重复 ID/.test(item)));
});

test('路径穿越、绝对路径、嵌套资产和目录外导出被拒绝', t => {
  const { project } = fixture(t);
  createAsset(project, 'WORLD', { rules: ['规则'] }); save(project, 'WORLD');
  assert.throws(() => saveVersion({ project, path: '../外部' }), /路径|目录/);
  assert.throws(() => saveVersion({ project, path: 'C:\\外部' }), /路径|目录/);
  assert.throws(() => exportProject({ project, out: '../外部' }), /导出目录/);
  changeProject(project, value => { value.assets[0].path = '01_世界观资产/../../外部'; });
  assert.equal(validateProject({ project }).ok, false);
});

test('资产目录内外部符号链接/目录联接不会读入快照', t => {
  const { root, project } = fixture(t);
  const external = path.join(root, '外部数据'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'secret.txt'), '不应被收集');
  const { directory } = createAsset(project, 'WORLD', { rules: ['规则'] });
  try { fs.symlinkSync(external, path.join(directory, '外链'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('当前系统不允许建立符号链接测试夹具'); throw error; }
  assert.throws(() => save(project, 'WORLD'), /符号链接|目录联接/);
});

test('章节七文件同时存在、身份版本一致、历史哈希防篡改', t => {
  const { project } = fixture(t);
  const { directory } = createAsset(project, 'CH', { events: [{ event_id: 'E01', story_time: '夜晚', summary: '交药' }] });
  fs.unlinkSync(path.join(directory, '情绪节点.json'));
  assert.throws(() => save(project, 'CH'), /七文件缺失/);
  writeJSON(path.join(directory, '情绪节点.json'), { version: '1.0.1', entries: ['紧张'] });
  assert.throws(() => save(project, 'CH'), /version 与章节版本不一致/);
  writeJSON(path.join(directory, '情绪节点.json'), { version: '1.0.0', entries: ['紧张'] });
  save(project, 'CH'); adopt(project, 'CH');
  const snapshot = path.join(project, '.ip-system/snapshots/IP900-CH-001/1.0.0');
  assert.equal(Object.keys(json(path.join(snapshot, '_snapshot.json')).files).length, 8);
  fs.appendFileSync(path.join(snapshot, '正文.md'), '篡改');
  assert.equal(validateProject({ project }).ok, false);
  assert.throws(() => adopt(project, 'CH'), /校验值不一致/);
});

test('草稿可保存但缺字段不能采用，空桥接不能导出', t => {
  const { project } = fixture(t);
  createAsset(project, 'EP', {}); const saved = save(project, 'EP');
  assert.ok(saved.warnings.length > 0);
  assert.throws(() => adopt(project, 'EP'), /chapter_refs|episode_number/);
  assert.throws(() => exportProject({ project, out: '07_发布资产/缺桥接' }), /缺少已采用/);
});

test('镜头来源事件与场次/剧集归属必须吻合', t => {
  const { project } = fixture(t); bridge(project);
  changeAsset(project, 'SHOT', asset => { asset.version = '1.0.1'; asset.data.source_refs[0].event_id = '不存在'; });
  assert.throws(() => save(project, 'SHOT'), /来源事件/);
  changeAsset(project, 'SC', asset => { asset.version = '1.0.1'; asset.data.location = ref('CH'); });
  save(project, 'SC');
  assert.throws(() => adopt(project, 'SC', '1.0.1'), /location 需要 LOC/);
});

test('写锁阻止并发进程，退出进程留下的锁可恢复', t => {
  const { project } = fixture(t); createAsset(project, 'WORLD', { rule: '规则' });
  const lock = path.join(project, '.ip-system/write.lock');
  writeJSON(lock, { pid: process.pid, host: os.hostname(), token: '本测试持锁', started_at: new Date().toISOString() });
  const blocked = spawnSync(process.execPath, [cli, 'save-version', '--project', project, '--path', '01_世界观资产/WORLD001', '--json'], { encoding: 'utf8' });
  assert.equal(blocked.status, 1); assert.match(blocked.stdout, /正被进程/);
  const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  writeJSON(lock, { pid: Number(exited.stdout.trim()), host: os.hostname(), token: '已退出进程', started_at: new Date().toISOString() });
  assert.equal(save(project, 'WORLD').ok, true); assert.equal(fs.existsSync(lock), false);
});

function prepareInterrupted(project, phase) {
  const registry = json(path.join(project, 'project.json'));
  const pendingRegistry = structuredClone(registry); pendingRegistry.recovery_test_marker = phase;
  const stagedRelative = '.ip-system/transactions/interruption/export';
  const staged = path.join(project, stagedRelative); fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, '交接说明.md'), '真实测试夹具：已写完但提交中断');
  const bytes = fs.readFileSync(path.join(staged, '交接说明.md'));
  const pending = { schema_version: 1, action: 'export', registry_before_sha256: hash(fs.readFileSync(path.join(project, 'project.json'))), registry_after: pendingRegistry, moves: [{ kind: 'export', staged: stagedRelative, target: '07_发布资产/中断恢复包', files: { '交接说明.md': { sha256: hash(bytes), size: bytes.length } } }] };
  writeJSON(path.join(project, '.ip-system/pending.json'), pending);
  if (phase === 'after-rename' || phase === 'after-registry') fs.renameSync(staged, path.join(project, '07_发布资产/中断恢复包'));
  if (phase === 'after-registry') writeJSON(path.join(project, 'project.json'), pendingRegistry);
  return { staged, pending };
}

for (const phase of ['before-rename', 'after-rename', 'after-registry']) {
  test(`中断事务恢复：${phase}，下次写入继续完整提交`, t => {
    const { project } = fixture(t); createAsset(project, 'WORLD', { rule: '规则' }); save(project, 'WORLD');
    prepareInterrupted(project, phase);
    assert.ok(validateProject({ project }).warnings.some(item => /待恢复事务/.test(item)));
    const result = adopt(project, 'WORLD');
    assert.equal(result.recovered_transaction.action, 'export');
    assert.equal(json(path.join(project, 'project.json')).recovery_test_marker, phase);
    assert.equal(fs.existsSync(path.join(project, '07_发布资产/中断恢复包/交接说明.md')), true);
    assert.equal(fs.existsSync(path.join(project, '.ip-system/pending.json')), false);
  });
}

test('中断文件损坏或外部编辑项目时拒绝恢复并保留证据', t => {
  const { project } = fixture(t); createAsset(project, 'WORLD', { rule: '规则' }); save(project, 'WORLD');
  const { staged } = prepareInterrupted(project, 'before-rename');
  fs.appendFileSync(path.join(staged, '交接说明.md'), '损坏');
  assert.throws(() => adopt(project, 'WORLD'), /校验值不一致/);
  assert.equal(fs.existsSync(path.join(project, '.ip-system/pending.json')), true);
  changeProject(project, value => { value.name = '外部编辑'; });
  assert.throws(() => adopt(project, 'WORLD'), /外部修改/);
});

test('重新打开进程续作与机器可读 CLI 退出码', t => {
  const { project } = fixture(t);
  createAsset(project, 'WORLD', { rule: '跨进程可恢复数据' });
  const saved = spawnSync(process.execPath, [cli, 'save-version', '--project', project, '--path', '01_世界观资产/WORLD001', '--json'], { encoding: 'utf8' });
  assert.equal(saved.status, 0, saved.stderr); assert.equal(JSON.parse(saved.stdout).version, '1.0.0');
  const adopted = spawnSync(process.execPath, [cli, 'adopt', '--project', project, '--asset', 'IP900-WORLD-001', '--version', '1.0.0', '--reason', '重新打开后审核采用', '--json'], { encoding: 'utf8' });
  assert.equal(adopted.status, 0, adopted.stderr);
  const checked = spawnSync(process.execPath, [cli, 'validate', '--project', project, '--strict', '--json'], { encoding: 'utf8' });
  assert.equal(checked.status, 0); assert.equal(JSON.parse(checked.stdout).stats.adopted, 1);
  const error = spawnSync(process.execPath, [cli, 'validate', '--project', project, '--typo', 'yes'], { encoding: 'utf8' });
  assert.equal(error.status, 1); assert.match(error.stderr, /不接受参数/);
});

test('章节 JSON 只有身份字段或空 entries 不能冒充完整内容', t => {
  const { project } = fixture(t);
  const { directory } = createAsset(project, 'CH', { events: [{ event_id: 'E01', story_time: '夜晚', summary: '交药' }] });
  writeJSON(path.join(directory, '摘要.json'), { schema_version: 1, project_id: 'IP900', asset_id: 'IP900-CH-001', version: '1.0.0', entries: [] });
  const result = save(project, 'CH'); assert.ok(result.warnings.some(item => /身份字段不能代替内容/.test(item)));
  assert.throws(() => adopt(project, 'CH'), /摘要.json 内容待补全/);
});

test('明确 refs 列表中的字符串或缺 asset_id 对象不能被静默忽略', t => {
  const { project } = fixture(t);
  createAsset(project, 'WORLD', { rules: ['规则'] }, { refs: ['IP999-WORLD-999@1.0.0', { wrong_key: 'IP999-WORLD-999', version: '1.0.0' }] });
  assert.throws(() => save(project, 'WORLD'), /正式引用需要有效/);
  changeAsset(project, 'WORLD', asset => { asset.refs = []; asset.data.character_refs = ['IP900-CHAR-001']; });
  assert.throws(() => save(project, 'WORLD'), /character_refs\[0\]/);
});

test('旧提示词依赖历史镜头：完整复制历史但不重复占用播放编号/时间', t => {
  const { project } = fixture(t); bridge(project);
  changeAsset(project, 'SHOT', asset => { asset.version = '1.0.1'; asset.data.emotion = '修订后的克制表情'; });
  save(project, 'SHOT'); adopt(project, 'SHOT', '1.0.1');
  const result = exportProject({ project, out: '07_发布资产/镜头新版与历史提示词' });
  const handoff = json(path.join(result.output, 'handoff.json'));
  assert.equal(handoff.assets.filter(item => item.type === 'SHOT').length, 2);
  assert.deepEqual(handoff.playback.shots, [{ asset_id: 'IP900-SHOT-001', version: '1.0.1' }]);
  const markdown = fs.readFileSync(path.join(result.output, '交接说明.md'), 'utf8');
  assert.equal((markdown.match(/11\. \*\*视频提示词\*\*/g) ?? []).length, 1);
  assert.match(markdown, /图像提示词：托药包的双手定格/); assert.match(markdown, /概述：船夫伸手托住药包/);
});

function secondEpisode(project, { episodeNumber = 2, version = '2.0.0', withShot = true } = {}) {
  const epRef = { asset_id: 'IP900-EP-002', version };
  const sceneRef = { asset_id: 'IP900-SC-002', version: '1.0.0' };
  createAsset(project, 'EP', { episode_number: episodeNumber, chapter_refs: [ref('CH')] }, { number: '002', version }); save(project, 'EP', '002'); adopt(project, 'EP', version, '002');
  createAsset(project, 'SC', { scene_number: 1, episode: epRef, location: ref('LOC'), source_refs: [event()] }, { number: '002' }); save(project, 'SC', '002'); adopt(project, 'SC', '1.0.0', '002');
  if (withShot) {
    const base = json(path.join(assetPath(project, 'SHOT'), 'asset.json')).data;
    createAsset(project, 'SHOT', { ...base, episode: epRef, scene: sceneRef, start_seconds: 0 }, { number: '002' }); save(project, 'SHOT', '002'); adopt(project, 'SHOT', '1.0.0', '002');
  }
}

test('不同 EP 的重复集号不能用不同版本绕过，各集独立时间轴可从零开始', t => {
  const { project } = fixture(t); bridge(project); secondEpisode(project, { episodeNumber: 1 });
  assert.throws(() => exportProject({ project, out: '07_发布资产/重复集号' }), /编号重复：EP:1/);
});

test('第二集完整桥接独立排时成功，新的场次缺镜头则明确拒绝', t => {
  const { project } = fixture(t); bridge(project); secondEpisode(project);
  const result = exportProject({ project, out: '07_发布资产/两集' });
  assert.equal(result.playback.episodes.length, 2);
  createAsset(project, 'SC', { scene_number: 2, episode: ref('EP'), location: ref('LOC'), source_refs: [event()] }, { number: '003' }); save(project, 'SC', '003'); adopt(project, 'SC', '1.0.0', '003');
  assert.throws(() => exportProject({ project, out: '07_发布资产/新场缺镜' }), /该场次尚无已采用 SHOT/);
});

test('同 ID 剧集新版不强制追新，历史完整链允许导出并明确未覆盖范围', t => {
  const { project } = fixture(t); bridge(project);
  changeAsset(project, 'EP', asset => { asset.version = '1.0.1'; asset.title = '待重新桥接的新集标题'; }); save(project, 'EP'); adopt(project, 'EP', '1.0.1');
  const result = exportProject({ project, out: '07_发布资产/旧集完整链' });
  assert.deepEqual(result.playback.episodes, [{ asset_id: 'IP900-EP-001', version: '1.0.0' }]);
  assert.ok(result.playback.uncovered_adopted_versions.some(item => item.asset_id === 'IP900-EP-001' && item.version === '1.0.1'));
  assert.match(fs.readFileSync(path.join(result.output, '交接说明.md'), 'utf8'), /不能据此宣称全项目最新版漫改完成/);
});

test('已有第一集不能掩盖全新第二集缺镜头', t => {
  const { project } = fixture(t); bridge(project); secondEpisode(project, { withShot: false });
  assert.throws(() => exportProject({ project, out: '07_发布资产/第二集缺镜' }), /该剧集尚无完整|该场次尚无已采用/);
});

test('保存修订依据同时记录到快照和真实操作日志', t => {
  const { project } = fixture(t); createAsset(project, 'WORLD', { rule: '修订规则' });
  const result = saveVersion({ project, path: '01_世界观资产/WORLD001', reason: '修正先后顺序，保留单一药包' });
  assert.equal(result.ok, true);
  assert.equal(json(path.join(project, '.ip-system/snapshots/IP900-WORLD-001/1.0.0/_snapshot.json')).reason, '修正先后顺序，保留单一药包');
  assert.equal(json(path.join(project, 'project.json')).operations.at(-1).reason, '修正先后顺序，保留单一药包');
});

test('保存过程中外部编辑项目清单时拒绝丢失更新', t => {
  const { project } = fixture(t); createAsset(project, 'WORLD', { rule: '规则' });
  const originalOpen = fs.openSync; let edited = false;
  fs.openSync = function (filename, ...args) {
    if (!edited && String(filename).endsWith('_snapshot.json')) { edited = true; changeProject(project, value => { value.name = '用户并行修改的项目名'; }); }
    return originalOpen.call(fs, filename, ...args);
  };
  try { assert.throws(() => save(project, 'WORLD'), /操作开始后 project.json 被外部修改/); }
  finally { fs.openSync = originalOpen; }
  const registry = json(path.join(project, 'project.json'));
  assert.equal(registry.name, '用户并行修改的项目名'); assert.equal(registry.assets.length, 0);
});

test('两个进程同时恢复旧锁时只有一个可解除，重试后两份登记均保留', async t => {
  const { root, project } = fixture(t);
  createAsset(project, 'WORLD', { rule: '规则' }); createAsset(project, 'CHAR', { name: '阿青' });
  const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  writeJSON(path.join(project, '.ip-system/write.lock'), { pid: Number(exited.stdout.trim()), host: os.hostname(), token: '共同看见的旧锁', started_at: new Date().toISOString() });
  const marker = path.join(root, 'A即将解除旧锁'); const release = path.join(root, '允许A继续'); const childFile = path.join(root, '锁竞争子进程.mjs');
  fs.writeFileSync(childFile, `import fs from 'node:fs';\nimport { saveVersion } from ${JSON.stringify(new URL('../src/project-service.mjs', import.meta.url).href)};\nconst original=fs.unlinkSync; let paused=false;\nfs.unlinkSync=function(filename,...args){ if(!paused && String(filename).endsWith('write.lock')){ paused=true; fs.writeFileSync(${JSON.stringify(marker)},'ready'); const sleep=new Int32Array(new SharedArrayBuffer(4)); const deadline=Date.now()+10000; while(!fs.existsSync(${JSON.stringify(release)})){ if(Date.now()>deadline)throw new Error('barrier timed out'); Atomics.wait(sleep,0,0,5); } } return original.call(fs,filename,...args); };\ntry { console.log(JSON.stringify(saveVersion({project:${JSON.stringify(project)},path:'01_世界观资产/WORLD001'}))); } catch(error) { console.error(error.message); process.exitCode=1; }\n`);
  const child = spawn(process.execPath, [childFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.on('close', resolve));
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(marker), true, 'A 应到达可重复竞争时序');
  const other = spawnSync(process.execPath, [cli, 'save-version', '--project', project, '--path', '02_人物资产/CHAR001', '--json'], { encoding: 'utf8' });
  fs.writeFileSync(release, 'go');
  assert.equal(await closed, 0, stderr);
  assert.equal(other.status, 1); assert.match(other.stdout, /恢复操作取得独占权/);
  assert.equal(save(project, 'CHAR').ok, true);
  assert.equal(json(path.join(project, 'project.json')).assets.length, 2);
});

test('中文菜单可退出', () => {
  const menu = spawnSync(process.execPath, [cli], { input: '0\n', encoding: 'utf8' });
  assert.equal(menu.status, 0, menu.stderr); assert.match(menu.stdout, /原创 IP 生产工具/);
});
