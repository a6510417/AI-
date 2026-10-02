import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { SYSTEM, object, filled, fail, hash, now, jsonText } from './rules.mjs';
import { safePath, readJSON, writeSynced, fingerprint, compareFiles, atomicJSON, PROJECT_HASHES } from './storage.mjs';
import { readProject, registryErrors, readSnapshot } from './registry.mjs';
import { workingPath, outputPath } from './layout.mjs';
import { ensureNoErrors } from './dependencies.mjs';
export function pendingStatus(root) { return fs.existsSync(safePath(root, `${SYSTEM}/pending.json`)); }
export function transactionBase(root) {
  const relative = `${SYSTEM}/transactions/${crypto.randomUUID()}`;
  const directory = safePath(root, relative);
  fs.mkdirSync(directory, { recursive: true });
  return { relative, directory };
}
function recoverWorkingRevision(root, move, project) {
  const entry = project.assets.find(item => item.path.replaceAll('\\', '/') === move.target);
  if (!entry) fail('工作稿修订目标未登记');
  const currentEntry = readProject(root).assets.find(item => item.asset_id === entry.asset_id);
  if (!currentEntry || currentEntry.path.replaceAll('\\', '/') !== move.target || currentEntry.type !== entry.type) fail('工作稿修订目标不是原清单中同一资产');
  const target = workingPath(root, move.target, project, entry);
  const match = typeof move.staged === 'string' && move.staged.match(/^(\.ip-system\/transactions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(.+)$/i);
  if (!match || move.backup !== `${match[1]}/原工作稿/${entry.asset_id}`) fail('工作稿修订备份必须位于同一事务的原工作稿目录');
  const staged = safePath(root, move.staged), backup = safePath(root, move.backup);
  const key = value => path.resolve(value).toLowerCase();
  const overlaps = (a, b) => key(a) === key(b) || key(a).startsWith(`${key(b)}${path.sep}`) || key(b).startsWith(`${key(a)}${path.sep}`);
  if (overlaps(staged, backup) || overlaps(staged, target) || overlaps(backup, target)) fail('工作稿修订的暂存、备份和目标不得相同或相互包含');
  if (!currentEntry.versions.some(item => item.version === move.base_version)) fail('工作稿修订基准必须是原清单中已保存的版本');
  const base = readSnapshot(root, project, entry.asset_id, move.base_version);
  compareFiles(move.before_files, base.manifest.files, '工作稿修订基准');
  const check = (directory, files, label) => compareFiles(fingerprint(root, directory), files, label);
  const beforeExists = fs.existsSync(backup);
  if (beforeExists) check(backup, move.before_files, '工作稿修订原件');
  if (fs.existsSync(staged)) check(staged, move.files, '工作稿修订暂存');
  if (beforeExists && fs.existsSync(target)) {
    check(target, move.files, '工作稿修订目标');
    return;
  }
  if (!fs.existsSync(staged)) fail('工作稿修订暂存缺失，不能继续替换');
  if (!beforeExists) {
    if (!fs.existsSync(target)) fail('工作稿修订目标与原件均缺失，不能恢复');
    check(target, move.before_files, '工作稿含未保存或并行修改');
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(target, backup);
    // A manual editor is not protected by the project lock; preserve and reject any changed original.
    check(backup, move.before_files, '移动期间工作稿原件');
  }
  if (fs.existsSync(target)) fail('工作稿修订目标被重新创建，保留原件并停止');
  check(staged, move.files, '提交前工作稿修订暂存');
  fs.renameSync(staged, target);
  check(target, move.files, '提交后工作稿修订目标');
}
export function recover(root) {
  const filename = safePath(root, `${SYSTEM}/pending.json`);
  if (!fs.existsSync(filename)) return null;
  const pending = readJSON(filename);
  if (pending.schema_version !== 1 || !object(pending.registry_after) || !/^[a-f0-9]{64}$/.test(pending.registry_before_sha256) || !Array.isArray(pending.moves)) fail('存在无法识别的中断事务，请保留 .ip-system/pending.json 后检查');
  const currentHash = hash(fs.readFileSync(safePath(root, 'project.json')));
  const afterHash = hash(jsonText(pending.registry_after));
  if (currentHash !== pending.registry_before_sha256 && currentHash !== afterHash) fail('中断事务期间 project.json 被外部修改，无法安全自动恢复；请先核对事务和项目清单');
  ensureNoErrors(registryErrors(root, pending.registry_after));
  for (const move of pending.moves) {
    if (typeof move.staged !== 'string' || !move.staged.startsWith(`${SYSTEM}/transactions/`)) fail('中断事务临时路径无效');
    const staged = safePath(root, move.staged);
    const target = safePath(root, move.target);
    if (move.kind === 'working-revision') {
      recoverWorkingRevision(root, move, pending.registry_after);
      continue;
    }
    if (move.kind === 'snapshot') {
      if (!move.target.startsWith(`${SYSTEM}/snapshots/`)) fail('中断快照目标路径无效');
    } else if (move.kind === 'export') {
      outputPath(root, move.target, pending.registry_after, 'export');
    } else if (move.kind === 'resume') {
      outputPath(root, move.target, pending.registry_after, 'resume');
    } else if (move.kind === 'working-asset') {
      const entry = pending.registry_after.assets.find(entry => entry.path.replaceAll('\\', '/') === move.target);
      if (!entry) fail('新资产事务目标未登记');
      workingPath(root, move.target, pending.registry_after, entry);
    } else if (move.kind === 'review') {
      if (!move.target.startsWith(`${SYSTEM}/reviews/`)) fail('中断审核记录目标路径无效');
    } else fail('中断事务类型无效');
    if (fs.existsSync(target)) compareFiles(fingerprint(root, target), move.files, '中断事务目标');
    else {
      if (!fs.existsSync(staged)) fail('中断事务的临时文件与目标均缺失，不能恢复');
      compareFiles(fingerprint(root, staged), move.files, '中断事务临时文件');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staged, target);
    }
  }
  if (currentHash !== afterHash) atomicJSON(safePath(root, 'project.json'), pending.registry_after);
  const summary = { action: pending.action, recovered_at: now() };
  try {
    // The durable registry is committed. Leave unrelated scratch data for inspection.
    fs.unlinkSync(filename);
    // Only remove an empty UUID container named by this committed transaction.
    for (const relative of new Set(pending.moves.map(move => move.staged.split('/').slice(0, 3).join('/')))) {
      if (!/^\.ip-system\/transactions\/[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(relative)) continue;
      const directory = safePath(root, relative);
      if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory() && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
    }
  } catch (error) {
    error.recovered_transaction = summary;
    error.cleanup_errors = [...(error.cleanup_errors ?? []), error.message];
    throw error;
  }
  return summary;
}
export function commit(root, project, { moves = [], action }) {
  const filename = safePath(root, `${SYSTEM}/pending.json`);
  if (fs.existsSync(filename)) fail('存在未恢复事务，拒绝启动另一个写入');
  const originalHash = PROJECT_HASHES.get(project);
  if (!originalHash || hash(fs.readFileSync(safePath(root, 'project.json'))) !== originalHash) fail('操作开始后 project.json 被外部修改，拒绝覆盖；工作稿及暂存文件已保留，请重新读取后重试');
  const pending = { schema_version: 1, action, at: now(), registry_before_sha256: originalHash, registry_after: project, moves };
  writeSynced(filename, jsonText(pending));
  recover(root);
}
function processExited(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  return false;
}
function readClaim(root, relative, existing, previousToken) {
  let claim;
  try { claim = readJSON(safePath(root, relative)); }
  catch { fail('旧锁恢复声明无法识别；请保留 lock-recovery-claims 与 write.lock 供核对'); }
  if (!object(claim) || claim.stale_token !== existing.token || claim.host !== os.hostname() || !Number.isInteger(claim.recovering_pid) || claim.recovering_pid <= 0 || !filled(claim.recovering_token) || claim.previous_recovering_token !== previousToken) fail('旧锁恢复声明的机器、进程或 token 关系无效；拒绝解除锁');
  return claim;
}
function claimStaleLock(root, existing, token, allowInterruptedClaims) {
  const directory = safePath(root, `${SYSTEM}/lock-recovery-claims`);
  fs.mkdirSync(directory, { recursive: true });
  let relative = `${SYSTEM}/lock-recovery-claims/${hash(existing.token)}.json`;
  const own = { stale_token: existing.token, recovering_pid: process.pid, recovering_token: token, host: os.hostname(), started_at: now() };
  try { writeSynced(safePath(root, relative), jsonText(own)); return { kind: 'stale-lock', claim_path: relative }; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  let previousToken;
  const seen = new Set([existing.token]);
  for (;;) {
    const claim = readClaim(root, relative, existing, previousToken);
    if (seen.has(claim.recovering_token)) fail('旧锁恢复声明形成循环；保留现场，拒绝解除锁');
    seen.add(claim.recovering_token);
    if (!processExited(claim.recovering_pid)) fail('该旧锁已有恢复操作取得独占权，恢复进程仍活动或状态未知；请稍后重试');
    if (!allowInterruptedClaims) fail('旧锁恢复进程已中断；请保留 lock-recovery-claims 与 write.lock，并运行 recover --project <项目目录> 核验恢复');
    previousToken = claim.recovering_token;
    relative = `${SYSTEM}/lock-recovery-claims/${hash(`claim-successor:${existing.token}:${previousToken}`)}.json`;
    // Immutable successor claims make takeover exclusive without deleting evidence.
    try {
      writeSynced(safePath(root, relative), jsonText({ ...own, previous_recovering_token: previousToken }));
      return { kind: 'interrupted-claim', claim_path: relative };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
export function withLock(root, action, { allowInterruptedClaims = false } = {}) {
  root = path.resolve(root);
  readProject(root);
  fs.mkdirSync(safePath(root, SYSTEM), { recursive: true });
  const lockFile = safePath(root, `${SYSTEM}/write.lock`);
  const token = crypto.randomUUID();
  const lock = { pid: process.pid, host: os.hostname(), token, started_at: now() };
  let acquired = false, recoveredTransaction = null, recoveredLock = null, result, failure;
  try {
    try { writeSynced(lockFile, jsonText(lock)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = readJSON(lockFile); } catch { fail('项目写入锁无法识别；请保留锁文件并确认原进程状态'); }
      if (!object(existing) || !Number.isInteger(existing.pid) || existing.pid <= 0 || existing.host !== os.hostname() || !filled(existing.token)) fail('项目写入锁属于其他机器或格式无效，不能自动解除');
      if (!processExited(existing.pid)) fail(`项目正被进程 ${existing.pid} 写入或进程状态未知，请稍后重试`);
      const claim = claimStaleLock(root, existing, token, allowInterruptedClaims);
      const latest = readJSON(lockFile);
      if (latest.token !== existing.token || latest.pid !== existing.pid || latest.host !== existing.host) fail('写入锁已被其他操作更换，拒绝解除；请稍后重试');
      if (!processExited(existing.pid)) fail('原锁进程仍活动或状态未知，拒绝解除');
      fs.unlinkSync(lockFile);
      recoveredLock = { ...claim, recovered_at: now() };
      try { writeSynced(lockFile, jsonText(lock)); } catch (lockError) { if (lockError.code === 'EEXIST') fail('项目写入锁已被另一操作取得，请稍后重试'); throw lockError; }
    }
    acquired = true;
    recoveredTransaction = recover(root);
    result = action(root);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (acquired) try {
      if (fs.existsSync(lockFile)) {
        const current = readJSON(lockFile);
        if (current.token === token && current.pid === process.pid && current.host === os.hostname()) fs.unlinkSync(lockFile);
      }
    } catch (error) {
      if (failure) failure.cleanup_errors = [...(failure.cleanup_errors ?? []), error.message];
      else failure = error;
    }
  }
  if (failure) {
    if (recoveredTransaction && !failure.recovered_transaction) failure.recovered_transaction = recoveredTransaction;
    if (recoveredLock) failure.recovered_lock = recoveredLock;
    throw failure;
  }
  if (recoveredTransaction) result.recovered_transaction = recoveredTransaction;
  if (recoveredLock) result.recovered_lock = recoveredLock;
  return result;
}
