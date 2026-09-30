import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { SYSTEM, object, filled, fail, hash, now, jsonText } from './rules.mjs';
import { safePath, readJSON, writeSynced, fingerprint, compareFiles, atomicJSON, PROJECT_HASHES } from './storage.mjs';
import { readProject, registryErrors } from './registry.mjs';
import { workingPath, outputPath } from './layout.mjs';
import { ensureNoErrors } from './dependencies.mjs';
export function pendingStatus(root) { return fs.existsSync(safePath(root, `${SYSTEM}/pending.json`)); }
export function transactionBase(root) {
  const relative = `${SYSTEM}/transactions/${crypto.randomUUID()}`;
  const directory = safePath(root, relative);
  fs.mkdirSync(directory, { recursive: true });
  return { relative, directory };
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
  // The durable registry is committed. Leave any unrelated scratch data for inspection.
  fs.unlinkSync(filename);
  // Only remove an empty UUID container named by this committed transaction.
  for (const relative of new Set(pending.moves.map(move => move.staged.split('/').slice(0, 3).join('/')))) {
    if (!/^\.ip-system\/transactions\/[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(relative)) continue;
    const directory = safePath(root, relative);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory() && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
  }
  return { action: pending.action, recovered_at: now() };
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
export function withLock(root, action) {
  root = path.resolve(root);
  readProject(root);
  fs.mkdirSync(safePath(root, SYSTEM), { recursive: true });
  const lockFile = safePath(root, `${SYSTEM}/write.lock`);
  const token = crypto.randomUUID();
  const lock = { pid: process.pid, host: os.hostname(), token, started_at: now() };
  try { writeSynced(lockFile, jsonText(lock)); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = readJSON(lockFile); } catch { fail('项目写入锁无法识别；请保留锁文件并确认原进程状态'); }
    if (!Number.isInteger(existing.pid) || existing.pid <= 0 || existing.host !== os.hostname() || !filled(existing.token)) fail('项目写入锁属于其他机器或格式无效，不能自动解除');
    let alive = true;
    try { process.kill(existing.pid, 0); } catch (killError) { if (killError.code === 'ESRCH') alive = false; }
    if (alive) fail(`项目正被进程 ${existing.pid} 写入，请稍后重试`);
    // Exactly one process may retire a particular stale token. Claims are durable:
    // a late contender cannot unlink a fresh lock acquired after stale cleanup.
    const claimDirectory = safePath(root, `${SYSTEM}/lock-recovery-claims`);
    fs.mkdirSync(claimDirectory, { recursive: true });
    const claimFile = safePath(root, `${SYSTEM}/lock-recovery-claims/${hash(existing.token)}.json`);
    try { writeSynced(claimFile, jsonText({ stale_token: existing.token, recovering_pid: process.pid, recovering_token: token, host: os.hostname(), started_at: now() })); }
    catch (claimError) {
      if (claimError.code === 'EEXIST') fail('该旧锁已有恢复操作取得独占权，请稍后重试；若恢复进程已中断，保留 lock-recovery-claims 与 write.lock 供核对，不自动删除活动锁');
      throw claimError;
    }
    const latest = readJSON(lockFile);
    if (latest.token !== existing.token || latest.pid !== existing.pid || latest.host !== existing.host) fail('写入锁已被其他操作更换，拒绝解除；请稍后重试');
    fs.unlinkSync(lockFile);
    try { writeSynced(lockFile, jsonText(lock)); } catch { fail('项目写入锁已被另一操作取得，请稍后重试'); }
  }
  try {
    const recovered = recover(root);
    const result = action(root);
    if (recovered) result.recovered_transaction = recovered;
    return result;
  } finally {
    if (fs.existsSync(lockFile) && readJSON(lockFile).token === token) fs.unlinkSync(lockFile);
  }
}
