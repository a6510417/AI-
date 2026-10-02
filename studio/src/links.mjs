import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { readProject, readSnapshot, registryErrors } from './registry.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const key = ref => `${ref.asset_id}@${ref.version}`;
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const text = value => `${JSON.stringify(value, null, 2)}\n`;
const encodeSegment = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const contained = (root, target) => { const rel = path.relative(root, target); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };

function safe(root, relative) {
  if (typeof relative !== 'string' || !relative || /[:\0]/.test(relative) || path.isAbsolute(relative) || /^[\\/]/.test(relative)) throw new Error(`拒绝非法项目路径：${relative}`);
  const full = path.resolve(root, relative);
  if (!contained(root, full)) throw new Error(`链接越出项目：${relative}`);
  let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接或目录联接：${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}

function context(project) {
  const root = path.resolve(project);
  if (fs.existsSync(safe(root, '.ip-system/migration-incomplete.json'))) throw new Error('迁移尚未完成，拒绝读取报告或生成交付视图');
  const registry = readProject(root);
  const issues = registryErrors(root, registry);
  if (issues.length) throw new Error(`项目登记格式无效：${issues.join('；')}`);
  const mappings = [];
  const migrationRoot = path.join(root, '.ip-system/migrations');
  if (fs.existsSync(migrationRoot)) for (const entry of fs.readdirSync(migrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filename = safe(root, `.ip-system/migrations/${entry.name}/migration.json`);
    if (fs.existsSync(filename)) { const record = json(filename); if (record.status === 'complete') mappings.push(...(record.prefix_mappings ?? [])); }
  }
  const snapshots = new Map();
  function snapshot(assetId, version) {
    return readSnapshot(root, registry, assetId, version, snapshots);
  }
  return { root, registry, mappings, snapshot };
}

function references(value, result = []) {
  if (Array.isArray(value)) for (const item of value) references(item, result);
  else if (value && typeof value === 'object') {
    if (typeof value.asset_id === 'string' && typeof value.version === 'string') result.push({ asset_id: value.asset_id, version: value.version });
    for (const item of Object.values(value)) references(item, result);
  }
  return result;
}

function closure(ctx, start) {
  const found = new Map();
  function visit(ref) {
    if (found.has(key(ref))) return;
    const item = ctx.snapshot(ref.asset_id, ref.version); found.set(key(ref), item);
    for (const dependency of references({ refs: item.asset.refs, data: item.asset.data })) visit(dependency);
    if (item.asset.type === 'CH') for (const filename of Object.keys(item.manifest.files).filter(name => name.endsWith('.json') && name !== 'asset.json')) {
      const value = json(path.join(item.directory, filename));
      for (const dependency of references(Array.isArray(value) ? value : Object.fromEntries(Object.entries(value).filter(([field]) => !['asset_id', 'chapter_id', 'project_id', 'version'].includes(field))))) visit(dependency);
    }
  }
  visit(start); return found;
}

function mapOld(ctx, relative) {
  const found = [...ctx.mappings].sort((a, b) => b.from.length - a.from.length).find(item => relative === item.from || relative.startsWith(`${item.from}/`));
  return found ? `${found.to}${relative.slice(found.from.length)}` : relative;
}

function decodeLink(raw) {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  // Markdown title syntax is deliberately limited to an explicit quoted suffix.
  target = target.replace(/\s+["'][^"']*["']$/, '');
  if (/^(?:https?:|mailto:|app:|codex:)/i.test(target) || target.startsWith('#')) return { external: true };
  if (/^[a-z][a-z0-9+.-]*:|^[\\/]/i.test(target)) throw new Error('拒绝绝对路径或不支持的链接协议');
  const index = target.indexOf('#'), suffix = index >= 0 ? target.slice(index) : '';
  const file = decodeURIComponent(index >= 0 ? target.slice(0, index) : target).replaceAll('\\', '/');
  if (!file || /[:\0]/.test(file)) throw new Error('链接文件路径无效');
  return { file, suffix };
}

function resolve(ctx, report, markdown, raw, dependencies) {
  const decoded = decodeLink(raw);
  if (decoded.external) return decoded;
  const rawFull = safe(ctx.root, slash(path.relative(ctx.root, path.resolve(path.dirname(markdown), decoded.file))));
  const rawExists = fs.existsSync(rawFull) && fs.lstatSync(rawFull).isFile();
  const oldBase = report.manifest.source_path ?? report.entry.path;
  const relativeMarkdown = slash(path.relative(report.directory, markdown));
  const oldRelative = path.posix.normalize(path.posix.join(oldBase, path.posix.dirname(relativeMarkdown), decoded.file));
  if (oldRelative === '..' || oldRelative.startsWith('../') || path.posix.isAbsolute(oldRelative)) throw new Error('链接越出项目');
  let chosen, file;
  const explicit = /^\.ip-system\/snapshots\/([^/]+)\/([^/]+)\/(.+)$/u.exec(oldRelative);
  if (explicit) {
    const [, id, version, filename] = explicit;
    if (id !== report.asset.asset_id && !dependencies.has(`${id}@${version}`)) throw new Error(`链接引用未声明的精确资产依赖：${id}@${version}`);
    chosen = ctx.snapshot(id, version); file = filename;
  } else {
    const mapped = mapOld(ctx, oldRelative);
    const candidates = ctx.registry.assets.filter(entry => mapped === entry.path || mapped.startsWith(`${entry.path}/`));
    if (candidates.length !== 1) throw new Error('链接未定位到唯一的登记资产或报告冻结附件');
    const entry = candidates[0];
    const versions = [...dependencies.values()].filter(item => item.asset.asset_id === entry.asset_id);
    if (versions.length !== 1) throw new Error(versions.length ? `依赖存在多个版本，拒绝猜选：${entry.asset_id}` : `链接资产未列入精确依赖：${entry.asset_id}`);
    chosen = versions[0]; file = mapped.slice(entry.path.length + 1);
  }
  if (!Object.hasOwn(chosen.manifest.files, file)) throw new Error(`链接文件未列入精确快照：${chosen.asset.asset_id}@${chosen.asset.version}/${file}`);
  const filename = safe(ctx.root, `${chosen.saved.path}/${file}`);
  if (!fs.lstatSync(filename).isFile()) throw new Error('链接目标不是普通文件');
  return { external: false, raw_exists: rawExists, source: filename, file, asset_id: chosen.asset.asset_id, version: chosen.asset.version, suffix: decoded.suffix, snapshot: chosen };
}

function markdownLinks(body) { return [...body.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]*)\)/g)]; }

/** Preserve raw link failures and the independently resolved exact-version result. */
export function auditLinks({ project }) {
  const reports = [], rawBroken = [], resolved = [], unresolved = [], warnings = [], errors = [];
  try {
    const ctx = context(project);
    for (const entry of ctx.registry.assets.filter(item => item.type === 'REPORT' && item.adopted_version)) {
      const report = ctx.snapshot(entry.asset_id, entry.adopted_version), dependencies = closure(ctx, report.asset);
      for (const [kind, directory] of [['work', safe(ctx.root, entry.path)], ['snapshot', report.directory]]) {
        const row = { asset_id: entry.asset_id, version: report.asset.version, kind, links: 0, raw_broken: 0, unresolved: 0 };
        for (const filename of Object.keys(report.manifest.files).filter(name => name.endsWith('.md'))) {
          const markdown = safe(ctx.root, slash(path.relative(ctx.root, path.join(directory, filename))));
          if (!fs.existsSync(markdown)) { errors.push(`报告工作附件缺失：${markdown}`); continue; }
          const body = fs.readFileSync(markdown, 'utf8');
          for (const matched of markdownLinks(body)) {
            const item = { asset_id: entry.asset_id, version: report.asset.version, kind, file: markdown, line: body.slice(0, matched.index).split('\n').length, raw: matched[1] };
            let counted = false;
            try {
              // Raw existence is measured from the actual document, not the old authored base.
              const decoded = decodeLink(matched[1]);
              if (decoded.external) continue;
              const rawFile = safe(ctx.root, slash(path.relative(ctx.root, path.resolve(path.dirname(markdown), decoded.file))));
              const rawExists = fs.existsSync(rawFile) && fs.lstatSync(rawFile).isFile();
              row.links++; counted = true;
              if (!rawExists) { row.raw_broken++; rawBroken.push(item); }
              const answer = resolve(ctx, report, kind === 'work' ? path.join(report.directory, filename) : markdown, matched[1], dependencies);
              resolved.push({ ...item, raw_exists: rawExists, target: answer.source, target_asset_id: answer.asset_id, target_version: answer.version });
            } catch (error) { if (!counted) row.links++; row.unresolved++; unresolved.push({ ...item, reason: error.message }); }
          }
        }
        reports.push(row);
      }
    }
  } catch (error) { errors.push(error.message); }
  for (const item of unresolved) warnings.push(`${item.file}:${item.line}：${item.reason}`);
  return { ok: errors.length === 0 && unresolved.length === 0, action: 'audit-links', reports, raw_broken: rawBroken, resolved, unresolved, warnings, errors, stats: { reports: reports.length, links: resolved.length + unresolved.length, raw_broken: rawBroken.length, resolved: resolved.length, unresolved: unresolved.length } };
}

function copySnapshot(snapshot, output) {
  const target = safe(output, `assets/${snapshot.asset.asset_id}/${snapshot.asset.version}`);
  fs.mkdirSync(target, { recursive: true });
  for (const filename of [...Object.keys(snapshot.manifest.files), '_snapshot.json']) {
    const destination = safe(target, filename); fs.mkdirSync(path.dirname(destination), { recursive: true });
    const bytes = fs.readFileSync(path.join(snapshot.directory, filename));
    const expected = filename === '_snapshot.json' ? { sha256: snapshot.saved.manifest_sha256 } : snapshot.manifest.files[filename];
    if (hash(bytes) !== expected.sha256 || (expected.size !== undefined && bytes.length !== expected.size)) throw new Error(`派生复制期间冻结来源发生变化：${snapshot.asset.asset_id}@${snapshot.asset.version}/${filename}`);
    if (fs.existsSync(destination)) { if (hash(fs.readFileSync(destination)) !== hash(bytes)) throw new Error(`派生包已有不同内容：${destination}`); }
    else fs.writeFileSync(destination, bytes, { flag: 'wx' });
  }
  return target;
}

function renderInto(ctx, report, output, { snapshotDirectory = snapshot => copySnapshot(snapshot, output), mode = 'portable' } = {}) {
  const warnings = [], rootIssues = [], historicalIssues = [], rendered = new Map(), copied = new Map(), queue = [report];
  const rootIdentity = key(report.asset);
  const add = snapshot => {
    const identity = key(snapshot.asset);
    if (!copied.has(identity)) {
      try { copied.set(identity, { snapshot, directory: snapshotDirectory(snapshot) }); }
      catch (error) { error.render_io = true; throw error; }
    }
    return copied.get(identity).directory;
  };
  while (queue.length) {
    const current = queue.shift(), identity = key(current.asset);
    if (rendered.has(identity)) continue;
    const dependencies = closure(ctx, current.asset);
    for (const item of dependencies.values()) add(item);
    const directory = path.join(output, 'reports', current.asset.asset_id, current.asset.version);
    fs.mkdirSync(directory, { recursive: true }); rendered.set(identity, directory);
    for (const filename of Object.keys(current.manifest.files)) {
      // Original metadata and attachments stay at their exact snapshot location.
      if (!filename.endsWith('.md')) continue;
      const destination = path.join(directory, filename); fs.mkdirSync(path.dirname(destination), { recursive: true });
      const original = path.join(add(current), filename);
      const body = fs.readFileSync(original, 'utf8');
      const rewritten = body.replace(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]*)\)/g, (whole, raw, offset) => {
        try {
          const answer = resolve(ctx, current, path.join(current.directory, filename), raw, dependencies);
          if (answer.external) return whole;
          let target = path.join(add(answer.snapshot), answer.file);
          if (answer.snapshot.asset.type === 'REPORT' && answer.file.endsWith('.md')) {
            target = path.join(output, 'reports', answer.asset_id, answer.version, answer.file);
            if (!rendered.has(key(answer.snapshot.asset))) queue.push(answer.snapshot);
          }
          const url = slash(path.relative(path.dirname(destination), target)).split('/').map(segment => segment === '..' ? segment : encodeSegment(segment)).join('/') + answer.suffix;
          return whole.replace(`(${raw})`, `(${url})`);
        } catch (error) {
          if (error.render_io) throw error;
          warnings.push(`${identity}/${filename}：${raw}；${error.message}`);
          const scope = identity === rootIdentity ? 'root' : 'historical';
          const issue = { asset_id: current.asset.asset_id, version: current.asset.version, file: filename, line: body.slice(0, offset).split('\n').length, raw_link: raw, reason: error.message, scope };
          const issueId = hash(text({ ...issue, offset })).slice(0, 20);
          issue.issue_page = `link-issues/${issueId}.md`;
          const issuePath = path.join(output, issue.issue_page); fs.mkdirSync(path.dirname(issuePath), { recursive: true });
          fs.writeFileSync(issuePath, `# 未定位链接说明\n\n内容类型：链接诊断说明。素材状态：未定位。此页不提供素材或验收结论。\n\n报告来源：${identity}\n\n原文位置：${filename}，第 ${issue.line} 行。检查层级：${scope === 'root' ? '本次根报告' : '根报告引用的历史说明'}。\n\n未定位原因：${error.message}\n\n原始链接：\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`\n\n原冻结正文和原链接保留在${mode === 'local' ? '项目的精确冻结快照' : '包内 assets'}中；派生阅读链接仅指向本诊断页。工具未选择任何替代素材或推定版本。\n`, { flag: 'wx' });
          (scope === 'root' ? rootIssues : historicalIssues).push(issue);
          const url = slash(path.relative(path.dirname(destination), issuePath)).split('/').map(segment => segment === '..' ? segment : encodeSegment(segment)).join('/');
          const label = /^!?\[([^\]\n]*)\]/.exec(whole)?.[1] ?? '未定位链接';
          // An unresolved image becomes a clickable diagnosis, never an image placeholder.
          return `[${label}（未定位链接说明）](${url})`;
        }
      });
      fs.writeFileSync(destination, rewritten, { flag: 'wx' });
    }
  }
  return { reports: [...rendered].map(([identity, directory]) => {
    const markdown = Object.keys(copied.get(identity).snapshot.manifest.files).filter(filename => filename.endsWith('.md'));
    const original = path.join(copied.get(identity).directory, 'asset.json');
    return { identity, path: slash(path.relative(output, directory)), entrypoint: markdown.includes('制作报告.md') ? '制作报告.md' : markdown[0] ?? slash(path.relative(directory, original)) };
  }), snapshots: copied.size, sources: [...copied.values()].map(({ snapshot, directory }) => ({ asset_id: snapshot.asset.asset_id, version: snapshot.asset.version, manifest_sha256: snapshot.saved.manifest_sha256, path: slash(path.relative(output, directory)) })), warnings: [...new Set(warnings)], root_issues: rootIssues, historical_issues: historicalIssues };
}

/** A fixed-version local view or explicitly portable package; originals are never rewritten. */
export function renderReport({ project, asset, version, out, mode = 'local' }) {
  let output;
  try {
    if (!['local', 'portable'].includes(mode)) throw new Error('报告阅读模式必须为 local 或 portable');
    const ctx = context(project), entry = ctx.registry.assets.find(item => item.asset_id === asset && item.type === 'REPORT');
    if (!entry) throw new Error('必须选择已登记的 REPORT');
    const selected = version ?? entry.adopted_version;
    if (!selected) throw new Error('必须指定确切版本或已有采用版本');
    const report = ctx.snapshot(asset, selected);
    const relative = out ?? `deliveries/views/${asset}_${selected}_${crypto.randomUUID()}`;
    if (!slash(relative).startsWith('deliveries/views/')) throw new Error('报告视图必须放入 deliveries/views 的新子目录');
    output = safe(ctx.root, relative);
    const viewsRoot = safe(ctx.root, 'deliveries/views');
    if (!contained(viewsRoot, output) || output === viewsRoot) throw new Error('报告视图输出不能逃出 deliveries/views');
    if (fs.existsSync(output)) throw new Error('报告视图目标已存在，拒绝覆盖');
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output);
    const result = renderInto(ctx, report, output, { mode, ...(mode === 'local' ? { snapshotDirectory: snapshot => snapshot.directory } : {}) });
    const record = { schema_version: 1, mode, source_asset_id: asset, source_version: selected, source_manifest_sha256: report.saved.manifest_sha256, generated_at: new Date().toISOString(), ...result };
    fs.writeFileSync(path.join(output, 'view.json'), text(record), { flag: 'wx' });
    fs.writeFileSync(path.join(output, '阅读说明.md'), `# 报告${mode === 'portable' ? '可移植' : '本地'}阅读视图\n\n来源：${asset}@${selected}。模式：${mode}。${mode === 'portable' ? 'assets 保留原冻结字节，可独立携带本目录。' : '原文与附件直接引用本项目的精确冻结快照，不含 assets 副本；移动本目录或原项目后须重新生成视图。'}reports 为重定位链接的派生阅读文本，准确来源路径、版本与哈希见 view.json 的 sources。\n\n${result.reports.map(item => `- [${item.identity}](${`${item.path}/${item.entrypoint}`.split('/').map(encodeSegment).join('/')})`).join('\n')}\n\n${result.warnings.length ? `链接检查记录：根报告 ${result.root_issues.length} 项，引用的历史说明 ${result.historical_issues.length} 项。未定位链接指向诊断说明页，素材仍为未定位。\n\n${[...result.root_issues, ...result.historical_issues].map(item => `- [${item.asset_id}@${item.version}/${item.file}:${item.line}](${item.issue_page})：${item.reason}`).join('\n')}` : '全部所解析链接使用准确冻结版本。'}\n`, { flag: 'wx' });
    return { ok: result.root_issues.length === 0, action: 'render-report', output, mode, report: asset, version: selected, source_manifest_sha256: report.saved.manifest_sha256, sources: result.sources, warnings: result.warnings, errors: [], root_issues: result.root_issues, historical_issues: result.historical_issues, stats: { reports: result.reports.length, snapshots: result.snapshots, root_issues: result.root_issues.length, historical_issues: result.historical_issues.length } };
  } catch (error) { return { ok: false, action: 'render-report', output, mode, report: asset, version, warnings: [], errors: [error.message] }; }
}

/** Add readable report views to a generated package without touching its assets snapshots. */
export function renderPackageLinks({ project, output, transactionToken }) {
  try {
    const ctx = context(project), directory = path.resolve(output);
    const relative = slash(path.relative(ctx.root, directory));
    let internalStage = false;
    if (/^\.ip-system\/transactions\/[0-9a-f-]{36}\/(?:resume|export)$/i.test(relative) && typeof transactionToken === 'string' && transactionToken) {
      const lock = json(safe(ctx.root, '.ip-system/write.lock'));
      internalStage = lock.pid === process.pid && lock.host === os.hostname() && lock.token === transactionToken;
    }
    if (!contained(ctx.root, directory) || directory === ctx.root || (relative.startsWith('.ip-system/') && !internalStage)) throw new Error('派生包输出必须为项目内普通交付目录或受保护的内部交付事务');
    if (!internalStage) {
      const allowed = ctx.registry.schema_version === 2 ? relative.startsWith('deliveries/') : relative.startsWith('00_项目管理/') || relative.startsWith('07_发布资产/');
      if (!allowed || ctx.registry.assets.some(entry => { const work = path.resolve(ctx.root, entry.path); return contained(work, directory) || contained(directory, work); })) throw new Error('派生包输出不能与工作资产目录相互包含');
    }
    safe(ctx.root, relative);
    const indexFile = ['handoff.json', '续作信息.json'].map(name => path.join(directory, name)).find(filename => fs.existsSync(filename));
    if (!indexFile) throw new Error('输出目录缺少交接或续作信息');
    const index = json(indexFile), warnings = [], reports = [], rootIssues = [], historicalIssues = [];
    const view = path.join(directory, 'views');
    if (fs.existsSync(view)) throw new Error('派生包 reports 视图已存在，拒绝重复覆盖');
    fs.mkdirSync(view);
    for (const item of index.assets ?? []) {
      const entry = ctx.registry.assets.find(asset => asset.asset_id === item.asset_id);
      if (entry?.type !== 'REPORT') continue;
      const reportOutput = path.join(view, item.asset_id, item.version); fs.mkdirSync(reportOutput, { recursive: true });
      const rendered = renderInto(ctx, ctx.snapshot(item.asset_id, item.version), reportOutput, { mode: 'package', snapshotDirectory: snapshot => copySnapshot(snapshot, directory) });
      const prefix = slash(path.relative(directory, reportOutput));
      rootIssues.push(...rendered.root_issues.map(issue => ({ ...issue, issue_page: `${prefix}/${issue.issue_page}` })));
      historicalIssues.push(...rendered.historical_issues.map(issue => ({ ...issue, issue_page: `${prefix}/${issue.issue_page}` })));
      warnings.push(...rendered.warnings); reports.push({ asset_id: item.asset_id, version: item.version, path: slash(path.relative(directory, reportOutput)), ...rendered });
    }
    fs.writeFileSync(path.join(view, '阅读视图.json'), text({ schema_version: 1, mode: 'package', generated_at: new Date().toISOString(), reports, warnings, root_issues: rootIssues, historical_issues: historicalIssues }), { flag: 'wx' });
    const description = ['交接说明.md', '续作说明.md'].map(name => path.join(directory, name)).find(filename => fs.existsSync(filename));
    if (description && reports.length) {
      const issues = [...rootIssues, ...historicalIssues];
      const diagnostics = issues.length ? `\n## 报告链接检查\n\n根报告未定位 ${rootIssues.length} 项，引用的历史说明未定位 ${historicalIssues.length} 项。下列页面为链接诊断说明，素材仍为未定位；不提供素材或验收结论。\n\n${issues.map(issue => `- [${issue.asset_id}@${issue.version}/${issue.file}:${issue.line}（${issue.scope === 'root' ? '根报告' : '历史说明'}）](${issue.issue_page.split('/').map(encodeSegment).join('/')})：${issue.reason}`).join('\n')}\n` : '';
      fs.appendFileSync(description, `\n## 报告阅读视图\n\n原冻结 assets 字节保留。可移植报告链接见：\n\n${reports.flatMap(item => item.reports.map(report => `- [${report.identity}](${`${item.path}/${report.path}/${report.entrypoint}`.split('/').map(encodeSegment).join('/')})`)).join('\n')}\n${diagnostics}`);
    }
    return { ok: rootIssues.length === 0, action: 'render-package-links', output: directory, mode: 'package', reports, warnings: [...new Set(warnings)], errors: [], root_issues: rootIssues, historical_issues: historicalIssues };
  } catch (error) { return { ok: false, action: 'render-package-links', output, reports: [], warnings: [], errors: [error.message] }; }
}
