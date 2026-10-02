import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { continuityShapeErrors, resolveContinuityState, selectContinuityEntities } from '../src/连续性状态.mjs';
import { initProject, newAsset, saveVersion, CHAPTER_FILES } from '../src/project-service.mjs';
import { jsonText, hash } from '../src/rules.mjs';
import { fingerprint } from '../src/storage.mjs';

const ref = (type, number = 1, version = '1.0.0') => ({ asset_id: `IP997-${type}-${String(number).padStart(3, '0')}`, version });
const asset = (type, number, data, version = '1.0.0') => ({ schema_version: 1, project_id: 'IP997', ...ref(type, number, version), type, title: '连续性测试', refs: [], source_kind: '原创创作', adoption_status: '建议', data });
const character = ref('CHAR'), location = ref('LOC'), prop = ref('PROP');
const event = (event_id = 'E01') => ({ ...ref('CH'), event_id });
const node = (change_id, before, after, entity = character, event_id = 'E01') => ({ change_id, entity, event_ref: event(event_id), effective_node: `${change_id} 镜头边界`, story_time: '不可排序的叙事时间', before, after });
const state = (data, number = 1) => asset('STATE', number, { timeline: '主线', initial_states: [], change_order: [], changes: [], knowledge: [], possessions: [], foreshadowing: [], ...data });
const point = (change_id = 'c1', phase = 'after', number = 1) => ({ state: ref('STATE', number), ...(phase === 'initial' ? {} : { change_id }), phase });
const valid = () => state({ initial_states: [{ entity: character, values: { clothing: '青袍', injury: '无伤' } }], change_order: ['c1', 'c2'],
  changes: [node('c2', { injury: '无伤' }, { injury: '左臂受伤' }, character, 'E02'), node('c1', { clothing: '青袍' }, { clothing: '破损青袍' })] });

function fixture(t, supplied = []) {
  const temporary = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'studio-continuity-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), temporary);
    assert.ok(path.basename(resolved).startsWith('studio-continuity-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const project = initProject({ root, id: 'IP997', name: '连续性隔离项目' }).project;
  const assets = new Map([asset('CHAR', 1, { name: '角色' }), asset('LOC', 1, { description: '场景' }), asset('PROP', 1, { name: '刀' }),
    asset('CH', 1, { events: [{ event_id: 'E01', summary: '衣服破损', story_time: '后来' }, { event_id: 'E02', summary: '左臂受伤', story_time: '更早' }] }), ...supplied]
    .map(value => [`${value.asset_id}@${value.version}`, value]));
  const resolveAsset = reference => {
    const value = assets.get(`${reference.asset_id}@${reference.version}`);
    if (!value) throw new Error('测试引用版本不存在');
    return { asset: value, candidate: true, saved: { manifest_sha256: hash(jsonText(value)) }, entry: { adopted_version: null } };
  };
  const resolve = (selected = point(), options = {}) => resolveContinuityState({ project, request: { point: selected, ...options }, resolveAsset });
  return { project, assets, resolve, resolveAsset };
}
const errors = result => result.issues.map(issue => `${issue.code}: ${issue.message}`).join('\n');

test('旧资产shape兼容，旧文本不能被解释为空的成功状态', t => {
  const legacy = asset('STATE', 1, { changes: [{ event_ref: event(), before: '原来无刀', after: '已得刀', effective_node: '章末', story_time: '当天' }], character_state: '已得刀' });
  assert.deepEqual(continuityShapeErrors(legacy), []);
  assert.deepEqual(continuityShapeErrors(asset('SHOT', 1, { entry_state: '原有自由文本' })), []);
  const f = fixture(t, [legacy]), before = fingerprint(f.project, f.project);
  const result = f.resolve(point(undefined, 'initial'));
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.unresolved[0].evidence.character_state, '已得刀');
  assert.deepEqual(result.states, []);
  assert.deepEqual(fingerprint(f.project, f.project), before);
});

test('严格按change_order应用增量，before/after边界不借用将来或章末状态', t => {
  const f = fixture(t, [valid()]);
  const initial = f.resolve(point(undefined, 'initial'));
  assert.equal(initial.ok, true, errors(initial));
  assert.deepEqual(initial.states[0].values, { clothing: '青袍', injury: '无伤' });
  const before = f.resolve(point('c2', 'before'));
  assert.equal(before.ok, true, errors(before));
  assert.deepEqual(before.states[0].values, { clothing: '破损青袍', injury: '无伤' });
  const after = f.resolve(point('c2'));
  assert.equal(after.ok, true, errors(after));
  assert.deepEqual(after.states[0].values, { clothing: '破损青袍', injury: '左臂受伤' });
  assert.equal(after.states[0].provenance.clothing.change_id, 'c1');
  assert.equal(after.states[0].provenance.injury.event_ref.event_id, 'E02');
  assert.ok(after.inputs.every(input => input.candidate && !input.was_adopted));
  assert.match(after.warnings.join(''), /未采用/);
});

test('跨STATE及跨集沿显式基准继承，角色地点道具均保留未改属性', t => {
  const first = valid();
  first.data.initial_states.push({ entity: location, values: { weather: '晴', lighting: '日光' } }, { entity: prop, values: { owner: character, visible: false } });
  const second = state({ base_state: point('c2'), initial_states: [{ entity: character, values: { clothing: '破损青袍', emotion: '愤怒' } }],
    change_order: ['e2s1', 'e2s2'], changes: [node('e2s1', { weather: '晴' }, { weather: '雨' }, location), node('e2s2', { visible: false }, { visible: true }, prop)] }, 2);
  const f = fixture(t, [first, second]);
  const result = f.resolve(point('e2s2', 'after', 2), { timeline: '主线' });
  assert.equal(result.ok, true, errors(result));
  assert.deepEqual(result.states.find(item => item.entity.asset_id === character.asset_id).values, { clothing: '破损青袍', injury: '左臂受伤', emotion: '愤怒' });
  assert.deepEqual(result.states.find(item => item.entity.asset_id === location.asset_id).values, { weather: '雨', lighting: '日光' });
  assert.deepEqual(result.states.find(item => item.entity.asset_id === prop.asset_id).values, { owner: character, visible: true });
  assert.equal(result.inputs.filter(input => input.type === 'STATE').length, 2);
  assert.equal(result.inputs.some(input => ['EP', 'SC', 'SHOT'].includes(input.type)), false);
});

test('before冲突及未知before都拒绝确认，不从before创建初值', t => {
  const conflict = valid(); conflict.data.changes[1].before.clothing = '红衣';
  const f = fixture(t, [conflict]);
  assert.match(errors(f.resolve()), /before-conflict/);
  conflict.data.initial_states = [];
  const unknown = f.resolve();
  assert.equal(unknown.ok, false);
  assert.match(errors(unknown), /before-unknown/);
  assert.equal(unknown.states.length, 0);
});

test('初值与基准冲突、不同实体版本、时间线变化均不能默默合并', t => {
  const next = state({ base_state: point(), initial_states: [{ entity: character, values: { clothing: '红衣' } }] }, 2);
  const f = fixture(t, [valid(), next]);
  assert.match(errors(f.resolve(point(undefined, 'initial', 2))), /initial-conflict/);
  const upgraded = asset('CHAR', 1, { name: '角色新版' }, '2.0.0');
  f.assets.set(`${upgraded.asset_id}@${upgraded.version}`, upgraded);
  next.data.initial_states = [{ entity: ref('CHAR', 1, '2.0.0'), values: { clothing: '红衣' } }];
  assert.match(errors(f.resolve(point(undefined, 'initial', 2))), /entity-version-conflict/);
  next.data.initial_states = []; next.data.timeline = '闪回';
  assert.match(errors(f.resolve(point(undefined, 'initial', 2))), /timeline-conflict/);
  assert.match(errors(f.resolve(point(), { timeline: '旁支' })), /timeline-conflict/);
});

test('缺序重复节点、缺失目标及循环基准被显式拒绝', t => {
  const current = valid(), f = fixture(t, [current]);
  delete current.data.change_order;
  assert.match(errors(f.resolve()), /显式给出/);
  current.data.change_order = ['c1', 'c1'];
  assert.match(errors(f.resolve()), /重复节点/);
  current.data.change_order = ['c1', 'c2'];
  assert.match(errors(f.resolve(point('未来节点'))), /point-not-found/);
  current.data.base_state = point('c2');
  assert.match(errors(f.resolve()), /base-cycle/);
});

test('多个STATE形成环和跨版本回环不能绕过循环检查', t => {
  const first = valid(), second = state({ base_state: point() }, 2);
  first.data.base_state = point(undefined, 'initial', 2);
  const f = fixture(t, [first, second]);
  assert.match(errors(f.resolve()), /base-cycle/);
  delete first.data.base_state;
  const upgraded = asset('STATE', 1, { ...state({}).data, base_state: point('c2') }, '2.0.0');
  f.assets.set(`${upgraded.asset_id}@${upgraded.version}`, upgraded);
  const newerPoint = { state: ref('STATE', 1, '2.0.0'), phase: 'initial' };
  assert.equal(f.resolve(newerPoint).ok, true, errors(f.resolve(newerPoint)));
  first.data.base_state = newerPoint;
  assert.match(errors(f.resolve(newerPoint)), /base-cycle/);
});

test('不存在或重复来源事件拒绝，未来变更的before冲突不污染较早边界', t => {
  const current = valid(), f = fixture(t, [current]);
  current.data.changes[0].before.injury = '已死亡';
  assert.equal(f.resolve(point('c1')).ok, true);
  current.data.changes[1].event_ref.event_id = 'E99';
  assert.match(errors(f.resolve(point('c1'))), /source-event-missing/);
  current.data.changes[1].event_ref.event_id = 'E01';
  f.assets.get('IP997-CH-001@1.0.0').data.events.push({ event_id: 'E01' });
  assert.match(errors(f.resolve(point('c1'))), /source-event-missing/);
});

test('输入指纹绑定STATE、实体及来源章节内容，求值不修改输入或项目', t => {
  const f = fixture(t, [valid()]), diskBefore = fingerprint(f.project, f.project), assetsBefore = JSON.stringify([...f.assets]);
  const result = f.resolve();
  assert.equal(result.ok, true, errors(result));
  assert.equal(result.input_fingerprint, f.resolve().input_fingerprint);
  assert.equal(JSON.stringify([...f.assets]), assetsBefore);
  assert.deepEqual(fingerprint(f.project, f.project), diskBefore);
  f.assets.get('IP997-CH-001@1.0.0').data.events[0].summary = '来源内容改变';
  assert.notEqual(result.input_fingerprint, f.resolve().input_fingerprint);
  const changedChapter = f.resolve().input_fingerprint;
  f.assets.get('IP997-CHAR-001@1.0.0').data.name = '身份内容改变';
  assert.notEqual(changedChapter, f.resolve().input_fingerprint);
});

test('属性支持原子及精确ref数组，拒绝原型键、未知嵌套、非法引用和浮动请求', t => {
  const current = valid();
  current.data.initial_states[0].values = { number: 0, absent: null, flag: true, refs: [prop, '布衣', 1, null], clothing: '青袍', injury: '无伤' };
  const f = fixture(t, [current]);
  assert.equal(f.resolve().ok, false);
  assert.ok(f.resolve().unresolved.some(item => item.path === 'values.absent'));
  current.data.initial_states[0].values.absent = '明确无';
  current.data.initial_states[0].values.refs = [prop, '布衣', 1];
  assert.equal(f.resolve().ok, true, errors(f.resolve()));
  current.data.initial_states[0].values.extra = { arbitrary: '无法判断其语义' };
  assert.match(errors(f.resolve()), /未知嵌套/);
  delete current.data.initial_states[0].values.extra;
  Object.defineProperty(current.data.initial_states[0].values, '__proto__', { value: '污染', enumerable: true, configurable: true });
  assert.match(errors(f.resolve()), /原型保留键/);
  delete current.data.initial_states[0].values.__proto__;
  assert.equal(f.resolve({ state: { asset_id: 'IP997-STATE-001' }, phase: 'initial' }).ok, false);
  assert.equal(f.resolve(point(undefined, 'initial'), { entities: [ref('CHAR', 99)] }).ok, false);
  assert.equal(f.resolve(point(), { entities: [character, ref('CHAR', 1, '2.0.0')] }).ok, false);
});

test('结构化STATE夹带旧变更保留未解证据，不因已有成功属性而假装完整', t => {
  const current = valid();
  current.data.changes.push({ before: '衣服完整', after: '沾血', event_ref: event(), effective_node: '旧节点', story_time: '同日' });
  const f = fixture(t, [current]), result = f.resolve();
  assert.deepEqual(continuityShapeErrors(current), []);
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.states[0].values.clothing, '破损青袍');
  assert.equal(result.unresolved.length, 1);
});

test('after不能绕过before覆盖已有值，新属性可明确建立，null不能冒充已知before', t => {
  const current = valid(), f = fixture(t, [current]);
  current.data.changes[1].before = {};
  assert.match(errors(f.resolve()), /before-missing/);
  current.data.changes[1].before = { clothing: '青袍' };
  current.data.changes[1].after.mood = '愤怒';
  assert.equal(f.resolve().ok, true, errors(f.resolve()));
  current.data.initial_states[0].values.mood = null;
  assert.equal(f.resolve().ok, true, errors(f.resolve()));
  current.data.changes[1].before.mood = null;
  assert.match(errors(f.resolve()), /before-unknown/);
});

test('空白、占位及未知文字不能产生complete:true，空数组可以明确无集合项', t => {
  const current = valid(), f = fixture(t, [current]);
  for (const uncertain of ['', '  \t\n', '待填', '待填服装', 'TODO', '未知', '未确定', '未确定。', ['青袍', '未知']]) {
    current.data.initial_states[0].values.extra = uncertain;
    const result = f.resolve();
    assert.equal(result.ok, false, JSON.stringify(uncertain));
    assert.equal(result.complete, false, JSON.stringify(uncertain));
    assert.ok(result.unresolved.some(item => item.path === 'values.extra'));
  }
  current.data.initial_states[0].values.extra = [];
  assert.equal(f.resolve().complete, true, errors(f.resolve()));
  current.data.initial_states[0].values.extra = '未知生物的足迹';
  assert.equal(f.resolve().complete, true, errors(f.resolve()));
  current.data.initial_states[0].values.extra = '未知';
  current.data.changes[1].before.extra = '未知';
  current.data.changes[1].after.extra = '无';
  assert.match(errors(f.resolve()), /before-unknown/);
  delete current.data.changes[1].before.extra;
  assert.equal(f.resolve().complete, true, errors(f.resolve()));
});

test('请求未知字段、注入虚假采用标记、循环非法输入均不能伪造成功或抛出异常', t => {
  const f = fixture(t, [valid()]);
  assert.match(errors(f.resolve(point(), { asset: character })), /未知字段/);
  const result = resolveContinuityState({ project: f.project, request: { point: point() }, resolveAsset(reference) {
    const snapshot = f.resolveAsset(reference);
    return { ...snapshot, candidate: false, was_adopted: true, current_adopted: true, entry: { adopted_version: '1.0.0' } };
  } });
  assert.equal(result.ok, true, errors(result));
  assert.ok(result.inputs.every(input => !input.current_adopted && !input.was_adopted));
  const cyclic = {}; cyclic.circular = cyclic;
  assert.doesNotThrow(() => {
    const invalid = resolveContinuityState({ project: f.project, request: { point: point(), entities: [cyclic] } });
    assert.equal(invalid.ok, false);
  });
});

test('SHOT/SC/EP continuity形状只接受明确时间线及精确入口出口', () => {
  for (const type of ['SHOT', 'SC', 'EP']) {
    const current = asset(type, 1, { continuity: { timeline: '主线', entry: point(undefined, 'initial'), exit: point() } });
    assert.deepEqual(continuityShapeErrors(current), []);
    current.data.continuity.link = 'continuous';
    assert.deepEqual(continuityShapeErrors(current), []);
    current.data.continuity.link = 'cut';
    assert.deepEqual(continuityShapeErrors(current), []);
    current.data.continuity.link = 'guess';
    assert.match(continuityShapeErrors(current).join('\n'), /link/);
    delete current.data.continuity.link;
    current.data.continuity.entry.change_id = 'c1';
    assert.match(continuityShapeErrors(current).join('\n'), /initial 不接受/);
    delete current.data.continuity.entry.change_id; delete current.data.continuity.timeline;
    assert.match(continuityShapeErrors(current).join('\n'), /timeline/);
  }
});

test('默认读取冻结快照和真实manifest，不消费脏工作稿；篡改冻结来源会失败', t => {
  const f = fixture(t);
  const registry = () => JSON.parse(fs.readFileSync(path.join(f.project, 'project.json'), 'utf8'));
  function save(type, data) {
    const id = newAsset({ project: f.project, type, title: '真实冻结夹具' }).asset_id;
    const entry = registry().assets.find(item => item.asset_id === id), directory = path.join(f.project, entry.path);
    const filename = path.join(directory, 'asset.json'), current = JSON.parse(fs.readFileSync(filename, 'utf8'));
    current.data = data; fs.writeFileSync(filename, jsonText(current));
    if (type === 'CH') {
      fs.writeFileSync(path.join(directory, '正文.md'), '角色衣服破损。');
      for (const name of CHAPTER_FILES.slice(1)) fs.writeFileSync(path.join(directory, name), jsonText({ project_id: 'IP997', chapter_id: id, version: '1.0.0', entries: [] }));
    }
    saveVersion({ project: f.project, asset: id });
    return { directory, ref: { asset_id: id, version: '1.0.0' } };
  }
  const char = save('CHAR', { name: '冻结角色' });
  save('CH', { chapter_number: 1, events: [{ event_id: 'E01', summary: '衣服破损', story_time: '当天' }], entry_state: '衣服完整', exit_state: '衣服破损' });
  const current = valid(); current.data.change_order = ['c1']; current.data.changes = [current.data.changes[1]];
  save('STATE', current.data);
  const work = path.join(char.directory, 'asset.json');
  const dirty = JSON.parse(fs.readFileSync(work, 'utf8')); dirty.data.name = '脏工作稿角色'; fs.writeFileSync(work, jsonText(dirty));
  const before = fingerprint(f.project, f.project);
  const result = resolveContinuityState({ project: f.project, request: { point: point() } });
  assert.equal(result.ok, true, errors(result));
  assert.ok(result.inputs.every(input => /^[a-f0-9]{64}$/.test(input.manifest_sha256)));
  assert.deepEqual(fingerprint(f.project, f.project), before);
  const snapshot = registry().assets.find(item => item.type === 'CH').versions[0].path;
  fs.appendFileSync(path.join(f.project, snapshot, '正文.md'), '篡改来源');
  const bad = resolveContinuityState({ project: f.project, request: { point: point() } });
  assert.equal(bad.ok, false);
  assert.match(errors(bad), /校验|内容|大小|不一致/);
});

test('局部消费移除画外未知，保留本镜未知，不为仅静态地点强造动态状态', t => {
  const current = valid(), outside = ref('CHAR', 2);
  current.data.initial_states.push({ entity: outside, values: { clothing: null } });
  const f = fixture(t, [current, asset('CHAR', 2, { name: '画外人物' })]);
  const full = f.resolve(), original = structuredClone(full);
  assert.equal(full.complete, false);
  const visible = selectContinuityEntities(full, [character, location]);
  assert.equal(visible.complete, true, errors(visible));
  assert.equal(visible.ok, true);
  assert.deepEqual(visible.states.map(item => item.entity), [character]);
  assert.deepEqual(visible.unresolved, []);
  assert.deepEqual(full, original);
  assert.equal(visible.scope.source_complete, false);
  assert.equal(visible.scope.source_input_fingerprint, full.input_fingerprint);
  assert.notEqual(visible.input_fingerprint, full.input_fingerprint);
  assert.equal(visible.input_fingerprint, selectContinuityEntities(full, [location, character]).input_fingerprint);
  const unknown = selectContinuityEntities(full, [outside]);
  assert.equal(unknown.complete, false);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.unresolved.some(item => item.entity?.asset_id === outside.asset_id && item.path === 'values.clothing'));
  const empty = selectContinuityEntities(full, [location]);
  assert.equal(empty.complete, false);
  assert.ok(empty.unresolved.some(item => !item.entity));
});

test('局部消费不丢通用未决或确定错误，精确版本不符持续阻断', t => {
  const current = valid();
  const f = fixture(t, [current]);
  const full = f.resolve();
  full.unresolved.push({ reason: '没有实体归属的旧事件，不能断定画内画外' });
  full.issues.push({ code: 'unresolved-state', severity: 'error', message: '旧未决' });
  full.issues.push({ code: 'before-conflict', severity: 'error', message: '画外确定冲突也不隐去', entity: ref('CHAR', 2) });
  full.complete = full.ok = false;
  const visible = selectContinuityEntities(full, [character]);
  assert.equal(visible.ok, false);
  assert.ok(visible.unresolved.some(item => /没有实体归属/.test(item.reason)));
  assert.ok(visible.issues.some(item => item.code === 'before-conflict'));
  assert.equal(visible.issues.filter(item => item.code === 'unresolved-state').length, 1);
  const mismatch = selectContinuityEntities(f.resolve(), [ref('CHAR', 1, '2.0.0')]);
  assert.equal(mismatch.complete, false);
  assert.ok(mismatch.issues.some(item => item.code === 'entity-version-conflict'));
  assert.equal(mismatch.states.length, 0);
  const mixed = selectContinuityEntities(f.resolve(), [character, ref('CHAR', 1, '2.0.0')]);
  assert.equal(mixed.ok, false);
  assert.ok(mixed.issues.some(item => item.code === 'entity-version-conflict'));
});
