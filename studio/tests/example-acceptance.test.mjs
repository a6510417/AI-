import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, validateProject } from '../src/project-service.mjs';

test('任意合法用户故事名称均可初始化，验收不读取真实工作根', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-name-acceptance-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { project } = initProject({ root: temporary, id: 'IP001', name: '最后一班渡船' });
  assert.equal(validateProject({ project }).ok, true);
});

test('新工作室布局创建独立临时项目而不要求发行包附带故事目录', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-v2-acceptance-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { project } = initProject({ root: temporary, id: 'IP002', name: '工作室空项目', schemaVersion: 2 });
  for (const name of ['assets', 'sources', 'production', 'deliveries', '.ip-system']) assert.equal(fs.statSync(path.join(project, name)).isDirectory(), true);
  assert.equal(validateProject({ project }).stats.assets, 0);
});
