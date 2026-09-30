import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { object, fail, hash, jsonText } from './rules.mjs';
export const PROJECT_HASHES = new WeakMap();
export function readText(filename) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filename)).replace(/^\uFEFF/, ''); }
  catch (error) { fail(`无法读取 UTF-8 文件 ${filename}：${error.message}`); }
}
export function readJSON(filename) {
  try { return JSON.parse(readText(filename)); }
  catch (error) { fail(`JSON 文件无效 ${filename}：${error.message}`); }
}
export function writeSynced(filename, bytes) {
  const fd = fs.openSync(filename, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function atomicJSON(filename, value) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  writeSynced(temp, jsonText(value));
  try { fs.renameSync(temp, filename); } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
}
export function safePath(root, relative, { allowRoot = false } = {}) {
  if (typeof relative !== 'string' || /[\x00-\x1f:]/.test(relative) || path.isAbsolute(relative) || /^[\\/]/.test(relative)) fail(`路径必须位于项目内：${String(relative)}`);
  const parts = relative.replaceAll('\\', '/').split('/');
  if ((!allowRoot && !relative) || parts.some(part => part === '..' || part === '.' || !part || /[ .]$/.test(part) || /[<>"|?*]/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) fail(`非法相对路径：${relative}`);
  const base = path.resolve(root);
  let current = base;
  if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) fail(`项目根目录不能是符号链接：${base}`);
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current) || (() => { try { return Boolean(fs.lstatSync(current)); } catch { return false; } })()) {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`拒绝符号链接或目录联接：${relative}`);
    }
  }
  const rel = path.relative(base, current);
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) fail(`路径越出项目目录：${relative}`);
  return current;
}
export function relativeFiles(root, directory, relative = '') {
  const result = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    const actual = safePath(root, path.relative(root, path.join(directory, item.name)).replaceAll('\\', '/'));
    const stat = fs.lstatSync(actual);
    if (stat.isDirectory()) result.push(...relativeFiles(root, actual, name));
    else if (stat.isFile()) result.push(name);
    else fail(`资产中存在不支持的特殊文件：${actual}`);
  }
  return result.sort();
}
export function fingerprint(root, directory, { skipManifest = false } = {}) {
  const files = {};
  for (const relative of relativeFiles(root, directory)) {
    if (skipManifest && relative === '_snapshot.json') continue;
    const bytes = fs.readFileSync(path.join(directory, relative));
    files[relative] = { sha256: hash(bytes), size: bytes.length };
  }
  return files;
}
export function compareFiles(actual, expected, label) {
  if (!object(expected) || JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort())) fail(`${label} 文件清单不一致，可能有缺失或新增文件`);
  for (const [name, file] of Object.entries(actual)) {
    if (file.sha256 !== expected[name]?.sha256 || file.size !== expected[name]?.size) fail(`${label}/${name} 校验值不一致，历史内容可能被改动`);
  }
}
