import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safePath, projectStatus } from '../src/project-service.mjs';

const projectRoot = path.resolve(process.argv[2] ?? 'projects/IP001_大反派今天也不想上班');
const read = relative => JSON.parse(fs.readFileSync(safePath(projectRoot, relative), 'utf8').replace(/^\uFEFF/, ''));
const project = read('project.json');
const status = projectStatus({ project: projectRoot });
if (!status.ok) throw new Error(status.errors.join('\n'));
const timestamp = new Date().toISOString();
const escape = text => String(text).replace(/[\r\n|]/g, ' ').replace(/\[/g, '〔').replace(/\]/g, '〕');
const link = (label, target) => `[${escape(label)}](<${target.replaceAll('\\', '/') }>)`;
const lines = [`# ${escape(project.name)}｜项目入口`, '', `读取时点：${timestamp}。这是状态导航；继续制作先重新运行 status。`, '', `资产 ${status.assets.length}，冻结版本 ${status.assets.reduce((total, entry) => total + entry.versions, 0)}，当前采用 ${status.adopted.length}。`, '', `当前正式图片基准：IP001-REPORT-002@${project.assets.find(entry => entry.asset_id === 'IP001-REPORT-002')?.adopted_version ?? '未采用'}。视频尚未生成或验收。`, '', '## 正式图片取用', '', '| 素材 | 精确采用版本 |', '| --- | --- |'];
for (const entry of project.assets.filter(entry => entry.type === 'MEDIA' && entry.adopted_version)) {
  const version = entry.versions.find(version => version.version === entry.adopted_version);
  const asset = read(`${version.path}/asset.json`);
  const images = (asset.data.files ?? []).filter(file => /\.(png|jpe?g|webp)$/i.test(file.path));
  for (const image of images) lines.push(`| ${link(image.path, `${version.path}/${image.path}`)} | ${entry.asset_id}@${entry.adopted_version} |`);
}
const reportView = 'deliveries/views/REPORT-002_1.1.2/reports/IP001-REPORT-002/1.1.2/制作报告.md';
if (fs.existsSync(safePath(projectRoot, reportView))) lines.push('', link('可点击取用的正式报告阅读副本', reportView));
lines.push('', '## 资产目录', '', '| 类型 | 资产 | 工作稿 | 采用快照 | 状态 |', '| --- | --- | --- | --- | --- |');
for (const entry of [...project.assets].sort((a, b) => a.type.localeCompare(b.type) || a.asset_id.localeCompare(b.asset_id))) {
  const asset = read(`${entry.path}/asset.json`);
  const version = entry.versions.find(version => version.version === entry.adopted_version);
  lines.push(`| ${entry.type} | ${escape(asset.title)} | ${link(entry.asset_id, `${entry.path}/asset.json`)} | ${version ? link(entry.adopted_version, `${version.path}/asset.json`) : '无'} | ${entry.lifecycle === 'retired' ? '已退役，保留历史' : entry.adopted_version ? '已采用' : '候选'} |`);
}
lines.push('', '## 制作记录与来源', '', '- `production/history/` 和 `production/legacy/` 保存旧操作及材料；一次性脚本不直接重放。', '- `deliveries/resume/续作包v1/` 是小说阶段历史包，生成时含54资产；当前全项目基准以状态为准。', `- ${link('当前来源索引', 'sources/来源索引.md')}`, '- 视频入口与模式仍需按实际账号核验；本次目录重构没有生成媒体。', '');
const latestResume = [...(project.resumes ?? [])].reverse().find(item => item.path?.startsWith('deliveries/resume/') && fs.existsSync(safePath(projectRoot, `${item.path}/续作说明.md`)));
if (latestResume) lines.push(link(`最近续作包（${latestResume.created_at}；使用前重新核对状态）`, `${latestResume.path}/续作说明.md`), '');
fs.writeFileSync(safePath(projectRoot, '项目入口.md'), lines.join('\n'));

const originalReceipt = '.ip-system/snapshots/IP001-REPORT-002/1.1.0/参考原图复制记录.json';
const sourceLines = ['# 来源索引', '', `生成时点：${timestamp}。此索引定位已有证据，不改变素材来源或采用状态。`, ''];
if (fs.existsSync(safePath(projectRoot, originalReceipt))) {
  const receipt = read(originalReceipt);
  const records = [];
  sourceLines.push(link('原参考图复制记录（冻结证据）', `../${originalReceipt}`), '', '| 参考图 | 来源范围 | 字节核对 |', '| --- | --- | --- |');
  for (const file of receipt.files) {
    const frozen = `.ip-system/snapshots/IP001-REPORT-002/1.1.0/${file.project_copy}`;
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(safePath(projectRoot, frozen))).digest('hex');
    if (actualHash !== file.copy_sha256) throw new Error(`历史来源副本校验失败：${frozen}`);
    records.push({ original_absolute_path: file.original_absolute_path, frozen_path: frozen, sha256: actualHash, role: file.role, evidence: originalReceipt });
    sourceLines.push(`| ${link(file.filename, `../${frozen}`)} | ${escape(file.role)} | 与冻结复制记录一致 |`);
  }
  fs.writeFileSync(safePath(projectRoot, 'sources/来源索引.json'), `${JSON.stringify({ created_at: timestamp, scope: '已有冻结参考图证据索引；不是新增采用', files: records }, null, 2)}\n`);
}
sourceLines.push('', '工作区 sources/inbox/ 中的参考小说尚未确认项目归属，不自动成为本项目依据。', '');
fs.writeFileSync(safePath(projectRoot, 'sources/来源索引.md'), sourceLines.join('\n'));
console.log(JSON.stringify({ ok: true, project: projectRoot, navigation: '项目入口.md', source_index: 'sources/来源索引.md', adopted: status.adopted.length, scope: '状态与文件字节；未进行小说或媒体内容审核' }));
