import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_TYPES, createAssetSkeleton, mediaFileErrors, referenceBindingErrors, normalizeReviewRecord,
  assertReviewPasses, reviewItemId, normalizeReviewDisposition, dispositionMatches,
} from '../src/rules.mjs';

const context = { reviewId: 'RV-test-001', projectId: 'IP901', assetId: 'IP901-CH-001', version: '1.0.0', manifestSha256: 'a'.repeat(64), recordedAt: '2026-09-28T08:00:00.000Z' };
const review = (extra = {}) => ({ method: 'ai', reviewer: '本轮文字审核代理', scope: '正文及六份配套资料、世界规则和前章出口状态', coverage: 'full', result: 'pass', issues: [], evidence: '已逐段对照章1段1至段4、世界规则 R1 和前章状态；本次未查看媒体。', ...extra });
const issue = (extra = {}) => ({ id: 'F001', severity: 'revision', status: 'open', description: '甲使用了此前已交出的钥匙', evidence: '章2段3与章1段4的交接记录冲突。', ...extra });
const stale = (extra = {}) => ({ asset_id: 'IP901-SHOT-001', version: '1.0.0', dependency_id: 'IP901-WORLD-001', referenced_version: '1.0.0', current_version: '1.1.0', via: ['IP901-CH-001@1.0.0', 'IP901-EP-001@1.0.0'], ...extra });
const disposition = (extra = {}) => ({ ...stale(), decision: 'keep-history', reason: '本镜为规则变更前的回忆，保留旧故事时期。', evidence: 'SHOT001 story_time 与章1段2均处于禁令变更之前。', method: 'human', reviewer: '本项目创作者（测试夹具）', ...extra });
const dispositionContext = { projectId: 'IP901', recordedAt: '2026-09-28T08:00:00Z' };

function hasContent(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasContent);
  if (value && typeof value === 'object') return Object.values(value).some(hasContent);
  return value !== null && value !== undefined;
}

test('十三类骨架有可填字段但没有虚构剧情、引用或完成状态', () => {
  for (const type of ASSET_TYPES) {
    const { asset, files } = createAssetSkeleton({ projectId: 'IP901', type, sequence: 2, title: '工作标题' });
    assert.equal(asset.asset_id, `IP901-${type}-002`);
    assert.equal(asset.version, '1.0.0');
    assert.equal(asset.adoption_status, '建议');
    assert.deepEqual(asset.refs, []);
    assert.ok(Object.keys(asset.data).length > 0);
    assert.equal(hasContent(asset.data), false, `${type} 骨架不能假装有实际内容`);
    assert.equal(Object.keys(files).length, type === 'CH' ? 7 : 0);
  }
});

test('章骨架七文件使用chapter_id和统一版本，配套JSON可解析且没有伪造事件', () => {
  const { asset, files } = createAssetSkeleton({ projectId: 'IP901', type: 'CH', sequence: '003', version: '2.0.0' });
  assert.equal(files['正文.md'], '');
  assert.deepEqual(Object.keys(files), ['正文.md', '摘要.json', '出场人物.json', '场景.json', '情绪节点.json', '新增设定.json', '漫改建议.json']);
  for (const [filename, content] of Object.entries(files)) {
    if (filename === '正文.md') continue;
    const data = JSON.parse(content);
    assert.equal(data.chapter_id, asset.asset_id);
    assert.equal(data.version, asset.version);
    assert.equal(data.project_id, asset.project_id);
    assert.equal(Object.hasOwn(data, 'asset_id'), false);
  }
  assert.deepEqual(asset.data.events, []);
});

test('不同骨架互不污染，非法ID/类型/版本/序号直接拒绝', () => {
  const first = createAssetSkeleton({ projectId: 'IP901', type: 'WORLD', sequence: 1 });
  first.asset.data.rules.push('仅修改第一份草稿');
  assert.deepEqual(createAssetSkeleton({ projectId: 'IP901', type: 'WORLD', sequence: 1 }).asset.data.rules, []);
  const plot = createAssetSkeleton({ projectId: 'IP901', type: 'PLOT', sequence: 1 }).asset.data;
  assert.equal(plot.reading_mode, '');
  assert.deepEqual(plot.relationship_debts, []);
  const state = createAssetSkeleton({ projectId: 'IP901', type: 'STATE', sequence: 1 }).asset.data;
  assert.deepEqual(state.knowledge, []);
  assert.deepEqual(state.possessions, []);
  assert.deepEqual(state.foreshadowing, []);
  for (const options of [{ projectId: '../IP901' }, { type: 'INVALID' }, { version: '1.0' }, { sequence: 0 }, { sequence: -1 }, { sequence: '1/../../' }, { sequence: 1.5 }]) {
    assert.throws(() => createAssetSkeleton({ projectId: 'IP901', type: 'CH', sequence: 1, ...options }));
  }
});

test('MEDIA文件形状和资产内路径校验，不把metadata或目录外文件登记为媒体', () => {
  assert.deepEqual(mediaFileErrors([{ path: 'images/人物.png', kind: 'image' }, { path: 'sound/对白.wav', kind: 'audio' }], { requireFiles: true }), []);
  assert.deepEqual(mediaFileErrors([]), []);
  assert.ok(mediaFileErrors([], { requireFiles: true }).length);
  for (const filepath of ['../他人.png', 'C:/外部.png', '/绝对.png', 'images/../外部.png', 'images//空.png', 'images/CON.png', 'asset.json', '_snapshot.json', 'image.png:流', 'images/尾空格 ']) assert.ok(mediaFileErrors([{ path: filepath, kind: 'image' }]).length, filepath);
  assert.ok(mediaFileErrors([{ path: 'test.png', kind: 'photo' }]).length);
  assert.ok(mediaFileErrors([{ path: 'A.png', kind: 'image' }, { path: 'a.png', kind: 'image' }]).some(error => /重复/.test(error)));
});

test('参考绑定校验可选声明形状、确切MEDIA引用和安全路径，用途标识只要求非空字符串', () => {
  const media = { asset_id: 'IP901-MEDIA-001', version: '1.0.0' };
  const valid = { media, file_path: '素材\\姿态 #1.png', expected_usage_id: 'K0', role: '接触前姿态' };
  assert.deepEqual(referenceBindingErrors([]), []);
  assert.deepEqual(referenceBindingErrors([valid, { ...valid, expected_usage_id: 'K0' }]), []);
  assert.deepEqual(referenceBindingErrors([{ media, file_path: '图片.png' }]), []);
  for (const bindings of [null, {}, '', [null], ['图片.png'], [{ file_path: '图片.png' }], [{ media: { ...media, asset_id: 'IP901-CHAR-001' }, file_path: '图片.png' }], [{ media: { asset_id: media.asset_id }, file_path: '图片.png' }]]) assert.ok(referenceBindingErrors(bindings).length);
  for (const file_path of ['', null, 1, '../图.png', '/图.png', 'C:/图.png', '素材/../图.png', '素材//图.png', '素材/CON.png', '图.png:流', 'asset.json', '素材/_snapshot.json']) assert.ok(referenceBindingErrors([{ media, file_path }]).length, String(file_path));
  for (const usage_id of ['', '  ', null, 1, {}, []]) {
    assert.ok(mediaFileErrors([{ path: '图.png', kind: 'image', usage_id }]).some(error => /usage_id/.test(error)));
    assert.ok(referenceBindingErrors([{ ...valid, expected_usage_id: usage_id }]).some(error => /expected_usage_id/.test(error)));
  }
  assert.deepEqual(mediaFileErrors([{ path: '甲.png', kind: 'image', usage_id: 'K0' }, { path: '乙.png', kind: 'image', usage_id: 'K0' }]), []);
  assert.deepEqual(referenceBindingErrors([{ ...valid, expected_usage_id: ' K0 ' }]), []);
});

test('审核绑定已保存版本和hash，默认partial不冒充全文审核或人工审核', () => {
  const input = review({ coverage: undefined });
  const record = normalizeReviewRecord(input, context);
  assert.equal(record.method, 'ai');
  assert.equal(record.coverage, 'partial');
  assert.equal(record.manifest_sha256, context.manifestSha256);
  assert.equal(Object.hasOwn(record, 'reviewed_at'), false);
  assert.throws(() => assertReviewPasses(record, context), /full/);
  assert.equal(input.coverage, undefined);
});

test('完整通过审核可精确绑定；其他资产、新版本或不同快照均拒绝复用', () => {
  const record = normalizeReviewRecord(review(), context);
  assert.deepEqual(assertReviewPasses(record, context), record);
  for (const changed of [{ assetId: 'IP901-CH-002' }, { version: '1.0.1' }, { manifestSha256: 'b'.repeat(64) }]) assert.throws(() => assertReviewPasses(record, { ...context, ...changed }), /不一致/);
  assert.throws(() => normalizeReviewRecord(review({ asset_id: 'IP902-CH-001' }), context), /不一致/);
  assert.throws(() => normalizeReviewRecord(review(), { ...context, assetId: 'IP902-CH-001' }), /跨 IP/);
});

test('通过门禁拒绝未解决阻塞和应修订；已解决或可选润色不会阻断', () => {
  for (const severity of ['blocker', 'revision']) assert.throws(() => normalizeReviewRecord(review({ issues: [issue({ severity })] }), context), /尚未解决/);
  const resolved = normalizeReviewRecord(review({ issues: [issue({ status: 'resolved', evidence: '已阅读修订版，甲改为请持钥匙的乙开门。' })] }), context);
  assert.doesNotThrow(() => assertReviewPasses(resolved, context));
  const suggestion = normalizeReviewRecord(review({ issues: [issue({ severity: 'suggestion' })] }), context);
  assert.doesNotThrow(() => assertReviewPasses(suggestion, context));
  for (const result of ['revise', 'unverified']) assert.throws(() => assertReviewPasses(normalizeReviewRecord(review({ result }), context), context), /尚未通过/);
});

test('审核要求真实范围、审查人和证据；联合、伪时间、重复问题拒绝', () => {
  for (const field of ['reviewer', 'scope', 'evidence']) assert.throws(() => normalizeReviewRecord(review({ [field]: '' }), context), new RegExp(field));
  assert.throws(() => normalizeReviewRecord(review({ issues: [issue({ evidence: '' })], result: 'revise' }), context), /evidence/);
  assert.throws(() => normalizeReviewRecord(review({ method: '联合' }), context), /method/);
  assert.throws(() => normalizeReviewRecord(review({ reviewed_at: '昨天' }), context), /reviewed_at/);
  assert.throws(() => normalizeReviewRecord(review({ reviewed_at: '2026-02-31T08:00:00Z' }), context), /不存在/);
  assert.throws(() => normalizeReviewRecord(review({ reviewed_at: '2026-09-28T24:00:00Z' }), context), /不存在/);
  assert.throws(() => normalizeReviewRecord(review({ result: 'revise', issues: [issue(), issue()] }), context), /重复/);
  assert.throws(() => normalizeReviewRecord(review(), { ...context, manifestSha256: '' }), /manifest_sha256/);
});

test('规范字段接受中文枚举，旧字段拒绝，修改稿未复查不误关问题', () => {
  const input = { method: '人工', reviewer: '实际检查者（测试夹具）', scope: '全文', coverage: 'full', result: '需修订', issues: [{ id: '问题一', severity: '应修订', status: '已实际应用待复查', description: '需要复查修改稿', evidence: '已收到替换段落但尚未对照。' }], evidence: '仅形成问题报告。' };
  const record = normalizeReviewRecord(input, context);
  assert.equal(record.method, 'human'); assert.equal(record.result, 'revise');
  assert.equal(record.issues[0].severity, 'revision'); assert.equal(record.issues[0].status, 'open');
  assert.equal(Object.hasOwn(record, 'reviewer_kind'), false);
  assert.throws(() => normalizeReviewRecord({ ...input, method: undefined, reviewer_kind: '人工' }, context), /请使用 method/);
  assert.throws(() => normalizeReviewRecord({ ...input, reviewer_kind: '人工' }, context), /请使用 method/);
  assert.throws(() => normalizeReviewRecord({ ...input, result: undefined, conclusion: '需修订' }, context), /请使用 result/);
  assert.throws(() => normalizeReviewRecord({ ...input, conclusion: '需修订' }, context), /请使用 result/);
});

test('复核稳定ID覆盖确切上下游版本及via，忽略描述顺序和刷新时间', () => {
  assert.equal(reviewItemId(stale()), reviewItemId({ reason: '刷新文案', ...stale() }));
  for (const changed of [
    { asset_id: 'IP901-SHOT-002' }, { version: '1.0.1' }, { dependency_id: 'IP901-WORLD-002' },
    { referenced_version: '0.9.0' }, { current_version: '1.2.0' }, { via: [] },
    { via: ['IP901-CH-001@1.0.1', 'IP901-EP-001@1.0.0'] },
    { via: ['IP901-EP-001@1.0.0', 'IP901-CH-001@1.0.0'] },
  ]) assert.notEqual(reviewItemId(stale()), reviewItemId(stale(changed)));
});

test('保留历史结论仅消解同一精确影响路径，后续变更重开且原记录不变', () => {
  const record = normalizeReviewDisposition(disposition(), dispositionContext);
  const before = JSON.stringify(record);
  assert.equal(dispositionMatches(stale(), record), true);
  for (const changed of [{ current_version: '1.2.0' }, { version: '1.0.1' }, { via: [] }]) assert.equal(dispositionMatches(stale(changed), record), false);
  assert.equal(JSON.stringify(record), before);
  assert.equal(record.review_item_id, reviewItemId(stale()));
});

test('复核需要证据且不接受跨IP、伪身份和无版本差异的广泛豁免', () => {
  for (const field of ['reason', 'evidence', 'reviewer']) assert.throws(() => normalizeReviewDisposition(disposition({ [field]: '' }), dispositionContext), new RegExp(field));
  assert.throws(() => normalizeReviewDisposition(disposition({ via: ['IP902-CH-001@1.0.0'] }), dispositionContext), /跨 IP/);
  assert.throws(() => normalizeReviewDisposition(disposition({ current_version: '1.0.0' }), dispositionContext), /相同/);
  assert.throws(() => normalizeReviewDisposition(disposition({ review_item_id: 'RI-incorrect' }), dispositionContext), /不一致/);
  assert.equal(dispositionMatches(stale(), { ...normalizeReviewDisposition(disposition(), dispositionContext), evidence: '' }), false);
});
