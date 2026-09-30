import { DIRECTORIES, TYPES, SYSTEM, ASSET_ID, fail } from './rules.mjs';
import { safePath } from './storage.mjs';
const V1_CATEGORY = { WORLD: DIRECTORIES[1], LOC: DIRECTORIES[1], CHAR: DIRECTORIES[2], PROP: DIRECTORIES[2], PLOT: DIRECTORIES[3], STATE: DIRECTORIES[3], CH: DIRECTORIES[3], EP: DIRECTORIES[4], SC: DIRECTORIES[4], SHOT: DIRECTORIES[4], PROMPT: DIRECTORIES[5], MEDIA: DIRECTORIES[5], REPORT: DIRECTORIES[0] };
const PROFILES = Object.freeze({
  1: Object.freeze({ schemaVersion: 1, directories: DIRECTORIES, templatePath: '00_项目管理/空白模板', exportPrefix: '07_发布资产/', resumePrefix: '00_项目管理/' }),
  2: Object.freeze({ schemaVersion: 2, directories: ['assets', 'sources', 'production', 'deliveries'], templatePath: 'production/空白模板', exportPrefix: 'deliveries/handoff/', resumePrefix: 'deliveries/resume/' }),
});
export function layoutFor(project = 1) {
  const version = typeof project === 'number' ? project : project.schema_version;
  if (!PROFILES[version]) fail('不支持的项目布局版本；仅支持 schema_version 1 或 2');
  return PROFILES[version];
}
export function assetDirectory(project, type, assetId) {
  if (!TYPES.includes(type) || !ASSET_ID.test(assetId) || assetId.split('-')[1] !== type) fail('资产目录需要匹配的类型和编号');
  return layoutFor(project).schemaVersion === 2 ? `assets/${type}/${assetId}` : `${V1_CATEGORY[type]}/${assetId}`;
}
export function workingPath(root, relative, project = 1, entry) {
  const normalized = String(relative).replaceAll('\\', '/');
  if (normalized.split('/')[0] === SYSTEM || normalized === 'project.json') fail(`工作资产不能使用系统路径：${relative}`);
  if (layoutFor(project).schemaVersion === 2) {
    const [category, type, assetId, ...tail] = normalized.split('/');
    if (category !== 'assets' || tail.length || !TYPES.includes(type) || !ASSET_ID.test(assetId ?? '') || assetId.split('-')[1] !== type) fail(`v2 工作资产应放在 assets/<TYPE>/<asset_id>：${relative}`);
    if (entry && (type !== entry.type || assetId !== entry.asset_id)) fail(`工作资产路径与登记的类型、编号不一致：${relative}`);
  } else if (!DIRECTORIES.includes(normalized.split('/')[0]) || normalized.split('/').length < 2) fail(`工作资产应放在八类目录的子目录内：${relative}`);
  return safePath(root, normalized);
}
export function outputPath(root, relative, project, kind) {
  if (typeof relative !== 'string') fail('输出目录需要项目内相对路径');
  const normalized = relative.replaceAll('\\', '/');
  const profile = layoutFor(project), prefix = kind === 'export' ? profile.exportPrefix : profile.resumePrefix;
  if (!normalized.startsWith(prefix) || normalized === prefix.slice(0, -1)) fail(`${kind === 'export' ? '导出' : '续作包'}目录必须位于本项目 ${prefix} 的新子目录`);
  return safePath(root, normalized);
}
