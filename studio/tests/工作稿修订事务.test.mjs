import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initProject, newAsset, saveVersion, recoverProject } from '../src/project-service.mjs';
import { readProject, readSnapshot, operation } from '../src/registry.mjs';
import { transactionBase, commit, withLock } from '../src/transactions.mjs';
import { fingerprint } from '../src/storage.mjs';
import { jsonText } from '../src/rules.mjs';

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-working-revision-'));
  t.after(() => {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('studio-working-revision-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const project = initProject({ root: temporary, id: 'IP789', name: '工作稿修订隔离测试' }).project;
  const created = newAsset({ project, type: 'WORLD', title: '旧设定' });
  const target = created.path, directory = path.join(project, target), file = path.join(directory, 'asset.json');
  const asset = JSON.parse(fs.readFileSync(file, 'utf8'));
  asset.data = { premise: '来客须在入夜前归还灯笼。' };
  fs.writeFileSync(file, jsonText(asset));
  fs.writeFileSync(path.join(directory, '说明.md'), '原工作稿附件\n');
  saveVersion({ project, asset: created.asset_id });
  const before = fs.readFileSync(file);
  asset.version = '1.0.1';
  asset.title = '修订设定';
  asset.data = { premise: '来客须在钟响前归还灯笼。' };
  fs.writeFileSync(file, jsonText(asset));
  fs.writeFileSync(path.join(directory, '说明.md'), '修订工作稿附件\n');
  saveVersion({ project, asset: created.asset_id });
  const after = fs.readFileSync(file);
  fs.writeFileSync(file, before);
  fs.writeFileSync(path.join(directory, '说明.md'), '原工作稿附件\n');
  return { temporary, project, assetId: created.asset_id, target, directory, file, before, after };
}

function plan(f, mutate = () => {}) {
  return withLock(f.project, root => {
    const project = readProject(root), tx = transactionBase(root);
    const staged = `${tx.relative}/新工作稿/${f.assetId}`;
    const candidate = path.join(root, staged);
    const next = readSnapshot(root, project, f.assetId, '1.0.1');
    fs.mkdirSync(candidate, { recursive: true });
    for (const filename of Object.keys(next.manifest.files)) fs.copyFileSync(path.join(next.directory, filename), path.join(candidate, filename));
    const move = {
      kind: 'working-revision', target: f.target, staged,
      backup: `${tx.relative}/原工作稿/${f.assetId}`, base_version: '1.0.0',
      files: fingerprint(root, candidate), before_files: readSnapshot(root, project, f.assetId, '1.0.0').manifest.files,
    };
    operation(project, 'working-revision-test', { asset_id: f.assetId, version: '1.0.1' });
    mutate(move, project);
    commit(root, project, { action: 'working-revision-test', moves: [move] });
    return { ok: true, move };
  });
}

function interrupt(f, phase, action = () => plan(f)) {
  const rename = fs.renameSync;
  let hit = false;
  fs.renameSync = (from, to) => {
    const oldToBackup = from === f.directory;
    const newToTarget = to === f.directory && String(from).includes(`${path.sep}新工作稿${path.sep}`);
    if (!hit && ((phase === 'before-original' && oldToBackup) || (phase === 'after-original' && oldToBackup) || (phase === 'after-revision' && newToTarget))) {
      hit = true;
      if (phase !== 'before-original') rename(from, to);
      throw new Error(`模拟修订中断 ${phase}`);
    }
    return rename(from, to);
  };
  try { assert.throws(action, /模拟修订中断/); }
  finally { fs.renameSync = rename; }
  assert.equal(hit, true);
  return JSON.parse(fs.readFileSync(path.join(f.project, '.ip-system/pending.json'), 'utf8')).moves[0];
}

for (const phase of ['before-original', 'after-original', 'after-revision']) {
  test(`工作稿修订在${phase}中断后按精确指纹恢复且回执不重复`, t => {
    const f = fixture(t), beforeRegistry = fs.readFileSync(path.join(f.project, 'project.json'));
    const move = interrupt(f, phase);
    assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), beforeRegistry);
    const result = recoverProject({ project: f.project });
    assert.equal(result.recovered_transaction.action, 'working-revision-test');
    assert.deepEqual(fs.readFileSync(f.file), f.after);
    assert.deepEqual(fs.readFileSync(path.join(f.project, move.backup, 'asset.json')), f.before);
    assert.equal(fs.readFileSync(path.join(f.project, move.backup, '说明.md'), 'utf8'), '原工作稿附件\n');
    const afterRegistry = fs.readFileSync(path.join(f.project, 'project.json'));
    assert.equal(recoverProject({ project: f.project }).recovered_transaction, null);
    assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), afterRegistry);
    assert.equal(readProject(f.project).operations.filter(item => item.action === 'working-revision-test').length, 1);
  });
}

test('工作稿修订拒绝未保存正文或新增附件并完整保留用户文件', t => {
  for (const kind of ['text', 'attachment']) {
    const f = fixture(t);
    if (kind === 'text') fs.appendFileSync(f.file, '\n');
    else fs.writeFileSync(path.join(f.directory, '用户备注.md'), '尚未保存的用户意见');
    const before = fingerprint(f.project, f.directory);
    assert.throws(() => plan(f), /工作稿含未保存或并行修改/);
    assert.deepEqual(fingerprint(f.project, f.directory), before);
    assert.equal(readProject(f.project).operations.some(item => item.action === 'working-revision-test'), false);
  }
});

test('工作稿修订不信任伪造的before_files或未保存base_version', t => {
  for (const kind of ['fingerprint', 'version']) {
    const f = fixture(t);
    assert.throws(() => plan(f, move => {
      if (kind === 'fingerprint') move.before_files = { ...move.files };
      else move.base_version = '2.0.0';
    }), /修订基准/);
    assert.deepEqual(fs.readFileSync(f.file), f.before);
  }
});

test('修订暂存和原件必须留在同一事务受控路径，拒绝越界和互相包含', t => {
  const attempts = [
    move => { move.backup = 'production/覆盖这里'; },
    move => { move.backup = `.ip-system/transactions/${crypto.randomUUID()}/原工作稿/IP789-WORLD-001`; },
    move => { move.staged = 'production/.staging/他人的工作'; },
    move => { move.staged = move.backup; },
    move => { move.staged = `${move.backup}/嵌套`; },
    move => { move.backup = `${move.staged}/原工作稿/IP789-WORLD-001`; },
    move => { move.staged = move.staged.replace('/新工作稿/', '/../新工作稿/'); },
    move => { move.target = 'production/未登记'; },
  ];
  for (const mutate of attempts) {
    const f = fixture(t);
    assert.throws(() => plan(f, mutate), /工作稿修订|非法相对路径|中断事务临时路径无效/);
    assert.deepEqual(fs.readFileSync(f.file), f.before);
  }
});

test('修订恢复发现原件被修改或目标被重新创建时拒绝覆盖并保留现场', t => {
  for (const kind of ['backup', 'target', 'staged']) {
    const f = fixture(t), move = interrupt(f, 'after-original');
    const location = kind === 'backup' ? path.join(f.project, move.backup) : kind === 'staged' ? path.join(f.project, move.staged) : f.directory;
    fs.mkdirSync(location, { recursive: true });
    fs.writeFileSync(path.join(location, '并行备注.md'), '用户新写入的内容');
    const before = fingerprint(f.project, location);
    assert.throws(() => recoverProject({ project: f.project }), /工作稿修订/);
    assert.deepEqual(fingerprint(f.project, location), before);
    assert.equal(fs.existsSync(path.join(f.project, '.ip-system/pending.json')), true);
  }
});

test('修订必须先有完整暂存，缺失或损坏时不移动原工作稿', t => {
  for (const kind of ['missing', 'changed']) {
    const f = fixture(t);
    assert.throws(() => plan(f, move => {
      if (kind === 'missing') move.staged = move.staged.replace('/新工作稿/', '/不存在/');
      else fs.appendFileSync(path.join(f.project, move.staged, 'asset.json'), '\n');
    }), /工作稿修订暂存/);
    assert.deepEqual(fs.readFileSync(f.file), f.before);
  }
});

test('修订清单已持久化但清理pending中断，恢复只核对新稿和原件不重复登记', t => {
  const f = fixture(t), unlink = fs.unlinkSync;
  let hit = false;
  fs.unlinkSync = file => {
    if (!hit && String(file) === path.join(f.project, '.ip-system/pending.json')) {
      hit = true;
      throw new Error('模拟修订清单提交后中断');
    }
    return unlink(file);
  };
  try { assert.throws(() => plan(f), /模拟修订清单提交后中断/); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(hit, true);
  const registryBytes = fs.readFileSync(path.join(f.project, 'project.json'));
  assert.deepEqual(fs.readFileSync(f.file), f.after);
  assert.equal(readProject(f.project).operations.filter(item => item.action === 'working-revision-test').length, 1);
  assert.equal(recoverProject({ project: f.project }).recovered_transaction.action, 'working-revision-test');
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), registryBytes);
});
