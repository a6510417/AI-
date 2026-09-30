import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { safePath } from '../src/project-service.mjs';

const [argument, ...deliveryArguments] = process.argv.slice(2);
if (!argument || !deliveryArguments.length) throw new Error('需要项目目录及至少一个项目内阅读视图/续作包相对路径');
const root = path.resolve(argument);
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const project = read(safePath(root, 'project.json'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const markdown = [safePath(root, '项目入口.md'), safePath(root, 'sources/来源索引.md')];
const manifests = [];
function walk(directory, frozen = false) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, '交付目录不能包含符号链接');
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename, frozen || entry.name === 'assets');
    else if (entry.name === '_snapshot.json') manifests.push(filename);
    else if (!frozen && entry.name.endsWith('.md')) markdown.push(filename);
  }
}
for (const relative of deliveryArguments) {
  assert.ok(relative.replaceAll('\\', '/').startsWith('deliveries/'), '只检查项目内交付目录');
  walk(safePath(root, relative));
}
let frozenFiles = 0;
for (const filename of manifests) {
  const manifest = read(filename);
  const entry = project.assets.find(item => item.asset_id === manifest.asset_id);
  const version = entry?.versions.find(item => item.version === manifest.version);
  assert.ok(version, `交付快照未登记：${filename}`);
  assert.equal(hash(fs.readFileSync(filename)), version.manifest_sha256, `快照清单字节不一致：${filename}`);
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(safePath(path.dirname(filename), relative));
    assert.equal(bytes.length, expected.size, `${filename}/${relative} 大小不一致`);
    assert.equal(hash(bytes), expected.sha256, `${filename}/${relative} 哈希不一致`);
    frozenFiles++;
  }
}
let links = 0;
const errors = [];
for (const filename of markdown) {
  const body = fs.readFileSync(filename, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
  for (const matched of body.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]*)\)/g)) {
    let target = matched[1].trim().replace(/^<|>$/g, '').replace(/\s+["'][^"']*["']$/, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    links++;
    try {
      const resolved = path.resolve(path.dirname(filename), decodeURIComponent(target));
      const relative = path.relative(root, resolved);
      const safe = safePath(root, relative);
      if (!fs.existsSync(safe)) errors.push(`${filename}：目标不存在 ${matched[1]}`);
    } catch (error) { errors.push(`${filename}：${error.message}`); }
  }
}
console.log(JSON.stringify({ ok: errors.length === 0, checked_at: new Date().toISOString(), deliveries: deliveryArguments, markdown_files: markdown.length, local_links: links, copied_snapshots: manifests.length, frozen_files_byte_verified: frozenFiles, errors, scope: '派生入口/报告及交付说明文件链接、交付冻结副本哈希；保留原文的旧链接另见audit-links，未进行媒体内容审核' }, null, 2));
if (errors.length) process.exitCode = 1;
