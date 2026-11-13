import {
  createInitialState,
  stepState,
  hashState,
  normalizeInput,
  cloneState,
} from './game.js';
import { RingBuffer } from './ring-buffer.js';
import { createHostPacket, createReconnectPacket } from './protocol.js';

// 权威主机：固定 tick 推进，缺失输入按空输入处理，
// 保留输入日志与状态快照，重连时下发全量状态与输入窗口。
export class AuthoritativeHost {
  constructor({ transport, endpointId = 'host', playerIds, history = 32, sendWindow = 16 }) {
    this.transport = transport;
    this.endpointId = endpointId;
    this.playerIds = [...playerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.history = history;
    this.sendWindow = sendWindow;
    this.currentTick = 0;
    this.state = createInitialState(this.playerIds);
    this.snapshots = new RingBuffer(history + 1);
    this.inputLog = new RingBuffer(history + sendWindow);
    this.seq = 0;
    this.stats = { ticks: 0, inputsReceived: 0, inputsLate: 0, packetsSent: 0, reconnects: 0 };

    this.snapshots.set(0, cloneState(this.state));
    const initialInputs = {};
    for (const id of this.playerIds) initialInputs[id] = normalizeInput(null);
    this.inputLog.set(0, initialInputs);
    transport.addEndpoint(endpointId);
  }

  // 收集某 tick 的输入；tick 已模拟完成才算迟到，仅记录统计不回改历史。
  // 当前待模拟 tick（currentTick）的输入仍可补录，模拟重传/迟到送达。
  receiveInput(packet) {
    if (!packet || packet.type !== 'input') return;
    this.stats.inputsReceived += 1;
    const tick = packet.tick;
    if (tick < this.currentTick) {
      this.stats.inputsLate += 1;
      return;
    }
    let entry = this.inputLog.get(tick);
    if (!entry) {
      entry = {};
      for (const id of this.playerIds) entry[id] = normalizeInput(null);
      this.inputLog.set(tick, entry);
    }
    entry[packet.clientId] = normalizeInput(packet.input);
  }

  pumpInputs(tick) {
    const packets = this.transport.receive(this.endpointId, tick);
    for (const packet of packets) this.receiveInput(packet);
  }

  inputsForTick(tick) {
    const entry = this.inputLog.get(tick);
    const inputs = {};
    for (const id of this.playerIds) {
      inputs[id] = entry ? normalizeInput(entry[id]) : normalizeInput(null);
    }
    return inputs;
  }

  advance(tick) {
    if (!Number.isInteger(tick) || tick <= this.currentTick) {
      throw new Error('advance requires a strictly increasing explicit tick');
    }
    while (this.currentTick < tick) {
      const nextTick = this.currentTick + 1;
      const inputs = this.inputsForTick(this.currentTick);
      this.state = stepState(this.state, inputs);
      this.currentTick = nextTick;
      this.snapshots.set(nextTick, cloneState(this.state));
      this.stats.ticks += 1;
    }
  }

  buildInputWindow() {
    const from = Math.max(0, this.currentTick - this.sendWindow);
    const window = {};
    for (let tick = from; tick <= this.currentTick; tick++) {
      const entry = this.inputLog.get(tick);
      if (!entry) continue;
      const normalized = {};
      for (const id of this.playerIds) normalized[id] = normalizeInput(entry[id]);
      window[tick] = normalized;
    }
    return window;
  }

  broadcast(tick, options = {}) {
    this.seq += 1;
    const window = this.buildInputWindow();
    const packet = options.reconnect
      ? createReconnectPacket(this.seq, this.currentTick, cloneState(this.state), hashState(this.state), window)
      : createHostPacket(this.seq, this.currentTick, cloneState(this.state), hashState(this.state), window);
    for (const clientId of this.playerIds) {
      if (this.transport.isConnected(this.endpointId, clientId)) {
        this.transport.send(this.endpointId, clientId, packet, tick);
        this.stats.packetsSent += 1;
      }
    }
    return packet;
  }

  // 重连响应：单独向该客户端补发全量状态。
  handleReconnect(clientId, tick) {
    this.stats.reconnects += 1;
    this.seq += 1;
    const packet = createReconnectPacket(
      this.seq,
      this.currentTick,
      cloneState(this.state),
      hashState(this.state),
      this.buildInputWindow(),
    );
    this.transport.send(this.endpointId, clientId, packet, tick);
    return packet;
  }
}
