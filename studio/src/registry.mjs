import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SYSTEM, TYPES, filled, VERSION, ASSET_ID as ID, object, fail, hash, now } from './rules.mjs';
import { safePath, readJSON, fingerprint, compareFiles, PROJECT_HASHES } from './storage.mjs';
import { workingPath } from './layout.mjs';
export function readProject(root, { migrationToken } = {}) {
  root = path.resolve(root);
  const incomplete = safePath(root, `${SYSTEM}/migration-incomplete.json`);
  if (fs.existsSync(incomplete)) {
    const marker = readJSON(incomplete);
    if (!filled(migrationToken) || !filled(marker.token) || migrationToken !== marker.token) fail('该目录迁移尚未完成，拒绝作为正式项目读取或写入；请核对迁移记录并使用已验证项目');
  }
  const filename = safePath(root, 'project.json');
  const bytes = fs.readFileSync(filename);
  let project;
  try { project = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch (error) { fail(`project.json：无法读取 UTF-8 JSON：${error.message}`); }
  if (!object(project) || ![1, 2].includes(project.schema_version) || !/^IP\d+$/.test(project.project_id) || !filled(project.name) || !Array.isArray(project.assets)) fail('project.json：需要 schema_version:1 或 2、IP数字格式 project_id、name 和 assets 数组');
  for (const key of ['adoption_history', 'operations', 'review_items', 'review_dispositions', 'content_reviews', 'exports', 'resumes', 'lifecycle_history']) if (project[key] !== undefined && !Array.isArray(project[key])) fail(`project.json/${key}：应为数组`);
  PROJECT_HASHES.set(project, hash(bytes));
  return project;
}
export function registryErrors(root, project) {
  const errors = [];
  if (!object(project) || ![1, 2].includes(project.schema_version) || !Array.isArray(project.assets)) return ['项目清单布局或资产列表无效'];
  const ids = new Set();
  const paths = [];
  const aliases = new Set();
  for (const [index, entry] of project.assets.entries()) {
    const label = `project.json/assets[${index}]`;
    try {
      if (!object(entry) || !ID.test(entry.asset_id)) fail(`${label}：asset_id 无效`);
      if (!entry.asset_id.startsWith(`${project.project_id}-`)) fail(`${label}：资产跨 IP`);
      if (!TYPES.includes(entry.type) || entry.asset_id.split('-')[1] !== entry.type) fail(`${label}：type 与 ID 不一致`);
      if (ids.has(entry.asset_id)) fail(`${label}：重复 ID ${entry.asset_id}`);
      ids.add(entry.asset_id);
      workingPath(root, entry.path, project, entry);
      if (project.schema_version === 2 && entry.lifecycle !== undefined && !['active', 'retired'].includes(entry.lifecycle)) fail(`${label}：lifecycle 只能为 active 或 retired`);
      if (project.schema_version === 2 && entry.lifecycle === 'retired' && entry.adopted_version) fail(`${label}：已采用资产不能作为候选退役`);
      const normalized = entry.path.replaceAll('\\', '/').toLowerCase();
      if (paths.some(other => other === normalized || other.startsWith(`${normalized}/`) || normalized.startsWith(`${other}/`))) fail(`${label}：工作资产路径重复或相互包含`);
      paths.push(normalized);
      if (!Array.isArray(entry.aliases ?? []) || (entry.aliases ?? []).some(alias => !filled(alias))) fail(`${label}：aliases 应为非空字符串数组`);
      for (const alias of entry.aliases ?? []) {
        if (aliases.has(alias)) fail(`${label}：旧编号别名重复 ${alias}`);
        aliases.add(alias);
      }
      if (!Array.isArray(entry.versions)) fail(`${label}：versions 应为数组`);
      const versions = new Set();
      for (const version of entry.versions) {
        if (!object(version) || !VERSION.test(version.version)) fail(`${label}：版本号无效`);
        if (versions.has(version.version)) fail(`${label}：重复版本 ${version.version}`);
        versions.add(version.version);
        if (version.path !== `${SYSTEM}/snapshots/${entry.asset_id}/${version.version}`) fail(`${label}：历史快照路径与 ID/版本不一致`);
        safePath(root, version.path);
        if (!/^[a-f0-9]{64}$/.test(version.manifest_sha256)) fail(`${label}：缺少历史校验值`);
      }
      if (entry.adopted_version != null && !versions.has(entry.adopted_version)) fail(`${label}：采用指针未指向已保存版本`);
    } catch (error) { errors.push(error.message); }
  }
  return errors;
}
export function findEntry(project, assetId) {
  const matches = project.assets.filter(entry => entry.asset_id === assetId);
  if (matches.length !== 1) fail(`资产 ${assetId} 未登记或 ID 重复`);
  return matches[0];
}
export function readSnapshot(root, project, assetId, version, cache = new Map()) {
  const key = `${assetId}@${version}`;
  if (cache.has(key)) return cache.get(key);
  const entry = findEntry(project, assetId);
  const saved = entry.versions.find(item => item.version === version);
  if (!saved) fail(`${key}：引用的版本不存在，请先保存上游版本`);
  if (saved.path !== `${SYSTEM}/snapshots/${assetId}/${version}`) fail(`${key}：快照路径不合法`);
  const directory = safePath(root, saved.path);
  const manifestFile = safePath(root, `${saved.path}/_snapshot.json`);
  if (hash(fs.readFileSync(manifestFile)) !== saved.manifest_sha256) fail(`${key}：快照清单校验值不一致`);
  const manifest = readJSON(manifestFile);
  if (manifest.schema_version !== 1 || manifest.project_id !== project.project_id || manifest.asset_id !== assetId || manifest.version !== version) fail(`${key}：快照清单身份不一致`);
  compareFiles(fingerprint(root, directory, { skipManifest: true }), manifest.files, key);
  const asset = readJSON(path.join(directory, 'asset.json'));
  if (asset.asset_id !== assetId || asset.version !== version || asset.project_id !== project.project_id || asset.type !== entry.type) fail(`${key}：快照资产身份不一致`);
  const result = { asset, directory, manifest, saved, entry };
  cache.set(key, result);
  return result;
}
export function operation(project, action, details) {
  const record = { operation_id: crypto.randomUUID(), action, at: now(), ...details };
  (project.operations ??= []).push(record);
  project.updated_at = record.at;
  return record;
}
