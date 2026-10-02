import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash, jsonText, normalizeReviewRecord } from '../src/rules.mjs';
import { latestReview, reviewForSnapshot } from '../src/reviews.mjs';
import { initProject, newAsset, saveVersion, recordReview, adoptVersion, exportProject, projectStatus, CHAPTER_FILES } from '../src/project-service.mjs';

const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => fs.writeFileSync(filename, jsonText(value));
function temporaryRoot(t) {
  const base = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'studio-review-evidence-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), base);
    assert.ok(path.basename(root).startsWith('studio-review-evidence-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function evidence(extra = {}) {
  return { method: 'ai', reviewer: '隔离审核链回归夹具', scope: '测试快照正文及配套文件', coverage: 'full', result: 'pass', issues: [], evidence: '仅验证精确快照的审核链行为，不代表真实作品内容检查。', ...extra };
}
function chain(t) {
  const root = temporaryRoot(t), project = { project_id: 'IP992', content_reviews: [] };
  const snapshot = { asset: { asset_id: 'IP992-CH-001', version: '1.0.0' }, saved: { manifest_sha256: 'a'.repeat(64) } };
  let sequence = 0;
  const append = (extra = {}, binding = {}) => {
    const reviewId = `REV-${++sequence}`;
    const record = normalizeReviewRecord(evidence(extra), { reviewId, projectId: project.project_id, assetId: snapshot.asset.asset_id, version: snapshot.asset.version, manifestSha256: snapshot.saved.manifest_sha256, recordedAt: '2026-10-01T00:00:00.000Z', ...binding });
    const relative = `.ip-system/reviews/${reviewId}/review.json`, filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); write(filename, record);
    project.content_reviews.push({ review_id: reviewId, path: relative, sha256: hash(fs.readFileSync(filename)), asset_id: record.asset_id, version: record.version, manifest_sha256: record.manifest_sha256 });
    return record;
  };
  const select = (options = { required: true }) => reviewForSnapshot(root, project, snapshot, options);
  return { root, project, snapshot, append, select };
}

test('无审核或只有局部通过时不能建立完整依据', t => {
  const fixture = chain(t);
  assert.equal(fixture.select({}), null);
  assert.throws(() => fixture.select(), /缺少绑定此快照/);
  const partial = fixture.append({ coverage: 'partial' });
  assert.equal(fixture.select({}), null);
  assert.throws(() => fixture.select(), /full 完整范围/);
  assert.throws(() => fixture.select({ reviewId: partial.review_id }), /完整范围/);
});

test('完整通过后局部通过只补证，原始最新记录与自动有效依据各自保留', t => {
  const fixture = chain(t), full = fixture.append();
  const partial = fixture.append({ coverage: 'partial' });
  assert.equal(fixture.select().review_id, full.review_id);
  assert.equal(fixture.select({}).review_id, full.review_id);
  assert.equal(fixture.select({ required: true, reviewId: full.review_id }).review_id, full.review_id);
  assert.equal(latestReview(fixture.root, fixture.project, fixture.snapshot.asset.asset_id, '1.0.0', fixture.snapshot.saved.manifest_sha256).review_id, partial.review_id);
  assert.throws(() => fixture.select({ reviewId: partial.review_id }), /完整范围/);
});

test('自动选择最近有效完整通过，显式可绑定同一有效区间内较早完整通过', t => {
  const fixture = chain(t), first = fixture.append(), second = fixture.append();
  fixture.append({ coverage: 'partial' });
  assert.equal(fixture.select().review_id, second.review_id);
  assert.equal(fixture.select({ reviewId: first.review_id }).review_id, first.review_id);
});

for (const result of ['revise', 'unverified']) for (const coverage of ['full', 'partial']) {
  test(`${coverage}/${result} 阻断旧依据，局部通过不能恢复，必须新完整通过`, t => {
    const fixture = chain(t), original = fixture.append();
    fixture.append({ coverage, result });
    assert.equal(fixture.select({}), null);
    assert.throws(() => fixture.select(), /审核结论尚未通过/);
    assert.throws(() => fixture.select({ reviewId: original.review_id }), /尚未通过/);
    const partial = fixture.append({ coverage: 'partial' });
    assert.throws(() => fixture.select(), /尚未通过/);
    assert.throws(() => fixture.select({ reviewId: partial.review_id }), /完整范围/);
    const restored = fixture.append();
    fixture.append({ coverage: 'partial' });
    assert.equal(fixture.select().review_id, restored.review_id);
    assert.equal(fixture.select({ reviewId: restored.review_id }).review_id, restored.review_id);
    assert.throws(() => fixture.select({ reviewId: original.review_id }), /尚未通过/);
  });
}

test('多个阻断以最近一次为界，阻断前的完整通过不能被新局部通过重新启用', t => {
  const fixture = chain(t);
  fixture.append({ coverage: 'partial', result: 'revise' });
  const intermediate = fixture.append();
  fixture.append({ coverage: 'partial', result: 'unverified' });
  fixture.append({ coverage: 'partial' });
  assert.throws(() => fixture.select(), /尚未通过/);
  assert.throws(() => fixture.select({ reviewId: intermediate.review_id }), /尚未通过/);
  const final = fixture.append();
  assert.equal(fixture.select().review_id, final.review_id);
});

test('登记顺序决定阻断与恢复，不以 reviewed_at 时间重新排序', t => {
  const fixture = chain(t), full = fixture.append({ reviewed_at: '2026-10-03T00:00:00.000Z' });
  fixture.append({ coverage: 'partial', reviewed_at: '2026-10-02T00:00:00.000Z' });
  assert.equal(fixture.select().review_id, full.review_id);
  fixture.append({ result: 'revise', reviewed_at: '2026-10-01T00:00:00.000Z' });
  assert.throws(() => fixture.select(), /尚未通过/);
  const restored = fixture.append({ reviewed_at: '2026-09-01T00:00:00.000Z' });
  assert.equal(fixture.select().review_id, restored.review_id);
});

for (const [label, binding] of [
  ['其他资产', { assetId: 'IP992-CH-002' }],
  ['其他版本', { version: '1.0.1' }],
  ['其他哈希', { manifestSha256: 'b'.repeat(64) }],
]) {
  test(`显式审核拒绝${label}，无关审核不改变当前快照有效依据`, t => {
    const fixture = chain(t), current = fixture.append(), other = fixture.append({}, binding);
    assert.equal(fixture.select().review_id, current.review_id);
    assert.throws(() => fixture.select({ reviewId: other.review_id }), /一致|身份|版本/);
  });
}

test('不存在或重复审核编号不能作为显式依据', t => {
  const fixture = chain(t), full = fixture.append();
  assert.throws(() => fixture.select({ reviewId: 'REV-missing' }), /不存在或重复/);
  fixture.project.content_reviews.push({ ...fixture.project.content_reviews[0] });
  assert.throws(() => fixture.select(), /不存在或重复/);
  assert.throws(() => fixture.select({ reviewId: full.review_id }), /不存在或重复/);
});

for (const damagedPosition of [0, 1, 2]) {
  test(`相关链第${damagedPosition + 1}项损坏时不能跳过，即使后面有新完整通过`, t => {
    const fixture = chain(t);
    fixture.append(); fixture.append({ coverage: 'partial' }); fixture.append({ result: 'revise' });
    const newest = fixture.append();
    const index = fixture.project.content_reviews[damagedPosition];
    const filename = path.join(fixture.root, index.path), record = read(filename);
    record.evidence += '被修改的历史证据'; write(filename, record);
    assert.throws(() => fixture.select(), /校验值不一致/);
    assert.throws(() => fixture.select({ reviewId: newest.review_id }), /校验值不一致/);
    assert.throws(() => fixture.select({}), /校验值不一致/);
  });
}

test('相关局部记录结构无效时不能仅凭哈希匹配和后续完整通过略过', t => {
  const fixture = chain(t); fixture.append(); fixture.append({ coverage: 'partial' }); fixture.append();
  const index = fixture.project.content_reviews[1], filename = path.join(fixture.root, index.path), record = read(filename);
  record.coverage = 'unknown'; write(filename, record); index.sha256 = hash(fs.readFileSync(filename));
  assert.throws(() => fixture.select(), /coverage/);
});

function projectFixture(t) {
  const root = temporaryRoot(t), project = initProject({ root, id: 'IP992', name: '审核链临时项目' }).project;
  const registry = () => read(path.join(project, 'project.json'));
  const ref = type => ({ asset_id: `IP992-${type}-001`, version: '1.0.0' });
  let inputSequence = 0;
  const review = (asset, extra = {}) => {
    const file = `production/review-input-${++inputSequence}.json`;
    write(path.join(project, file), evidence(extra));
    return recordReview({ project, asset, version: '1.0.0', file }).review_id;
  };
  const draft = (type, data) => {
    const asset = newAsset({ project, type, title: `${type}审核链测试` }).asset_id;
    const directory = path.join(project, registry().assets.find(entry => entry.asset_id === asset).path);
    const filename = path.join(directory, 'asset.json'), content = read(filename); content.data = data; write(filename, content);
    if (type === 'CH') {
      fs.writeFileSync(path.join(directory, '正文.md'), '来客接稳钥匙，守灯人才松手。');
      for (const filename of CHAPTER_FILES.slice(1)) write(path.join(directory, filename), { project_id: 'IP992', chapter_id: asset, version: '1.0.0', entries: filename === '新增设定.json' ? [] : ['同一把钥匙的交接状态'] });
    }
    saveVersion({ project, asset });
    return asset;
  };
  const adopt = (asset, reviewId) => adoptVersion({ project, asset, version: '1.0.0', reason: '隔离测试绑定有效完整审核', review: reviewId });
  const chapter = draft('CH', { events: [{ event_id: 'E01', story_time: '第一夜', summary: '交还钥匙' }] });
  const initialReview = review(chapter); adopt(chapter, initialReview);
  const event = { ...ref('CH'), event_id: 'E01' };
  for (const [type, data] of [
    ['LOC', { description: '石塔灯室' }],
    ['EP', { episode_number: 1, chapter_refs: [ref('CH')] }],
    ['SC', { scene_number: 1, episode: ref('EP'), location: ref('LOC'), source_refs: [event], script: '接稳钥匙后松手' }],
    ['SHOT', { episode: ref('EP'), scene: ref('SC'), source_refs: [event], shot_number: 1, start_seconds: 0, duration_seconds: 5, story_time: '第一夜', scene_description: '石塔灯室', characters: '守灯人与来客', action: '来客接稳钥匙后守灯人才松手', emotion: '释然', dialogue: '无', shot_size: '双手近景', camera_movement: '固定', lighting: '暖光', video_prompt: '固定双手近景，来客接稳钥匙后守灯人才松手。', visual_description: '同一把钥匙全程可见' }],
  ]) { const asset = draft(type, data); adopt(asset, review(asset)); }
  const reviewPending = () => projectStatus({ project }).pending.filter(item => item.asset_id === chapter && item.action === '补齐精确版本的完整内容审核');
  const exportedReview = name => {
    const output = exportProject({ project, out: `deliveries/handoff/${name}` });
    return read(path.join(output.output, 'handoff.json')).content_reviews;
  };
  return { project, registry, chapter, initialReview, review, adopt, reviewPending, exportedReview };
}

test('采用、status和正式导出共用有效完整审核：补证保留，阻断后需新完整通过', t => {
  const fixture = projectFixture(t);
  const partial = fixture.review(fixture.chapter, { coverage: 'partial' });
  assert.deepEqual(fixture.reviewPending(), []);
  assert.equal(fixture.adopt(fixture.chapter, fixture.initialReview).ok, true);
  assert.equal(fixture.registry().adoption_history.at(-1).review_id, fixture.initialReview);
  assert.throws(() => fixture.adopt(fixture.chapter, partial), /完整范围/);
  assert.deepEqual(fixture.exportedReview('补证包'), [fixture.initialReview]);
  fixture.review(fixture.chapter, { coverage: 'partial', result: 'unverified' });
  fixture.review(fixture.chapter, { coverage: 'partial' });
  assert.equal(fixture.reviewPending().length, 1);
  assert.match(fixture.reviewPending()[0].reason, /尚未通过/);
  assert.throws(() => fixture.adopt(fixture.chapter, fixture.initialReview), /尚未通过/);
  assert.throws(() => fixture.exportedReview('阻断包'), /尚未通过/);
  assert.equal(fs.existsSync(path.join(fixture.project, 'deliveries/handoff/阻断包')), false);
  const restored = fixture.review(fixture.chapter);
  fixture.review(fixture.chapter, { coverage: 'partial' });
  assert.deepEqual(fixture.reviewPending(), []);
  assert.throws(() => fixture.adopt(fixture.chapter, fixture.initialReview), /尚未通过/);
  assert.equal(fixture.adopt(fixture.chapter, restored).ok, true);
  assert.deepEqual(fixture.exportedReview('恢复包'), [restored]);
});

test('相关旧局部证据损坏会在status、采用及导出中阻断，不能被新完整审核遮掉', t => {
  const fixture = projectFixture(t), partial = fixture.review(fixture.chapter, { coverage: 'partial' });
  const restored = fixture.review(fixture.chapter);
  const index = fixture.registry().content_reviews.find(item => item.review_id === partial), filename = path.join(fixture.project, index.path);
  const record = read(filename); record.evidence += '损坏记录'; write(filename, record);
  assert.match(fixture.reviewPending()[0].reason, /校验值不一致/);
  assert.throws(() => fixture.adopt(fixture.chapter, restored), /校验值不一致/);
  assert.throws(() => fixture.exportedReview('损坏链包'), /校验值不一致/);
});
