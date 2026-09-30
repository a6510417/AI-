import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const expectedSkills = ['comic-studio', 'comic-image-assets', 'jimeng-video-prompts', 'comic-media-review', 'comic-production', 'comic-audio', 'comic-capcut-post', 'comic-rights-release', 'comic-production-retro'];
const errors = [];
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { errors.push(`共享区不允许链接目录：${path.relative(root, target)}`); continue; }
    if (entry.isDirectory()) walk(target);
    else if (entry.name.endsWith('.md')) files.push(target);
  }
}
for (const directory of ['studio/docs', 'studio/使用说明', 'studio/技能库', 'studio/模板库', 'studio/知识库', '.agents/skills']) walk(path.join(root, directory));
for (const filename of ['README.md', 'AGENTS.md', 'studio/项目总览.md', 'archive/README.md', 'releases/README.md']) if (fs.existsSync(path.join(root, filename))) files.push(path.join(root, filename));
for (const entry of fs.readdirSync(path.join(root, 'archive'), { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') files.push(path.join(root, 'archive', entry.name));
let links = 0;
for (const filename of files) {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filename));
  const text = raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    let href = match[1].replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\$)/i.test(href)) continue;
    href = href.split('#')[0].split('?')[0];
    if (!href) continue;
    try { href = decodeURIComponent(href); } catch { errors.push(`链接编码无效：${filename}: ${href}`); continue; }
    links++;
    const target = path.resolve(path.dirname(filename), href);
    if (!fs.existsSync(target)) errors.push(`${path.relative(root, filename)}：目标不存在 ${match[1]}`);
  }
}
for (const name of expectedSkills) {
  const filename = path.join(root, '.agents/skills', name, 'SKILL.md');
  const text = fs.readFileSync(filename, 'utf8');
  if (!text.startsWith('---') || !new RegExp(`^name: ${name}$`, 'm').test(text) || !/^description: .+/m.test(text)) errors.push(`${name} 元数据无效`);
  if (!fs.existsSync(path.join(path.dirname(filename), 'agents/openai.yaml'))) errors.push(`${name} 缺少现有UI说明`);
}
console.log(JSON.stringify({ ok: errors.length === 0, markdown_files: files.length, local_links: links, skills: expectedSkills.length, errors, scope: '当前共享文档文件目标与技能元数据；不验证远程网页、段落锚点、宿主发现或媒体内容' }, null, 2));
if (errors.length) process.exitCode = 1;
