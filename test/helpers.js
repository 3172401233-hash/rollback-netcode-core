import { SimTransport } from '../src/sim-transport.js';
import { AuthoritativeHost } from '../src/host.js';
import { RollbackClient } from '../src/client.js';
import { stepState, cloneState, normalizeInput, createInitialState } from '../src/game.js';

export const PLAYERS = ['p1', 'p2'];

export function createWorld(options = {}) {
  const transport = new SimTransport();
  const host = new AuthoritativeHost({
    transport,
    playerIds: PLAYERS,
    history: options.hostHistory ?? 16,
    sendWindow: options.sendWindow ?? 16,
  });
  const clients = {};
  for (const id of PLAYERS) {
    clients[id] = new RollbackClient({
      transport,
      endpointId: id,
      playerIds: PLAYERS,
      localId: id,
      maxRollback: options.maxRollback ?? 4,
      history: options.clientHistory ?? 8,
    });
  }
  // 默认全链路直通，测试可按需覆盖策略或注入故障。
  transport.setLink('host', 'p1', {}, 11);
  transport.setLink('host', 'p2', {}, 22);
  transport.setLink('p1', 'host', {}, 33);
  transport.setLink('p2', 'host', {}, 44);
  return { transport, host, clients };
}

// 一帧的固定调度（tick 由测试显式给出，无系统时间）：
// 1. 客户端在 tick 提交本地输入并发送；
// 2. 主机收集输入、从 tick 推进到 tick+1、广播权威帧；
// 3. 客户端先处理权威确认（可能回滚），再从 tick 推进到 tick+1。
// 客户端与主机在帧末处于同一 tick，输入 setLocalInput(tick) 用于 tick -> tick+1 的步进。
export function runTick(world, tick, inputs = {}) {
  const { transport, host, clients } = world;
  for (const id of PLAYERS) {
    clients[id].setLocalInput(tick, inputs[id] || normalizeInput(null));
    clients[id].sendInput(tick);
  }
  host.pumpInputs(tick);
  host.advance(tick + 1);
  host.broadcast(tick + 1);
  // 先吸收权威确认与输入窗口（可能回滚/预填），再推进本帧预测。
  for (const id of PLAYERS) clients[id].pump(tick + 1);
  for (const id of PLAYERS) clients[id].advance(tick + 1);
}

// 不经过任何网络逻辑的顺序参考实现，用于校验重放结果与顺序执行一致。
export function buildSequentialState(playerIds, perTickInputs, ticks) {
  let state = createInitialState(playerIds);
  for (let tick = 0; tick < ticks; tick++) {
    state = stepState(state, perTickInputs[tick] || {});
  }
  return state;
}

export function snapshotOf(state) {
  return cloneState(state);
}

export function findEvent(client, kind) {
  return client.events.find((event) => event.kind === kind) || null;
}

export function countEvents(client, kind) {
  return client.events.filter((event) => event.kind === kind).length;
}
