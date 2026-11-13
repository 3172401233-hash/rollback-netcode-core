import {
  createInitialState,
  stepState,
  hashState,
  normalizeInput,
  inputsEqual,
  cloneState,
  interpolateState,
  SCALE,
} from './game.js';
import { RingBuffer } from './ring-buffer.js';
import { createInputPacket } from './protocol.js';

const MODE_NORMAL = 'normal';
const MODE_CATCH_UP = 'catch-up';

// 回滚客户端：本地预测 + 权威确认 + 快照重放 + 追帧降级。
// 所有推进均由外部显式 tick 驱动，内部不读取任何系统时间。
export class RollbackClient {
  constructor({ transport, endpointId, playerIds, localId, maxRollback = 8, history = 16 }) {
    if (!playerIds.includes(localId)) throw new Error('localId must be one of playerIds');
    this.transport = transport;
    this.endpointId = endpointId;
    this.playerIds = [...playerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.localId = localId;
    this.maxRollback = maxRollback;
    this.history = history;

    this.currentTick = 0;
    this.state = createInitialState(this.playerIds);
    this.snapshots = new RingBuffer(history + 1);
    this.localInputs = new RingBuffer(history + maxRollback + 1);
    this.remoteInputs = new RingBuffer(history + maxRollback + 1);
    this.usedInputs = new RingBuffer(history + 1);
    this.confirmedInputs = new RingBuffer(history + maxRollback + 1);
    this.snapshots.set(0, cloneState(this.state));

    this.lastHostSeq = -1;
    this.lastHostTick = -1;
    this.oldestDirty = null;
    this.mode = MODE_NORMAL;
    this.pendingFuture = [];
    this.events = [];
    this.stats = {
      sentInputs: 0,
      rollbacks: 0,
      replayedTicks: 0,
      hashMismatches: 0,
      duplicatePackets: 0,
      stalePackets: 0,
      futurePackets: 0,
      snapshotMisses: 0,
      catchUpEntered: 0,
      catchUpExited: 0,
      reconnects: 0,
      emptyInputTicks: 0,
    };
    transport.addEndpoint(endpointId);
  }

  recordEvent(kind, detail) {
    this.events.push({ atTick: this.currentTick, kind, detail: detail ?? null });
    if (this.events.length > 200) this.events.shift();
  }

  // 每帧提交本地输入：该输入用于从 tick 推进到 tick+1。
  setLocalInput(tick, input) {
    const normalized = normalizeInput(input);
    if (normalized.move === 0 && normalized.attack === 0) this.stats.emptyInputTicks += 1;
    this.localInputs.set(tick, normalized);
    return normalized;
  }

  localInputFor(tick) {
    return this.localInputs.get(tick) || normalizeInput(null);
  }

  remoteInputFor(tick) {
    const entry = this.remoteInputs.get(tick);
    const inputs = {};
    for (const id of this.playerIds) {
      inputs[id] = entry ? normalizeInput(entry[id]) : normalizeInput(null);
    }
    return inputs;
  }

  // 组装某 tick 的输入：本地玩家用本地输入，远端优先用权威日志，缺失则空输入预测。
  buildInputs(tick) {
    const inputs = this.remoteInputFor(tick);
    inputs[this.localId] = this.localInputFor(tick);
    return inputs;
  }

  advance(tick) {
    if (!Number.isInteger(tick) || tick <= this.currentTick) {
      throw new Error('advance requires a strictly increasing explicit tick');
    }
    while (this.currentTick < tick) {
      const stepTick = this.currentTick;
      const inputs = this.buildInputs(stepTick);
      this.usedInputs.set(stepTick, this.cloneInputs(inputs));
      this.state = stepState(this.state, inputs);
      this.currentTick = stepTick + 1;
      this.snapshots.set(this.currentTick, cloneState(this.state));
    }
    // 全部步进完成后统一排空到期确认，回滚重放不会与推进循环互相覆盖。
    this.drainFuturePackets();
  }

  cloneInputs(inputs) {
    const copy = {};
    for (const id of this.playerIds) copy[id] = normalizeInput(inputs[id]);
    return copy;
  }

  sendInput(tick) {
    const packet = createInputPacket(this.endpointId, tick, this.localInputFor(tick));
    this.transport.send(this.endpointId, 'host', packet, tick);
    this.stats.sentInputs += 1;
    return packet;
  }

  // 重传历史 tick 的输入，用于丢包后迟到送达的场景。
  resendInput(tick, sendAtTick) {
    const packet = createInputPacket(this.endpointId, tick, this.localInputFor(tick));
    this.transport.send(this.endpointId, 'host', packet, sendAtTick);
    this.stats.sentInputs += 1;
    return packet;
  }

  pump(tick) {
    const packets = this.transport.receive(this.endpointId, tick);
    for (const packet of packets) this.handlePacket(packet);
    this.drainFuturePackets();
    if (this.mode === MODE_CATCH_UP && this.currentTick >= this.lastHostTick && this.lastHostTick >= 0) {
      this.mode = MODE_NORMAL;
      this.stats.catchUpExited += 1;
      this.recordEvent('catch-up-end', { tick: this.currentTick });
    }
  }

  drainFuturePackets() {
    if (this.pendingFuture.length === 0) return;
    this.pendingFuture.sort((a, b) => (a.tick - b.tick) || (a.seq - b.seq));
    const remaining = [];
    for (const packet of this.pendingFuture) {
      if (packet.tick <= this.currentTick) {
        if (packet.seq > this.lastHostSeq) this.lastHostSeq = packet.seq;
        if (packet.tick > this.lastHostTick) this.lastHostTick = packet.tick;
        this.mergeInputWindow(packet);
        // 到期后该包可能仍略超前；processAck 内部会再次校验 tick 边界。
        this.processAck(packet);
      } else {
        remaining.push(packet);
      }
    }
    this.pendingFuture = remaining;
  }

  handlePacket(packet) {
    if (!packet || (packet.type !== 'host' && packet.type !== 'reconnect')) return;

    if (packet.type === 'reconnect') {
      this.applyReconnect(packet);
      return;
    }

    // 缓冲过的未来包到期重放：序号水位可能已被后续包推进，跳过重复/过期判定。
    if (!packet._buffered) {
      if (packet.seq === this.lastHostSeq) {
        this.stats.duplicatePackets += 1;
        this.recordEvent('duplicate-packet', { seq: packet.seq });
        return;
      }
      if (packet.seq < this.lastHostSeq) {
        this.stats.stalePackets += 1;
        this.recordEvent('stale-packet', { seq: packet.seq });
        return;
      }
      if (packet.tick > this.currentTick) {
        if (this.pendingFuture.some((pending) => pending.seq === packet.seq)) {
          this.stats.duplicatePackets += 1;
          this.recordEvent('duplicate-packet', { seq: packet.seq });
          return;
        }
        this.stats.futurePackets += 1;
        // 输入窗口提前吸收，但不写入已确认缓存，保留后续迟到修正的检测能力。
        this.prefillInputWindow(packet);
        this.pendingFuture.push({ ...packet, _buffered: true });
        this.recordEvent('future-packet-buffered', { tick: packet.tick });
        return;
      }
      this.lastHostSeq = packet.seq;
    }

    if (packet.tick > this.lastHostTick) this.lastHostTick = packet.tick;
    this.mergeInputWindow(packet);
    this.processAck(packet);
  }

  // 合并权威输入窗口；与本端实际使用过的输入比较，标记最早分歧 tick。
  prefillInputWindow(packet) {
    const ticks = Object.keys(packet.inputs).map((key) => Number(key)).sort((a, b) => a - b);
    for (const tick of ticks) {
      // 预填尚未实际执行的 tick（含即将推进的下一 tick），避免空预测。
      if (tick < this.currentTick) continue;
      const normalized = this.cloneInputs(packet.inputs[tick]);
      normalized[this.localId] = this.localInputFor(tick);
      this.remoteInputs.set(tick, normalized);
    }
  }

  mergeInputWindow(packet) {
    const ticks = Object.keys(packet.inputs).map((key) => Number(key)).sort((a, b) => a - b);
    for (const tick of ticks) {
      const normalized = this.cloneInputs(packet.inputs[tick]);
      // 本地玩家的输入永远以本端为准，权威窗口只用于远端玩家。
      normalized[this.localId] = this.localInputFor(tick);
      const authoritative = normalized;
      const previouslyConfirmed = this.confirmedInputs.has(tick)
        ? this.confirmedInputs.get(tick)
        : null;
      this.remoteInputs.set(tick, authoritative);
      this.confirmedInputs.set(tick, this.cloneInputs(authoritative));
      if (tick > this.currentTick) continue;
      const used = this.usedInputs.get(tick);
      let changed = false;
      for (const id of this.playerIds) {
        if (id === this.localId) continue;
        if (!used) {
          // 输入记录已被环形缓存回收时，无法判定输入分歧，交给哈希确认兜底。
          continue;
        }
        // 实际使用与权威一致：永不算分歧。
        if (inputsEqual(used[id], authoritative[id])) continue;
        // 首次确认（之前只有空预测）或权威值相对旧确认发生修正：需要回滚。
        if (previouslyConfirmed === null || !inputsEqual(previouslyConfirmed[id], authoritative[id])) {
          changed = true;
        }
      }
      if (changed && (this.oldestDirty === null || tick < this.oldestDirty)) {
        this.oldestDirty = tick;
      }
    }
  }

  processAck(packet) {
    const ackTick = packet.tick;
    if (ackTick < 0 || ackTick > this.currentTick) return;

    // 无输入分歧时只做哈希确认，不产生回滚。
    if (this.oldestDirty === null) {
      const ackSnapshot = this.snapshots.get(ackTick);
      if (ackSnapshot && hashState(ackSnapshot) !== packet.hash) {
        this.stats.hashMismatches += 1;
        this.recordEvent('hash-mismatch', { tick: ackTick });
        this.enterCatchUp(packet, this.currentTick - ackTick);
      }
      return;
    }

    // 回滚到分歧 tick 的快照，用修正后的输入从该 tick 重新执行。
    const targetTick = Math.min(this.oldestDirty, ackTick);
    const gap = this.currentTick - targetTick;
    if (!this.snapshots.has(targetTick) || gap > this.maxRollback) {
      if (!this.snapshots.has(targetTick)) this.stats.snapshotMisses += 1;
      this.enterCatchUp(packet, gap);
      return;
    }

    this.rollbackAndReplay(targetTick);

    const ackSnapshot = this.snapshots.get(ackTick);
    if (ackSnapshot && hashState(ackSnapshot) !== packet.hash) {
      this.stats.hashMismatches += 1;
      this.recordEvent('hash-mismatch', { tick: ackTick });
      this.enterCatchUp(packet, gap);
      return;
    }

    if (this.oldestDirty <= ackTick) this.oldestDirty = null;
  }

  rollbackAndReplay(targetTick) {
    const base = this.snapshots.get(targetTick);
    if (!base) {
      this.stats.snapshotMisses += 1;
      return false;
    }
    this.stats.rollbacks += 1;
    this.recordEvent('rollback', { from: this.currentTick, to: targetTick });
    // 回滚到 targetTick 后需要重放至回滚前已生成的最新快照（含 currentTick）。
    const stopTick = this.currentTick;
    this.state = cloneState(base);
    this.currentTick = targetTick;

    let replayed = 0;
    while (this.currentTick < stopTick) {
      const stepTick = this.currentTick;
      const inputs = this.buildInputs(stepTick);
      this.usedInputs.set(stepTick, this.cloneInputs(inputs));
      this.state = stepState(this.state, inputs);
      this.currentTick = stepTick + 1;
      this.snapshots.set(this.currentTick, cloneState(this.state));
      replayed += 1;
    }
    this.stats.replayedTicks += replayed;
    return true;
  }

  enterCatchUp(packet, gap) {
    this.mode = MODE_CATCH_UP;
    this.stats.catchUpEntered += 1;
    this.recordEvent('catch-up-enter', { hostTick: packet.tick, gap });
    this.applyAuthoritativeState(packet);
  }

  applyAuthoritativeState(packet) {
    this.state = cloneState(packet.state);
    this.currentTick = packet.tick;
    this.snapshots.resetTo(packet.tick);
    this.usedInputs.resetTo(packet.tick);
    this.snapshots.set(packet.tick, cloneState(this.state));
    this.mergeAuthoritativeInputs(packet);
    this.oldestDirty = null;
    this.pendingFuture = [];
  }

  mergeAuthoritativeInputs(packet) {
    const ticks = Object.keys(packet.inputs).map((key) => Number(key)).sort((a, b) => a - b);
    for (const tick of ticks) {
      const normalized = this.cloneInputs(packet.inputs[tick]);
      normalized[this.localId] = this.localInputFor(tick);
      this.remoteInputs.set(tick, normalized);
      if (tick <= packet.tick) this.usedInputs.set(tick, normalized);
    }
  }

  applyReconnect(packet) {
    this.stats.reconnects += 1;
    this.lastHostSeq = packet.seq;
    this.lastHostTick = packet.tick;
    this.recordEvent('reconnect-resync', { tick: packet.tick });
    this.applyAuthoritativeState(packet);
    this.mode = MODE_NORMAL;
    this.stats.catchUpExited += 1;
  }

  // 显示用插值：alpha 为 [0, SCALE] 的定点整数，不修改模拟状态。
  renderState(alpha = SCALE) {
    const next = this.snapshots.get(this.currentTick);
    const prev = this.snapshots.get(this.currentTick - 1) || next;
    return interpolateState(prev, next, alpha);
  }

  predictedHash() {
    return hashState(this.state);
  }
}
