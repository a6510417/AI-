import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, newAsset, saveVersion, retireAsset, cleanupDeletedAssets, projectStatus, validateProject } from '../src/project-service.mjs';
import { dispatch } from '../src/cli.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-deleted-candidates-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const project = initProject({ root, id: 'IP711', name: '已删候选核验' }).project;
  const registry = () => read(path.join(project, 'project.json'));
  const work = id => path.join(project, registry().assets.find(entry => entry.asset_id === id).path);
  const removeWork = id => { const directory = work(id); assert.ok(directory.startsWith(project + path.sep)); fs.rmSync(directory, { recursive: true }); };
  return { project, registry, work, removeWork };
}
function media(f) {
  const { asset_id: id } = newAsset({ project: f.project, type: 'MEDIA', title: '未采用图片候选' });
  saveVersion({ project: f.project, asset: id });
  retireAsset({ project: f.project, asset: id, reason: '放弃候选' });
  return id;
}

test('中文入口移除已删候选的现行登记，保留历史字节并继续使用新编号', async t => {
  const f = fixture(t), ids = [media(f), media(f), media(f)];
  const before = ids.map(id => fs.readFileSync(path.join(f.project, '.ip-system/snapshots', id, '1.0.0/_snapshot.json')));
  const oldOperations = f.registry().operations;
  ids.forEach(f.removeWork);
  assert.equal(projectStatus({ project: f.project }).ok, false);
  const result = await dispatch('清理已删候选', { project: f.project, assets: ids.join(','), reason: '用户已删除三个弃用工作目录' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, ids);
  assert.equal(projectStatus({ project: f.project }).ok, true);
  assert.equal(validateProject({ project: f.project }).ok, true);
  assert.deepEqual(f.registry().operations.slice(0, oldOperations.length), oldOperations);
  assert.deepEqual(f.registry().operations.at(-1).removed_assets.map(entry => entry.asset_id), ids);
  ids.forEach((id, index) => assert.deepEqual(fs.readFileSync(path.join(f.project, '.ip-system/snapshots', id, '1.0.0/_snapshot.json')), before[index]));
  assert.throws(() => newAsset({ project: f.project, type: 'MEDIA', sequence: '001' }), /编号已使用/);
  assert.equal(newAsset({ project: f.project, type: 'MEDIA' }).asset_id, 'IP711-MEDIA-004');
});

test('工作目录仍在或候选未退役时拒绝清理，不写清单', t => {
  const f = fixture(t), id = media(f);
  let before = fs.readFileSync(path.join(f.project, 'project.json'));
  assert.throws(() => cleanupDeletedAssets({ project: f.project, assets: id, reason: '核验' }), /工作目录仍存在/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), before);
  const active = newAsset({ project: f.project, type: 'MEDIA' }).asset_id;
  f.removeWork(active);
  before = fs.readFileSync(path.join(f.project, 'project.json'));
  assert.throws(() => cleanupDeletedAssets({ project: f.project, assets: active, reason: '核验' }), /退役候选/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), before);
});

for (const historical of [false, true]) test(`拒绝清理仍被${historical ? '历史快照' : '工作稿'}引用的候选`, t => {
  const f = fixture(t), id = media(f);
  const other = newAsset({ project: f.project, type: 'REPORT', title: '候选引用核验' }).asset_id;
  const file = path.join(f.work(other), 'asset.json'), asset = read(file);
  asset.refs = [{ asset_id: id, version: '1.0.0' }]; write(file, asset);
  if (historical) {
    saveVersion({ project: f.project, asset: other });
    asset.refs = []; asset.version = '1.0.1'; write(file, asset);
  }
  f.removeWork(id);
  const before = fs.readFileSync(path.join(f.project, 'project.json'));
  assert.throws(() => cleanupDeletedAssets({ project: f.project, assets: id, reason: '核验引用阻断' }), /仍引用/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), before);
});

test('历史快照损坏时拒绝清理，不用移除登记掩盖问题', t => {
  const f = fixture(t), id = media(f);
  f.removeWork(id);
  fs.appendFileSync(path.join(f.project, '.ip-system/snapshots', id, '1.0.0/asset.json'), '\n');
  const before = fs.readFileSync(path.join(f.project, 'project.json'));
  assert.throws(() => cleanupDeletedAssets({ project: f.project, assets: id, reason: '核验完整性' }), /校验|文件/);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.json')), before);
});
