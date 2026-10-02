import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject, newAsset, saveVersion, recordReview, adoptVersion, exportProject, resumeProject, recoverProject, CHAPTER_FILES } from '../src/project-service.mjs';
import { withLock } from '../src/transactions.mjs';
import { hash, jsonText } from '../src/rules.mjs';

const cli = fileURLToPath(new URL('../bin/studio.mjs', import.meta.url));
const serviceURL = new URL('../src/project-service.mjs', import.meta.url).href;
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => fs.writeFileSync(filename, jsonText(value));
const registry = project => json(path.join(project, 'project.json'));
const work = (project, asset) => path.join(project, registry(project).assets.find(entry => entry.asset_id === asset).path);
const lockFile = project => path.join(project, '.ip-system/write.lock');
const claimPath = (project, stale, previous) => path.join(project, '.ip-system/lock-recovery-claims', `${hash(previous === undefined ? stale : `claim-successor:${stale}:${previous}`)}.json`);
function fixture(t, schemaVersion = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-recovery-regression-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, project: initProject({ root, id: 'IP790', name: '隔离恢复夹具', schemaVersion }).project };
}
function exitedPID() {
  const run = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  const pid = Number(run.stdout.trim());
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  return pid;
}
function staleLock(project, pid = exitedPID()) {
  const lock = { pid, host: os.hostname(), token: crypto.randomUUID(), started_at: new Date().toISOString() };
  write(lockFile(project), lock);
  return lock;
}
function claim(project, lock, extra = {}, previous) {
  const file = claimPath(project, lock.token, previous);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { stale_token: lock.token, recovering_pid: lock.pid, recovering_token: crypto.randomUUID(), host: os.hostname(), started_at: new Date().toISOString(), ...(previous === undefined ? {} : { previous_recovering_token: previous }), ...extra };
  write(file, data);
  return { file, data };
}
function interruptMove(kind, action) {
  const rename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = (from, to) => {
    if (!interrupted && String(from).includes(`${path.sep}transactions${path.sep}`) && path.basename(String(from)) === kind) { interrupted = true; throw new Error(`模拟${kind}提交中断`); }
    return rename(from, to);
  };
  try { assert.throws(action, /模拟.*提交中断/); }
  finally { fs.renameSync = rename; }
  assert.equal(interrupted, true);
}
function draft(project, type, data) {
  const asset = newAsset({ project, type, title: `${type}恢复测试` }).asset_id;
  const filename = path.join(work(project, asset), 'asset.json'), value = json(filename);
  value.data = data; write(filename, value);
  return asset;
}
function review(project, asset) {
  const file = `production/恢复审核-${crypto.randomUUID()}.json`;
  write(path.join(project, file), { method: 'ai', reviewer: '恢复测试夹具', scope: '隔离测试资产的全部结构和内容', coverage: 'full', result: 'pass', issues: [], evidence: '仅验证精确快照恢复，不代表实际文学或媒体检查。' });
  return recordReview({ project, asset, version: '1.0.0', file });
}
function adopt(project, asset) {
  saveVersion({ project, asset });
  adoptVersion({ project, asset, version: '1.0.0', reason: '隔离恢复测试采用', review: review(project, asset).review_id });
}
function bridge(project) {
  const ref = type => ({ asset_id: `IP790-${type}-001`, version: '1.0.0' });
  const event = { ...ref('CH'), event_id: 'E01' };
  for (const [type, data] of [
    ['LOC', { description: '石塔灯室' }],
    ['CH', { events: [{ event_id: 'E01', story_time: '第一夜', summary: '交还钥匙' }] }],
    ['EP', { episode_number: 1, chapter_refs: [ref('CH')] }],
    ['SC', { scene_number: 1, episode: ref('EP'), location: ref('LOC'), source_refs: [event], script: '来客接稳钥匙后，守灯人松手。' }],
    ['SHOT', { episode: ref('EP'), scene: ref('SC'), source_refs: [event], shot_number: 1, start_seconds: 0, duration_seconds: 5, story_time: '第一夜', scene_description: '石塔灯室', characters: '守灯人与来客', action: '来客接稳钥匙后守灯人松手', emotion: '释然', dialogue: '无', shot_size: '双手近景', camera_movement: '固定', lighting: '暖光', video_prompt: '同一把钥匙由守灯人交给来客，接稳后松手。', visual_description: '同一把钥匙清晰可见' }],
  ]) {
    const asset = draft(project, type, data);
    if (type === 'CH') {
      fs.writeFileSync(path.join(work(project, asset), '正文.md'), '来客接稳钥匙后，守灯人才松开手。');
      for (const filename of CHAPTER_FILES.slice(1)) write(path.join(work(project, asset), filename), { project_id: 'IP790', chapter_id: asset, version: '1.0.0', entries: filename === '新增设定.json' ? [] : ['交还钥匙的真实测试状态'] });
    }
    adopt(project, asset);
  }
}
function runCLI(project, command, extra = [], asJSON = true) {
  return spawnSync(process.execPath, [cli, command, '--project', project, ...extra, ...(asJSON ? ['--json'] : [])], { encoding: 'utf8' });
}
test('recover无事务重复运行不增资产、审核、采用或操作日志，CLI返回显式null', t => {
  const { project } = fixture(t), before = fs.readFileSync(path.join(project, 'project.json'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = recoverProject({ project });
    assert.equal(result.ok, true); assert.equal(result.action, 'recover');
    assert.equal(result.recovered_transaction, null); assert.equal(result.recovered_lock, null);
  }
  const run = runCLI(project, 'recover'); assert.equal(run.status, 0, run.stdout);
  assert.equal(JSON.parse(run.stdout).recovered_transaction, null);
  assert.deepEqual(fs.readFileSync(path.join(project, 'project.json')), before);
  assert.equal(fs.existsSync(lockFile(project)), false);
});
for (const kind of ['asset', 'snapshot', 'review', 'resume', 'export']) test(`recover只完成已有${kind}事务，重复恢复不追加业务记录`, t => {
  const { project } = fixture(t);
  let asset;
  if (kind === 'snapshot' || kind === 'review') asset = draft(project, 'WORLD', { rules: ['钥匙不可复制'] });
  if (kind === 'review') saveVersion({ project, asset });
  if (kind === 'export') bridge(project);
  interruptMove(kind, () => {
    if (kind === 'asset') newAsset({ project, type: 'WORLD', title: '只创建一次的世界' });
    if (kind === 'snapshot') saveVersion({ project, asset });
    if (kind === 'review') review(project, asset);
    if (kind === 'resume') resumeProject({ project, out: 'deliveries/resume/中断包' });
    if (kind === 'export') exportProject({ project, out: 'deliveries/handoff/中断包' });
  });
  const pending = json(path.join(project, '.ip-system/pending.json'));
  const result = recoverProject({ project });
  assert.equal(result.recovered_transaction.action, pending.action);
  assert.deepEqual(registry(project), pending.registry_after);
  assert.equal(fs.existsSync(path.join(project, '.ip-system/pending.json')), false);
  const after = fs.readFileSync(path.join(project, 'project.json'));
  assert.equal(recoverProject({ project }).recovered_transaction, null);
  assert.deepEqual(fs.readFileSync(path.join(project, 'project.json')), after);
  if (kind === 'asset') assert.equal(registry(project).assets.length, 1);
});
test('自动恢复后同版本保存抛错仍保留已恢复上下文', t => {
  const { project } = fixture(t), asset = draft(project, 'WORLD', { rules: ['钥匙不可复制'] });
  interruptMove('snapshot', () => saveVersion({ project, asset }));
  assert.throws(() => saveVersion({ project, asset }), error => {
    assert.match(error.message, /已保存/); assert.equal(error.recovered_transaction.action, 'save-version'); return true;
  });
  assert.equal(registry(project).assets[0].versions.length, 1);
});
test('CLI失败同时显示已恢复事务与旧锁，避免声称没有写入', t => {
  const { project } = fixture(t);
  interruptMove('asset', () => newAsset({ project, type: 'WORLD', title: '恢复后已存在' }));
  staleLock(project);
  const run = runCLI(project, 'new-asset', ['--type', 'WORLD', '--sequence', '001']);
  assert.equal(run.status, 1);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false); assert.match(result.errors[0], /资产已存在/);
  assert.equal(result.recovered_transaction.action, 'new-asset'); assert.equal(result.recovered_lock.kind, 'stale-lock');
  assert.equal(registry(project).assets.length, 1); assert.equal(fs.existsSync(lockFile(project)), false);
});
test('锁清理错误不遮蔽原业务异常或恢复上下文', t => {
  const { project } = fixture(t);
  interruptMove('asset', () => newAsset({ project, type: 'WORLD', title: '恢复后失败' }));
  const unlink = fs.unlinkSync;
  fs.unlinkSync = filename => { if (String(filename) === lockFile(project)) throw new Error('模拟锁清理失败'); return unlink(filename); };
  try {
    assert.throws(() => withLock(project, () => { throw new Error('原业务失败'); }), error => {
      assert.equal(error.message, '原业务失败'); assert.equal(error.recovered_transaction.action, 'new-asset'); assert.deepEqual(error.cleanup_errors, ['模拟锁清理失败']); return true;
    });
  } finally { fs.unlinkSync = unlink; }
});
for (const cleanup of ['pending-unlink', 'container-rmdir']) test(`事务清单已提交后${cleanup}失败仍报告持久结果，再恢复不重复登记`, t => {
  const { project } = fixture(t);
  interruptMove('asset', () => newAsset({ project, type: 'WORLD', title: '提交后清理中断' }));
  const pendingFile = path.join(project, '.ip-system/pending.json'), pending = json(pendingFile);
  const unlink = fs.unlinkSync, rmdir = fs.rmdirSync;
  fs.unlinkSync = filename => { if (cleanup === 'pending-unlink' && String(filename) === pendingFile) throw new Error('模拟提交后pending清理失败'); return unlink(filename); };
  fs.rmdirSync = filename => { if (cleanup === 'container-rmdir' && String(filename).includes(`${path.sep}transactions${path.sep}`)) throw new Error('模拟提交后容器清理失败'); return rmdir(filename); };
  try {
    assert.throws(() => recoverProject({ project }), error => {
      assert.match(error.message, /模拟提交后.*清理失败/); assert.equal(error.recovered_transaction.action, 'new-asset'); assert.deepEqual(error.cleanup_errors, [error.message]); return true;
    });
  } finally { fs.unlinkSync = unlink; fs.rmdirSync = rmdir; }
  assert.deepEqual(registry(project), pending.registry_after);
  const committed = fs.readFileSync(path.join(project, 'project.json'));
  recoverProject({ project });
  assert.deepEqual(fs.readFileSync(path.join(project, 'project.json')), committed); assert.equal(registry(project).assets.length, 1);
  assert.equal(fs.existsSync(pendingFile), false);
});
test('恢复临时文件损坏或清单外改时保留现场并拒绝恢复', t => {
  for (const cause of ['damaged', 'changed']) {
    const { project } = fixture(t);
    interruptMove('asset', () => newAsset({ project, type: 'WORLD', title: '不可猜测恢复' }));
    const pendingFile = path.join(project, '.ip-system/pending.json'), before = fs.readFileSync(pendingFile), pending = json(pendingFile);
    if (cause === 'damaged') fs.appendFileSync(path.join(project, pending.moves[0].staged, 'asset.json'), '损坏');
    else { const current = registry(project); current.name = '外部修改'; write(path.join(project, 'project.json'), current); }
    assert.throws(() => recoverProject({ project }), /校验值不一致|外部修改/);
    assert.deepEqual(fs.readFileSync(pendingFile), before); assert.equal(fs.existsSync(path.join(project, pending.moves[0].staged)), true);
  }
});
test('只有recover接替明确中断的claim，旧证据与项目清单保留', t => {
  const { project } = fixture(t), lock = staleLock(project), initial = claim(project, lock);
  const before = fs.readFileSync(initial.file), projectBefore = fs.readFileSync(path.join(project, 'project.json'));
  assert.throws(() => newAsset({ project, type: 'CHAR', title: '不应新增' }), /运行 recover/);
  const result = recoverProject({ project });
  assert.equal(result.recovered_lock.kind, 'interrupted-claim'); assert.equal(result.recovered_transaction, null);
  const successor = json(path.join(project, result.recovered_lock.claim_path)); assert.equal(successor.previous_recovering_token, initial.data.recovering_token);
  assert.deepEqual(fs.readFileSync(initial.file), before); assert.deepEqual(fs.readFileSync(path.join(project, 'project.json')), projectBefore);
  assert.equal(fs.existsSync(lockFile(project)), false);
});
test('接替恢复进程再次崩溃后可继续，沿链保留每次声明', t => {
  const { project } = fixture(t), lock = staleLock(project), initial = claim(project, lock);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; import {recoverProject} from ${JSON.stringify(serviceURL)}; const unlink=fs.unlinkSync; fs.unlinkSync=filename=>{if(String(filename).endsWith('write.lock'))process.exit(19);return unlink(filename);}; recoverProject({project:${JSON.stringify(project)}});`], { encoding: 'utf8' });
  assert.equal(child.status, 19, child.stderr);
  assert.equal(fs.existsSync(lockFile(project)), true);
  assert.equal(json(claimPath(project, lock.token, initial.data.recovering_token)).previous_recovering_token, initial.data.recovering_token);
  assert.equal(recoverProject({ project }).recovered_lock.kind, 'interrupted-claim');
  assert.equal(fs.readdirSync(path.dirname(initial.file)).length, 3);
});
test('活动、异机、未知或损坏锁不得解除', t => {
  for (const cause of ['active', 'foreign', 'unknown', 'damaged']) {
    const { project } = fixture(t), lock = staleLock(project, cause === 'active' ? process.pid : exitedPID());
    if (cause === 'foreign') write(lockFile(project), { ...lock, host: '另一台机器' });
    if (cause === 'damaged') fs.writeFileSync(lockFile(project), '{坏');
    const before = fs.readFileSync(lockFile(project)), kill = process.kill;
    if (cause === 'unknown') process.kill = () => { const error = new Error('无法核对'); error.code = 'EPERM'; throw error; };
    try { assert.throws(() => recoverProject({ project }), /活动|未知|机器|无法识别|状态未知|写入/); }
    finally { process.kill = kill; }
    assert.deepEqual(fs.readFileSync(lockFile(project)), before);
  }
});
test('活动、异机、损坏、token错误或循环claim不得接替', t => {
  for (const cause of ['active', 'foreign', 'damaged', 'token', 'cycle', 'unknown']) {
    const { project } = fixture(t), lock = staleLock(project), initial = claim(project, lock);
    if (cause === 'active') write(initial.file, { ...initial.data, recovering_pid: process.pid });
    if (cause === 'foreign') write(initial.file, { ...initial.data, host: '另一台机器' });
    if (cause === 'damaged') fs.writeFileSync(initial.file, '{坏');
    if (cause === 'token') write(initial.file, { ...initial.data, stale_token: '另一把锁' });
    if (cause === 'cycle') {
      const second = claim(project, lock, {}, initial.data.recovering_token);
      claim(project, lock, { recovering_token: initial.data.recovering_token }, second.data.recovering_token);
    }
    if (cause === 'unknown') write(initial.file, { ...initial.data, recovering_pid: 987654 });
    const beforeLock = fs.readFileSync(lockFile(project)), beforeClaim = fs.readFileSync(initial.file), kill = process.kill;
    if (cause === 'unknown') process.kill = (pid, signal) => { if (pid === 987654) { const error = new Error('未知'); error.code = 'EPERM'; throw error; } return kill(pid, signal); };
    try { assert.throws(() => recoverProject({ project }), /独占权|无法识别|关系无效|循环/); }
    finally { process.kill = kill; }
    assert.deepEqual(fs.readFileSync(lockFile(project)), beforeLock); assert.deepEqual(fs.readFileSync(initial.file), beforeClaim);
  }
});
test('核对claim期间出现的新锁不得解除，finally也不删除替换锁', t => {
  const { project } = fixture(t), old = staleLock(project), replacement = { pid: process.pid, host: os.hostname(), token: crypto.randomUUID(), started_at: new Date().toISOString() };
  const read = fs.readFileSync; let reads = 0;
  fs.readFileSync = (filename, ...args) => { if (String(filename) === lockFile(project) && ++reads === 2) write(lockFile(project), replacement); return read(filename, ...args); };
  try { assert.throws(() => recoverProject({ project }), /更换/); } finally { fs.readFileSync = read; }
  assert.deepEqual(json(lockFile(project)), replacement);
  fs.unlinkSync(lockFile(project));
  assert.throws(() => withLock(project, () => { write(lockFile(project), replacement); throw new Error('保持新锁'); }), /保持新锁/);
  assert.deepEqual(json(lockFile(project)), replacement); assert.notEqual(old.token, replacement.token);
});
test('两个进程竞争中断claim时只有一个接替，迟到进程不解除活动锁', async t => {
  const { root, project } = fixture(t), lock = staleLock(project); claim(project, lock);
  const marker = path.join(root, '接替已取得'), release = path.join(root, '允许继续');
  const script = `import fs from 'node:fs'; import {recoverProject} from ${JSON.stringify(serviceURL)}; const unlink=fs.unlinkSync; fs.unlinkSync=filename=>{if(String(filename).endsWith('write.lock')&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'ready'); const wait=new Int32Array(new SharedArrayBuffer(4)),end=Date.now()+8000; while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw new Error('测试屏障超时');Atomics.wait(wait,0,0,5);}}return unlink(filename);};try{console.log(JSON.stringify(recoverProject({project:${JSON.stringify(project)}})));}catch(error){console.error(error.message);process.exitCode=1;}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise(resolve => child.on('close', resolve));
  const deadline = Date.now() + 6000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(marker), true);
  const other = runCLI(project, 'recover');
  fs.writeFileSync(release, 'go');
  assert.equal(await closed, 0, errors); assert.equal(other.status, 1); assert.match(other.stdout, /独占权/);
  assert.equal(JSON.parse(output).recovered_lock.kind, 'interrupted-claim');
  assert.equal(fs.existsSync(lockFile(project)), false); assert.equal(recoverProject({ project }).recovered_lock, null);
});
test('带参入口提供纯恢复并保留恢复后的业务失败上下文', t => {
  const { project } = fixture(t);
  const recovered = runCLI(project, 'recover', [], false);
  assert.equal(recovered.status, 0, recovered.stderr); assert.match(recovered.stdout, /没有待恢复事务或旧锁/);
  const asset = draft(project, 'WORLD', { rules: ['钥匙不可复制'] });
  interruptMove('snapshot', () => saveVersion({ project, asset }));
  const failure = runCLI(project, 'save-version', ['--asset', asset], false);
  assert.equal(failure.status, 1); assert.match(failure.stderr, /已保存/); assert.match(failure.stderr, /已确认事务提交：save-version/);
});
test('诊断阅读视图已写出但链接未通过时仍报告产物位置和检查问题', t => {
  const { project } = fixture(t), asset = draft(project, 'REPORT', { summary: '有明确断链的隔离报告' });
  fs.writeFileSync(path.join(work(project, asset), '报告.md'), '[未定位素材](missing.png)\n');
  saveVersion({ project, asset });
  const run = runCLI(project, 'render-report', ['--asset', asset, '--version', '1.0.0', '--out', 'deliveries/views/诊断'], false);
  assert.equal(run.status, 1); assert.match(run.stdout, /阅读视图已生成；链接检查未通过/); assert.match(run.stdout, /输出目录/);
  assert.equal(fs.existsSync(path.join(project, 'deliveries/views/诊断/view.json')), true);
});
