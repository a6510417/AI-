import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { filled, fail, jsonText } from './rules.mjs';
import { safePath, readJSON, writeSynced } from './storage.mjs';
import { initProject, newAsset, projectStatus, resumeProject, validateProject, recoverProject, saveVersion, recordReview, reviewItem, adoptVersion, exportProject, retireAsset, restoreAsset, cleanupDeletedAssets } from './project-service.mjs';
import { readProject } from './registry.mjs';
const USAGE = `AI 漫剧工作室命令接口
用法：node studio/bin/studio.mjs <命令> [参数]`;
const HELP = `${USAGE}
  init --root projects --id IP003 --name 新故事 [--schema 1|2]（默认 v2）
  new-asset --project <项目目录> --type CH --title 第一章 [--sequence 001]
  status --project <项目目录>
  validate --project <项目目录> [--strict]
  recover --project <项目目录>（仅恢复已有中断事务，不新增业务成果）
  save-version --project <项目目录> (--asset <资产ID> | --path <资产相对目录>) [--reason <修订依据>]
  record-review --project <项目目录> --asset <资产ID> --version 1.0.0 --file <项目内审核输入.json>
  adopt --project <项目目录> --asset <资产ID> --version 1.0.0 --reason <采用依据> --review <审核ID>（v1 可省略）
  review-item --project <项目目录> --item <复核项ID> --reason <理由> --evidence <核对证据> --method ai --reviewer <审查者>
  export --project <项目目录> --out deliveries/handoff/交接包 [--episodes <ID,ID> | --chapters <ID,ID>] [--require-review]
  resume --project <项目目录> --out deliveries/resume/续作包 [--reading-views]（默认只打包冻结资产与读取清单）
  retire-asset --project <v2项目> --asset <未采用候选ID> --reason <弃用理由>
  restore-asset --project <v2项目> --asset <退役候选ID> --reason <恢复理由>
  清理已删候选 --project <v2项目> --assets <退役候选ID,退役候选ID> --reason <清理理由>
  migration-preflight --project <v1项目> --to <新的v2项目目录>
  migrate --project <v1项目> --to <新的v2项目目录>
  audit-links --project <项目目录>
  render-report --project <项目目录> --asset <REPORT-ID> --version <版本> --out deliveries/views/<新阅读目录> [--mode local|portable]（默认 local 精确快照引用）
  制作上下文 --project <项目目录> --file <AI准备的请求.json> [--out production/制作准备/<新目录>]
  预填资产 --project <项目目录> --file <AI准备的请求.json> [--out production/制作准备/<新目录>]
  编译提示词 --project <项目目录> --file <AI准备的请求.json> [--out production/制作准备/<新目录>]
  创建制作任务 --project <项目目录> --file <AI准备的计划.json>
  制作任务状态 --project <项目目录> [--asset <REPORT-ID> --version <版本>]
  登记制作成果 --project <项目目录> --file <AI准备的成果.json>
  解析连续状态 --project <项目目录> --file <AI准备的状态请求.json> [--out production/制作准备/<新目录>]
  检查制作成果 --project <项目目录> --file <AI准备的检查请求.json> [--out production/制作准备/<新目录>]
  修复制作成果 --project <项目目录> --file <AI准备的修复请求.json> [--out production/制作准备/<新目录>]
  状态解析、检查与修复只返回诊断或候选，不写入资产、审核或采用；未通过时仍可用 --out 保存真实诊断。
  制作请求由AI按小说和创作方向填写，用户无需逐镜填写提示词；v1派生输出使用00_项目管理/制作准备/。
  v1 导出及续作保持 07_发布资产/ 与 00_项目管理/；v2 导出始终要求章节完整审核。
  不带参数：显示用法后退出；--help：本说明；--json：输出机器可读 JSON。
路径或名称含空格时请加引号。详细字段见 studio/docs/数据协议.md；命令说明见 studio/docs/接口规范.md。`;
function printResult(result, asJSON = false) {
  if (asJSON) { console.log(jsonText(result).trimEnd()); return; }
  const diagnostic = ['resolve-continuity-state', 'check-production', 'repair-production'].includes(result.action);
  console.log(result.ok ? result.complete === false ? '检查已执行；仍有未完成项' : diagnostic ? '机器检查已执行；内容审核仍须实际完成' : '完成' : diagnostic && result.output ? '诊断文件已生成；检查仍未通过' : result.action === 'render-report' && result.output && !result.errors?.length ? '阅读视图已生成；链接检查未通过' : '请求未通过；请核对错误与已有结果');
  if (result.message) console.log(result.message);
  if (result.project) console.log(`项目：${result.project}`);
  if (result.asset_id) console.log(`资产：${result.asset_id}@${result.version}`);
  if (result.output) console.log(`输出目录：${result.output}`);
  if (result.path) console.log(`工作目录：${result.path}`);
  if (result.review_id) console.log(`审核记录：${result.review_id}；方式 ${result.method}；结论 ${result.result}；范围 ${result.coverage}`);
  if (result.task) console.log(`制作任务：${result.title ?? ''} ${result.task.asset_id}@${result.task.version}`);
  for (const stage of result.stages ?? result.status?.stages ?? []) console.log(`${stage.name}：${stage.status}；成果 ${stage.outputs.length} 项`);
  for (const task of result.tasks ?? []) console.log(`制作任务：${task.title} ${task.task.asset_id}@${task.task.version}；${task.next_stage ? `下一阶段 ${task.next_stage}` : '已完成计划阶段'}`);
  for (const field of result.missing_fields ?? []) console.log(`AI需补充：${typeof field === 'string' ? field : JSON.stringify(field)}`);
  if (typeof result.complete === 'boolean') console.log(`本次检查覆盖：${result.complete ? '声明范围已处理；不等于内容审核通过' : '尚有未知、缺项或未通过内容'}`);
  for (const state of result.states ?? []) console.log(`连续状态：${state.entity?.asset_id ?? ''}@${state.entity?.version ?? ''} ${JSON.stringify(state.values ?? {})}`);
  for (const issue of result.issues ?? []) console.log(typeof issue === 'string' ? `检查问题：${issue}` : `检查问题［${issue.severity ?? issue.level ?? '待核实'}］${issue.asset_id ?? issue.asset?.asset_id ?? ''} ${issue.path ?? issue.location ?? (issue.locations ? JSON.stringify(issue.locations) : '')}：${issue.message ?? issue.description ?? JSON.stringify(issue)}`);
  if (result.repair) console.log(`候选修复：${typeof result.repair === 'string' ? result.repair : JSON.stringify(result.repair)}`);
  if (result.action === 'repair-production') console.log(`候选修复：${result.passes ?? 0} 轮，${result.patches?.length ?? 0} 项修改，${result.unresolved?.length ?? result.issues?.length ?? 0} 项未解决；未保存、未审核、未采用。`);
  if (result.coverage?.semantic_review) console.log(`语义审核：${result.coverage.semantic_review}`);
  if (result.budget) console.log(`上下文字符：${result.budget.used_chars}/${result.budget.max_chars}；${result.budget.complete ? '范围完整' : '超出预算，需缩小范围'}`);
  if (result.files && !result.output) console.log('派生内容已在返回结果中；AI可用 --json 读取，或 --out 保存到新的中文目录。');
  if (Array.isArray(result.assets)) for (const asset of result.assets) console.log(asset.asset ? `修复候选：${asset.asset.asset_id}@${asset.asset.version}；尚未登记` : `${asset.asset_id}｜工作版 ${asset.work_version}｜采用版 ${asset.adopted_version ?? '无'}｜${asset.retired ? '候选已退役' : asset.unsaved_changes ? '有未保存修改' : '已保存'}`);
  for (const pending of result.pending ?? []) console.log(`待办：${pending.asset_id ?? ''} ${pending.action}；${pending.reason}`);
  for (const note of result.production_notes ?? []) console.log(`制作报告 ${note.asset_id}@${note.version}：${JSON.stringify(note)}`);
  if (result.stats) {
    const labels = { assets: '资产', versions: '历史版本', adopted: '当前采用', files: '文件', reports: '报告', links: '链接', raw_broken: '原路径失效', resolved: '精确定位', unresolved: '未定位', snapshots: '冻结版本', copied_files: '已复制文件', bytes: '字节' };
    console.log(Object.entries(result.stats).map(([key, value]) => `${labels[key] ?? key} ${value}`).join('；'));
  }
  for (const error of result.errors ?? []) console.log(`错误：${error}`);
  for (const warning of result.warnings ?? []) console.log(`提示：${warning}`);
  for (const review of result.review_items ?? []) console.log(`需复核［${review.review_item_id ?? '旧记录；请用status刷新编号'}］：${review.asset_id}@${review.version} ${review.via?.length ? `经 ${review.via.join(' → ')} 间接` : ''}引用 ${review.dependency_id}@${review.referenced_version}，上游当前采用 ${review.current_version}`);
  printRecoveryContext(result);
}
function printRecoveryContext(result, write = console.log) {
  if (result.recovered_transaction) write(`已确认事务提交：${result.recovered_transaction.action}`);
  if (result.recovered_lock) write(`已恢复旧锁：${result.recovered_lock.kind}；证据 ${result.recovered_lock.claim_path}`);
  for (const error of result.cleanup_errors ?? []) write(`恢复或锁清理问题：${error}`);
}
function failureResult(error) {
  const result = { ok: false, errors: [error.message] };
  for (const field of ['recovered_transaction', 'recovered_lock', 'cleanup_errors']) if (error[field]) result[field] = error[field];
  return result;
}
function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith('--')) fail(`无法识别参数：${key}`);
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) fail(`参数重复：${key}`);
    if (['strict', 'json', 'help', 'require-review', 'reading-views'].includes(name)) result[name] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) fail(`参数 ${key} 缺少值`);
      result[name] = args[++index];
    }
  }
  return result;
}
export async function dispatch(command, options) {
  const aliases = { 制作上下文: 'production-context', 预填资产: 'seed-production-asset', 编译提示词: 'compile-prompts', 创建制作任务: 'create-production-task', 制作任务状态: 'production-task-status', 登记制作成果: 'import-production-results', 解析连续状态: 'resolve-continuity-state', 检查制作成果: 'check-production', 修复制作成果: 'repair-production' };
  command = aliases[command] ?? command;
  if (command === '清理已删候选') command = 'cleanup-deleted-assets';
  const permitted = { init: ['root', 'id', 'name', 'schema'], 'new-asset': ['project', 'type', 'title', 'sequence'], status: ['project'], resume: ['project', 'out', 'reading-views'], validate: ['project', 'strict'], recover: ['project'], 'save-version': ['project', 'asset', 'path', 'reason'], 'record-review': ['project', 'asset', 'version', 'file'], 'review-item': ['project', 'item', 'reason', 'evidence', 'method', 'reviewer'], adopt: ['project', 'asset', 'version', 'reason', 'review'], export: ['project', 'out', 'episodes', 'chapters', 'require-review'], 'retire-asset': ['project', 'asset', 'reason'], 'restore-asset': ['project', 'asset', 'reason'], 'migration-preflight': ['project', 'to'], migrate: ['project', 'to'], 'audit-links': ['project'], 'render-report': ['project', 'asset', 'version', 'out', 'mode'] };
  for (const name of ['production-context', 'seed-production-asset', 'compile-prompts', 'resolve-continuity-state', 'check-production', 'repair-production']) permitted[name] = ['project', 'file', 'out'];
  permitted['cleanup-deleted-assets'] = ['project', 'assets', 'reason'];
  for (const name of ['create-production-task', 'import-production-results']) permitted[name] = ['project', 'file'];
  permitted['production-task-status'] = ['project', 'file', 'asset', 'version'];
  if (!permitted[command]) fail(`未知命令 ${command}\n${HELP}`);
  for (const key of Object.keys(options)) if (![...permitted[command], 'json', 'help'].includes(key)) fail(`命令 ${command} 不接受参数 --${key}`);
  if (command !== 'init' && !filled(options.project)) fail('必须指定 --project 项目目录');
  if (Object.values(aliases).includes(command)) {
    const root = path.resolve(options.project);
    if (command !== 'production-task-status' && !filled(options.file)) fail('需要 --file，由宿主 AI 准备结构化请求');
    if (command === 'production-task-status' && (Boolean(options.asset) !== Boolean(options.version) || (options.file && options.asset))) fail('状态查询使用 --file 或成对的 --asset 与 --version，也可省略以列出任务');
    const request = options.file ? readJSON(safePath(root, options.file)) : undefined;
    let result;
    if (command === 'production-context') result = (await import('./生产上下文.mjs')).buildProductionContext({ project: root, request });
    else if (command === 'compile-prompts') result = (await import('./提示词编译.mjs')).compileShotPrompts({ project: root, request });
    else if (command === 'resolve-continuity-state') result = (await import('./连续性状态.mjs')).resolveContinuityState({ project: root, request });
    else if (['check-production', 'repair-production'].includes(command)) {
      const quality = await import('./制作质检.mjs');
      result = quality[command === 'check-production' ? 'checkProduction' : 'repairProduction']({ project: root, request });
    }
    else {
      const workflow = await import('./生产流程.mjs');
      const names = { 'seed-production-asset': 'seedProductionAsset', 'create-production-task': 'createProductionTask', 'production-task-status': 'productionTaskStatus', 'import-production-results': 'importProductionResults' };
      result = workflow[names[command]]({ project: root, request, asset: options.asset, version: options.version });
    }
    if (options.out && (result.ok || ['resolve-continuity-state', 'check-production', 'repair-production'].includes(command))) result.output = savePreparedOutput(root, options.out, result);
    return result;
  }
  const handlers = { init: initProject, 'new-asset': newAsset, status: projectStatus, resume: resumeProject, validate: validateProject, recover: recoverProject, 'save-version': saveVersion, 'record-review': recordReview, 'review-item': reviewItem, adopt: adoptVersion, export: exportProject, 'retire-asset': retireAsset, 'restore-asset': restoreAsset };
  handlers['cleanup-deleted-assets'] = cleanupDeletedAssets;
  if (command === 'migration-preflight' || command === 'migrate') {
    const migration = await import('./migration.mjs');
    return migration[command === 'migrate' ? 'migrateProject' : 'migrationPreflight'](options);
  }
  if (command === 'audit-links' || command === 'render-report') {
    const links = await import('./links.mjs');
    return links[command === 'audit-links' ? 'auditLinks' : 'renderReport'](options);
  }
  return handlers[command]({ ...options, schemaVersion: options.schema === undefined ? undefined : Number(options.schema), requireReview: options['require-review'] === true, readingViews: options['reading-views'] === true });
}
function savePreparedOutput(root, relative, result) {
  const project = readProject(root), prefix = project.schema_version === 2 ? 'production/制作准备/' : '00_项目管理/制作准备/';
  const normalized = relative.replaceAll('\\', '/');
  if (!normalized.startsWith(prefix) || normalized.length <= prefix.length) fail(`派生文件应保存到 ${prefix} 的新子目录`);
  const destination = safePath(root, normalized);
  if (project.assets.some(entry => { const p = entry.path.replaceAll('\\', '/').toLowerCase(); const d = normalized.toLowerCase(); return p === d || p.startsWith(`${d}/`) || d.startsWith(`${p}/`); })) fail('派生输出不能写入或包含已登记工作资产');
  if (fs.existsSync(destination)) fail('派生输出目录已存在，拒绝覆盖');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = safePath(root, `${prefix}临时-${crypto.randomUUID()}`); fs.mkdirSync(temporary);
  const files = { '执行结果.json': jsonText(result), ...(result.files ?? {}), ...(result.asset ? { '候选资产.json': jsonText(result.asset) } : {}), ...(result.context ? { '制作上下文.json': jsonText(result.context) } : {}) };
  for (const [name, content] of Object.entries(files)) { const file = safePath(temporary, name); fs.mkdirSync(path.dirname(file), { recursive: true }); writeSynced(file, typeof content === 'string' ? content : jsonText(content)); }
  if (fs.existsSync(destination)) fail('输出目录在生成期间已出现，拒绝覆盖；临时文件保留供核对');
  fs.renameSync(temporary, destination); return destination;
}
export async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) { console.error('本工具需要 Node.js 22 或更新版本，请选择本机已有的新版本。'); process.exitCode = 1; return; }
  if (!args.length) { console.log(`${USAGE}\n使用 --help 查看命令；在命令后添加 --json 获取机器可读结果。`); return; }
  if (args[0] === '--help' || args[0] === '-h') { console.log(HELP); return; }
  let options;
  try {
    if (args[0].startsWith('--')) fail('缺少命令；请先指定命令，再提供参数。');
    options = parseArgs(args.slice(1));
    if (options.help) { console.log(HELP); return; }
    const result = await dispatch(args[0], options);
    printResult(result, options.json);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const result = failureResult(error);
    if (options?.json || args.includes('--json')) printResult(result, true);
    else { console.error(`请求未通过：${error.message}`); printRecoveryContext(result, console.error); }
    process.exitCode = 1;
  }
}
