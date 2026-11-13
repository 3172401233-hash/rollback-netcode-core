import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  runTick,
  buildSequentialState,
  PLAYERS,
  findEvent,
  countEvents,
} from './helpers.js';
import { hashState, normalizeInput, SCALE, createInitialState } from '../src/game.js';

const RIGHT = { move: 1, attack: 0 };
const LEFT = { move: -1, attack: 0 };
const IDLE = { move: 0, attack: 0 };

test('正常确认：直通链路上客户端预测与权威状态逐 tick 一致', () => {
  const world = createWorld();
  const script = { p1: RIGHT, p2: LEFT };
  for (let tick = 0; tick < 8; tick++) runTick(world, tick, script);
  for (const id of PLAYERS) {
    assert.equal(world.clients[id].currentTick, world.host.currentTick);
    assert.equal(world.clients[id].predictedHash(), hashState(world.host.state));
    assert.equal(world.clients[id].stats.rollbacks, 0);
  }
});

test('预测回滚：远端输入迟到后重放，结果与顺序执行一致', () => {
  const world = createWorld();
  const { transport, host, clients } = world;
  runTick(world, 0, { p1: RIGHT, p2: RIGHT });
  runTick(world, 1, { p1: RIGHT, p2: RIGHT });
  // tick2：主机到 p1 的权威包被暂存，p1 收不到 p2 的权威输入，只能空预测。
  transport.injectFault('host', 'p1', { reorder: true, holdTicks: 2 });
  runTick(world, 2, { p1: RIGHT, p2: RIGHT });
  const predictedBefore = clients.p1.state.players.p2.x;
  assert.equal(clients.p1.remoteInputFor(2).p2.move, 0);

  // tick3、tick4：暂存包与后续权威包陆续到达，p1 发现 tick2 预测错误并回滚重放。
  runTick(world, 3, { p1: RIGHT, p2: RIGHT });
  transport.flushHeld('p1');
  runTick(world, 4, { p1: RIGHT, p2: RIGHT });
  assert.ok(clients.p1.stats.rollbacks >= 1);
  assert.ok(findEvent(clients.p1, 'rollback'));
  assert.notEqual(clients.p1.state.players.p2.x, predictedBefore);

  const perTick = {};
  for (let tick = 0; tick < 5; tick++) perTick[tick] = { p1: RIGHT, p2: RIGHT };
  const sequential = buildSequentialState(PLAYERS, perTick, 5);
  assert.deepEqual(clients.p1.state, sequential);
  assert.equal(clients.p1.predictedHash(), hashState(host.state));
  assert.equal(host.inputLog.get(2).p2.move, 1);
});

test('重复确认：相同序号包被识别为重复且不触发二次回滚', () => {
  const world = createWorld();
  const { transport, clients } = world;
  for (let tick = 0; tick < 3; tick++) runTick(world, tick, { p1: RIGHT, p2: IDLE });
  transport.injectFault('host', 'p1', 'duplicate');
  runTick(world, 3, { p1: RIGHT, p2: IDLE });
  assert.ok(clients.p1.stats.duplicatePackets >= 1);
  const rollbacks = clients.p1.stats.rollbacks;
  runTick(world, 4, { p1: RIGHT, p2: IDLE });
  assert.equal(clients.p1.stats.rollbacks, rollbacks);
});

test('过期包：序号低于水位的包被丢弃并计入统计', () => {
  const world = createWorld();
  const { clients } = world;
  for (let tick = 0; tick < 2; tick++) runTick(world, tick, { p1: IDLE, p2: IDLE });
  const stale = { type: 'host', seq: 1, tick: 1, state: clients.p1.state, hash: hashState(clients.p1.state), inputs: {} };
  clients.p1.handlePacket(stale);
  assert.equal(clients.p1.stats.stalePackets, 1);
  assert.ok(findEvent(clients.p1, 'stale-packet'));
});

test('未来 tick：先缓冲，待本地追上后按序处理', () => {
  const world = createWorld();
  const { host, clients } = world;
  host.advance(1);
  const packet = host.broadcast(1);
  // 客户端仍停留在 tick0，直接收到主机 tick1 的包。
  clients.p1.handlePacket(packet);
  assert.equal(clients.p1.stats.futurePackets, 1);
  assert.equal(clients.p1.pendingFuture.length, 1);
  clients.p1.advance(1);
  clients.p1.pump(1);
  assert.equal(clients.p1.pendingFuture.length, 0);
  assert.equal(clients.p1.lastHostTick, 1);
});

test('空输入：缺失输入与显式空输入等价且计入统计', () => {
  const world = createWorld();
  const { clients } = world;
  clients.p1.setLocalInput(0, null);
  assert.deepEqual(clients.p1.localInputFor(0), normalizeInput(null));
  assert.equal(clients.p1.stats.emptyInputTicks, 1);
  clients.p1.advance(1);
  assert.equal(clients.p1.state.players.p1.x, createInitialState(PLAYERS).players.p1.x);
});

test('快照缺口：环形缓存被截断后进入追帧模式而非无声漂移', () => {
  const world = createWorld({ clientHistory: 4, maxRollback: 2 });
  const { host, clients } = world;
  for (let tick = 0; tick < 6; tick++) runTick(world, tick, { p1: RIGHT, p2: RIGHT });
  // 构造一个指向已被覆盖 tick 的迟到确认。
  const oldPacket = {
    type: 'host',
    seq: host.seq + 1,
    tick: 1,
    state: host.snapshots.get(1),
    hash: hashState(host.snapshots.get(1)),
    inputs: { 1: { p1: RIGHT, p2: IDLE } },
  };
  clients.p1.handlePacket(oldPacket);
  assert.equal(clients.p1.mode, 'catch-up');
  assert.ok(clients.p1.stats.snapshotMisses >= 1);
  assert.ok(findEvent(clients.p1, 'catch-up-enter'));
});

test('连续回滚：多个脏 tick 分批次确认，最终收敛到权威状态', () => {
  const world = createWorld();
  const { transport, host, clients } = world;
  // 主机到 p1 链路多次乱序暂存，制造多个迟到的权威修正。
  for (const tick of [2, 5]) transport.injectFault('host', 'p1', { reorder: true, holdTicks: 2 });
  for (let tick = 0; tick < 8; tick++) runTick(world, tick, { p1: RIGHT, p2: LEFT });
  transport.flushHeld('p1');
  for (let tick = 8; tick < 10; tick++) runTick(world, tick, { p1: RIGHT, p2: LEFT });
  assert.ok(clients.p1.stats.rollbacks >= 2);
  assert.ok(clients.p1.stats.replayedTicks >= 2);
  assert.equal(clients.p1.predictedHash(), hashState(host.state));
  assert.equal(clients.p1.oldestDirty, null);
});

test('追帧降级：回滚跨度超过 maxRollback 时明确进入追帧模式', () => {
  const world = createWorld({ maxRollback: 2, clientHistory: 16 });
  const { transport, host, clients } = world;
  // 主机到 p1 长时间中断，权威修正累积，恢复时回滚跨度超过 maxRollback。
  transport.disconnect('host', 'p1');
  for (let tick = 0; tick < 6; tick++) runTick(world, tick, { p1: RIGHT, p2: LEFT });
  transport.reconnect('host', 'p1');
  runTick(world, 6, { p1: RIGHT, p2: LEFT });
  assert.equal(clients.p1.mode, 'catch-up');
  assert.equal(clients.p1.currentTick, host.currentTick);
  assert.equal(clients.p1.predictedHash(), hashState(host.state));
  runTick(world, 7, { p1: RIGHT, p2: LEFT });
  assert.equal(clients.p1.mode, 'normal');
  assert.ok(clients.p1.stats.catchUpExited >= 1);
  assert.ok(findEvent(clients.p1, 'catch-up-enter'));
});

test('断线重连：断线期间丢包，重连后全量状态对齐', () => {
  const world = createWorld();
  const { transport, host, clients } = world;
  for (let tick = 0; tick < 3; tick++) runTick(world, tick, { p1: RIGHT, p2: IDLE });
  transport.disconnect('host', 'p1');
  transport.disconnect('p1', 'host');
  const hostTickBefore = host.currentTick;
  for (let tick = 3; tick < 6; tick++) runTick(world, tick, { p1: RIGHT, p2: IDLE });
  // 断线期间客户端收不到任何主机确认，lastHostTick 停在断线前。
  assert.equal(clients.p1.lastHostTick, hostTickBefore);
  transport.reconnect('host', 'p1');
  transport.reconnect('p1', 'host');
  host.handleReconnect('p1', 7);
  clients.p1.pump(7);
  assert.equal(clients.p1.stats.reconnects, 1);
  assert.equal(clients.p1.currentTick, host.currentTick);
  assert.equal(clients.p1.predictedHash(), hashState(host.state));
  assert.ok(findEvent(clients.p1, 'reconnect-resync'));
});

test('确定性重放：同种子两世界逐 tick 结果与哈希完全相同', () => {
  function runWorld(seed) {
    const world = createWorld();
    world.transport.setLink('p2', 'host', { lossRate: 0.6, jitter: 2 }, seed);
    world.transport.setLink('host', 'p1', { lossRate: 0.4, jitter: 1 }, seed + 1);
    const hashes = [];
    for (let tick = 0; tick < 16; tick++) {
      runTick(world, tick, { p1: RIGHT, p2: LEFT });
      hashes.push(world.clients.p1.predictedHash());
    }
    return hashes;
  }
  assert.deepEqual(runWorld(123), runWorld(123));
});

test('重放期间再次收到确认：多个确认顺序处理后状态仍与权威一致', () => {
  const world = createWorld();
  const { transport, host, clients } = world;
  runTick(world, 0, { p1: RIGHT, p2: RIGHT });
  runTick(world, 1, { p1: RIGHT, p2: RIGHT });
  transport.injectFault('p2', 'host', 'drop');
  runTick(world, 2, { p1: RIGHT, p2: RIGHT });
  // 连续两个 tick 的主机包在同一 pump 中到达，期间发生重放。
  runTick(world, 3, { p1: RIGHT, p2: RIGHT });
  runTick(world, 4, { p1: RIGHT, p2: RIGHT });
  assert.equal(clients.p1.predictedHash(), hashState(host.state));
  assert.equal(countEvents(clients.p1, 'hash-mismatch'), 0);
});

test('状态插值：渲染结果随 alpha 单调且保持定点整数', () => {
  const world = createWorld();
  runTick(world, 0, { p1: RIGHT, p2: IDLE });
  runTick(world, 1, { p1: RIGHT, p2: IDLE });
  const client = world.clients.p1;
  const r0 = client.renderState(0);
  const rHalf = client.renderState(SCALE / 2);
  const rFull = client.renderState(SCALE);
  assert.ok(rHalf.players.p1.x >= r0.players.p1.x);
  assert.ok(rFull.players.p1.x >= rHalf.players.p1.x);
  assert.ok(Number.isInteger(rHalf.players.p1.x));
});

test('哈希不一致：篡改权威状态后触发追帧并产生 mismatch 事件', () => {
  const world = createWorld({ maxRollback: 8, clientHistory: 16 });
  const { host, clients } = world;
  for (let tick = 0; tick < 3; tick++) runTick(world, tick, { p1: IDLE, p2: IDLE });
  const tampered = structuredClone(host.state);
  tampered.players.p1.hp = 1;
  const packet = {
    type: 'host',
    seq: host.seq + 1,
    tick: 3,
    state: tampered,
    hash: hashState(tampered),
    inputs: {},
  };
  clients.p1.handlePacket(packet);
  assert.ok(clients.p1.stats.hashMismatches >= 1);
  assert.equal(clients.p1.mode, 'catch-up');
  assert.equal(clients.p1.state.players.p1.hp, 1);
});
