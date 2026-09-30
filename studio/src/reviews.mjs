import fs from 'node:fs';
import { SYSTEM, fail, hash, assertReviewPasses } from './rules.mjs';
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
  const latest = latestReview(root, project, context.assetId, context.version, context.manifestSha256);
  const selected = reviewId ? reviewRecord(root, project, reviewId) : latest;
  if (!selected) { if (required) fail(`${context.assetId}@${context.version}：缺少绑定此快照的内容审核记录`); return null; }
  if (required || reviewId) {
    assertReviewPasses(selected, context);
    if (latest && latest.review_id !== selected.review_id) assertReviewPasses(latest, context);
  }
  return selected;
}
