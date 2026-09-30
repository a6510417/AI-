import { filled, fail } from './rules.mjs';
import { readProject, registryErrors, findEntry, operation } from './registry.mjs';
import { exportClosure, ensureNoErrors } from './dependencies.mjs';
import { withLock, commit } from './transactions.mjs';

function changeLifecycle({ project: root, asset: assetId, reason }, lifecycle) {
  if (!filled(reason)) fail('退役或恢复必须提供具体 --reason');
  return withLock(root, resolved => {
    const project = readProject(resolved);
    if (project.schema_version !== 2) fail('候选退役及恢复仅适用于 v2 项目');
    ensureNoErrors(registryErrors(resolved, project));
    const entry = findEntry(project, assetId), previous = entry.lifecycle ?? 'active';
    if (previous === lifecycle) fail(lifecycle === 'retired' ? '候选已经退役' : '候选已经处于活动状态');
    if (entry.adopted_version || (project.adoption_history ?? []).some(event => event.asset_id === assetId)) fail('已采用过的资产不能作为未采用候选退役或恢复');
    const adoptedClosure = exportClosure(resolved, project, null, { requireBridge: false });
    if (adoptedClosure.some(snapshot => snapshot.asset.asset_id === assetId)) fail('候选被已采用下游引用，不能退役或恢复');
    entry.lifecycle = lifecycle;
    const action = lifecycle === 'retired' ? 'retire-asset' : 'restore-asset';
    const record = operation(project, action, { asset_id: assetId, previous_lifecycle: previous, lifecycle, reason });
    (project.lifecycle_history ??= []).push({ asset_id: assetId, previous_lifecycle: previous, lifecycle, reason, at: record.at, operation_id: record.operation_id });
    commit(resolved, project, { action });
    return { ok: true, action, asset_id: assetId, lifecycle, message: lifecycle === 'retired' ? '未采用候选已退役；文件及历史保留，退出行动待办。' : '候选已恢复；仍须保存、审核并明确采用。' };
  });
}
export function retireAsset(options) { return changeLifecycle(options, 'retired'); }
export function restoreAsset(options) { return changeLifecycle(options, 'active'); }
