import fs from 'node:fs';
import { SYSTEM, fail, hash, assertReviewPasses, normalizeReviewRecord } from './rules.mjs';
import { safePath, readJSON } from './storage.mjs';
export function reviewRecord(root, project, reviewId) {
  const records = (project.content_reviews ?? []).filter(record => record.review_id === reviewId);
  if (records.length !== 1) fail(`审核记录 ${reviewId} 不存在或重复`);
  const index = records[0];
  if (index.path !== `${SYSTEM}/reviews/${reviewId}/review.json`) fail('审核记录路径无效');
  const filename = safePath(root, index.path);
  const bytes = fs.readFileSync(filename);
  if (hash(bytes) !== index.sha256) fail(`审核记录 ${reviewId} 校验值不一致`);
  const record = readJSON(filename);
  if (record.review_id !== reviewId || record.project_id !== project.project_id || record.asset_id !== index.asset_id || record.version !== index.version || record.manifest_sha256 !== index.manifest_sha256) fail(`审核记录 ${reviewId} 身份或版本不一致`);
  return record;
}
export function latestReview(root, project, assetId, version, manifestSha256) {
  const index = (project.content_reviews ?? []).filter(record => record.asset_id === assetId && record.version === version && record.manifest_sha256 === manifestSha256).at(-1);
  return index ? reviewRecord(root, project, index.review_id) : null;
}
export function reviewForSnapshot(root, project, snapshot, { reviewId, required = false } = {}) {
  const context = { assetId: snapshot.asset.asset_id, version: snapshot.asset.version, manifestSha256: snapshot.saved.manifest_sha256 };
  const indexes = (project.content_reviews ?? []).filter(record => record.asset_id === context.assetId && record.version === context.version && record.manifest_sha256 === context.manifestSha256);
  let effective = null, lastBlocking = -1;
  const records = indexes.map((index, position) => {
    const record = reviewRecord(root, project, index.review_id);
    const normalized = normalizeReviewRecord(record, { reviewId: index.review_id, projectId: project.project_id, ...context, recordedAt: record.recorded_at });
    // Registration order is authoritative. Partial passes supplement an existing
    // full pass; only a new full pass can restore evidence after a blocking result.
    if (normalized.result !== 'pass') { effective = null; lastBlocking = position; }
    else if (normalized.coverage === 'full') effective = record;
    return record;
  });
  if (reviewId) {
    const selected = reviewRecord(root, project, reviewId);
    assertReviewPasses(selected, context);
    if (records.findIndex(record => record.review_id === reviewId) <= lastBlocking) fail('审核结论尚未通过：所选完整审核之后存在需修订或待核实记录，必须绑定阻断之后的新 full 完整通过审核');
    return selected;
  }
  if (effective) return effective;
  if (!required) return null;
  if (lastBlocking >= 0) fail('审核结论尚未通过：需修订或待核实记录之后尚无新的 full 完整通过审核');
  if (records.length) fail('正式采用／章节交接需要 full 完整范围，局部通过只能补证，不能建立完整审核依据');
  fail(`${context.assetId}@${context.version}：缺少绑定此快照的内容审核记录`);
}
