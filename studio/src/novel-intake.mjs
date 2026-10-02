import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = message => { throw new Error(message); };
const headingDefault = '^(?:正文_|_)?第(.+?)章[ \\t]*(.*)$';
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pathKey = value => path.resolve(value).toLowerCase();

function ordinaryPath(absolute, mustExist = true) {
  for (let cursor = path.resolve(absolute);;) {
    if (fs.existsSync(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink()) fail(`拒绝符号链接或目录联接：${cursor}`);
    } else if (cursor === absolute && mustExist) fail(`文件不存在：${absolute}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolute;
}
function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) fail(`非法相对路径：${relative}`);
  const absolute = path.resolve(root, relative);
  if (!pathKey(absolute).startsWith(pathKey(root) + path.sep)) fail(`路径越界：${relative}`);
  return ordinaryPath(absolute);
}
function readBytes(file) {
  const absolute = ordinaryPath(path.resolve(file));
  if (!fs.statSync(absolute).isFile()) fail(`需要普通文件：${absolute}`);
  return fs.readFileSync(absolute);
}
function protectedOutput(absolute, mode) {
  const pieces = absolute.toLowerCase().split(/[\\/]/);
  if (pieces.includes('.ip-system')) fail('禁止写入冻结快照、审核或系统历史目录');
  for (const name of ['archive', 'backups', 'releases']) {
    const reserved = path.join(workspaceRoot, name);
    if (pathKey(absolute) === pathKey(reserved) || pathKey(absolute).startsWith(pathKey(reserved) + path.sep)) fail(`禁止写入历史、备份或发行目录：${reserved}`);
  }
  for (let parent = path.dirname(absolute);;) {
    if (fs.existsSync(path.join(parent, 'project.json'))) {
      const relative = path.relative(parent, absolute).toLowerCase().split(path.sep);
      const permitted = mode === 'ingest' ? relative[0] === 'sources' : relative[0] === 'production' && relative[1] === '.staging' && !!relative[2];
      if (!permitted) fail(mode === 'ingest' ? '项目接入输出仅允许全新 sources 子目录' : '项目取材输出仅允许 production/.staging/<任务标识>/，不写正式资产、冻结历史或旧交付');
      break;
    }
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
}
function freshOutput(output, input, mode = 'read') {
  const absolute = path.resolve(output);
  ordinaryPath(absolute, false);
  protectedOutput(absolute, mode);
  if (fs.existsSync(absolute)) fail(`目标已存在，拒绝覆盖：${absolute}`);
  if (input && pathKey(input).startsWith(pathKey(absolute) + path.sep)) fail('输出目录不能包含输入文件');
  return absolute;
}
function writeFiles(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, bytes] of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
}
function decode(bytes, encoding) {
  const normalized = String(encoding ?? '').toLowerCase();
  if (!['utf-8', 'utf-16le', 'utf-16be'].includes(normalized)) fail('须显式指定 --encoding utf-8、utf-16le 或 utf-16be；不猜测编码');
  const text = new TextDecoder(normalized, { fatal: true, ignoreBOM: true }).decode(bytes);
  const encoded = normalized === 'utf-8' ? Buffer.from(text, 'utf8') : Buffer.from(text, 'utf16le');
  if (normalized === 'utf-16be') encoded.swap16();
  if (!encoded.equals(bytes)) fail('编码往返不一致，停止接入');
  const byteOffsets = new Uint32Array(text.length + 1);
  if (normalized !== 'utf-8') for (let i = 0; i <= text.length; i++) byteOffsets[i] = i * 2;
  else {
    let offset = 0;
    for (let i = 0; i < text.length;) {
      const code = text.codePointAt(i), units = code > 0xffff ? 2 : 1;
      byteOffsets[i] = offset;
      if (units === 2) byteOffsets[i + 1] = offset;
      offset += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      i += units; byteOffsets[i] = offset;
    }
  }
  return { text, byteOffsets, encoding: normalized };
}
function linesOf(text) {
  const lines = [];
  const re = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for (const match of text.matchAll(re)) {
    if (!match[0].length) continue;
    lines.push({ text: match[0].replace(/(?:\r\n|\r|\n)$/, ''), start: match.index, end: match.index + match[0].length });
  }
  return lines;
}
function chapterNumber(text) {
  if (/^\d+$/.test(text)) return Number.isSafeInteger(Number(text)) ? Number(text) : null;
  if (!/^[〇零一二三四五六七八九十百千万两]+$/.test(text)) return null;
  const digits = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if ([...text].every(char => Object.hasOwn(digits, char))) { const parsed = Number([...text].map(char => digits[char]).join('')); return Number.isSafeInteger(parsed) ? parsed : null; }
  let group = 0, number = 0, total = 0, previousUnit = 10000, sawTenThousand = false;
  for (const char of text) {
    if (Object.hasOwn(digits, char)) number = digits[char];
    else if (char === '万') {
      if (sawTenThousand) return null;
      total += (group + number || 1) * 10000; group = 0; number = 0; previousUnit = 10000; sawTenThousand = true;
    } else {
      const unit = { 十: 10, 百: 100, 千: 1000 }[char];
      if (unit >= previousUnit) return null;
      group += (number || 1) * unit; number = 0; previousUnit = unit;
    }
  }
  return total + group + number;
}
function regex(source) {
  try { return new RegExp(source, 'u'); } catch (error) { fail(`正则无效：${error.message}`); }
}

/** Copies the source once. Splitting is explicit; no CH, review or adoption is created. */
export function ingestNovel({ input, output, encoding, split, separator = '------------', headingPattern = headingDefault, packaging = ['正文', '正文卷'], adPattern }) {
  if (!input || !output) fail('接入需要 --input 和 --output');
  if (split !== undefined && !['heading', 'separator'].includes(split)) fail('--split 仅支持 heading 或 separator；省略时只保留原稿');
  const root = freshOutput(output, input, 'ingest'), bytes = readBytes(input), decoded = decode(bytes, encoding);
  const { text, byteOffsets } = decoded, lines = linesOf(text), heading = regex(headingPattern);
  const segments = [], chapters = [], anomalies = [], files = [], boundaries = [];
  const addAnomaly = (kind, segment, start, end, detail) => {
    const id = `A${String(anomalies.length + 1).padStart(6, '0')}`;
    anomalies.push({ id, kind, segment_id: segment?.id ?? null, character_start: start, character_end_exclusive: end, byte_start: byteOffsets[start], byte_end_exclusive: byteOffsets[end], detail });
    const chapter = chapters.find(row => row.segment_id === segment?.id);
    if (chapter) chapter.anomaly_ids.push(id);
    return id;
  };
  if (split === 'heading') {
    lines.forEach((line, i) => { if (heading.test(line.text.replace(/^\uFEFF/, ''))) boundaries.push({ line: i, heading: i }); });
  } else if (split === 'separator') {
    lines.forEach((line, i) => {
      if (line.text !== separator) return;
      let j = i + 1;
      while (j < lines.length && !lines[j].text.trim()) j++;
      if (j === lines.length) fail(`分隔符之后没有标题：行 ${i + 1}`);
      if (!heading.test(lines[j].text) && !packaging.includes(lines[j].text)) fail(`未识别分隔块，须明确标题或包装规则：行 ${j + 1}`);
      boundaries.push({ line: i, heading: j });
    });
  }
  if (split && !boundaries.length) fail('未找到章节边界，停止；不能将猜测结果当作无损分章');
  const sourcePath = `原稿/${path.basename(input)}`;
  files.push([sourcePath, bytes]);
  const addSegment = (start, end, kind, headingLine) => {
    const id = `S${String(segments.length + 1).padStart(6, '0')}`;
    const sequence = kind === 'chapter' ? chapters.length + 1 : null;
    const segmentPath = split ? `${kind === 'chapter' ? '分章' : '包装'}/${id}.txt` : sourcePath;
    const fragment = bytes.subarray(byteOffsets[start], byteOffsets[end]);
    const segment = { id, kind, path: segmentPath, byte_start: byteOffsets[start], byte_end_exclusive: byteOffsets[end], sha256: sha(fragment), character_start: start, character_end_exclusive: end };
    segments.push(segment);
    if (split) files.push([segmentPath, fragment]);
    if (kind === 'chapter') {
      const line = lines[headingLine], raw = line.text.replace(/^\uFEFF/, ''), match = raw.match(heading);
      segment.heading_line = headingLine + 1;
      segment.body_character_start = line.end;
      segment.body_byte_start = byteOffsets[line.end];
      const numberText = match[1] ?? '', number = chapterNumber(numberText);
      const chapter = { sequence, segment_id: id, heading: raw, chapter_number_text: numberText, chapter_number: number, anomaly_ids: [] };
      chapters.push(chapter);
      if (number === null) addAnomaly('unrecognized-number', segment, line.start, line.end, '保留原题，不推定或改写编号');
      if (match[2] !== undefined && !match[2].trim()) addAnomaly('empty-title', segment, line.start, line.end, '原题无题名，不补造');
    }
    return segment;
  };
  if (!split) addSegment(0, text.length, 'source');
  else {
    if (lines[boundaries[0].line].start > 0) addSegment(0, lines[boundaries[0].line].start, 'packaging');
    boundaries.forEach((boundary, i) => addSegment(lines[boundary.line].start, i + 1 < boundaries.length ? lines[boundaries[i + 1].line].start : text.length, packaging.includes(lines[boundary.heading].text) ? 'packaging' : 'chapter', boundary.heading));
  }
  const numberGroups = new Map();
  for (const chapter of chapters) {
    if (chapter.chapter_number === null) continue;
    const previous = numberGroups.get(chapter.chapter_number);
    if (previous) {
      const segment = segments.find(row => row.id === chapter.segment_id);
      const id = addAnomaly('duplicate-number', segment, segment.character_start, segment.body_character_start, { other_segment_id: previous.segment_id, note: '按物理顺序保留，重复编号不证明正文重复' });
      previous.anomaly_ids.push(id);
    } else numberGroups.set(chapter.chapter_number, chapter);
  }
  const markers = /<!--[^]*?-->|<\/?[A-Za-z][^>]*>/gu;
  const scanMarkers = (regexp, kind) => {
    let segmentIndex = 0;
    for (const match of text.matchAll(regexp)) {
      while (segments[segmentIndex + 1] && match.index >= segments[segmentIndex].character_end_exclusive) segmentIndex++;
      addAnomaly(kind, segments[segmentIndex], match.index, match.index + match[0].length, '仅标记；原稿与分章原字节保留。取材时人工核对后生成选章清理版本');
    }
  };
  scanMarkers(markers, 'html-marker');
  if (adPattern) scanMarkers(new RegExp(regex(adPattern).source, 'gu'), 'advert-marker');
  const reconstructed = Buffer.concat(segments.map(segment => bytes.subarray(segment.byte_start, segment.byte_end_exclusive)));
  if (!reconstructed.equals(bytes)) fail('无损拼接核验失败');
  const catalog = { intake_version: 1, source: { path: sourcePath, encoding: decoded.encoding, bytes: bytes.length, sha256: sha(bytes), character_units: 'UTF-16 code units', characters: text.length }, split: split ?? null, segments, chapters, anomalies, operations: [{ action: 'ingest', at: new Date().toISOString(), scope: split ? '原稿存档与无损分章；程序结构扫描' : '仅原稿存档', reconstruction: 'byte-identical', semantic_review: '未进行' }] };
  files.push(['intake.json', json(catalog)]);
  writeFiles(root, files);
  return { ok: true, action: 'ingest', output: root, catalog: path.join(root, 'intake.json'), source_sha256: catalog.source.sha256, chapters: chapters.length, anomalies: anomalies.length, reconstruction: 'byte-identical', assets_created: 0 };
}

function loadCatalog(catalogFile) {
  const absolute = path.resolve(catalogFile), data = JSON.parse(readBytes(absolute).toString('utf8'));
  if (data.intake_version === 1) return { root: path.dirname(absolute), catalog: data, legacy: false };
  // Read-only adapter for the existing v1 sources layout; never migrates or rewrites it.
  if (!Array.isArray(data.chapters) || !data.source?.original_path) fail('不支持的接入索引');
  const root = path.dirname(path.dirname(absolute)), manifest = JSON.parse(readBytes(path.join(path.dirname(absolute), '拼接顺序.json')).toString('utf8'));
  if (manifest.original_sha256 !== data.source.sha256 || manifest.original_bytes !== data.source.bytes) fail('旧索引与拼接清单的原稿基准不一致');
  const bytes = readBytes(inside(root, data.source.original_path)), decoded = decode(bytes, String(data.source.encoding).toLowerCase());
  const wanted = new Set(manifest.fragments.flatMap(row => [row.byte_start, row.byte_end_exclusive]));
  data.chapters.forEach(row => wanted.add(row.body_byte_start));
  const positions = new Map();
  decoded.byteOffsets.forEach((offset, character) => { if (wanted.has(offset) && !positions.has(offset)) positions.set(offset, character); });
  const segments = manifest.fragments.map((row, i) => ({ id: `S${String(i + 1).padStart(6, '0')}`, kind: row.kind, path: row.path, byte_start: row.byte_start, byte_end_exclusive: row.byte_end_exclusive, sha256: row.sha256, character_start: positions.get(row.byte_start), character_end_exclusive: positions.get(row.byte_end_exclusive) }));
  const chapters = data.chapters.map(row => {
    const segment = segments.find(part => part.path === row.path);
    if (!segment || ['byte_start', 'byte_end_exclusive', 'sha256'].some(key => segment[key] !== row[key])) fail(`旧索引与拼接清单不一致：${row.path}`);
    segment.body_byte_start = row.body_byte_start;
    segment.body_character_start = positions.get(row.body_byte_start);
    segment.heading_line = row.heading_line;
    return { sequence: row.source_sequence, segment_id: segment.id, heading: row.source_heading_raw, chapter_number: row.source_chapter_number, anomaly_ids: [] };
  });
  return { root, legacy: true, catalog: { intake_version: 1, source: { path: data.source.original_path, bytes: data.source.bytes, sha256: data.source.sha256, encoding: decoded.encoding }, segments, chapters } };
}
function checkedCatalog(catalogFile, selected) {
  const loaded = loadCatalog(catalogFile), { root, catalog } = loaded;
  const bytes = readBytes(inside(root, catalog.source.path));
  if (bytes.length !== catalog.source.bytes || sha(bytes) !== catalog.source.sha256) fail('原稿字节或哈希不符');
  const decoded = decode(bytes, catalog.source.encoding), ids = new Set(), paths = new Set();
  let end = 0, checked = 0;
  for (const segment of catalog.segments) {
    if (ids.has(segment.id) || paths.has(segment.path)) fail('片段ID或路径重复');
    ids.add(segment.id); paths.add(segment.path);
    if (segment.byte_start !== end || !Number.isInteger(segment.byte_end_exclusive) || segment.byte_end_exclusive < end || segment.byte_end_exclusive > bytes.length) fail(`拼接区间不连续或越界：${segment.id}`);
    if (!scalarBoundary(decoded.text, segment.character_start) || !scalarBoundary(decoded.text, segment.character_end_exclusive) || decoded.byteOffsets[segment.character_start] !== segment.byte_start || decoded.byteOffsets[segment.character_end_exclusive] !== segment.byte_end_exclusive) fail(`字节与字符定位不一致：${segment.id}`);
    const originalFragment = bytes.subarray(segment.byte_start, segment.byte_end_exclusive);
    if (sha(originalFragment) !== segment.sha256) fail(`片段记录哈希不符：${segment.id}`);
    if (!selected || selected.has(segment.id)) {
      const fragment = readBytes(inside(root, segment.path));
      if (!fragment.equals(originalFragment)) fail(`无损片段核验失败：${segment.path}`);
      checked++;
    }
    end = segment.byte_end_exclusive;
  }
  if (end !== bytes.length) fail('拼接清单未覆盖原稿EOF');
  return { ...loaded, bytes, ...decoded, checked };
}
export function verifyNovel({ catalog }) {
  if (!catalog) fail('核验需要 --catalog');
  const result = checkedCatalog(catalog);
  return { ok: true, action: 'verify', catalog: path.resolve(catalog), compatibility: result.legacy ? 'existing-v1-read-only' : 'intake-v1', source_sha256: result.catalog.source.sha256, fragments_checked: result.checked, reconstruction: 'byte-identical', scope: '原稿、全部片段及区间/哈希核验；不证明全文语义审核', files_written: 0 };
}
function selection(value) {
  if (!value || value === 'all' || value === '*') fail('须显式列出本轮取材章物理序，不支持默认全书清理');
  const numbers = [];
  for (const part of String(value).split(',')) {
    if (/^[1-9]\d*$/.test(part)) {
      if (!Number.isSafeInteger(Number(part))) fail(`选章数字超出安全整数范围：${part}`);
      numbers.push(Number(part));
    }
    else {
      const match = part.match(/^([1-9]\d*)-([1-9]\d*)$/);
      if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < Number(match[1]) || Number(match[2]) - Number(match[1]) > 10000) fail(`选章无效或数字超出安全整数范围：${part}`);
      for (let n = Number(match[1]); n <= Number(match[2]); n++) numbers.push(n);
    }
  }
  return [...new Set(numbers)];
}
function scalarBoundary(text, index) {
  if (!Number.isInteger(index) || index < 0 || index > text.length) return false;
  return !(index > 0 && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff);
}
function requireScalarText(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) fail('清理规则含孤立Unicode代理字符');
    } else if (code >= 0xdc00 && code <= 0xdfff) fail('清理规则含孤立Unicode代理字符');
  }
}
function cleanBody(text, rules) {
  const changes = [], warnings = [];
  const push = (start, original, replacement, rule) => {
    if (!scalarBoundary(text, start) || !scalarBoundary(text, start + original.length)) fail('清理范围截断Unicode字符，无法提供无损字节定位');
    requireScalarText(replacement);
    changes.push({ start, end: start + original.length, replacement, rule });
  };
  const htmlNames = 'html|head|body|title|meta|link|p|br|hr|div|span|em|strong|b|i|u|s|a|img|font|h[1-6]|blockquote|pre|code|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|script|style';
  const tags = new RegExp(`<!--|-->|<\\/?(?:${htmlNames})(?=[\\s/>])[^>]*>`, 'giu');
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.kind === 'html') {
      // Only remove markup delimiters/tags. Comment/script/style text remains until
      // a human confirms an explicit literal rule; no keyword-based story deletion.
      for (const match of text.matchAll(tags)) {
        const tag = match[0].match(/^<(\/)?([a-z0-9]+)/i), name = tag?.[2].toLowerCase();
        const newline = name === 'br' || name === 'hr' || (tag?.[1] && /^(p|div|li|tr|h[1-6]|blockquote|pre|table)$/.test(name));
        push(match.index, match[0], newline ? '\n' : '', i);
      }
      for (const match of text.matchAll(/<\/?[A-Za-z][^>]*>/gu)) if (!changes.some(change => change.start === match.index && change.end === match.index + match[0].length)) warnings.push({ kind: 'unknown-html-like-text-preserved', start: match.index, end: match.index + match[0].length });
      for (const match of text.matchAll(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/giu)) {
        const entity = match[0].slice(1, -1).toLowerCase(), names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
        const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : entity.startsWith('#') ? Number(entity.slice(1)) : null;
        if (code !== null && (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))) fail(`HTML实体编码无效：${match[0]}`);
        const replacement = code === null ? names[entity] : String.fromCodePoint(code);
        if (!changes.some(change => match.index >= change.start && match.index < change.end)) push(match.index, match[0], replacement, i);
      }
    } else if (rule.kind === 'literal' && typeof rule.text === 'string' && rule.text.length) {
      if (typeof (rule.replacement ?? '') !== 'string') fail('literal replacement 须为字符串');
      requireScalarText(rule.text); requireScalarText(rule.replacement ?? '');
      for (let start = text.indexOf(rule.text); start !== -1; start = text.indexOf(rule.text, start + rule.text.length)) push(start, rule.text, rule.replacement ?? '', i);
    } else fail('清理规则只支持 html 或非空 literal；广告文本须明确列出');
  }
  changes.sort((a, b) => a.start - b.start || b.end - a.end);
  for (let i = 1; i < changes.length; i++) if (changes[i].start < changes[i - 1].end) fail('清理规则范围重叠，须缩小规则，不能自动删去不确定正文');
  let result = '', cursor = 0;
  for (const change of changes) {
    result += text.slice(cursor, change.start);
    change.output_start = result.length; result += change.replacement; change.output_end_exclusive = result.length;
    cursor = change.end;
  }
  result += text.slice(cursor);
  return { text: result, changes, warnings };
}
/** Generates only the selected production reading text and one replayable trace. */
export function readNovelSelection({ catalog: catalogFile, chapters, output, cleanHtml = false, plan }) {
  if (!catalogFile || !output) fail('取材需要 --catalog、--chapters 和 --output');
  const numbers = selection(chapters), loaded = loadCatalog(catalogFile);
  const chosen = numbers.map(number => loaded.catalog.chapters.find(row => row.sequence === number) ?? fail(`物理序不存在：${number}`));
  const root = freshOutput(output), result = checkedCatalog(catalogFile, new Set(chosen.map(row => row.segment_id)));
  const rules = plan ? JSON.parse(readBytes(plan).toString('utf8')).rules : [];
  if (!Array.isArray(rules)) fail('清理计划须包含 rules 数组');
  if (cleanHtml) rules.unshift({ kind: 'html' });
  const trace = { reading_version: 1, catalog: path.resolve(catalogFile), source_sha256: result.catalog.source.sha256, encoding: result.encoding, rules, chapters: [], operations: [{ action: 'read-selection', at: new Date().toISOString(), scope: `物理序 ${numbers.join(',')}；选章文本提取与明确规则清理，未做语义审核` }] };
  const parts = [];
  for (const chapter of chosen) {
    const segment = result.catalog.segments.find(row => row.id === chapter.segment_id);
    if (!scalarBoundary(result.text, segment.body_character_start) || result.byteOffsets[segment.body_character_start] !== segment.body_byte_start || segment.body_byte_start < segment.byte_start || segment.body_byte_start > segment.byte_end_exclusive) fail(`正文定位无效：${chapter.sequence}`);
    const original = result.text.slice(segment.body_character_start, segment.character_end_exclusive), cleaned = cleanBody(original, rules);
    const heading = `# ${chapter.heading}\n\n`;
    parts.push(heading + cleaned.text);
    trace.chapters.push({ sequence: chapter.sequence, segment_id: segment.id, generated_heading: heading, source_body_byte_start: segment.body_byte_start, source_body_byte_end_exclusive: segment.byte_end_exclusive, source_body_character_start: segment.body_character_start, source_body_character_end_exclusive: segment.character_end_exclusive, source_body_sha256: sha(result.bytes.subarray(segment.body_byte_start, segment.byte_end_exclusive)), cleaned_body_sha256_utf8: sha(Buffer.from(cleaned.text)), warnings: cleaned.warnings.map(warning => ({ kind: warning.kind, source_character_start: segment.body_character_start + warning.start, source_character_end_exclusive: segment.body_character_start + warning.end, source_byte_start: result.byteOffsets[segment.body_character_start + warning.start], source_byte_end_exclusive: result.byteOffsets[segment.body_character_start + warning.end] })), transformations: cleaned.changes.map(change => ({ rule: change.rule, source_character_start: segment.body_character_start + change.start, source_character_end_exclusive: segment.body_character_start + change.end, source_byte_start: result.byteOffsets[segment.body_character_start + change.start], source_byte_end_exclusive: result.byteOffsets[segment.body_character_start + change.end], replacement: change.replacement, output_body_character_start: change.output_start, output_body_character_end_exclusive: change.output_end_exclusive })) });
  }
  const reading = parts.join('\n\n');
  trace.output = { path: '阅读文本.md', sha256_utf8: sha(Buffer.from(reading)), separator: '\n\n' };
  writeFiles(root, [['阅读文本.md', reading], ['来源追溯.json', json(trace)]]);
  return { ok: true, action: 'read-selection', output: root, chapters: numbers, transformations: trace.chapters.reduce((sum, chapter) => sum + chapter.transformations.length, 0), warnings: trace.chapters.reduce((sum, chapter) => sum + chapter.warnings.length, 0), source_sha256: trace.source_sha256, output_sha256: trace.output.sha256_utf8, scope: '已选正文与清理定位；原稿和分章未改，未创建/保存/审核/采用资产' };
}

export const INTAKE_HELP = `可复用小说接入（不登记或采用资产）
ingest --input 原稿.txt --output 新目录 --encoding utf-8 [--split heading|separator] [--separator ------------] [--heading-pattern 正则] [--packaging 正文,正文卷] [--ad-pattern 正则]
verify --catalog 新目录/intake.json
verify --catalog 现有项目/sources/章节索引.json （兼容只读，无需重导）
read --catalog 索引.json --chapters 1-3,5 --output production/.staging/本轮/取材 [--clean-html] [--plan 清理计划.json]
清理计划：{"rules":[{"kind":"literal","text":"经人工确认的广告原文","replacement":""}]}
--clean-html 只移除白名单标签/注释边界，块标签与br/hr保留换行并解码实体；未知标签样式原样保留并定位提示，script/style/注释文字保留；广告用明确literal规则。
索引唯一维护定位/拼接/哈希；异常详情仅一处。选章按物理序，不按可能重复的原章号。
ingest 未指定 split 只存档；read 未明确选章即拒绝，all/* 被拒绝。输出必须不存在。
项目内ingest仅写全新sources子目录，read仅写production/.staging/<任务标识>/；禁止冻结历史、正式资产、历史/备份/发行目录。
正式 CH 只为本轮必要来源使用既有 new-asset，直接填七文件，再 save-version；不批量正式化。
`;

export function novelIntakeMain(args) {
  try {
    if (!args.length || args.includes('--help')) { process.stdout.write(INTAKE_HELP); return; }
    const [command, ...rest] = args, values = {};
    const boolean = new Set(['clean-html']);
    const accepted = { ingest: new Set(['input', 'output', 'encoding', 'split', 'separator', 'heading-pattern', 'packaging', 'ad-pattern']), verify: new Set(['catalog']), read: new Set(['catalog', 'chapters', 'output', 'clean-html', 'plan']) }[command];
    if (!accepted) fail(`未知命令：${command}`);
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i].slice(2);
      if (!rest[i].startsWith('--') || !accepted.has(key) || Object.hasOwn(values, key)) fail(`未知或重复参数：${rest[i]}`);
      if (boolean.has(key)) values[key] = true;
      else { if (rest[i + 1] === undefined || /^--[A-Za-z][A-Za-z-]*$/.test(rest[i + 1])) fail(`参数缺值：${rest[i]}`); values[key] = rest[++i]; }
    }
    const result = command === 'ingest' ? ingestNovel({ ...values, headingPattern: values['heading-pattern'], packaging: values.packaging?.split(','), adPattern: values['ad-pattern'] }) : command === 'verify' ? verifyNovel(values) : readNovelSelection({ ...values, cleanHtml: values['clean-html'] });
    process.stdout.write(json(result));
  } catch (error) { process.stderr.write(json({ ok: false, error: error.message })); process.exitCode = 1; }
}
