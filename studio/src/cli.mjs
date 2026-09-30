import { createInterface } from 'node:readline/promises';
import { TYPES, filled, fail, jsonText } from './rules.mjs';
import { initProject, newAsset, projectStatus, resumeProject, validateProject, saveVersion, recordReview, reviewItem, adoptVersion, exportProject, retireAsset, restoreAsset } from './project-service.mjs';
import { readProject } from './registry.mjs';
import { layoutFor } from './layout.mjs';
const HELP = `原创 IP 本地辅助工具（零依赖）
用法：node studio/bin/studio.mjs <命令> [参数]
  init --root projects --id IP003 --name 新故事 [--schema 1|2]（默认 v2）
  new-asset --project <项目目录> --type CH --title 第一章 [--sequence 001]
  status --project <项目目录>
  validate --project <项目目录> [--strict]
  save-version --project <项目目录> (--asset <资产ID> | --path <资产相对目录>) [--reason <修订依据>]
  record-review --project <项目目录> --asset <资产ID> --version 1.0.0 --file <项目内审核输入.json>
  adopt --project <项目目录> --asset <资产ID> --version 1.0.0 --reason <采用依据> --review <审核ID>（v1 可省略）
  review-item --project <项目目录> --item <复核项ID> --reason <理由> --evidence <核对证据> --method ai --reviewer <审查者>
  export --project <项目目录> --out deliveries/handoff/交接包 [--episodes <ID,ID> | --chapters <ID,ID>] [--require-review]
  resume --project <项目目录> --out deliveries/resume/续作包
  retire-asset --project <v2项目> --asset <未采用候选ID> --reason <弃用理由>
  restore-asset --project <v2项目> --asset <退役候选ID> --reason <恢复理由>
  migration-preflight --project <v1项目> --to <新的v2项目目录>
  migrate --project <v1项目> --to <新的v2项目目录>
  audit-links --project <项目目录>
  render-report --project <项目目录> --asset <REPORT-ID> --version <版本> --out deliveries/views/<新阅读目录>
  v1 导出及续作保持 07_发布资产/ 与 00_项目管理/；v2 导出始终要求章节完整审核。
  不带参数：中文菜单；--help：本说明；--json：输出机器可读 JSON。
路径或名称含空格时请加引号。详细字段见 studio/docs/数据协议.md；命令说明见 studio/docs/接口规范.md。`;
function printResult(result, asJSON = false) {
  if (asJSON) { console.log(jsonText(result).trimEnd()); return; }
  console.log(result.ok ? '完成' : '检查未通过');
  if (result.message) console.log(result.message);
  if (result.project) console.log(`项目：${result.project}`);
  if (result.asset_id) console.log(`资产：${result.asset_id}@${result.version}`);
  if (result.output) console.log(`输出目录：${result.output}`);
  if (result.path) console.log(`工作目录：${result.path}`);
  if (result.review_id) console.log(`审核记录：${result.review_id}；方式 ${result.method}；结论 ${result.result}；范围 ${result.coverage}`);
  if (Array.isArray(result.assets)) for (const asset of result.assets) console.log(`${asset.asset_id}｜工作版 ${asset.work_version}｜采用版 ${asset.adopted_version ?? '无'}｜${asset.retired ? '候选已退役' : asset.unsaved_changes ? '有未保存修改' : '已保存'}`);
  for (const pending of result.pending ?? []) console.log(`待办：${pending.asset_id ?? ''} ${pending.action}；${pending.reason}`);
  for (const note of result.production_notes ?? []) console.log(`制作报告 ${note.asset_id}@${note.version}：${JSON.stringify(note)}`);
  if (result.stats) {
    const labels = { assets: '资产', versions: '历史版本', adopted: '当前采用', files: '文件', reports: '报告', links: '链接', raw_broken: '原路径失效', resolved: '精确定位', unresolved: '未定位', snapshots: '冻结版本', copied_files: '已复制文件', bytes: '字节' };
    console.log(Object.entries(result.stats).map(([key, value]) => `${labels[key] ?? key} ${value}`).join('；'));
  }
  for (const error of result.errors ?? []) console.log(`错误：${error}`);
  for (const warning of result.warnings ?? []) console.log(`提示：${warning}`);
  for (const review of result.review_items ?? []) console.log(`需复核［${review.review_item_id ?? '旧记录；请用status刷新编号'}］：${review.asset_id}@${review.version} ${review.via?.length ? `经 ${review.via.join(' → ')} 间接` : ''}引用 ${review.dependency_id}@${review.referenced_version}，上游当前采用 ${review.current_version}`);
  if (result.recovered_transaction) console.log(`已恢复中断事务：${result.recovered_transaction.action}`);
}
function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith('--')) fail(`无法识别参数：${key}`);
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) fail(`参数重复：${key}`);
    if (['strict', 'json', 'help', 'require-review'].includes(name)) result[name] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) fail(`参数 ${key} 缺少值`);
      result[name] = args[++index];
    }
  }
  return result;
}
export async function dispatch(command, options) {
  const permitted = { init: ['root', 'id', 'name', 'schema'], 'new-asset': ['project', 'type', 'title', 'sequence'], status: ['project'], resume: ['project', 'out'], validate: ['project', 'strict'], 'save-version': ['project', 'asset', 'path', 'reason'], 'record-review': ['project', 'asset', 'version', 'file'], 'review-item': ['project', 'item', 'reason', 'evidence', 'method', 'reviewer'], adopt: ['project', 'asset', 'version', 'reason', 'review'], export: ['project', 'out', 'episodes', 'chapters', 'require-review'], 'retire-asset': ['project', 'asset', 'reason'], 'restore-asset': ['project', 'asset', 'reason'], 'migration-preflight': ['project', 'to'], migrate: ['project', 'to'], 'audit-links': ['project'], 'render-report': ['project', 'asset', 'version', 'out'] };
  if (!permitted[command]) fail(`未知命令 ${command}\n${HELP}`);
  for (const key of Object.keys(options)) if (![...permitted[command], 'json', 'help'].includes(key)) fail(`命令 ${command} 不接受参数 --${key}`);
  if (command !== 'init' && !filled(options.project)) fail('必须指定 --project 项目目录');
  const handlers = { init: initProject, 'new-asset': newAsset, status: projectStatus, resume: resumeProject, validate: validateProject, 'save-version': saveVersion, 'record-review': recordReview, 'review-item': reviewItem, adopt: adoptVersion, export: exportProject, 'retire-asset': retireAsset, 'restore-asset': restoreAsset };
  if (command === 'migration-preflight' || command === 'migrate') {
    const migration = await import('./migration.mjs');
    return migration[command === 'migrate' ? 'migrateProject' : 'migrationPreflight'](options);
  }
  if (command === 'audit-links' || command === 'render-report') {
    const links = await import('./links.mjs');
    return links[command === 'audit-links' ? 'auditLinks' : 'renderReport'](options);
  }
  return handlers[command]({ ...options, schemaVersion: options.schema === undefined ? undefined : Number(options.schema), requireReview: options['require-review'] === true });
}
async function menu() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let selectedProject = '';
  const ask = async (prompt, fallback = '') => (await rl.question(`${prompt}${fallback ? `［${fallback}］` : ''}：`)).trim() || fallback;
  try {
    while (true) {
      console.log('\n原创 IP 生产工具\n1 创建项目\n2 检查项目\n3 保存已登记资产版本\n4 添加已有资产并保存版本\n5 采用指定历史版本\n6 导出漫改交接包\n7 新建各类空白资产\n8 查看当前基准与待办\n9 生成新对话续作包\n10 登记精确版本内容审核\n11 记录保留历史引用的复核\n12 退役未采用候选\n13 恢复退役候选\n14 迁移预检\n15 迁移到新项目目录\n16 检查报告链接\n17 生成报告可移植阅读视图\n0 退出');
      const choice = await ask('选择');
      if (choice === '0' || choice === '') break;
      try {
        let result;
        if (choice === '1') {
          result = initProject({ root: await ask('项目根目录', 'projects'), id: await ask('项目 ID（如 IP003）'), name: await ask('项目名称') });
          selectedProject = result.project;
        } else if (['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17'].includes(choice)) {
          selectedProject = await ask('项目目录', selectedProject);
          if (!selectedProject) fail('项目目录不能为空');
          const profile = layoutFor(readProject(selectedProject));
          if (choice === '2') result = validateProject({ project: selectedProject, strict: (await ask('严格检查完整内容？输入 是', '否')) === '是' });
          if (choice === '3') result = saveVersion({ project: selectedProject, asset: await ask('资产 ID'), reason: await ask('本次保存或修订依据', '保存本轮工作稿快照') });
          if (choice === '4') result = saveVersion({ project: selectedProject, path: await ask('资产相对目录（已有填写好的 asset.json）'), reason: await ask('本次保存或修订依据', '保存本轮工作稿快照') });
          if (choice === '5') result = adoptVersion({ project: selectedProject, asset: await ask('资产 ID'), version: await ask('已保存版本'), reason: await ask('审核采用依据'), review: (await ask(profile.schemaVersion === 2 ? '绑定精确审核 ID（v2必填）' : '绑定审核 ID（留空沿用兼容方式）')) || undefined });
          if (choice === '6') {
            const range = await ask('导出范围：全部、剧集或章节', '全部');
            if (!['全部', '剧集', '章节'].includes(range)) fail('范围请输入全部、剧集或章节');
            const ids = range === '全部' ? undefined : await ask('完整资产 ID，多个用逗号分隔');
            result = exportProject({ project: selectedProject, out: await ask('新的导出目录', `${profile.exportPrefix}交接包`), episodes: range === '剧集' ? ids : undefined, chapters: range === '章节' ? ids : undefined, requireReview: profile.schemaVersion === 2 || (await ask('要求完整内容审核通过？是／否', '是')) === '是' });
          }
          if (choice === '7') result = newAsset({ project: selectedProject, type: await ask(`类型（${TYPES.join('/')}）`), title: await ask('资产标题'), sequence: (await ask('序号（留空自动编号）')) || undefined });
          if (choice === '8') result = projectStatus({ project: selectedProject });
          if (choice === '9') result = resumeProject({ project: selectedProject, out: await ask('新的续作包目录', `${profile.resumePrefix}续作包`) });
          if (choice === '10') result = recordReview({ project: selectedProject, asset: await ask('被审资产 ID'), version: await ask('已保存版本'), file: await ask('真实审核输入 JSON 的项目内相对路径') });
          if (choice === '11') result = reviewItem({ project: selectedProject, item: await ask('status列出的完整复核项 ID'), reason: await ask('保留旧版的理由'), evidence: await ask('实际核对证据'), method: await ask('实际审核方式 ai 或 human'), reviewer: await ask('实际审查者') });
          if (choice === '12' || choice === '13') result = (choice === '12' ? retireAsset : restoreAsset)({ project: selectedProject, asset: await ask('候选资产 ID'), reason: await ask('本次退役或恢复理由') });
          if (choice === '14' || choice === '15') result = await dispatch(choice === '14' ? 'migration-preflight' : 'migrate', { project: selectedProject, to: await ask('新的目标项目目录') });
          if (choice === '16') result = await dispatch('audit-links', { project: selectedProject });
          if (choice === '17') result = await dispatch('render-report', { project: selectedProject, asset: await ask('REPORT 资产 ID'), version: await ask('已保存版本'), out: await ask('新的报告阅读目录', 'deliveries/views/报告阅读') });
        } else fail('请输入菜单中的数字');
        printResult(result);
      } catch (error) { console.error(`未完成：${error.message}`); }
    }
  } finally { rl.close(); }
}
export async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) { console.error('本工具需要 Node.js 22 或更新版本，请选择本机已有的新版本。'); process.exitCode = 1; return; }
  if (!args.length) return menu();
  if (args[0] === '--help' || args[0] === '-h') { console.log(HELP); return; }
  let options;
  try {
    options = parseArgs(args.slice(1));
    if (options.help) { console.log(HELP); return; }
    const result = await dispatch(args[0], options);
    printResult(result, options.json);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (options?.json || args.includes('--json')) console.log(jsonText({ ok: false, errors: [error.message] }).trimEnd());
    else console.error(`未完成：${error.message}`);
    process.exitCode = 1;
  }
}
