import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject, newAsset, saveVersion, adoptVersion, validateProject, projectStatus, resumeProject, recordReview, reviewItem, exportProject, CHAPTER_FILES, TYPES } from '../src/project-service.mjs';

const cli = fileURLToPath(new URL('../bin/studio.mjs', import.meta.url));
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
const id = (type, n = 1) => `IP800-${type}-${String(n).padStart(3, '0')}`;
const ref = (type, n = 1, version = '1.0.0') => ({ asset_id: id(type, n), version });
const ev = n => ({ ...ref('CH', n), event_id: 'E01' });
let reviewCounter = 0;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'IP_开工 缺陷回归_'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project: initProject({ root, id: 'IP800', name: '续作测试' }).project };
}
function entry(project, assetId) { return json(path.join(project, 'project.json')).assets.find(item => item.asset_id === assetId); }
function work(project, assetId) { return path.join(project, entry(project, assetId).path); }
function edit(project, assetId, action) { const filename = path.join(work(project, assetId), 'asset.json'); const asset = json(filename); action(asset); write(filename, asset); }
function draft(project, type, data, { n = 1, refs = [] } = {}) {
  const created = newAsset({ project, type, title: `${type}${n} 测试`, sequence: n });
  edit(project, created.asset_id, asset => { asset.data = data; asset.refs = refs; });
  if (type === 'CH') {
    fs.writeFileSync(path.join(work(project, created.asset_id), '正文.md'), `# 第${n}章\n守灯人在天亮前记录信号，并将钥匙交还。`);
    for (const name of CHAPTER_FILES.slice(1)) write(path.join(work(project, created.asset_id), name), { schema_version: 1, project_id: 'IP800', chapter_id: created.asset_id, version: '1.0.0', entries: name === '新增设定.json' ? [] : ['具体测试情节'] });
  }
  return created.asset_id;
}
function saveAdopt(project, assetId) {
  saveVersion({ project, asset: assetId });
  return adoptVersion({ project, asset: assetId, version: json(path.join(work(project, assetId), 'asset.json')).version, reason: '测试采用，非实际创作批准' });
}
function base(project) {
  saveAdopt(project, draft(project, 'WORLD', { rules: ['同一把钥匙不能同时由两人持有'] }));
  saveAdopt(project, draft(project, 'LOC', { description: '石塔灯室' }));
}
function chapter(project, n) { return draft(project, 'CH', { events: [{ event_id: 'E01', story_time: `第${n}夜`, summary: '交还钥匙' }] }, { n, refs: [ref('WORLD')] }); }
function episode(project, n, shotExtras = {}) {
  saveAdopt(project, chapter(project, n));
  saveAdopt(project, draft(project, 'EP', { episode_number: n, chapter_refs: [ref('CH', n)] }, { n }));
  saveAdopt(project, draft(project, 'SC', { scene_number: 1, episode: ref('EP', n), location: ref('LOC'), source_refs: [ev(n)], script: '守灯人交还钥匙，对方接稳后松手。' }, { n }));
  saveAdopt(project, draft(project, 'SHOT', { episode: ref('EP', n), scene: ref('SC', n), source_refs: [ev(n)], shot_number: 1, start_seconds: 0, duration_seconds: 8, story_time: `第${n}夜`, scene_description: '石塔灯室', characters: '守灯人与来客', action: '对方接稳钥匙，守灯人才松手', emotion: '释然', dialogue: '无', shot_size: '双手近景', camera_movement: '固定', lighting: '灯火暖光', video_prompt: '灯室暖光下，来客接稳钥匙后守灯人才松手，固定双手近景。', visual_description: '同一把钥匙交接全程可见', ...shotExtras }, { n }));
  saveAdopt(project, draft(project, 'PROMPT', { shot: ref('SHOT', n), image_prompt: '双手与一把钥匙', video_prompt: '连续交接动作', negative_prompt: '避免重复钥匙', optimization: '手部动作在画' }, { n }));
}
function review(project, assetId, { version = '1.0.0', ...overrides } = {}) {
  const filename = `00_项目管理/审核输入${++reviewCounter}.json`;
  write(path.join(project, filename), { method: 'ai', reviewer: '测试 AI', scope: '全文、七文件及采用世界规则', coverage: 'full', result: 'pass', issues: [], evidence: '测试夹具内容已对照，不代表用户人工审核', ...overrides });
  return recordReview({ project, asset: assetId, version, file: filename });
}
function referenceFixture(t, files = [{ path: '素材/Key #1.png', kind: 'image', usage_id: 'K0' }]) {
  const { project } = fixture(t); base(project); episode(project, 1);
  const media = draft(project, 'MEDIA', { files, source_refs: [ref('PROMPT')] });
  for (const file of files) {
    const filename = path.join(work(project, media), file.path.replaceAll('\\', '/'));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, Buffer.from('测试媒体字节，不代表图片内容验收'));
  }
  fs.writeFileSync(path.join(work(project, media), '未登记附件.png'), '存在于快照，但没有登记为媒体');
  saveAdopt(project, media);
  const binding = { media: ref('MEDIA'), file_path: files[0].path, expected_usage_id: 'K0' };
  const prompt = draft(project, 'PROMPT', { shot: ref('SHOT'), image_prompt: '接触前单把钥匙仍由守灯人持有', negative_prompt: '无额外项', reference_bindings: [binding] }, { n: 2 });
  return { project, media, prompt, binding };
}
// Simulate an intact record authored before binding validation, only inside a temporary test project.
function legacySnapshot(project, assetId, version, change) {
  const registryFile = path.join(project, 'project.json'); const registry = json(registryFile);
  const saved = registry.assets.find(item => item.asset_id === assetId).versions.find(item => item.version === version);
  const directory = path.join(project, saved.path); const assetFile = path.join(directory, 'asset.json');
  const asset = json(assetFile); change(asset); write(assetFile, asset);
  const manifestFile = path.join(directory, '_snapshot.json'); const manifest = json(manifestFile); const bytes = fs.readFileSync(assetFile);
  manifest.files['asset.json'] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }; write(manifestFile, manifest);
  saved.manifest_sha256 = createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex');
  for (const record of [...(registry.adoption_history ?? []), ...(registry.operations ?? [])]) if (record.asset_id === assetId && record.version === version && Object.hasOwn(record, 'manifest_sha256')) record.manifest_sha256 = saved.manifest_sha256;
  write(registryFile, registry);
}

test('十三类菜单骨架均登记工作稿，不生成采用或虚构内容', t => {
  const { project } = fixture(t);
  for (const type of TYPES) {
    const made = newAsset({ project, type, title: `${type} 空白骨架` });
    assert.equal(entry(project, made.asset_id).adopted_version, null);
    assert.equal(entry(project, made.asset_id).versions.length, 0);
    const saved = saveVersion({ project, asset: made.asset_id }); assert.ok(saved.warnings.length > 0);
    assert.throws(() => adoptVersion({ project, asset: made.asset_id, version: '1.0.0', reason: '不能采用空白骨架' }), /待补全|需要/);
  }
  assert.equal(newAsset({ project, type: 'CH', title: '下一章' }).asset_id, 'IP800-CH-002');
  assert.throws(() => newAsset({ project, type: 'CH', title: '覆盖', sequence: 1 }), /拒绝覆盖/);
});

test('初始化章节模板保持未登记，填入实际内容后可保存、审核采用及续作', t => {
  const { project } = fixture(t);
  const template = path.join(project, '00_项目管理', '空白模板');
  const original = fs.readFileSync(path.join(template, 'asset.json'));
  assert.equal(json(path.join(project, 'project.json')).assets.length, 0);
  for (const filename of CHAPTER_FILES.slice(1)) {
    const content = json(path.join(template, filename));
    assert.equal(content.project_id, 'IP800');
    assert.equal(content.chapter_id, id('CH'));
    assert.equal(content.version, '1.0.0');
  }
  const relative = '03_小说资产/从模板填写的首章';
  const directory = path.join(project, relative);
  fs.cpSync(template, directory, { recursive: true, errorOnExist: true, force: false });
  const asset = json(path.join(directory, 'asset.json'));
  asset.title = '交还钥匙';
  asset.data = { chapter_number: 1, events: [{ event_id: 'E01', story_time: '第一夜', summary: '守灯人将钥匙交还来客' }], entry_state: '守灯人持钥匙', exit_state: '来客持钥匙' };
  write(path.join(directory, 'asset.json'), asset);
  fs.writeFileSync(path.join(directory, '正文.md'), '# 第一章\n来客接稳钥匙，守灯人才松开手。\n');
  const details = {
    '摘要.json': { summary: '守灯人交还钥匙', events: asset.data.events, continuation_notes: [] },
    '出场人物.json': { entries: ['守灯人', '来客'] },
    '场景.json': { entries: ['石塔灯室'] },
    '情绪节点.json': { entries: ['确认接稳后释然'] },
    '新增设定.json': { candidates: [] },
    '漫改建议.json': { suggestions: ['近景呈现接稳后才松手'] },
  };
  for (const [filename, content] of Object.entries(details)) write(path.join(directory, filename), { ...json(path.join(directory, filename)), ...content });
  assert.equal(saveVersion({ project, path: relative }).ok, true);
  assert.equal(entry(project, id('CH')).adopted_version, null);
  const reviewed = review(project, id('CH'));
  adoptVersion({ project, asset: id('CH'), version: '1.0.0', reason: '采用测试模板填写的章节', review: reviewed.review_id });
  const report = validateProject({ project, strict: true });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.warnings, []);
  const resumed = resumeProject({ project, out: '00_项目管理/模板续作' });
  assert.equal(json(path.join(resumed.output, '续作信息.json')).reading_list[0].chapter_files.length, 7);
  assert.deepEqual(fs.readFileSync(path.join(template, 'asset.json')), original);
});

test('章配套 chapter_id 与 asset_id 双身份均须匹配，版本也须同步', t => {
  const { project } = fixture(t); base(project); const assetId = chapter(project, 1);
  const filename = path.join(work(project, assetId), '摘要.json'); const sidecar = json(filename);
  sidecar.chapter_id = id('CH', 999); write(filename, sidecar);
  assert.throws(() => saveVersion({ project, asset: assetId }), /chapter_id 与章节 asset_id 不一致/);
  sidecar.chapter_id = assetId; sidecar.asset_id = id('CH', 2); write(filename, sidecar);
  assert.throws(() => saveVersion({ project, asset: assetId }), /asset_id 与章节版本不一致/);
  sidecar.asset_id = assetId; sidecar.version = '9.0.0'; write(filename, sidecar);
  assert.throws(() => saveVersion({ project, asset: assetId }), /version 与章节版本不一致/);
  sidecar.version = '1.0.0'; write(filename, sidecar); saveAdopt(project, assetId);
  assert.equal(validateProject({ project, strict: true }).ok, true);
});

test('MEDIA旧file_path声明不能冒充文件，空文件清单仅能存草稿', t => {
  const { project } = fixture(t);
  const assetId = draft(project, 'MEDIA', { file_path: '../../虚构.png', status: '已生成' });
  assert.ok(saveVersion({ project, asset: assetId }).warnings.some(message => message.includes('MEDIA.data.files')));
  assert.throws(() => adoptVersion({ project, asset: assetId, version: '1.0.0', reason: '仅声明文件不够' }), /MEDIA.data.files/);
});

test('MEDIA拒绝越界、绝对路径、不存在文件、目录、元数据和重复文件', t => {
  const { project } = fixture(t); const assetId = draft(project, 'MEDIA', { files: [] });
  const directory = work(project, assetId); fs.mkdirSync(path.join(directory, '素材')); fs.writeFileSync(path.join(directory, '测试.bin'), 'fixture');
  for (const value of ['../不存在.bin', 'C:\\外部.bin', '/outside.bin', '不存在.bin', '素材', 'asset.json', '_snapshot.json']) {
    edit(project, assetId, asset => { asset.data.files = [{ path: value, kind: 'other' }]; });
    assert.throws(() => saveVersion({ project, asset: assetId }), /data.files\[0\]/, value);
  }
  edit(project, assetId, asset => { asset.data.files = [{ path: '测试.bin', kind: 'other' }, { path: '测试.bin', kind: 'other' }]; });
  assert.throws(() => saveVersion({ project, asset: assetId }), /重复/);
});

test('MEDIA外部目录联接与文件链接拒绝；合法二进制按快照哈希打包', t => {
  const { root, project } = fixture(t); base(project); episode(project, 1);
  const assetId = draft(project, 'MEDIA', { files: [{ path: 'link/fixture.bin', kind: 'other' }], source_refs: [ref('SHOT')] });
  const external = path.join(root, '外部'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'fixture.bin'), 'outside');
  const directory = work(project, assetId);
  try { fs.symlinkSync(external, path.join(directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('系统不允许建立链接夹具'); throw error; }
  assert.throws(() => saveVersion({ project, asset: assetId }), /符号链接|目录联接/);
  fs.unlinkSync(path.join(directory, 'link'));
  const binary = Buffer.from([0, 255, 1, 254, 10, 0]);
  const binaryPath = '素材/fixture.bin';
  fs.mkdirSync(path.join(directory, '素材'));
  fs.writeFileSync(path.join(directory, binaryPath), binary);
  edit(project, assetId, asset => { asset.data.files = [{ path: binaryPath, kind: 'other' }]; }); saveAdopt(project, assetId);
  fs.writeFileSync(path.join(directory, binaryPath), '未采用的替换工作稿');
  const exported = exportProject({ project, out: '07_发布资产/媒体冻结', episodes: id('EP') });
  const resumed = resumeProject({ project, out: '00_项目管理/媒体续作' });
  const packages = [[exported.output, 'handoff.json'], [resumed.output, '续作信息.json']];
  for (const [output, index] of packages) {
    const assets = json(path.join(output, index)).assets;
    assert.equal(assets.length, 8);
    for (const used of assets) {
      const saved = entry(project, used.asset_id).versions.find(item => item.version === used.version);
      assert.equal(used.manifest_sha256, saved.manifest_sha256);
      const manifestFile = path.join(output, used.path, '_snapshot.json');
      assert.equal(createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex'), saved.manifest_sha256);
      for (const [filename, expected] of Object.entries(json(manifestFile).files)) {
        const bytes = fs.readFileSync(path.join(output, used.path, filename));
        assert.equal(bytes.length, expected.size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
      }
    }
    assert.deepEqual(fs.readFileSync(path.join(output, `assets/${assetId}/1.0.0/${binaryPath}`)), binary);
  }
});

test('精确审核绑定与采用门禁：AI不冒充人工，局部/修订/不同版本均拒绝', t => {
  const { project } = fixture(t); base(project); const assetId = chapter(project, 1); saveVersion({ project, asset: assetId });
  const partial = review(project, assetId, { coverage: 'partial' });
  assert.throws(() => adoptVersion({ project, asset: assetId, version: '1.0.0', reason: '局部不能当全文', review: partial.review_id }), /完整|full|局部/);
  const full = review(project, assetId); assert.equal(full.method, 'ai');
  const result = adoptVersion({ project, asset: assetId, version: '1.0.0', reason: '完整AI审核之后采用', review: full.review_id }); assert.deepEqual(result.warnings, []);
  const registry = json(path.join(project, 'project.json')); assert.equal(registry.adoption_history.at(-1).review_id, full.review_id);
  const stored = json(path.join(project, registry.content_reviews.at(-1).path)); assert.equal(stored.method, 'ai'); assert.equal(Object.hasOwn(stored, 'reviewed_at'), false);
  review(project, assetId, { result: 'revise', issues: [{ id: 'I1', severity: 'blocker', status: 'open', description: '新增问题', evidence: '此处仅是测试门禁的实际夹具' }] });
  assert.throws(() => adoptVersion({ project, asset: assetId, version: '1.0.0', reason: '不能绕过较新问题', review: full.review_id }), /通过|pass|阻塞|待处理/);
  const final = review(project, assetId);
  edit(project, assetId, asset => { asset.version = '1.0.1'; });
  for (const file of CHAPTER_FILES.slice(1)) { const filename = path.join(work(project, assetId), file); const sidecar = json(filename); sidecar.version = '1.0.1'; write(filename, sidecar); }
  saveVersion({ project, asset: assetId });
  assert.throws(() => adoptVersion({ project, asset: assetId, version: '1.0.1', reason: '旧审核不可复用', review: final.review_id }), /版本|身份|一致|匹配/);
});

test('审核输入不可伪造目标身份，冻结审核记录改动会被发现', t => {
  const { project } = fixture(t); base(project); const assetId = chapter(project, 1); saveAdopt(project, assetId);
  assert.throws(() => review(project, assetId, { asset_id: id('CH', 2) }), /一致/);
  assert.throws(() => review(project, assetId, { method: undefined }), /method/);
  const recorded = review(project, assetId); const index = json(path.join(project, 'project.json')).content_reviews.find(item => item.review_id === recorded.review_id);
  fs.appendFileSync(path.join(project, index.path), ' ');
  assert.ok(validateProject({ project }).errors.some(error => /审核记录.*校验值不一致/.test(error)));
  assert.throws(() => adoptVersion({ project, asset: assetId, version: '1.0.0', reason: '检查损坏', review: recorded.review_id }), /校验值不一致/);
});

test('按集交付不受未来小说阻挡，跨章REPORT仅扩展来源不扩展播放树', t => {
  const { project } = fixture(t); base(project); episode(project, 1); episode(project, 2); saveAdopt(project, chapter(project, 3));
  saveAdopt(project, draft(project, 'REPORT', { summary: '第一集审核也参考未来第三章的承接' }, { refs: [ref('CH'), ref('CH', 3)] }));
  saveAdopt(project, draft(project, 'REPORT', { summary: '跨两个制作集的镜头报告' }, { n: 2, refs: [ref('SHOT'), ref('SHOT', 2)] }));
  review(project, id('CH'));
  const result = exportProject({ project, out: '07_发布资产/仅第一集', episodes: id('EP'), requireReview: true });
  const handoff = json(path.join(result.output, 'handoff.json'));
  assert.deepEqual(handoff.playback.episodes, [ref('EP')]); assert.deepEqual(handoff.playback.shots, [ref('SHOT')]);
  assert.ok(handoff.assets.some(asset => asset.asset_id === id('REPORT')));
  assert.ok(handoff.assets.some(asset => asset.asset_id === id('CH', 3)));
  for (const type of ['EP', 'SC', 'SHOT', 'PROMPT']) assert.equal(handoff.assets.some(asset => asset.asset_id === id(type, 2)), false, `${type} 第二集不能串包`);
  assert.equal(handoff.assets.some(asset => asset.asset_id === id('REPORT', 2)), false);
  assert.ok(result.warnings.some(warning => /范围外/.test(warning)));
  assert.throws(() => exportProject({ project, out: '07_发布资产/默认整包仍严格' }), /该章节尚无完整/);
  assert.deepEqual(exportProject({ project, out: '07_发布资产/按章节选择', chapters: id('CH'), requireReview: true }).playback.episodes, [ref('EP')]);
  assert.throws(() => exportProject({ project, out: '07_发布资产/互斥', episodes: id('EP'), chapters: id('CH') }), /不能同时/);
});

test('范围内真实缺镜仍阻止交付，严格门禁只针对选中播放章节', t => {
  const { project } = fixture(t); base(project); episode(project, 1); episode(project, 2);
  assert.throws(() => exportProject({ project, out: '07_发布资产/未审核', episodes: id('EP'), requireReview: true }), /缺少.*审核/);
  review(project, id('CH'));
  assert.equal(exportProject({ project, out: '07_发布资产/仅第一集已审核', episodes: id('EP'), requireReview: true }).ok, true);
  assert.throws(() => exportProject({ project, out: '07_发布资产/两集需都审核', episodes: `${id('EP')},${id('EP', 2)}`, requireReview: true }), /IP800-CH-002/);
  saveAdopt(project, draft(project, 'SC', { scene_number: 2, episode: ref('EP'), location: ref('LOC'), source_refs: [ev(1)] }, { n: 3 }));
  assert.throws(() => exportProject({ project, out: '07_发布资产/本集漏镜', episodes: id('EP'), requireReview: true }), /该场次尚无已采用/);
});

test('中文交接保留十一项且完整展开嵌套镜头扩展，PROMPT展开保持兼容', t => {
  const { project } = fixture(t); base(project);
  const extensions = {
    photography: { view: '双手侧面', observation_side: '石窗一侧', focus: { target: '两手接触处', change: '保持焦点' }, movement: '固定摄影机', rhythm: '接稳后留一拍' },
    entry_state: { hands: ['守灯人右手持钥匙', '来客右手空握'], support: '双方双脚落地' },
    exit_state: { possession: '来客右手持同一把钥匙', residue: [] },
    duration_basis: '交接与确认动作预计八秒，待生成后实测',
    sound: { voice: '无对白', effects: ['金属轻响'], ambience: '窗外风声' },
    experimental_direction: { amount: 0, enabled: false, empty: {}, undecided: null, phrase: '保留原始扩展值' },
  };
  episode(project, 1, extensions);
  const result = exportProject({ project, out: '07_发布资产/镜头扩展', episodes: id('EP') });
  const handoff = json(path.join(result.output, 'handoff.json'));
  assert.equal(handoff.schema_version, 1);
  const data = handoff.content.find(asset => asset.asset_id === id('SHOT')).data;
  for (const [key, value] of Object.entries(extensions)) assert.deepEqual(data[key], value);
  const markdown = fs.readFileSync(path.join(result.output, '交接说明.md'), 'utf8');
  assert.equal((markdown.match(/^\d+\. \*\*/gm) ?? []).length, 11);
  assert.equal((markdown.match(/^3\. \*\*场景\*\*/gm) ?? []).length, 1);
  assert.match(markdown, /摄影设计：observation_side：石窗一侧/);
  assert.match(markdown, /摄影设计：观察角度：双手侧面/);
  assert.match(markdown, /摄影设计：清晰范围：target：两手接触处/);
  assert.match(markdown, /摄影设计：摄影运动：固定摄影机/);
  assert.match(markdown, /摄影设计：镜内节奏：接稳后留一拍/);
  assert.match(markdown, /起始状态：hands：2\. 来客右手空握/);
  assert.match(markdown, /结束状态：residue：\[\]/);
  assert.match(markdown, /时长依据：交接与确认动作预计八秒/);
  assert.match(markdown, /声音设计：effects：1\. 金属轻响/);
  assert.match(markdown, /experimental_direction：amount：0/);
  assert.match(markdown, /experimental_direction：enabled：false/);
  assert.match(markdown, /experimental_direction：empty：\{\}/);
  assert.match(markdown, /experimental_direction：undecided：null/);
  assert.match(markdown, /experimental_direction：phrase：保留原始扩展值/);
  assert.match(markdown, /- 所属镜头：IP800-SHOT-001@1\.0\.0\n- 图像提示词：双手与一把钥匙\n- 视频提示词：连续交接动作\n- 负面提示词：避免重复钥匙\n- 优化建议：手部动作在画/);
  assert.doesNotMatch(markdown, /- shot_number：|- scene_description：|- start_seconds：/);
});

test('关键帧与MEDIA依赖闭包按集导出，特殊文件名附件链接正确且快照冻结', t => {
  const { project } = fixture(t); base(project); episode(project, 1); episode(project, 2);
  const keyframe = draft(project, 'PROMPT', { shot: ref('SHOT'), frame_purpose: '接触前关键姿态', design_id: 'K0', image_prompt: '来客右手伸向守灯人右手中的单把钥匙，尚未接触。', negative_prompt: '无额外项' }, { n: 3 });
  const attachment = '说明 空间/接触 #[A](正反) 100%.md';
  fs.mkdirSync(path.join(work(project, keyframe), '说明 空间'));
  const frozenDesign = '# 接触设计\nK0 是设计编号，不是实测帧号。\n';
  fs.writeFileSync(path.join(work(project, keyframe), attachment), frozenDesign);
  saveAdopt(project, keyframe);
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const image = draft(project, 'MEDIA', { files: [{ path: '接触 #1.png', kind: 'image' }], source_refs: [ref('PROMPT', 3)] });
  fs.writeFileSync(path.join(work(project, image), '接触 #1.png'), tinyPng); saveAdopt(project, image);
  const bindings = [{ media: ref('MEDIA'), file_path: '接触 #1.png', role: '接触关系参考', allowed: ['持械手与相对位置'], forbidden: ['新增第二把钥匙'] }];
  const videoPrompt = draft(project, 'PROMPT', { shot: ref('SHOT'), video_prompt: '来客接稳钥匙后守灯人才松手，保持单把钥匙。', negative_prompt: '避免重复钥匙', reference_bindings: bindings }, { n: 4 });
  saveAdopt(project, videoPrompt);
  const media = draft(project, 'MEDIA', { files: [{ path: '生成结果夹具.bin', kind: 'other' }], source_refs: [ref('PROMPT', 4)] }, { n: 2 });
  fs.writeFileSync(path.join(work(project, media), '生成结果夹具.bin'), Buffer.from([1, 2, 3])); saveAdopt(project, media);
  const outside = draft(project, 'MEDIA', { files: [{ path: '第二集.png', kind: 'image' }], source_refs: [ref('PROMPT', 2)] }, { n: 3 });
  fs.writeFileSync(path.join(work(project, outside), '第二集.png'), tinyPng); saveAdopt(project, outside);
  saveAdopt(project, draft(project, 'PROMPT', { shot: ref('SHOT'), video_prompt: '用于跨集依赖排除的测试提示词。', negative_prompt: '无额外项', reference_bindings: [{ media: ref('MEDIA', 3), file_path: '第二集.png', role: '跨集测试参考' }] }, { n: 5 }));
  fs.writeFileSync(path.join(work(project, keyframe), attachment), '工作稿已改，禁止混入采用版');
  fs.writeFileSync(path.join(work(project, keyframe), '未采用附件.md'), '禁止从工作目录发现新附件');
  const result = exportProject({ project, out: '07_发布资产/关键帧链交接', episodes: id('EP') });
  const handoff = json(path.join(result.output, 'handoff.json'));
  assert.deepEqual(handoff.playback.episodes, [ref('EP')]); assert.deepEqual(handoff.playback.shots, [ref('SHOT')]);
  for (const assetId of [keyframe, image, videoPrompt, media]) assert.ok(handoff.assets.some(asset => asset.asset_id === assetId), assetId);
  for (const assetId of [id('EP', 2), id('SHOT', 2), id('PROMPT', 2), outside, id('PROMPT', 5)]) assert.equal(handoff.assets.some(asset => asset.asset_id === assetId), false, assetId);
  assert.ok(result.warnings.some(warning => warning.includes(`${id('PROMPT', 5)}@1.0.0`) && /范围外/.test(warning)));
  assert.deepEqual(handoff.content.find(asset => asset.asset_id === videoPrompt).data.reference_bindings, bindings);
  assert.equal(fs.readFileSync(path.join(result.output, `assets/${keyframe}/1.0.0/${attachment}`), 'utf8'), frozenDesign);
  const markdown = fs.readFileSync(path.join(result.output, '交接说明.md'), 'utf8');
  assert.match(markdown, /## 随包附件与素材/);
  assert.match(markdown, /%20/); assert.match(markdown, /%23/); assert.match(markdown, /%28/); assert.match(markdown, /%25/);
  assert.doesNotMatch(markdown, /未采用附件/);
  const targets = [...markdown.matchAll(/(?<!\\)\]\(([^)\n]+)\)/g)].map(match => decodeURIComponent(match[1]));
  assert.ok(targets.includes(`assets/${keyframe}/1.0.0/${attachment}`));
  for (const target of targets) assert.equal(fs.statSync(path.join(result.output, target)).isFile(), true, target);
  const exportedImage = handoff.assets.find(asset => asset.asset_id === image);
  const manifest = json(path.join(result.output, exportedImage.path, '_snapshot.json'));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(result.output, exportedImage.path, '接触 #1.png'))).digest('hex'), manifest.files['接触 #1.png'].sha256);
});

test('未增加关键帧字段的旧资产可继续保存采用导出，不产生空扩展栏目', t => {
  const { project } = fixture(t); base(project); episode(project, 1);
  assert.equal(validateProject({ project, strict: true }).ok, true);
  const result = exportProject({ project, out: '07_发布资产/旧格式兼容', episodes: id('EP') });
  const handoff = json(path.join(result.output, 'handoff.json'));
  assert.equal(handoff.schema_version, 1);
  const prompt = handoff.content.find(asset => asset.asset_id === id('PROMPT'));
  assert.equal(Object.hasOwn(prompt.data, 'reference_bindings'), false);
  assert.equal(Object.hasOwn(prompt.data, 'frame_purpose'), false);
  const markdown = fs.readFileSync(path.join(result.output, '交接说明.md'), 'utf8');
  assert.doesNotMatch(markdown, /镜头补充设计|随包附件与素材/);
  assert.match(markdown, /11\. \*\*视频提示词\*\*：灯室暖光下/);
  assert.equal(result.warnings.some(warning => /用途匹配/.test(warning)), false);
});

test('已声明参考绑定检查独立于正文内容，结构、路径、类型和未登记文件不能保存', t => {
  const { project, prompt, binding } = referenceFixture(t);
  const invalid = [null, {}, '', [null], [{ ...binding, media: ref('CHAR') }], [{ ...binding, media: { asset_id: id('MEDIA') } }],
    ...['', '../图.png', 'C:/图.png', '/图.png', '素材/../图.png', '素材//图.png', '素材/CON.png', 'asset.json', '素材', '未登记附件.png', '素材/key #1.png'].map(file_path => [{ ...binding, file_path }]),
    [{ ...binding, file_path: 1 }], ...['', ' ', null, 3].map(expected_usage_id => [{ ...binding, expected_usage_id }])];
  for (const reference_bindings of invalid) {
    edit(project, prompt, asset => { asset.data.reference_bindings = reference_bindings; });
    assert.throws(() => saveVersion({ project, asset: prompt }), /reference_bindings|正式引用|版本不存在/);
    assert.equal(validateProject({ project }).ok, false);
  }
  edit(project, prompt, asset => { asset.data = { reference_bindings: {} }; });
  assert.throws(() => saveVersion({ project, asset: prompt }), /reference_bindings 必须为数组/);
});

test('用途匹配读取文件登记值且精确比较，同用途多个候选和斜线转换合法', t => {
  const files = [{ path: '素材/Key #1.png', kind: 'image', usage_id: 'K0' }, { path: '素材/备用.png', kind: 'image', usage_id: 'K0' }, { path: '素材/尾帧.png', kind: 'image', usage_id: 'K1' }];
  const { project, prompt, binding } = referenceFixture(t, files);
  for (const expected_usage_id of ['K1', ' K0', 'K0 ']) {
    edit(project, prompt, asset => { asset.data.reference_bindings = [{ ...binding, expected_usage_id }]; });
    assert.throws(() => saveVersion({ project, asset: prompt }), /expected_usage_id.*不一致/);
  }
  edit(project, prompt, asset => { asset.data.reference_bindings = [{ ...binding, file_path: files[2].path }]; });
  assert.throws(() => saveVersion({ project, asset: prompt }), /expected_usage_id.*不一致/);
  edit(project, prompt, asset => { asset.data.reference_bindings = files.slice(0, 2).map(file => ({ ...binding, file_path: file.path.replaceAll('/', '\\') })); });
  assert.equal(saveVersion({ project, asset: prompt }).warnings.some(warning => /用途匹配/.test(warning)), false);
  assert.equal(adoptVersion({ project, asset: prompt, version: '1.0.0', reason: '两个候选均由人工登记同一设计用途' }).ok, true);
  const exported = exportProject({ project, out: '07_发布资产/同用途候选', episodes: id('EP') });
  const data = json(path.join(exported.output, 'handoff.json')).content.find(asset => asset.asset_id === prompt).data;
  assert.deepEqual(data.reference_bindings.map(item => item.file_path), ['素材\\Key #1.png', '素材\\备用.png']);
});

test('MEDIA用途字段实际校验，未登记用途的文件不能满足expected，绑定空数组保持可用', t => {
  const { project, prompt, binding, media } = referenceFixture(t, [{ path: '素材/Key #1.png', kind: 'image' }]);
  assert.throws(() => saveVersion({ project, asset: prompt }), /expected_usage_id.*非空 usage_id/);
  for (const usage_id of ['', ' ', null, 1, {}]) {
    edit(project, media, asset => { asset.version = '1.1.0'; asset.data.files[0].usage_id = usage_id; });
    assert.throws(() => saveVersion({ project, asset: media }), /usage_id.*非空字符串/);
  }
  edit(project, media, asset => { delete asset.data.files[0].usage_id; });
  saveVersion({ project, asset: media });
  edit(project, prompt, asset => { asset.data.reference_bindings = []; });
  assert.equal(saveVersion({ project, asset: prompt }).warnings.some(warning => /用途匹配/.test(warning)), false);
  assert.equal(adoptVersion({ project, asset: prompt, version: '1.0.0', reason: '无参考输入的独立生图稿' }).ok, true);
  assert.equal(Object.hasOwn(binding, 'expected_usage_id'), true);
});

test('旧绑定仅校验文件且各入口返回未启用用途匹配提示，无绑定PROMPT保持静默', t => {
  const { project, prompt, binding } = referenceFixture(t);
  const old = { media: binding.media, file_path: binding.file_path, role: '旧参考说明' };
  edit(project, prompt, asset => { asset.data.reference_bindings = [old]; });
  assert.ok(saveVersion({ project, asset: prompt }).warnings.some(warning => /未启用用途匹配/.test(warning)));
  assert.ok(adoptVersion({ project, asset: prompt, version: '1.0.0', reason: '兼容旧绑定，仍需制作审核' }).warnings.some(warning => /未启用用途匹配/.test(warning)));
  assert.ok(validateProject({ project, strict: true }).warnings.some(warning => /未启用用途匹配/.test(warning)));
  const exported = exportProject({ project, out: '07_发布资产/旧绑定提示', episodes: id('EP') });
  assert.ok(exported.warnings.some(warning => /未启用用途匹配/.test(warning)));
  assert.ok(json(path.join(exported.output, 'handoff.json')).warnings.some(warning => /未启用用途匹配/.test(warning)));
  assert.match(fs.readFileSync(path.join(exported.output, '交接说明.md'), 'utf8'), /未启用用途匹配/);
  const resumed = resumeProject({ project, out: '00_项目管理/旧绑定提示续作' });
  assert.ok(resumed.warnings.some(warning => /未启用用途匹配/.test(warning)));
  assert.ok(json(path.join(resumed.output, '续作信息.json')).warnings.some(warning => /未启用用途匹配/.test(warning)));
  assert.match(fs.readFileSync(path.join(resumed.output, '续作说明.md'), 'utf8'), /未启用用途匹配/);
});

function shadowedReferenceFixture(t, shape) {
  const result = referenceFixture(t);
  const { project, prompt, binding } = result;
  const hidden = draft(project, 'MEDIA', { files: [{ path: '隐藏参考.png', kind: 'image', usage_id: 'K0' }] }, { n: 2 });
  fs.writeFileSync(path.join(work(project, hidden), '隐藏参考.png'), '实际引用媒体的冻结字节');
  saveVersion({ project, asset: hidden });
  edit(project, prompt, asset => {
    if (shape === 'binding') asset.data.reference_bindings = [{ ...ref('MEDIA'), ...binding, media: ref('MEDIA', 2), file_path: '隐藏参考.png' }];
    if (shape === 'data') { Object.assign(asset.data, ref('MEDIA')); asset.data.reference_bindings = [{ ...binding, media: ref('MEDIA', 2), file_path: '隐藏参考.png' }]; }
    if (shape === 'metadata') asset.data.reference_bindings = [{ ...binding, context: { ...ref('MEDIA'), nested_media: ref('MEDIA', 2) } }];
  });
  return { ...result, hidden };
}

test('引用对象和绑定附带身份字段不能遮蔽未采用的真实嵌套MEDIA', t => {
  for (const shape of ['binding', 'data', 'metadata']) {
    const { project, prompt, hidden } = shadowedReferenceFixture(t, shape);
    assert.equal(saveVersion({ project, asset: prompt }).ok, true);
    assert.equal(entry(project, hidden).adopted_version, null);
    assert.throws(() => adoptVersion({ project, asset: prompt, version: '1.0.0', reason: '嵌套上游必须实际采用' }), new RegExp(`${hidden}@1\\.0\\.0.*依赖版本从未采用`), shape);
  }
});

test('历史已采用绑定也不能遮蔽未采用MEDIA而导出缺失依赖', t => {
  const { project, prompt, binding } = referenceFixture(t); saveAdopt(project, prompt);
  const hidden = draft(project, 'MEDIA', { files: [{ path: '历史遗漏.png', kind: 'image', usage_id: 'K0' }] }, { n: 2 });
  fs.writeFileSync(path.join(work(project, hidden), '历史遗漏.png'), '仅保存而从未采用的参考夹具');
  saveVersion({ project, asset: hidden });
  legacySnapshot(project, prompt, '1.0.0', asset => {
    asset.data.reference_bindings = [{ ...ref('MEDIA'), ...binding, media: ref('MEDIA', 2), file_path: '历史遗漏.png' }];
  });
  assert.equal(entry(project, hidden).adopted_version, null);
  assert.throws(() => exportProject({ project, out: '07_发布资产/拒绝历史缺失依赖', episodes: id('EP') }), new RegExp(`${hidden}@1\\.0\\.0.*未曾采用的草稿`));
});

test('带身份字段的外层引用仍递归收集真实MEDIA并冻结进按集交接包', t => {
  for (const shape of ['binding', 'data', 'metadata']) {
    const { project, prompt, hidden } = shadowedReferenceFixture(t, shape);
    adoptVersion({ project, asset: hidden, version: '1.0.0', reason: '采用真实嵌套上游测试夹具' });
    saveAdopt(project, prompt);
    const exported = exportProject({ project, out: `07_发布资产/嵌套引用_${shape}`, episodes: id('EP') });
    const handoff = json(path.join(exported.output, 'handoff.json'));
    const exportedPrompt = handoff.assets.find(asset => asset.asset_id === prompt);
    assert.ok(exportedPrompt.refs.some(reference => reference.asset_id === hidden && reference.version === '1.0.0'), shape);
    const actualMedia = handoff.assets.find(asset => asset.asset_id === hidden && asset.version === '1.0.0');
    assert.ok(actualMedia, shape);
    assert.equal(fs.readFileSync(path.join(exported.output, actualMedia.path, '隐藏参考.png'), 'utf8'), '实际引用媒体的冻结字节', shape);
    const markdown = fs.readFileSync(path.join(exported.output, '交接说明.md'), 'utf8');
    const renderedBinding = shape === 'metadata' ? `media：${id('MEDIA')}@1.0.0` : `media：${hidden}@1.0.0`;
    assert.ok(markdown.includes(renderedBinding), shape);
    assert.ok(markdown.includes(`file_path：${shape === 'metadata' ? '素材/Key #1.png' : '隐藏参考.png'}`), shape);
    assert.match(markdown, /expected_usage_id：K0/);
    assert.doesNotMatch(markdown, /reference_bindings：1\. asset_id：|reference_bindings：1\. version：/);
  }
});

test('参考绑定冻结旧版文件和用途，不读取工作目录或当前采用新版', t => {
  const { project, prompt, media } = referenceFixture(t); const original = fs.readFileSync(path.join(work(project, media), '素材/Key #1.png'));
  edit(project, media, asset => { asset.version = '1.1.0'; asset.data.files[0].usage_id = 'K1'; });
  fs.writeFileSync(path.join(work(project, media), '素材/Key #1.png'), '新版已改为结束姿态'); saveAdopt(project, media);
  edit(project, media, asset => { asset.data.files[0].usage_id = 'K2'; });
  fs.writeFileSync(path.join(work(project, media), '素材/Key #1.png'), '未采用工作稿');
  saveAdopt(project, prompt);
  const exported = exportProject({ project, out: '07_发布资产/冻结旧用途', episodes: id('EP') });
  const handoff = json(path.join(exported.output, 'handoff.json'));
  const oldMedia = handoff.assets.find(asset => asset.asset_id === media && asset.version === '1.0.0');
  assert.ok(oldMedia); assert.deepEqual(fs.readFileSync(path.join(exported.output, oldMedia.path, '素材/Key #1.png')), original);
  assert.equal(handoff.content.find(asset => asset.asset_id === media && asset.version === '1.0.0').data.files[0].usage_id, 'K0');
});

test('旧非当前绑定快照警告可见，重新采用或导出错误当前采用版仍被阻止', t => {
  const { project, prompt } = referenceFixture(t); saveAdopt(project, prompt);
  legacySnapshot(project, prompt, '1.0.0', asset => { asset.data.reference_bindings[0].expected_usage_id = '错误旧用途'; });
  edit(project, prompt, asset => { asset.version = '1.1.0'; asset.data.reference_bindings = []; }); saveAdopt(project, prompt);
  const checked = validateProject({ project, strict: true });
  assert.equal(checked.ok, true);
  assert.ok(checked.warnings.some(warning => warning.includes(`${prompt}/.ip-system/snapshots/${prompt}/1.0.0`) && /expected_usage_id.*不一致/.test(warning)));
  assert.throws(() => adoptVersion({ project, asset: prompt, version: '1.0.0', reason: '旧错误不能再次采用' }), /expected_usage_id.*不一致/);
  const registryFile = path.join(project, 'project.json'); const registry = json(registryFile); registry.assets.find(asset => asset.asset_id === prompt).adopted_version = '1.0.0'; write(registryFile, registry);
  assert.equal(validateProject({ project }).ok, false);
  assert.throws(() => exportProject({ project, out: '07_发布资产/拒绝旧错误', episodes: id('EP') }), /expected_usage_id.*不一致/);
});

test('绑定路径必须同时匹配冻结登记清单和manifest实际拼写，旧MEDIA用途错误保留警告', t => {
  const { project, prompt, media, binding } = referenceFixture(t);
  legacySnapshot(project, media, '1.0.0', asset => { asset.data.files[0].path = '素材/key #1.png'; });
  edit(project, prompt, asset => { asset.data.reference_bindings = [{ ...binding, file_path: '素材/key #1.png' }]; });
  assert.throws(() => saveVersion({ project, asset: prompt }), /file_path.*实际拼写不匹配/);
  legacySnapshot(project, media, '1.0.0', asset => { asset.data.files[0].path = binding.file_path; asset.data.files[0].usage_id = ''; });
  edit(project, prompt, asset => { asset.data.reference_bindings = []; });
  edit(project, media, asset => { asset.version = '1.1.0'; }); saveAdopt(project, media);
  const checked = validateProject({ project, strict: true });
  assert.equal(checked.ok, true);
  assert.ok(checked.warnings.some(warning => warning.includes(`${media}/.ip-system/snapshots/${media}/1.0.0`) && /usage_id.*非空字符串/.test(warning)));
  assert.throws(() => adoptVersion({ project, asset: media, version: '1.0.0', reason: '已声明非法用途标识不能采用' }), /usage_id.*非空字符串/);
});

test('绑定引用的MEDIA文件或清单遭篡改，在校验保存采用导出入口均保持硬错误', async t => {
  for (const target of ['file', 'manifest']) await t.test(target, t => {
    const { project, prompt, media } = referenceFixture(t); saveAdopt(project, prompt);
    const snapshot = path.join(project, entry(project, media).versions[0].path);
    if (target === 'file') fs.writeFileSync(path.join(snapshot, '素材/Key #1.png'), '历史被改动');
    else fs.appendFileSync(path.join(snapshot, '_snapshot.json'), ' ');
    assert.ok(validateProject({ project }).errors.some(error => /校验值不一致/.test(error)));
    edit(project, prompt, asset => { asset.version = '1.1.0'; });
    assert.throws(() => saveVersion({ project, asset: prompt }), /校验值不一致/);
    assert.throws(() => adoptVersion({ project, asset: prompt, version: '1.0.0', reason: '损坏上游禁止采用' }), /校验值不一致/);
    assert.throws(() => exportProject({ project, out: '07_发布资产/拒绝损坏', episodes: id('EP') }), /校验值不一致/);
  });
});

test('返修REPORT附件冻结失败证据，不要求采用失败候选MEDIA且可按集交付', t => {
  const { project, prompt } = referenceFixture(t); saveAdopt(project, prompt);
  const failed = draft(project, 'MEDIA', { files: [{ path: '未验收.png', kind: 'image' }], source_refs: [ref('PROMPT', 2)], generation_record: '已取得候选，构图不合格，尚未验收' }, { n: 2 });
  fs.writeFileSync(path.join(work(project, failed), '未验收.png'), '失败候选截图夹具'); saveVersion({ project, asset: failed });
  const report = draft(project, 'REPORT', { prompt: ref('PROMPT', 2), candidate: `${failed}@1.0.0`, status: '构图需返修，媒体未验收', next_action: '只调整主体右侧留白，再检查身份与画风', summary: '附件仅为失败证据，不是通过结果' });
  const evidence = '返修证据/未验收 #1.png'; fs.mkdirSync(path.join(work(project, report), '返修证据'));
  fs.copyFileSync(path.join(work(project, failed), '未验收.png'), path.join(work(project, report), evidence)); saveAdopt(project, report);
  fs.writeFileSync(path.join(work(project, report), evidence), '后续工作稿不进入包');
  const exported = exportProject({ project, out: '07_发布资产/失败证据附件', episodes: id('EP') }); const handoff = json(path.join(exported.output, 'handoff.json'));
  assert.equal(entry(project, failed).adopted_version, null);
  assert.equal(handoff.assets.some(asset => asset.asset_id === failed), false);
  assert.equal(handoff.content.find(asset => asset.asset_id === report).data.candidate, `${failed}@1.0.0`);
  assert.equal(fs.readFileSync(path.join(exported.output, `assets/${report}/1.0.0/${evidence}`), 'utf8'), '失败候选截图夹具');
  assert.ok(projectStatus({ project }).production_notes.some(note => note.asset_id === report && note.status.includes('未验收')));
  const markdown = fs.readFileSync(path.join(exported.output, '交接说明.md'), 'utf8');
  const links = [...markdown.matchAll(/(?<!\\)\]\(([^)\n]+)\)/g)].map(match => decodeURIComponent(match[1]));
  assert.ok(links.includes(`assets/${report}/1.0.0/${evidence}`));
});

test('同集两镜共用一次PROMPT时保留直接引用与独立播放镜头，不重复计算任务时长', t => {
  const { project } = fixture(t); base(project); episode(project, 1); episode(project, 2);
  const firstData = json(path.join(work(project, id('SHOT')), 'asset.json')).data;
  saveAdopt(project, draft(project, 'SHOT', { ...firstData, shot_number: 2, start_seconds: 8, duration_seconds: 5, action: '来客将已经接到的钥匙收入右侧衣袋，守灯人保持空手', video_prompt: '来客右手将同一把钥匙收入右侧衣袋，守灯人保持空手，固定中景。' }, { n: 3 }));
  const orderedShots = [ref('SHOT'), ref('SHOT', 3)];
  const assetId = draft(project, 'PROMPT', { shot: ref('SHOT'), shot_refs: orderedShots, video_prompt: '第一镜固定双手近景，来客接稳钥匙后守灯人才松手。第二镜切到固定中景，来客将同一把钥匙收入右侧衣袋，守灯人保持空手。', negative_prompt: '避免重复钥匙或重复交接', timing: '镜头一规划0—8秒，镜头二规划8—13秒；属于同一生成任务，总计13秒，尚未实测。' }, { n: 3 });
  saveAdopt(project, assetId);
  const result = exportProject({ project, out: '07_发布资产/同集多镜任务', episodes: id('EP') });
  const handoff = json(path.join(result.output, 'handoff.json'));
  assert.deepEqual(handoff.playback.episodes, [ref('EP')]);
  assert.deepEqual(handoff.playback.shots, orderedShots);
  const prompt = handoff.content.find(asset => asset.asset_id === assetId);
  assert.deepEqual(prompt.data.shot, ref('SHOT')); assert.deepEqual(prompt.data.shot_refs, orderedShots);
  const playbackIds = new Set(handoff.playback.shots.map(shot => shot.asset_id));
  assert.equal(handoff.content.filter(asset => asset.type === 'SHOT' && playbackIds.has(asset.asset_id)).reduce((total, asset) => total + asset.data.duration_seconds, 0), 13);
  assert.equal(handoff.assets.some(asset => asset.asset_id === id('EP', 2)), false);
  const markdown = fs.readFileSync(path.join(result.output, '交接说明.md'), 'utf8');
  assert.equal((markdown.match(/^1\. \*\*镜头编号\*\*/gm) ?? []).length, 2);
  assert.match(markdown, /shot_refs：1\. IP800-SHOT-001@1\.0\.0/);
  assert.match(markdown, /shot_refs：2\. IP800-SHOT-003@1\.0\.0/);
  assert.match(markdown, /总计13秒，尚未实测/);
});

test('策划必须声明阅读模式和主引擎，状态的知情持物伏笔必须引用真实事件', t => {
  const { project } = fixture(t); base(project); saveAdopt(project, chapter(project, 1));
  const plot = draft(project, 'PLOT', { premise: '守灯', audience: '成人', theme: '交接', reading_mode: '未定', engine: '期限压迫', relationship_debts: [] });
  assert.throws(() => saveVersion({ project, asset: plot }), /reading_mode/);
  edit(project, plot, asset => { asset.data.reading_mode = '追读向'; asset.data.engine = ''; });
  assert.throws(() => saveVersion({ project, asset: plot }), /engine/);
  edit(project, plot, asset => { asset.data.engine = '期限压迫'; asset.data.relationship_debts = [{ who: '来客' }]; });
  assert.throws(() => saveVersion({ project, asset: plot }), /relationship_debts\[0\]/);
  edit(project, plot, asset => { asset.data.relationship_debts = [{ who: '来客', owes: '守灯人', what: '天亮前归还钥匙' }]; });
  saveAdopt(project, plot);
  const state = draft(project, 'STATE', { changes: [{ event_ref: ev(1), before: '守灯人持钥匙', after: '来客持钥匙', effective_node: 'E01交接完成', story_time: '第一夜' }], knowledge: '来客知道信号' });
  assert.throws(() => saveVersion({ project, asset: state }), /knowledge 必须为数组/);
  edit(project, state, asset => { asset.data.knowledge = [{ who: '来客', fact: '知道信号', status: '听说', event_ref: ev(1) }]; asset.data.possessions = []; asset.data.foreshadowing = []; });
  assert.throws(() => saveVersion({ project, asset: state }), /status 只能是知道、怀疑、误信或未知/);
  edit(project, state, asset => { asset.data.knowledge = [{ who: '来客', fact: '知道信号', status: '知道', event_ref: { ...ev(1), event_id: 'E99' } }]; });
  assert.throws(() => saveVersion({ project, asset: state }), /来源事件 E99 不存在/);
  edit(project, state, asset => { asset.data.knowledge = [{ who: '来客', fact: '听见两短一长', status: '知道', event_ref: ev(1) }]; asset.data.possessions = [{ holder: '来客', fact: '铜钥匙在来客右手', event_ref: ev(1) }]; asset.data.foreshadowing = [{ fact: '灯灭后的第二声', status: '已埋', event_ref: ev(1) }]; });
  saveAdopt(project, state);
  assert.equal(validateProject({ project, strict: true }).ok, true);
});

test('只读status与纯小说resume：采用正文、状态、真实制作备注和未保存待办分开', t => {
  const { project } = fixture(t); base(project); saveAdopt(project, chapter(project, 1));
  saveAdopt(project, draft(project, 'STATE', { changes: [{ event_ref: ev(1), before: '守灯人持钥匙', after: '来客持钥匙', effective_node: 'E01交接完成', story_time: '第一夜' }], knowledge: [], possessions: [], foreshadowing: [] }));
  saveAdopt(project, draft(project, 'REPORT', { status: '媒体未生成', next_action: '制作人物参考和动作预演' }));
  review(project, id('CH'));
  const originalBody = fs.readFileSync(path.join(work(project, id('CH')), '正文.md'), 'utf8');
  fs.appendFileSync(path.join(work(project, id('CH')), '正文.md'), '\n尚未采用的新情节');
  const before = fs.readFileSync(path.join(project, 'project.json'));
  const status = projectStatus({ project }); assert.deepEqual(fs.readFileSync(path.join(project, 'project.json')), before);
  assert.ok(status.drafts.some(asset => asset.asset_id === id('CH'))); assert.ok(status.production_notes.some(note => note.next_action === '制作人物参考和动作预演'));
  assert.match(status.message, /空列表不代表/);
  const resumed = resumeProject({ project, out: '00_项目管理/继续写第二章' });
  const info = json(path.join(resumed.output, '续作信息.json')); assert.equal(info.states.length, 1); assert.ok(info.pending.length > 0);
  assert.equal(fs.readFileSync(path.join(resumed.output, `assets/${id('CH')}/1.0.0/正文.md`), 'utf8'), originalBody);
  assert.equal(info.assets.some(asset => ['EP', 'SC', 'SHOT'].includes(asset.type)), false);
  assert.match(fs.readFileSync(path.join(resumed.output, '续作说明.md'), 'utf8'), /媒体未生成/);
  assert.throws(() => resumeProject({ project, out: '00_项目管理/继续写第二章' }), /拒绝覆盖/);
  assert.throws(() => resumeProject({ project, out: '00_项目管理/../../越界' }), /路径/);
});

test('复核保留旧版可关闭精确事项，上游再次变化自动重新提示', t => {
  const { project } = fixture(t); base(project); saveAdopt(project, chapter(project, 1));
  edit(project, id('WORLD'), asset => { asset.version = '1.1.0'; asset.data.rules.push('新规则'); }); saveAdopt(project, id('WORLD'));
  const before = projectStatus({ project }); const item = before.review_items.find(item => item.asset_id === id('CH'));
  assert.ok(item.review_item_id.startsWith('RI-'));
  assert.throws(() => reviewItem({ project, item: item.review_item_id, reason: '仅理由不能替代证据', method: 'ai', reviewer: '测试 AI' }), /evidence/);
  const resolved = reviewItem({ project, item: item.review_item_id, reason: '本章仍发生于旧规则时期', evidence: '已对照本章E01与世界规则变更生效时点', method: 'ai', reviewer: '测试 AI' });
  assert.equal(resolved.review_items.length, 0); assert.equal(projectStatus({ project }).resolved_reviews, 1);
  assert.equal(json(path.join(project, '.ip-system/snapshots/IP800-CH-001/1.0.0/asset.json')).refs[0].version, '1.0.0');
  edit(project, id('WORLD'), asset => { asset.version = '1.2.0'; asset.data.rules.push('又一条新规则'); }); saveAdopt(project, id('WORLD'));
  const again = projectStatus({ project }).review_items.find(item => item.asset_id === id('CH'));
  assert.notEqual(again.review_item_id, item.review_item_id); assert.equal(again.current_version, '1.2.0');
  assert.throws(() => reviewItem({ project, item: item.review_item_id, reason: '旧豁免不可复用', evidence: '旧证据', method: 'ai', reviewer: '测试 AI' }), /过期编号/);
});

for (const kind of ['resume', 'review', 'working-asset']) {
  test(`新写操作 ${kind} 在持久日志后中断可完整恢复`, t => {
    const { project } = fixture(t); base(project);
    const originalRename = fs.renameSync; let interrupted = false;
    fs.renameSync = function (from, to, ...args) {
      if (!interrupted && String(from).includes(`${path.sep}transactions${path.sep}`) && path.basename(String(from)) === (kind === 'working-asset' ? 'asset' : kind)) { interrupted = true; throw new Error('测试中断'); }
      return originalRename.call(fs, from, to, ...args);
    };
    try {
      if (kind === 'resume') assert.throws(() => resumeProject({ project, out: '00_项目管理/恢复续作包' }), /测试中断/);
      if (kind === 'review') assert.throws(() => review(project, id('WORLD')), /测试中断/);
      if (kind === 'working-asset') assert.throws(() => newAsset({ project, type: 'CHAR', title: '恢复的角色' }), /测试中断/);
    } finally { fs.renameSync = originalRename; }
    assert.ok(fs.existsSync(path.join(project, '.ip-system/pending.json')));
    const recovered = adoptVersion({ project, asset: id('WORLD'), version: '1.0.0', reason: '恢复后重复采用现有版本' });
    assert.ok(recovered.recovered_transaction); assert.equal(fs.existsSync(path.join(project, '.ip-system/pending.json')), false);
    if (kind === 'resume') assert.ok(fs.existsSync(path.join(project, '00_项目管理/恢复续作包/续作信息.json')));
    if (kind === 'review') assert.equal(json(path.join(project, 'project.json')).content_reviews.length, 1);
    if (kind === 'working-asset') assert.ok(entry(project, id('CHAR')));
  });
}

test('提示词正文拒绝 undefined、null 和同上，必须指向真实镜头', t => {
  const { project } = fixture(t); base(project); episode(project, 1);
  for (const image of ['同镜开始时的单帧：undefined', 'null', '同上', '〔待填：首帧〕']) {
    const assetId = draft(project, 'PROMPT', { shot: ref('SHOT'), image_prompt: image, video_prompt: '连续交接动作', negative_prompt: '避免重复钥匙', optimization: '手部动作在画' }, { n: 2 });
    assert.throws(() => saveVersion({ project, asset: assetId }), /image_prompt/, image);
    fs.rmSync(work(project, assetId), { recursive: true, force: true });
    const registry = json(path.join(project, 'project.json'));
    registry.assets = registry.assets.filter(item => item.asset_id !== assetId);
    write(path.join(project, 'project.json'), registry);
  }
  const video = draft(project, 'PROMPT', { shot: ref('SHOT'), image_prompt: '动作开始前，钥匙仍在守灯人右手', video_prompt: 'undefined', negative_prompt: '无额外项' }, { n: 3 });
  assert.throws(() => saveVersion({ project, asset: video }), /video_prompt/);
  edit(project, video, asset => { asset.data.video_prompt = '来客接稳后守灯人才松手'; asset.data.negative_prompt = ''; });
  assert.throws(() => saveVersion({ project, asset: video }), /negative_prompt/);
  edit(project, video, asset => { asset.data.negative_prompt = '无额外项'; asset.data.shot = { asset_id: id('CH'), version: '1.0.0' }; });
  assert.throws(() => saveVersion({ project, asset: video }), /shot 需要 SHOT/);
});

test('新CLI参数和JSON结果可实际跨进程调用，状态命令不改变项目', t => {
  const { project } = fixture(t);
  const run = args => spawnSync(process.execPath, [cli, ...args, '--project', project, '--json'], { encoding: 'utf8' });
  const created = run(['new-asset', '--type', 'WORLD', '--title', '世界骨架']); assert.equal(created.status, 0, created.stderr); assert.equal(JSON.parse(created.stdout).asset_id, id('WORLD'));
  const before = fs.readFileSync(path.join(project, 'project.json')); const status = run(['status']); assert.equal(status.status, 0, status.stderr); assert.deepEqual(fs.readFileSync(path.join(project, 'project.json')), before);
  const resumed = run(['resume', '--out', '00_项目管理/空基准待创作']); assert.equal(resumed.status, 0, resumed.stderr); assert.equal(JSON.parse(resumed.stdout).assets, 0);
  const flag = run(['export', '--out', '07_发布资产/缺项', '--episodes', id('EP'), '--require-review']); assert.equal(flag.status, 1); assert.doesNotMatch(flag.stdout, /不接受参数|缺少值/);
});
