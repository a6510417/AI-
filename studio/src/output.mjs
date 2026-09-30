import fs from 'node:fs';
import path from 'node:path';
import { CHAPTER_FILES, SHOT_LABELS, object, referenceKey, eventKey } from './rules.mjs';
import { relativeFiles, writeSynced, compareFiles, fingerprint } from './storage.mjs';
export function dataMarkdown(value, prefix = '', options = {}) {
  if (Array.isArray(value)) return !value.length && options.preserveEmpty ? [`${prefix}[]`] : value.flatMap((item, index) => dataMarkdown(item, `${prefix}${index + 1}. `, options));
  if (object(value) && value.asset_id && value.version) {
    const metadata = Object.fromEntries(Object.entries(value).filter(([key]) => !['asset_id', 'version', 'event_id'].includes(key)));
    return [`${prefix}${referenceKey(value)}${value.event_id ? `#${value.event_id}` : ''}`, ...(Object.keys(metadata).length ? dataMarkdown(metadata, prefix, options) : [])];
  }
  if (object(value)) {
    const labels = { summary: '概述', script: '剧本', dialogue: '对白', dialogues: '对白', beats: '行动段落', action: '动作', actions: '动作', story_time: '故事时间', location: '地点', episode: '所属剧集', scene: '所属场次', source_refs: '来源事件', scene_number: '场次序号', shot: '所属镜头', shot_ref: '所属镜头', image_prompt: '图像提示词', first_frame_prompt: '首帧提示词', video_prompt: '视频提示词', negative_prompt: '负面提示词', negative_handling: '负面处理', optimization: '优化建议', optimization_notes: '优化建议', optimization_suggestions: '优化建议', prompt: '提示词', notes: '备注', character_refs: '人物版本', voice: '声音', sound: '声音', source_ref: '来源', timing: '时间规划', description: '描述', image: '图像提示词', video: '视频提示词', negative: '负面处理', suggestions: '优化建议' };
    if (!Object.keys(value).length && options.preserveEmpty) return [`${prefix}{}`];
    return Object.entries(value).flatMap(([key, item]) => dataMarkdown(item, `${prefix}${options.labels?.[key] ?? labels[key] ?? key}：`, options));
  }
  return [`${prefix}${value === null && options.preserveEmpty ? 'null' : String(value ?? '无')}`];
}
export function markdownRelativePath(relative) {
  return relative.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}
export function handoffMarkdown(project, exported, assets, reviews, playback) {
  const lines = [`# ${project.name}｜漫改交接包`, '', `项目：${project.project_id}；导出时间：${exported}。`, '', '本包包含文字策划、采用快照及来源版本；不代表图像、视频、配音已生成，也不替代内容审核。', '', '## 采用版本与来源', '', '| 资产 | 名称 | 类型 | 版本 | 来源性质 | 快照 |', '| --- | --- | --- | --- | --- | --- |'];
  const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  for (const { asset } of assets) lines.push(`| ${asset.asset_id} | ${cell(asset.title)} | ${asset.type} | ${asset.version} | ${asset.source_kind} | [完整资产](assets/${asset.asset_id}/${asset.version}/asset.json) |`);
  if (reviews.length) { lines.push('', '## 上游变更复核提示', ''); for (const review of reviews) lines.push(`- ${review.asset_id}@${review.version} ${review.via?.length ? `经 ${review.via.join(' → ')} 间接` : ''}保留引用 ${review.dependency_id}@${review.referenced_version}；上游当前已采用 ${review.current_version}，本次未自动替换。`); }
  lines.push('', '## 本次实际镜头链与覆盖范围', '', `实际使用 ${playback.episodes.length} 集、${playback.scenes.length} 场、${playback.shots.length} 镜；下文仅展开这些制作节点，历史镜头依赖保存在完整资产包中，不重复占用播放时长。`, '', ...playback.episodes.map(item => `- 第 ${item.asset.data.episode_number} 集：${referenceKey(item.asset)}`));
  if (playback.uncovered.length) lines.push('', '本次是固定历史版本交接，以下当前采用新版尚未重新桥接；不能据此宣称全项目最新版漫改完成：', '', ...playback.uncovered.map(item => `- ${referenceKey(item)}：${item.reason}`));
  for (const { asset } of assets.filter(item => item.asset.type === 'CH')) lines.push('', `## 章节 ${asset.asset_id}@${asset.version}`, '', `[阅读小说正文](assets/${asset.asset_id}/${asset.version}/正文.md)`, '', ...asset.data.events.map(event => `- ${event.event_id}｜故事时间：${event.story_time}｜${event.summary}`));
  const episodes = [...playback.episodes].sort((a, b) => a.asset.data.episode_number - b.asset.data.episode_number);
  for (const { asset: ep } of episodes) {
    lines.push('', `## 第 ${ep.data.episode_number} 集 ${ep.title}（${referenceKey(ep)}）`, '', `章节来源：${ep.data.chapter_refs.map(referenceKey).join('、')}。`);
    const scenes = playback.scenes.filter(item => referenceKey(item.asset.data.episode) === referenceKey(ep)).sort((a, b) => a.asset.data.scene_number - b.asset.data.scene_number);
    for (const { asset: scene } of scenes) {
      lines.push('', `### 场次 ${scene.data.scene_number}：${scene.title}（${referenceKey(scene)}）`, '', `地点资产：${referenceKey(scene.data.location)}；来源事件：${scene.data.source_refs.map(eventKey).join('、')}。`);
      const sceneContent = Object.fromEntries(Object.entries(scene.data).filter(([key]) => !['scene_number', 'episode', 'location', 'source_refs'].includes(key)));
      if (Object.keys(sceneContent).length) lines.push('', ...dataMarkdown(sceneContent).map(line => `- ${line}`));
      const shots = playback.shots.filter(item => referenceKey(item.asset.data.scene) === referenceKey(scene)).sort((a, b) => a.asset.data.shot_number - b.asset.data.shot_number);
      for (const { asset: shot } of shots) {
        const d = shot.data;
        lines.push('', `#### 镜头 ${d.shot_number}｜${shot.title}`, '', `1. **镜头编号**：${shot.asset_id}@${shot.version}`, `2. **时长**：${d.start_seconds}—${Number((d.start_seconds + d.duration_seconds).toFixed(6))} 秒，共 ${d.duration_seconds} 秒；文字规划，未实测。`);
        let index = 3;
        for (const [field, label] of Object.entries(SHOT_LABELS)) lines.push(`${index++}. **${label}**：${d[field]}`);
        lines.push('', `- 所属：${referenceKey(d.episode)} → ${referenceKey(d.scene)}`, `- 故事时间：${d.story_time}`, `- 来源：${d.source_refs.map(eventKey).join('、')}`, `- 视觉描述：${d.visual_description}`);
        const displayed = new Set(['shot_number', 'start_seconds', 'duration_seconds', 'episode', 'scene', 'story_time', 'source_refs', 'visual_description', ...Object.keys(SHOT_LABELS)]);
        const extensions = Object.fromEntries(Object.entries(d).filter(([key]) => !displayed.has(key)));
        if (Object.keys(extensions).length) lines.push('', '**镜头补充设计**', '', ...dataMarkdown(extensions, '', { preserveEmpty: true, labels: { photography: '摄影设计', view: '观察角度', focus: '清晰范围', movement: '摄影运动', rhythm: '镜内节奏', entry_state: '起始状态', exit_state: '结束状态', duration_basis: '时长依据', sound: '声音设计' } }).map(line => `- ${line}`));
      }
    }
  }
  const prompts = assets.filter(item => item.asset.type === 'PROMPT');
  if (prompts.length) {
    lines.push('', '## 完整提示词包', '', '以下逐份展开实际采用提示词与固定来源；引用旧镜头的提示词仍保留其旧版本，不自动改写。');
    for (const { asset } of prompts) lines.push('', `### ${asset.title}（${referenceKey(asset)}）`, '', ...dataMarkdown(asset.data).map(line => `- ${line}`));
  }
  const attachments = assets.map(snapshot => ({ ...snapshot, files: Object.keys(snapshot.manifest.files).filter(filename => filename !== 'asset.json' && !(snapshot.asset.type === 'CH' && CHAPTER_FILES.includes(filename))) })).filter(snapshot => snapshot.files.length);
  if (attachments.length) {
    lines.push('', '## 随包附件与素材', '', '以下链接来自本次已校验的版本快照；说明附件与实际素材均随包冻结，不读取后续工作稿。媒体文件列入不代表已经观看或验收。');
    for (const { asset, files } of attachments) {
      lines.push('', `### ${asset.title}（${referenceKey(asset)}）`, '');
      for (const filename of files) {
        const label = filename.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('\n', ' ');
        lines.push(`- [${label}](${markdownRelativePath(`assets/${asset.asset_id}/${asset.version}/${filename}`)})`);
      }
    }
  }
  lines.push('', '## 交给现有技能', '', '使用 00 总导演组织漫剧制作；06 读取章节与桥接依据；07 读取以上十一项镜头卡；08 核对观察侧、动作可见性与摄影；09 读取完整视频提示词并整理提示词包；11 检查实际提供的文字与采用版本。未提供实际媒体时保留“媒体未生成／未检查”结论。', '');
  return lines.join('\n');
}

export function copySnapshot(root, snapshot, outputDirectory, label) {
  const relative = `assets/${snapshot.asset.asset_id}/${snapshot.asset.version}`;
  const destination = path.join(outputDirectory, relative);
  fs.mkdirSync(destination, { recursive: true });
  for (const filename of relativeFiles(root, snapshot.directory)) {
    const output = path.join(destination, filename);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    writeSynced(output, fs.readFileSync(path.join(snapshot.directory, filename)));
  }
  compareFiles(fingerprint(root, destination, { skipManifest: true }), snapshot.manifest.files, `${label} ${referenceKey(snapshot.asset)}`);
  return relative;
}
