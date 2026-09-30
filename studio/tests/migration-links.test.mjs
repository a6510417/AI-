import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initProject, saveVersion, recordReview, adoptVersion, validateProject, projectStatus, resumeProject } from '../src/project-service.mjs';
import { migrateProject, migrationPreflight } from '../src/migration.mjs';
import { auditLinks, renderReport, renderPackageLinks } from '../src/links.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
const ref = (id, version = '1.0.0') => ({ asset_id: `IP991-${id}`, version });
function files(directory) {
  const result = {};
  function walk(current) { for (const item of fs.readdirSync(current, { withFileTypes: true })) { const full = path.join(current, item.name); if (item.isDirectory()) walk(full); else result[path.relative(directory, full).replaceAll('\\', '/')] = hash(fs.readFileSync(full)); } }
  walk(directory); return result;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-迁移-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = initProject({ root: path.join(root, 'old'), id: 'IP991', name: '迁移测试', schemaVersion: 1 }).project;
  const mediaPath = '05_视觉资产/IP991-MEDIA-001', reportPath = '00_项目管理/IP991-REPORT-001';
  function asset(type, relative, data, refs = [], version = '1.0.0') {
    const directory = path.join(project, relative); fs.mkdirSync(directory, { recursive: true });
    write(path.join(directory, 'asset.json'), { schema_version: 1, project_id: 'IP991', asset_id: `IP991-${type}-001`, type, title: `${type}测试`, version, source_kind: '原创创作', adoption_status: '建议', refs, data });
    return directory;
  }
  function adopt(type, relative) {
    const saved = saveVersion({ project, path: relative });
    const input = path.join(project, '00_项目管理', `审核_${type}.json`);
    write(input, { method: 'ai', reviewer: '测试夹具', scope: `${type}准确冻结文件`, coverage: 'full', result: 'pass', issues: [], evidence: '仅测试结构与精确版本，不构成真实媒体审核。' });
    const review = recordReview({ project, asset: saved.asset_id, version: saved.version, file: path.relative(project, input) });
    adoptVersion({ project, asset: saved.asset_id, version: saved.version, reason: '测试夹具采用', review: review.review_id });
    return saved;
  }
  const media = asset('MEDIA', mediaPath, { files: [{ path: '图像 空格#1.png', kind: 'image' }] });
  fs.writeFileSync(path.join(media, '图像 空格#1.png'), 'test media bytes version one'); adopt('MEDIA', mediaPath);
  const report = asset('REPORT', reportPath, { summary: '测试精确媒体依赖' }, [ref('MEDIA-001')]);
  fs.writeFileSync(path.join(report, '制作报告.md'), '# 制作报告\n\n[精确图片](../../05_视觉资产/IP991-MEDIA-001/图像%20空格%231.png)\n'); adopt('REPORT', reportPath);
  fs.writeFileSync(path.join(project, '00_项目管理', 'loose.txt'), 'loose source evidence');
  const target = path.join(root, 'new', 'IP991_迁移测试');
  return { root, project, target, media, report, mediaPath, reportPath, asset, adopt };
}

test('v1→v2迁移保留源与每个工作/历史字节，按类型重定位且登记历史原样', async t => {
  const f = fixture(t), before = files(f.project), oldRegistry = read(path.join(f.project, 'project.json'));
  const preflight = await migrationPreflight({ project: f.project, to: f.target });
  assert.equal(preflight.ok, true); assert.equal(fs.existsSync(f.target), false); assert.deepEqual(files(f.project), before);
  const result = await migrateProject({ project: f.project, to: f.target });
  assert.equal(result.ok, true, result.errors?.join('\n')); assert.deepEqual(files(f.project), before);
  const registry = read(path.join(f.target, 'project.json'));
  assert.equal(registry.schema_version, 2);
  assert.deepEqual(registry.assets.map(a => a.path), ['assets/MEDIA/IP991-MEDIA-001', 'assets/REPORT/IP991-REPORT-001']);
  assert.deepEqual(registry.adoption_history, oldRegistry.adoption_history);
  assert.deepEqual(registry.content_reviews, oldRegistry.content_reviews);
  assert.deepEqual(registry.operations, oldRegistry.operations);
  const record = read(result.migration); assert.equal(record.status, 'complete');
  for (const item of record.files) assert.equal(hash(fs.readFileSync(path.join(f.target, item.to))), before[item.from]);
  assert.equal(fs.existsSync(path.join(f.target, '.ip-system/migration-incomplete.json')), false);
  assert.equal(validateProject({ project: f.target, strict: true }).ok, true);
  assert.equal(fs.existsSync(path.join(f.target, 'production/review-inputs/审核_MEDIA.json')), true);
  assert.equal(fs.existsSync(path.join(f.target, 'production/legacy/00_项目管理/loose.txt')), true);
});

test('预检拒绝既有/嵌套目标、任意锁和待恢复事务，全部只读', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.target, { recursive: true });
  assert.equal((await migrationPreflight({ project: f.project, to: f.target })).ok, false);
  assert.equal((await migrationPreflight({ project: f.project, to: path.join(f.project, 'nested') })).ok, false);
  assert.equal((await migrationPreflight({ project: f.project, to: f.root })).ok, false);
  fs.writeFileSync(path.join(f.project, '.ip-system/write.lock'), 'unknown lock');
  const locked = files(f.project);
  assert.match((await migrationPreflight({ project: f.project, to: `${f.target}-new` })).errors.join(' '), /锁/);
  assert.deepEqual(files(f.project), locked); fs.unlinkSync(path.join(f.project, '.ip-system/write.lock'));
  fs.writeFileSync(path.join(f.project, '.ip-system/pending.json'), 'unknown transaction');
  const pending = files(f.project);
  assert.match((await migrationPreflight({ project: f.project, to: `${f.target}-new` })).errors.join(' '), /待恢复/);
  assert.deepEqual(files(f.project), pending);
});

test('迁移期间源被外部修改会保留incomplete目标并阻断普通读写', async t => {
  const f = fixture(t), nativeCopy = fs.copyFileSync;
  fs.copyFileSync = (source, destination, ...args) => {
    nativeCopy(source, destination, ...args);
    if (path.basename(source) === 'loose.txt') fs.writeFileSync(source, 'external source mutation');
  };
  let result;
  try { result = await migrateProject({ project: f.project, to: f.target }); } finally { fs.copyFileSync = nativeCopy; }
  assert.equal(result.ok, false); assert.equal(result.incomplete, true);
  assert.match(result.errors.join(' '), /源项目发生变化/);
  assert.equal(read(result.migration).status, 'incomplete');
  assert.equal(validateProject({ project: f.target }).ok, false);
  assert.throws(() => projectStatus({ project: f.target }), /迁移|incomplete/);
  assert.equal(auditLinks({ project: f.target }).ok, false);
  assert.equal(fs.existsSync(path.join(f.project, '.ip-system/write.lock')), false);
  assert.equal((await migrateProject({ project: f.project, to: f.target })).ok, false);
});

test('复制后目标被外部修改也不成功，保留失败证据', async t => {
  const f = fixture(t), nativeCopy = fs.copyFileSync;
  let copiedLoose;
  fs.copyFileSync = (source, destination, ...args) => {
    nativeCopy(source, destination, ...args);
    if (copiedLoose) fs.writeFileSync(copiedLoose, 'external destination mutation');
    if (path.basename(source) === 'loose.txt') copiedLoose = destination;
  };
  let result;
  try { result = await migrateProject({ project: f.project, to: f.target }); } finally { fs.copyFileSync = nativeCopy; }
  assert.equal(result.ok, false); assert.match(result.errors.join(' '), /目标复制后发生变化/);
  assert.equal(read(result.migration).status, 'incomplete');
});

test('冻结报告原始坏链接按准确依赖修复到派生视图，源与快照不改', t => {
  const f = fixture(t), before = files(path.join(f.project, '.ip-system'));
  const audit = auditLinks({ project: f.project });
  assert.equal(audit.ok, true, audit.warnings.join('\n')); assert.equal(audit.stats.raw_broken, 1); assert.equal(audit.stats.resolved, 2);
  assert.equal(audit.resolved.every(item => item.target_version === '1.0.0'), true);
  const result = renderReport({ project: f.project, asset: 'IP991-REPORT-001', out: 'deliveries/views/test' });
  assert.equal(result.ok, true, result.warnings.join('\n'));
  const rendered = path.join(result.output, 'reports/IP991-REPORT-001/1.0.0/制作报告.md');
  const link = /\]\(([^)]+)\)/.exec(fs.readFileSync(rendered, 'utf8'))[1];
  assert.equal(fs.readFileSync(path.resolve(path.dirname(rendered), decodeURIComponent(link)), 'utf8'), 'test media bytes version one');
  assert.deepEqual(files(path.join(f.project, '.ip-system')), before);
  assert.equal(renderReport({ project: f.project, asset: 'IP991-REPORT-001', out: 'deliveries/views/test' }).ok, false);
  assert.equal(renderReport({ project: f.project, asset: 'IP991-REPORT-001', out: 'deliveries/views/../../assets/unsafe' }).ok, false);
  assert.equal(fs.existsSync(path.join(f.project, 'assets/unsafe')), false);
});

test('迁后报告通过旧source_path映射解析，不猜最新采用版', async t => {
  const f = fixture(t);
  const metadata = read(path.join(f.media, 'asset.json')); metadata.version = '1.1.0'; write(path.join(f.media, 'asset.json'), metadata);
  fs.writeFileSync(path.join(f.media, '图像 空格#1.png'), 'new adopted media bytes'); f.adopt('MEDIA', f.mediaPath);
  assert.equal((await migrateProject({ project: f.project, to: f.target })).ok, true);
  const audit = auditLinks({ project: f.target });
  assert.equal(audit.ok, true, audit.warnings.join('\n'));
  assert.equal(audit.resolved.every(item => item.target_version === '1.0.0'), true);
  const view = renderReport({ project: f.target, asset: 'IP991-REPORT-001', out: 'deliveries/views/exact-old' });
  assert.equal(view.ok, true); assert.equal(fs.readFileSync(path.join(view.output, 'assets/IP991-MEDIA-001/1.0.0/图像 空格#1.png'), 'utf8'), 'test media bytes version one');
});

test('歧义版本和未声明依赖保留警告，拒绝越界链接', t => {
  const f = fixture(t);
  const media = read(path.join(f.media, 'asset.json')); media.version = '1.1.0'; write(path.join(f.media, 'asset.json'), media); f.adopt('MEDIA', f.mediaPath);
  const report = read(path.join(f.report, 'asset.json')); report.version = '1.1.0'; report.refs.push(ref('MEDIA-001', '1.1.0')); write(path.join(f.report, 'asset.json'), report); f.adopt('REPORT', f.reportPath);
  const ambiguous = auditLinks({ project: f.project }); assert.equal(ambiguous.ok, false); assert.match(ambiguous.warnings.join('\n'), /多个版本/);
  report.version = '1.2.0'; report.refs = []; write(path.join(f.report, 'asset.json'), report);
  fs.writeFileSync(path.join(f.report, '制作报告.md'), '[undeclared](../../05_视觉资产/IP991-MEDIA-001/图像%20空格%231.png)\n[escape](../../../../outside.md)\n'); f.adopt('REPORT', f.reportPath);
  const invalid = auditLinks({ project: f.project }); assert.equal(invalid.ok, false); assert.match(invalid.warnings.join('\n'), /未列入精确依赖/); assert.match(invalid.warnings.join('\n'), /越出项目/);
});

test('源符号链接/目录联接被只读预检拒绝', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(f.project, '00_项目管理', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前主机不允许创建测试链接'); return; } throw error; }
  const result = await migrationPreflight({ project: f.project, to: f.target }); assert.equal(result.ok, false); assert.match(result.errors.join('\n'), /符号链接|目录联接/);
});

test('续作包新增派生报告视图，包内冻结assets字节保持', t => {
  const f = fixture(t), pack = resumeProject({ project: f.project, out: '00_项目管理/续作测试' }).output;
  const before = files(path.join(pack, 'assets'));
  const result = renderPackageLinks({ project: f.project, output: pack });
  assert.equal(result.ok, true, result.warnings.join('\n')); assert.deepEqual(files(path.join(pack, 'assets')), before);
  const body = fs.readFileSync(path.join(pack, '续作说明.md'), 'utf8'); assert.match(body, /报告阅读视图/);
});

test('同REPORT历史说明也生成可读链接，原历史Markdown字节不变', t => {
  const f = fixture(t), historical = path.join(f.project, '.ip-system/snapshots/IP991-REPORT-001/1.0.0/制作报告.md'), original = fs.readFileSync(historical);
  const metadata = read(path.join(f.report, 'asset.json')); metadata.version = '1.1.0'; write(path.join(f.report, 'asset.json'), metadata);
  fs.appendFileSync(path.join(f.report, '制作报告.md'), '[历史报告](../../.ip-system/snapshots/IP991-REPORT-001/1.0.0/制作报告.md)\n'); f.adopt('REPORT', f.reportPath);
  const result = renderReport({ project: f.project, asset: 'IP991-REPORT-001', out: 'deliveries/views/historical' });
  assert.equal(result.ok, true, result.warnings.join('\n')); assert.equal(result.stats.reports, 2);
  assert.deepEqual(fs.readFileSync(historical), original);
  assert.equal(fs.existsSync(path.join(result.output, 'reports/IP991-REPORT-001/1.0.0/制作报告.md')), true);
});

test('派生链接编码空格井号及不配对括号，保持合法Markdown目标', t => {
  const f = fixture(t), filename = '图(片 #2.png';
  const media = read(path.join(f.media, 'asset.json')); media.version = '1.1.0'; media.data.files[0].path = filename; write(path.join(f.media, 'asset.json'), media);
  fs.renameSync(path.join(f.media, '图像 空格#1.png'), path.join(f.media, filename)); f.adopt('MEDIA', f.mediaPath);
  const report = read(path.join(f.report, 'asset.json')); report.version = '1.1.0'; report.refs = [ref('MEDIA-001', '1.1.0')]; write(path.join(f.report, 'asset.json'), report);
  fs.writeFileSync(path.join(f.report, '制作报告.md'), '[括号文件](../../05_视觉资产/IP991-MEDIA-001/图%28片%20%232.png)\n'); f.adopt('REPORT', f.reportPath);
  const result = renderReport({ project: f.project, asset: 'IP991-REPORT-001', out: 'deliveries/views/parens' }); assert.equal(result.ok, true);
  const markdown = path.join(result.output, 'reports/IP991-REPORT-001/1.1.0/制作报告.md'), body = fs.readFileSync(markdown, 'utf8'), link = /\]\(([^)]+)\)/.exec(body)[1];
  assert.match(link, /%28/); assert.equal(link.includes('('), false);
  assert.equal(fs.existsSync(path.resolve(path.dirname(markdown), decodeURIComponent(link))), true);
});

test('报告读取共用冻结完整性门禁，额外文件也拒绝', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, '.ip-system/snapshots/IP991-MEDIA-001/1.0.0/未登记附件.txt'), 'extra snapshot file');
  const result = auditLinks({ project: f.project }); assert.equal(result.ok, false); assert.match(result.errors.join('\n'), /文件清单不一致/);
});

test('交付事务视图只接受本进程准确锁token，不开放系统目录写入', t => {
  const f = fixture(t), id = crypto.randomUUID(), token = crypto.randomUUID(), stage = path.join(f.project, '.ip-system/transactions', id, 'resume');
  fs.mkdirSync(stage, { recursive: true });
  write(path.join(stage, '续作信息.json'), { assets: [{ asset_id: 'IP991-REPORT-001', version: '1.0.0' }] }); fs.writeFileSync(path.join(stage, '续作说明.md'), '# 测试交付事务\n');
  const lock = path.join(f.project, '.ip-system/write.lock'); write(lock, { token, pid: process.pid, host: os.hostname() });
  try {
    assert.equal(renderPackageLinks({ project: f.project, output: stage, transactionToken: 'wrong-token' }).ok, false);
    assert.equal(fs.existsSync(path.join(stage, 'views')), false);
    assert.equal(renderPackageLinks({ project: f.project, output: path.join(f.project, '.ip-system/snapshots/IP991-REPORT-001/1.0.0'), transactionToken: token }).ok, false);
    const result = renderPackageLinks({ project: f.project, output: stage, transactionToken: token }); assert.equal(result.ok, true, result.errors.join('\n'));
  } finally { fs.unlinkSync(lock); }
});

test('根报告引用的历史说明未声明媒体依赖时生成明确诊断页，不猜素材且不阻断根阅读', t => {
  const f = fixture(t), secondary = path.join(f.project, '05_视觉资产/IP991-MEDIA-002');
  fs.mkdirSync(secondary);
  const media = read(path.join(f.media, 'asset.json')); media.asset_id = 'IP991-MEDIA-002'; write(path.join(secondary, 'asset.json'), media);
  fs.writeFileSync(path.join(secondary, '图像 空格#1.png'), 'unreferenced historical media'); saveVersion({ project: f.project, path: '05_视觉资产/IP991-MEDIA-002' });
  const historicalBody = '# 历史来源说明\n\n![早期参考](../../05_视觉资产/IP991-MEDIA-002/图像%20空格%231.png)\n';
  const metadata = read(path.join(f.report, 'asset.json')); metadata.version = '1.0.1'; write(path.join(f.report, 'asset.json'), metadata);
  fs.writeFileSync(path.join(f.report, '制作报告.md'), historicalBody); f.adopt('REPORT', f.reportPath);
  metadata.version = '1.1.0'; write(path.join(f.report, 'asset.json'), metadata);
  fs.writeFileSync(path.join(f.report, '制作报告.md'), '# 当前报告\n\n[正式图片](../../05_视觉资产/IP991-MEDIA-001/图像%20空格%231.png)\n[历史说明](../../.ip-system/snapshots/IP991-REPORT-001/1.0.1/制作报告.md)\n'); f.adopt('REPORT', f.reportPath);
  const before = files(path.join(f.project, '.ip-system'));
  const result = renderReport({ project: f.project, asset: 'IP991-REPORT-001', out: 'deliveries/views/history-diagnosis' });
  assert.equal(result.ok, true, result.errors.join('\n')); assert.equal(result.root_issues.length, 0); assert.equal(result.historical_issues.length, 1);
  const issue = result.historical_issues[0]; assert.equal(issue.asset_id, 'IP991-REPORT-001'); assert.equal(issue.version, '1.0.1'); assert.equal(issue.scope, 'historical'); assert.match(issue.reason, /未列入精确依赖/);
  assert.equal(result.warnings.some(message => message.includes('IP991-MEDIA-002')), true);
  const issuePath = path.join(result.output, issue.issue_page), diagnostic = fs.readFileSync(issuePath, 'utf8');
  assert.match(diagnostic, /素材状态：未定位/); assert.match(diagnostic, /IP991-REPORT-001@1.0.1/); assert.match(diagnostic, /IP991-MEDIA-002/);
  const rendered = path.join(result.output, 'reports/IP991-REPORT-001/1.0.1/制作报告.md'), body = fs.readFileSync(rendered, 'utf8');
  assert.equal(body.includes('!['), false); assert.match(body, /未定位链接说明/);
  const diagnosticLink = /\]\(([^)]+)\)/.exec(body)[1]; assert.equal(path.resolve(path.dirname(rendered), decodeURIComponent(diagnosticLink)), issuePath);
  assert.equal(fs.existsSync(path.join(result.output, 'assets/IP991-MEDIA-002')), false);
  assert.equal(fs.readFileSync(path.join(result.output, 'assets/IP991-REPORT-001/1.0.1/制作报告.md'), 'utf8'), historicalBody);
  assert.deepEqual(files(path.join(f.project, '.ip-system')), before);
  const failedRoot = renderReport({ project: f.project, asset: 'IP991-REPORT-001', version: '1.0.1', out: 'deliveries/views/root-diagnosis' });
  assert.equal(failedRoot.ok, false); assert.equal(failedRoot.root_issues.length, 1); assert.equal(failedRoot.historical_issues.length, 0);
  assert.equal(fs.existsSync(path.join(failedRoot.output, failedRoot.root_issues[0].issue_page)), true);
  const pack = resumeProject({ project: f.project, out: '00_项目管理/历史问题交接' }).output;
  const packaged = renderPackageLinks({ project: f.project, output: pack });
  assert.equal(packaged.ok, true); assert.equal(packaged.historical_issues.length, 1); assert.equal(packaged.root_issues.length, 0);
  assert.equal(fs.existsSync(path.join(pack, packaged.historical_issues[0].issue_page)), true);
  const chineseDescription = fs.readFileSync(path.join(pack, '续作说明.md'), 'utf8');
  assert.match(chineseDescription, /根报告未定位 0 项，引用的历史说明未定位 1 项/);
  assert.match(chineseDescription, /素材仍为未定位/); assert.match(chineseDescription, /未列入精确依赖/);
  assert.equal(chineseDescription.includes(`](${packaged.historical_issues[0].issue_page})`), true);
});
