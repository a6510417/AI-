import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject, newAsset, saveVersion, recordReview, adoptVersion, exportProject, resumeProject, retireAsset, restoreAsset, projectStatus, validateProject, validateMigratingProject, CHAPTER_FILES } from '../src/project-service.mjs';
import { safePath } from '../src/storage.mjs';
import { workingPath } from '../src/layout.mjs';
import { normalizeReviewRecord, assertReviewPasses, mediaFileErrors } from '../src/rules.mjs';

const cli = fileURLToPath(new URL('../bin/studio.mjs', import.meta.url));
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
function fixture(t, schemaVersion = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-v2-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project: initProject({ root, id: 'IP700', name: '临时工作室', schemaVersion }).project };
}
const registry = project => json(path.join(project, 'project.json'));
const work = (project, assetId) => path.join(project, registry(project).assets.find(entry => entry.asset_id === assetId).path);
const ref = type => ({ asset_id: `IP700-${type}-001`, version: '1.0.0' });
const event = () => ({ ...ref('CH'), event_id: 'E01' });
function draft(project, type, data) {
  const created = newAsset({ project, type, title: `${type}具体测试资产` });
  const directory = work(project, created.asset_id), filename = path.join(directory, 'asset.json');
  const asset = json(filename); asset.data = data; write(filename, asset);
  if (type === 'CH') {
    fs.writeFileSync(path.join(directory, '正文.md'), '天亮之前，来客接稳钥匙，守灯人才松开手。');
    for (const filename of CHAPTER_FILES.slice(1)) write(path.join(directory, filename), { project_id: 'IP700', chapter_id: created.asset_id, version: '1.0.0', entries: filename === '新增设定.json' ? [] : ['钥匙交接的具体状态'] });
  }
  return created.asset_id;
}
function review(project, asset, extra = {}) {
  const file = `production/审核-${crypto.randomUUID()}.json`;
  write(path.join(project, file), { method: 'ai', reviewer: '隔离回归夹具', scope: '具体测试全文及文件结构', coverage: 'full', result: 'pass', issues: [], evidence: '临时夹具验证结构与精确版本，不代表真实文学或媒体验收。', ...extra });
  return recordReview({ project, asset, version: '1.0.0', file }).review_id;
}
function saveAdopt(project, asset) {
  saveVersion({ project, asset });
  return adoptVersion({ project, asset, version: '1.0.0', reason: '隔离测试采用精确版本', review: review(project, asset) });
}
function bridge(project) {
  for (const [type, data] of [
    ['WORLD', { rules: ['同一把钥匙只能由一人持有'] }],
    ['LOC', { description: '石塔灯室' }],
    ['CH', { events: [{ event_id: 'E01', story_time: '第一夜', summary: '交还钥匙' }] }],
    ['EP', { episode_number: 1, chapter_refs: [ref('CH')] }],
    ['SC', { scene_number: 1, episode: ref('EP'), location: ref('LOC'), source_refs: [event()], script: '对方接稳后，守灯人才松手。' }],
    ['SHOT', { episode: ref('EP'), scene: ref('SC'), source_refs: [event()], shot_number: 1, start_seconds: 0, duration_seconds: 5, story_time: '第一夜', scene_description: '石塔灯室', characters: '守灯人与来客', action: '来客接稳钥匙后守灯人才松手', emotion: '释然', dialogue: '无', shot_size: '双手近景', camera_movement: '固定', lighting: '暖光', video_prompt: '来客接稳钥匙后守灯人才松手，固定双手近景。', visual_description: '同一把钥匙完整可见' }],
  ]) saveAdopt(project, draft(project, type, data));
}

test('公开API默认v1，新bin默认v2且可显式初始化v1', t => {
  const { root } = fixture(t);
  const old = initProject({ root, id: 'IP701', name: 'API默认旧版' });
  assert.equal(registry(old.project).schema_version, 1);
  for (const [id, flags, expected] of [['IP702', [], 2], ['IP703', ['--schema', '1'], 1]]) {
    const run = spawnSync(process.execPath, [cli, 'init', '--root', root, '--id', id, '--name', 'CLI版本', ...flags, '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(registry(JSON.parse(run.stdout).project).schema_version, expected);
  }
});

test('v2只迁工作目录形状，资产及七文件保持v1身份和原快照路径', t => {
  const { project } = fixture(t);
  const chapter = draft(project, 'CH', { events: [{ event_id: 'E01', story_time: '第一夜', summary: '交钥匙' }] });
  const entry = registry(project).assets[0];
  assert.equal(entry.path, `assets/CH/${chapter}`);
  assert.equal(json(path.join(work(project, chapter), 'asset.json')).schema_version, 1);
  for (const filename of CHAPTER_FILES) assert.ok(fs.existsSync(path.join(work(project, chapter), filename)));
  saveVersion({ project, asset: chapter });
  assert.equal(registry(project).assets[0].versions[0].path, `.ip-system/snapshots/${chapter}/1.0.0`);
  assert.equal(validateProject({ project, strict: true }).ok, true);
});

test('v2路径拒绝类型/ID不匹配、旧目录、嵌套资产、越界和控制字符', t => {
  const { project } = fixture(t);
  const context = registry(project);
  for (const relative of ['assets/CH/IP700-WORLD-001', 'assets/CH/IP700-CH-001/sub', '03_小说资产/章节001', 'assets/CH/../WORLD', 'assets/CH/IP700-CH-001\n']) assert.throws(() => workingPath(project, relative, context));
  assert.throws(() => safePath(project, 'a\nb.png'));
  assert.throws(() => safePath(project, '../outside'));
  const asset = newAsset({ project, type: 'WORLD', title: '世界' });
  const value = registry(project); value.assets[0].path = `assets/CHAR/${asset.asset_id}`; write(path.join(project, 'project.json'), value);
  assert.equal(validateProject({ project }).ok, false);
});

test('v2采用必须精确完整审核，未绑定或新版错绑不会改采用指针', t => {
  const { project } = fixture(t), asset = draft(project, 'WORLD', { rules: ['钥匙不可复制'] });
  saveVersion({ project, asset });
  assert.throws(() => adoptVersion({ project, asset, version: '1.0.0', reason: '具体测试理由' }), /必须提供 --review/);
  assert.equal(registry(project).assets[0].adopted_version, null);
  const partial = review(project, asset, { coverage: 'partial' });
  assert.throws(() => adoptVersion({ project, asset, version: '1.0.0', reason: '具体测试理由', review: partial }), /完整范围/);
  const full = review(project, asset);
  assert.equal(adoptVersion({ project, asset, version: '1.0.0', reason: '具体测试理由', review: full }).ok, true);
});

test('v2导出默认且强制审核，旧路径拒绝、交接包格式及快照仍v1', t => {
  const { project } = fixture(t); bridge(project);
  assert.throws(() => exportProject({ project, out: '07_发布资产/旧位置' }), /deliveries\/handoff/);
  const output = exportProject({ project, out: 'deliveries/handoff/测试包', requireReview: false });
  const handoff = json(path.join(output.output, 'handoff.json'));
  assert.equal(handoff.schema_version, 1); assert.equal(handoff.require_review, true);
  assert.equal(resumeProject({ project, out: 'deliveries/resume/测试续作' }).ok, true);
  review(project, ref('CH').asset_id, { result: 'revise' });
  assert.throws(() => exportProject({ project, out: 'deliveries/handoff/拒绝失效审核', requireReview: false }), /审核结论尚未通过/);
});

test('退役候选保留文件和历史、退出行动待办，保存采用须显式恢复', t => {
  const { project } = fixture(t), asset = newAsset({ project, type: 'MEDIA', title: '弃用空候选' }).asset_id;
  const bytes = fs.readFileSync(path.join(work(project, asset), 'asset.json'));
  assert.ok(projectStatus({ project }).pending.some(item => item.asset_id === asset));
  retireAsset({ project, asset, reason: '具体候选路线已由后续设计替代' });
  const status = projectStatus({ project });
  assert.equal(status.assets.length, 1); assert.equal(status.retired[0].asset_id, asset);
  assert.equal(status.pending.some(item => item.asset_id === asset), false);
  assert.deepEqual(fs.readFileSync(path.join(work(project, asset), 'asset.json')), bytes);
  assert.equal(validateProject({ project, strict: true }).ok, true);
  assert.throws(() => saveVersion({ project, asset }), /先 restore-asset/);
  assert.throws(() => adoptVersion({ project, asset, version: '1.0.0', reason: '具体测试理由' }), /先 restore-asset/);
  restoreAsset({ project, asset, reason: '具体候选重新进入设计' });
  assert.equal(projectStatus({ project }).retired.length, 0);
  assert.equal(registry(project).lifecycle_history.length, 2);
});

test('v1不支持候选退役，已采用v2资产不能退役', t => {
  const legacy = fixture(t, 1).project, old = newAsset({ project: legacy, type: 'MEDIA' }).asset_id;
  assert.throws(() => retireAsset({ project: legacy, asset: old, reason: '具体测试理由' }), /仅适用于 v2/);
  const { project } = fixture(t); const adopted = draft(project, 'WORLD', { rules: ['规则具体'] }); saveAdopt(project, adopted);
  assert.throws(() => retireAsset({ project, asset: adopted, reason: '具体测试理由' }), /已采用过/);
});

test('已提交空UUID被清理，非本次非空事务证据保持原样', t => {
  const { project } = fixture(t), transactionRoot = path.join(project, '.ip-system/transactions');
  const orphan = path.join(transactionRoot, crypto.randomUUID()); fs.mkdirSync(orphan, { recursive: true }); fs.writeFileSync(path.join(orphan, '失败证据.txt'), '保留');
  const emptyUnknown = path.join(transactionRoot, crypto.randomUUID()); fs.mkdirSync(emptyUnknown);
  newAsset({ project, type: 'WORLD', title: '新世界' });
  assert.deepEqual(fs.readdirSync(transactionRoot).sort(), [path.basename(orphan), path.basename(emptyUnknown)].sort());
  assert.equal(fs.readFileSync(path.join(orphan, '失败证据.txt'), 'utf8'), '保留');
});

test('v2中断新资产事务按照v2目标恢复', t => {
  const { project } = fixture(t), rename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = (from, to) => { if (!interrupted && path.basename(from) === 'asset') { interrupted = true; throw new Error('临时模拟中断'); } return rename(from, to); };
  try { assert.throws(() => newAsset({ project, type: 'WORLD', title: '中断世界' }), /模拟中断/); } finally { fs.renameSync = rename; }
  assert.ok(fs.existsSync(path.join(project, '.ip-system/pending.json')));
  const result = newAsset({ project, type: 'CHAR', title: '恢复后角色' });
  assert.ok(result.recovered_transaction);
  assert.ok(fs.existsSync(path.join(project, 'assets/WORLD/IP700-WORLD-001/asset.json')));
  assert.equal(validateProject({ project }).ok, true);
});

test('v2交付在事务提交前加入报告视图并保留未解析警告及冻结字节', t => {
  const { project } = fixture(t);
  saveAdopt(project, draft(project, 'WORLD', { rules: ['测试世界规则'] }));
  const report = draft(project, 'REPORT', { summary: '具体报告', world: ref('WORLD') });
  const body = '[规则](../../WORLD/IP700-WORLD-001/asset.json)\n[待核实附件](missing.md)\n';
  fs.writeFileSync(path.join(work(project, report), '制作报告.md'), body);
  saveAdopt(project, report);
  const frozen = path.join(project, `.ip-system/snapshots/${report}/1.0.0/制作报告.md`), before = fs.readFileSync(frozen);
  const result = resumeProject({ project, out: 'deliveries/resume/报告视图回归' });
  assert.ok(result.warnings.some(warning => warning.includes('missing.md')));
  assert.ok(json(path.join(result.output, '续作信息.json')).warnings.some(warning => warning.includes('missing.md')));
  const views = json(path.join(result.output, 'views/阅读视图.json'));
  assert.equal(views.reports.length, 1);
  assert.deepEqual(fs.readFileSync(frozen), before);
  assert.deepEqual(fs.readFileSync(path.join(result.output, `assets/${report}/1.0.0/制作报告.md`)), before);
});

test('审核占位文本与生产MEDIA形状使用统一规则', t => {
  const context = { reviewId: 'REV-test', projectId: 'IP700', assetId: 'IP700-CH-001', version: '1.0.0', manifestSha256: 'a'.repeat(64), recordedAt: '2026-09-30T00:00:00Z' };
  const base = { method: 'ai', reviewer: '测试审查者', scope: '具体文件结构与版本', evidence: '本次具体测试夹具', coverage: 'full', result: 'pass', issues: [] };
  for (const field of ['reviewer', 'scope', 'evidence']) for (const placeholder of ['undefined', 'null', '同上', '待补', '待填', 'TODO']) assert.throws(() => normalizeReviewRecord({ ...base, [field]: placeholder }, context));
  const valid = normalizeReviewRecord(base, context); assert.equal(assertReviewPasses(valid, { assetId: context.assetId, version: context.version, manifestSha256: context.manifestSha256 }).result, 'pass');
  assert.ok(mediaFileErrors([{ path: 'sub/asset.json', kind: 'other' }]).length);
  const { project } = fixture(t), asset = draft(project, 'MEDIA', { files: [{ path: 'sub/asset.json', kind: 'other' }] });
  fs.mkdirSync(path.join(work(project, asset), 'sub')); write(path.join(work(project, asset), 'sub/asset.json'), { content: '错误元数据文件' });
  assert.throws(() => saveVersion({ project, asset }), /不能把资产元数据/);
});

test('incomplete迁移目录所有正常入口拒绝，只有精确内部token可只读核验', t => {
  const { project } = fixture(t), sentinel = path.join(project, '.ip-system/migration-incomplete.json');
  write(sentinel, { token: '具体迁移token' });
  assert.equal(validateProject({ project }).ok, false);
  assert.throws(() => projectStatus({ project }), /迁移尚未完成/);
  assert.throws(() => newAsset({ project, type: 'WORLD' }), /迁移尚未完成/);
  assert.equal(validateMigratingProject({ project, migrationToken: 'wrong-token' }).ok, false);
  assert.equal(validateMigratingProject({ project, migrationToken: '具体迁移token' }).ok, true);
  const cliRun = spawnSync(process.execPath, [cli, 'validate', '--project', project, '--migration-token', '具体迁移token', '--json'], { encoding: 'utf8' });
  assert.equal(cliRun.status, 1); assert.match(cliRun.stdout, /不接受参数/);
});

test('CLI解析失败仍返回JSON，退役与恢复跨进程可用', t => {
  const { project } = fixture(t), asset = newAsset({ project, type: 'MEDIA' }).asset_id;
  const duplicate = spawnSync(process.execPath, [cli, 'status', '--project', project, '--json', '--json'], { encoding: 'utf8' });
  assert.equal(duplicate.status, 1); assert.equal(JSON.parse(duplicate.stdout).ok, false);
  for (const command of ['retire-asset', 'restore-asset']) {
    const result = spawnSync(process.execPath, [cli, command, '--project', project, '--asset', asset, '--reason', '具体隔离回归理由', '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(JSON.parse(result.stdout).action, command);
  }
});
