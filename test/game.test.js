import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALE,
  createInitialState,
  stepState,
  normalizeInput,
  hashState,
  canonicalStateString,
  interpolateState,
  interpolateInt,
  inputsEqual,
  hashString,
} from '../src/game.js';
import { RingBuffer } from '../src/ring-buffer.js';

test('空输入推进只增加 tick，玩家位置与血量不变', () => {
  const initial = createInitialState(['p2', 'p1']);
  const next = stepState(initial, { p1: null, p2: undefined });
  assert.equal(next.tick, 1);
  assert.deepEqual(next.players.p1.x, initial.players.p1.x);
  assert.equal(next.players.p1.hp, 100);
});

test('移动使用定点整数且被场地边界钳制', () => {
  let state = createInitialState(['p1']);
  const startX = state.players.p1.x;
  state = stepState(state, { p1: { move: 1, attack: 0 } });
  assert.equal(state.players.p1.x, startX + 2 * SCALE);
  for (let i = 0; i < 60; i++) state = stepState(state, { p1: { move: 1 } });
  assert.equal(state.players.p1.x, 100 * SCALE);
  assert.ok(Number.isInteger(state.players.p1.x));
});

test('攻击在射程内扣血，冷却期内不重复生效', () => {
  let state = createInitialState(['p1', 'p2']);
  state.players.p1.x = 10 * SCALE;
  state.players.p2.x = 15 * SCALE;
  state = stepState(state, { p1: { attack: 1 } });
  assert.equal(state.players.p2.hp, 90);
  assert.equal(state.players.p1.cooldown, 3);
  state = stepState(state, { p1: { attack: 1 } });
  assert.equal(state.players.p2.hp, 90);
});

test('规范化输入把非法值视为空输入', () => {
  assert.deepEqual(normalizeInput({ move: 5, attack: 9 }), { move: 0, attack: 0 });
  assert.deepEqual(normalizeInput(null), { move: 0, attack: 0 });
  assert.equal(inputsEqual({ move: 1, attack: 0 }, { move: 1, attack: 0 }), true);
});

test('状态哈希不依赖对象键声明顺序', () => {
  const a = createInitialState(['p1', 'p2']);
  const b = createInitialState(['p2', 'p1']);
  assert.equal(canonicalStateString(a), canonicalStateString(b));
  assert.equal(hashState(a), hashState(b));
  const moved = stepState(a, { p1: { move: 1 } });
  assert.notEqual(hashState(moved), hashState(a));
});

test('哈希为确定的 32 位无符号整数且同输入同输出', () => {
  const h1 = hashString('deterministic');
  const h2 = hashString('deterministic');
  assert.equal(h1, h2);
  assert.ok(h1 > 0 && h1 <= 0xffffffff);
});

test('插值结果为整数且落在两帧之间，不修改原状态', () => {
  const a = createInitialState(['p1']);
  const b = stepState(a, { p1: { move: 1 } });
  const render = interpolateState(a, b, SCALE / 2);
  assert.equal(render.players.p1.x, interpolateInt(a.players.p1.x, b.players.p1.x, SCALE / 2));
  assert.ok(render.players.p1.x >= a.players.p1.x && render.players.p1.x <= b.players.p1.x);
  assert.equal(a.players.p1.x, createInitialState(['p1']).players.p1.x);
});

test('RingBuffer 覆盖后旧 tick 判定为缺失', () => {
  const buffer = new RingBuffer(3);
  buffer.set(0, 'a');
  buffer.set(1, 'b');
  buffer.set(2, 'c');
  assert.equal(buffer.get(1), 'b');
  buffer.set(3, 'd');
  assert.equal(buffer.has(0), false);
  assert.equal(buffer.get(3), 'd');
  buffer.resetTo(10);
  assert.equal(buffer.has(3), false);
  assert.equal(buffer.oldestTick, 10);
});
