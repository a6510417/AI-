import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ingestNovel, verifyNovel, readNovelSelection } from '../src/novel-intake.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'novel-intake-'), root = fs.mkdtempSync(prefix);
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('novel-intake-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}
function create(root, text, encoding = 'utf-8') {
  const bytes = Buffer.from(text, encoding === 'utf-8' ? 'utf8' : 'utf16le');
  if (encoding === 'utf-16be') bytes.swap16();
  const input = path.join(root, '原稿.txt'); fs.writeFileSync(input, bytes);
  const output = path.join(root, 'sources');
  const result = ingestNovel({ input, output, encoding, split: 'separator' });
  return { bytes, input, output, catalog: result.catalog, result };
}
test('explicit lossless splitting retains BOM, mixed endings, packaging, duplicate chapters and astral characters', t => {
  const root = fixture(t), text = '\uFEFF卷前文字\r\n------------\r\n\r\n正文\r\n------------\n第一章 开始\r\n甲😀<p>危险</p>\r\n    第一章 开始\n------------\r第二章 反击\r乙\r------------\n第二章 原号重复\n丙';
  const source = create(root, text), data = JSON.parse(fs.readFileSync(source.catalog));
  assert.equal(source.result.chapters, 3);
  assert.deepEqual(data.chapters.map(row => row.chapter_number), [1, 2, 2]);
  assert.equal(data.segments.filter(row => row.kind === 'packaging').length, 2);
  assert.equal(data.anomalies.filter(row => row.kind === 'duplicate-number').length, 1);
  assert.ok(data.chapters[1].anomaly_ids.some(id => data.chapters[2].anomaly_ids.includes(id)));
  assert.ok(data.chapters.every(row => !('contamination' in row) && !('sha256' in row) && !('byte_start' in row)));
  const joined = Buffer.concat(data.segments.map(row => fs.readFileSync(path.join(source.output, row.path))));
  assert.ok(joined.equals(source.bytes));
  const before = fs.readFileSync(source.catalog);
  assert.equal(verifyNovel({ catalog: source.catalog }).reconstruction, 'byte-identical');
  assert.ok(fs.readFileSync(source.catalog).equals(before));
});
test('archiving alone does not create splits or formal source assets', t => {
  const root = fixture(t), input = path.join(root, '全文.txt'); fs.writeFileSync(input, '第一章 未请求分章\n内容');
  const result = ingestNovel({ input, output: path.join(root, 'archive'), encoding: 'utf-8' });
  const data = JSON.parse(fs.readFileSync(result.catalog));
  assert.equal(result.chapters, 0); assert.equal(result.assets_created, 0);
  assert.equal(data.segments.length, 1); assert.equal(data.segments[0].path, data.source.path);
  assert.deepEqual(fs.readdirSync(path.dirname(result.catalog)).sort(), ['intake.json', '原稿']);
  assert.equal(verifyNovel({ catalog: result.catalog }).fragments_checked, 1);
});
test('the public CLI accepts an explicit hyphen separator and runs read-only verification', t => {
  const root = fixture(t), input = path.join(root, '原稿.txt'), output = path.join(root, 'sources');
  fs.writeFileSync(input, '------------\n第一章 原稿\n文字');
  const cli = fileURLToPath(new URL('../bin/novel-intake.mjs', import.meta.url));
  const intake = spawnSync(process.execPath, [cli, 'ingest', '--input', input, '--output', output, '--encoding', 'utf-8', '--split', 'separator', '--separator', '------------'], { encoding: 'utf8' });
  assert.equal(intake.status, 0, intake.stderr);
  const result = JSON.parse(intake.stdout); assert.equal(result.chapters, 1);
  const verify = spawnSync(process.execPath, [cli, 'verify', '--catalog', result.catalog], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr); assert.equal(JSON.parse(verify.stdout).files_written, 0);
});
for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) test(`${encoding} selected reading has byte-correct, replayable cleaning and leaves other chapters untouched`, t => {
  const root = fixture(t), source = create(root, '\uFEFF前言\n------------\n第一章 求生\n<p>甲😀&amp;乙</p><!-- 广告 --><script>广告函数()</script>已核对广告词\n------------\n第二章 未取材\n<em>保留</em>', encoding);
  const plan = path.join(root, 'plan.json'); fs.writeFileSync(plan, JSON.stringify({ rules: [{ kind: 'literal', text: '已核对广告词' }, { kind: 'literal', text: ' 广告 ' }, { kind: 'literal', text: '广告函数()' }] }));
  const result = readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(root, 'staging'), cleanHtml: true, plan });
  const reading = fs.readFileSync(path.join(result.output, '阅读文本.md'), 'utf8'), trace = JSON.parse(fs.readFileSync(path.join(result.output, '来源追溯.json')));
  assert.match(reading, /甲😀&乙/); assert.doesNotMatch(reading, /未取材|广告|<p>/);
  assert.equal(trace.chapters.length, 1); assert.equal(hash(Buffer.from(reading)), trace.output.sha256_utf8);
  const chapter = trace.chapters[0], transforms = chapter.transformations;
  const rawBody = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(source.bytes.subarray(chapter.source_body_byte_start, chapter.source_body_byte_end_exclusive));
  let replay = '', cursor = 0;
  for (const change of transforms) {
    const start = change.source_character_start - chapter.source_body_character_start, end = change.source_character_end_exclusive - chapter.source_body_character_start;
    const original = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(source.bytes.subarray(change.source_byte_start, change.source_byte_end_exclusive));
    assert.equal(original, rawBody.slice(start, end));
    replay += rawBody.slice(cursor, start) + change.replacement; cursor = end;
  }
  replay += rawBody.slice(cursor);
  assert.equal(reading, chapter.generated_heading + replay);
  assert.ok(fs.readFileSync(source.input).equals(source.bytes));
  assert.equal(verifyNovel({ catalog: source.catalog }).reconstruction, 'byte-identical');
});
test('HTML-only cleanup preserves prose inside tags, comments and script/style text', t => {
  const root = fixture(t), source = create(root, '------------\n第一章 内容\n<p>真正的正文</p><!-- 评论文字 --><script>可能是正文</script><style>同样待判断</style>');
  const result = readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(root, 'html-only'), cleanHtml: true });
  const reading = fs.readFileSync(path.join(result.output, '阅读文本.md'), 'utf8');
  assert.match(reading.replace(/\s+/g, ' '), /真正的正文 评论文字 可能是正文同样待判断/);
  assert.doesNotMatch(reading, /<p>|<!--|<script>/);
});
test('HTML cleaning preserves unknown game symbols and paragraph/action boundaries', t => {
  const root = fixture(t), source = create(root, '------------\n第一章 显示\n生命值<HP=1>仍在下降<br>第二个动作<p>别动！</p><p>趴下！</p>');
  const result = readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(root, 'html'), cleanHtml: true });
  const text = fs.readFileSync(path.join(result.output, '阅读文本.md'), 'utf8'), trace = JSON.parse(fs.readFileSync(path.join(result.output, '来源追溯.json')));
  assert.match(text, /生命值<HP=1>仍在下降\n第二个动作/);
  assert.match(text, /别动！\n趴下！\n/);
  assert.equal(result.warnings, 1); assert.equal(trace.chapters[0].warnings[0].kind, 'unknown-html-like-text-preserved');
});
test('project outputs protect snapshots, assets, old deliveries and permit one staging location', t => {
  const root = fixture(t), source = create(root, '------------\n第一章 示例\n正文');
  const project = path.join(root, 'IP009'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'project.json'), '{}');
  for (const target of ['.ip-system/snapshots/CH/1.0.0/reading', 'assets/CH/CH001/reading', 'deliveries/handoff/old/reading', 'sources/new-reading', 'production/.staging']) {
    assert.throws(() => readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(project, target) }), /禁止|仅允许/);
    assert.ok(!fs.existsSync(path.join(project, target)));
  }
  assert.throws(() => ingestNovel({ input: source.input, output: path.join(project, 'assets/new-source'), encoding: 'utf-8' }), /仅允许/);
  const staged = readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(project, 'production/.staging/task-1/reading') });
  assert.ok(fs.existsSync(path.join(staged.output, '阅读文本.md')));
  const imported = ingestNovel({ input: source.input, output: path.join(project, 'sources/new-intake'), encoding: 'utf-8' });
  assert.ok(fs.existsSync(imported.catalog));
});
test('partial surrogate cleanup and unsafe selection integers are rejected before any output', t => {
  const root = fixture(t), source = create(root, '------------\n第一章 字符\n甲😀乙');
  const plan = path.join(root, 'plan.json');
  for (const rule of [{ kind: 'literal', text: '\ud83d' }, { kind: 'literal', text: '😀', replacement: '\ude00' }]) {
    fs.writeFileSync(plan, JSON.stringify({ rules: [rule] }));
    assert.throws(() => readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(root, 'partial'), plan }), /孤立Unicode/);
    assert.ok(!fs.existsSync(path.join(root, 'partial')));
  }
  for (const chapters of ['9007199254740992', '9007199254740992-9007199254740992']) assert.throws(() => readNovelSelection({ catalog: source.catalog, chapters, output: path.join(root, 'oversized') }), /安全整数/);
  assert.ok(!fs.existsSync(path.join(root, 'oversized')));
});
test('Windows case variants cannot bypass frozen/archive protection and permitted staging is case-insensitive', t => {
  const root = fixture(t), source = create(root, '------------\n第一章 原稿\n正文');
  const project = path.join(root, 'IP010'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'project.json'), '{}');
  for (const target of ['.IP-SYSTEM/SNAPSHOTS/CH/1.0.0/NEW', 'ASSETS/CH/NEW', 'DELIVERIES/RESUME/NEW']) {
    assert.throws(() => readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(project, target) }), /禁止|仅允许/);
    assert.ok(!fs.existsSync(path.join(project, target)));
  }
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  for (const reserved of ['ARCHIVE', 'BACKUPS', 'RELEASES']) {
    const forbidden = path.join(workspace, reserved, `__never-write-${path.basename(root)}`);
    assert.throws(() => readNovelSelection({ catalog: source.catalog, chapters: '1', output: forbidden }), /禁止/);
    assert.ok(!fs.existsSync(forbidden));
  }
  const read = readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(project, 'PRODUCTION/.STAGING/Task/Reading') });
  assert.ok(fs.existsSync(path.join(read.output, '阅读文本.md')));
  const intake = ingestNovel({ input: source.input, output: path.join(project, 'SOURCES/Intake'), encoding: 'utf-8' });
  assert.ok(fs.existsSync(intake.catalog));
});
test('unsafe inputs, ambiguous cleaning, unselected whole-book cleanup and changed fragments are rejected without overwriting', t => {
  const root = fixture(t), source = create(root, '------------\n第一章 原稿\n<p>正文广告</p>\n');
  assert.throws(() => ingestNovel({ input: source.input, output: path.join(root, 'missing-encoding') }), /显式/);
  assert.throws(() => ingestNovel({ input: source.input, output: source.output, encoding: 'utf-8' }), /已存在/);
  assert.throws(() => readNovelSelection({ catalog: source.catalog, chapters: 'all', output: path.join(root, 'all') }), /显式/);
  assert.throws(() => readNovelSelection({ catalog: source.catalog, chapters: '2', output: path.join(root, 'absent') }), /不存在/);
  const plan = path.join(root, 'plan.json'); fs.writeFileSync(plan, JSON.stringify({ rules: [{ kind: 'literal', text: '<p>正文' }] }));
  assert.throws(() => readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(root, 'overlap'), cleanHtml: true, plan }), /重叠/);
  assert.ok(!fs.existsSync(path.join(root, 'overlap')));
  const data = JSON.parse(fs.readFileSync(source.catalog)); fs.writeFileSync(path.join(source.output, data.segments[0].path), '改过的片段');
  assert.throws(() => verifyNovel({ catalog: source.catalog }), /无损片段/);
  assert.throws(() => readNovelSelection({ catalog: source.catalog, chapters: '1', output: path.join(root, 'bad') }), /无损片段/);
  assert.ok(!fs.existsSync(path.join(root, 'bad')));
});
test('invalid UTF-8 and unknown separator blocks fail before producing output', t => {
  const root = fixture(t), input = path.join(root, 'bad.txt'); fs.writeFileSync(input, Buffer.from([0xc3, 0x28]));
  assert.throws(() => ingestNovel({ input, output: path.join(root, 'bad'), encoding: 'utf-8' }));
  assert.ok(!fs.existsSync(path.join(root, 'bad')));
  fs.writeFileSync(input, '------------\n无法识别的边界\n正文');
  assert.throws(() => ingestNovel({ input, output: path.join(root, 'unknown'), encoding: 'utf-8', split: 'separator' }), /未识别/);
  assert.ok(!fs.existsSync(path.join(root, 'unknown')));
});
test('existing v1 project sources are verified/read without migration or reimport', t => {
  const root = fixture(t), source = create(root, '包装\n------------\n第一章 开始\n<p>文字</p>\n');
  const modern = JSON.parse(fs.readFileSync(source.catalog)), legacyRoot = path.join(root, 'legacy'), legacySources = path.join(legacyRoot, 'sources');
  fs.mkdirSync(legacySources, { recursive: true });
  for (const part of [modern.source, ...modern.segments]) {
    const target = path.join(legacySources, part.path); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source.output, part.path), target);
  }
  const index = { source: { original_path: `sources/${modern.source.path}`, encoding: 'UTF-8', bytes: source.bytes.length, sha256: modern.source.sha256 }, chapters: modern.chapters.map(row => {
    const segment = modern.segments.find(item => item.id === row.segment_id);
    return { source_sequence: row.sequence, source_heading_raw: row.heading, source_chapter_number: row.chapter_number, path: `sources/${segment.path}`, byte_start: segment.byte_start, byte_end_exclusive: segment.byte_end_exclusive, sha256: segment.sha256, body_byte_start: segment.body_byte_start, heading_line: segment.heading_line };
  }) };
  const manifest = { original_bytes: source.bytes.length, original_sha256: modern.source.sha256, fragments: modern.segments.map(row => ({ ...row, path: `sources/${row.path}` })) };
  const catalog = path.join(legacySources, '章节索引.json'); fs.writeFileSync(catalog, JSON.stringify(index)); fs.writeFileSync(path.join(legacySources, '拼接顺序.json'), JSON.stringify(manifest));
  const before = fs.readFileSync(catalog);
  assert.equal(verifyNovel({ catalog }).compatibility, 'existing-v1-read-only');
  const reading = readNovelSelection({ catalog, chapters: '1', output: path.join(root, 'legacy-reading'), cleanHtml: true });
  assert.match(fs.readFileSync(path.join(reading.output, '阅读文本.md'), 'utf8'), /文字/);
  assert.ok(fs.readFileSync(catalog).equals(before));
  index.chapters[0].sha256 = '0'.repeat(64); fs.writeFileSync(catalog, JSON.stringify(index));
  assert.throws(() => verifyNovel({ catalog }), /旧索引与拼接清单不一致/);
});
