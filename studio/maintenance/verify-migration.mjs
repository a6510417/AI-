import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { projectStatus, validateProject, safePath } from '../src/project-service.mjs';

const [sourceArgument, targetArgument] = process.argv.slice(2);
if (!sourceArgument || !targetArgument) throw new Error('需要原项目与迁移项目目录两个参数');
const source = path.resolve(sourceArgument), target = path.resolve(targetArgument);
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const original = json(path.join(source, 'project.json')), migrated = json(path.join(target, 'project.json'));
assert.equal(original.schema_version, 1);
assert.equal(migrated.schema_version, 2);
assert.equal(migrated.project_id, original.project_id);
assert.equal(migrated.name, original.name);
assert.equal(migrated.assets.length, original.assets.length);
for (const key of ['adoption_history', 'content_reviews', 'review_items', 'review_dispositions']) assert.deepEqual(migrated[key], original[key], `${key} 历史不能改变`);
for (const key of ['exports', 'resumes']) {
  const before = original[key] ?? [], after = migrated[key] ?? [];
  assert.deepEqual(after.slice(0, before.length), before, `${key} 原历史不能改变；新交付只追加`);
}
assert.deepEqual(migrated.operations.slice(0, original.operations.length), original.operations, '原操作证据不能改变');
let assetFiles = 0, historyFiles = 0, mediaFiles = 0;
function compareTrees(before, after, counter) {
  const oldEntries = fs.readdirSync(before, { withFileTypes: true });
  const newEntries = fs.readdirSync(after, { withFileTypes: true });
  assert.deepEqual(newEntries.map(item => item.name).sort(), oldEntries.map(item => item.name).sort(), `文件清单不一致 ${before}`);
  for (const entry of oldEntries) {
    assert.equal(entry.isSymbolicLink(), false);
    const oldFile = path.join(before, entry.name), newFile = path.join(after, entry.name);
    if (entry.isDirectory()) compareTrees(oldFile, newFile, counter);
    else { assert.equal(hash(newFile), hash(oldFile), `文件字节变化 ${oldFile}`); counter(); }
  }
}
for (const entry of original.assets) {
  const next = migrated.assets.find(item => item.asset_id === entry.asset_id);
  assert.ok(next);
  assert.equal(next.path, `assets/${entry.type}/${entry.asset_id}`);
  const expected = { ...entry, path: next.path, ...(next.lifecycle ? { lifecycle: next.lifecycle } : {}) };
  assert.deepEqual(next, expected, `资产登记只应改变路径和显式退役状态 ${entry.asset_id}`);
  compareTrees(safePath(source, entry.path), safePath(target, next.path), () => assetFiles++);
  if (entry.type === 'MEDIA' && entry.adopted_version) {
    const saved = entry.versions.find(item => item.version === entry.adopted_version);
    const asset = json(safePath(target, `${saved.path}/asset.json`));
    mediaFiles += asset.data.files.length;
  }
}
for (const folder of ['snapshots', 'reviews', 'transactions']) compareTrees(path.join(source, '.ip-system', folder), path.join(target, '.ip-system', folder), () => historyFiles++);
const record = json(safePath(target, migrated.migration.record));
assert.equal(record.status, 'complete');
for (const file of record.files) {
  assert.equal(hash(safePath(source, file.from)), file.sha256, `源记录变化 ${file.from}`);
  assert.equal(hash(safePath(target, file.to)), file.sha256, `迁移记录校验失败 ${file.to}`);
}
const status = projectStatus({ project: target });
const validation = validateProject({ project: target, strict: true });
assert.equal(status.ok, true, status.errors.join('\n'));
assert.equal(validation.ok, true, validation.errors.join('\n'));
assert.deepEqual(validation.warnings, []);
assert.equal(status.adopted.length, original.assets.filter(entry => entry.adopted_version).length);
assert.equal(status.assets.some(entry => entry.unsaved_changes), false);
console.log(JSON.stringify({ ok: true, checked_at: new Date().toISOString(), source, target, assets: status.assets.length, versions: status.assets.reduce((total, entry) => total + entry.versions, 0), adopted: status.adopted.length, pending: status.pending.length, retired: status.retired?.length ?? 0, asset_files_byte_identical: assetFiles, history_files_byte_identical: historyFiles, copied_materials_byte_identical: record.files.length, adopted_media_attachments: mediaFiles, strict_errors: validation.errors, strict_warnings: validation.warnings, scope: '文件字节、结构、精确版本与审核历史；未阅读小说语义或进行媒体视听验收' }, null, 2));
