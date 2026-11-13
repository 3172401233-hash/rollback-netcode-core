// 模拟网络：不创建任何 socket / 真实连接。
// 所有投递由显式 tick 参数驱动，故障行为由确定性策略与故障队列控制。

// mulberry32：确定性伪随机，测试可用固定种子复现丢包/抖动序列。
export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 链路策略：lossRate 丢包比例；baseDelay 固定延迟 tick；
// jitter 由 rng 决定的附加延迟 tick；reorderHold 暂存后与后续包交换投递。
export function createLinkPolicy(options = {}) {
  return {
    lossRate: options.lossRate ?? 0,
    baseDelay: options.baseDelay ?? 0,
    jitter: options.jitter ?? 0,
    reorderHold: options.reorderHold ?? 0,
  };
}

let envelopeSeq = 0;

export class SimTransport {
  constructor() {
    this.endpoints = [];
    this.policies = {};             // key: from->to
    this.queues = {};               // key: to，数组，按投递 tick 排序后取出
    this.faults = {};               // key: from->to，故障指令队列
    this.connected = {};            // key: from->to，布尔
    this.rngs = {};                 // key: from->to，独立确定性随机源
    this.seeds = {};
    this.stats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, held: 0 };
  }

  addEndpoint(id) {
    if (!this.endpoints.includes(id)) this.endpoints.push(id);
    return id;
  }

  linkKey(from, to) {
    return `${from}->${to}`;
  }

  setLink(from, to, policy = {}, seed = 1) {
    const key = this.linkKey(from, to);
    this.policies[key] = createLinkPolicy(policy);
    this.seeds[key] = seed >>> 0;
    this.rngs[key] = createRng(seed >>> 0);
    this.connected[key] = true;
  }

  disconnect(from, to) {
    this.connected[this.linkKey(from, to)] = false;
  }

  reconnect(from, to) {
    const key = this.linkKey(from, to);
    this.connected[key] = true;
    // 重连后重新播种，保证测试中的重连行为可复现。
    this.rngs[key] = createRng(this.seeds[key] ?? 1);
  }

  isConnected(from, to) {
    return this.connected[this.linkKey(from, to)] === true;
  }

  // 测试用故障注入：对该方向下一个包施加指定行为。
  injectFault(from, to, fault) {
    const key = this.linkKey(from, to);
    if (!this.faults[key]) this.faults[key] = [];
    this.faults[key].push(fault);
  }

  nextFault(from, to) {
    const queue = this.faults[this.linkKey(from, to)];
    return queue && queue.length > 0 ? queue.shift() : null;
  }

  send(from, to, packet, tick) {
    if (!Number.isInteger(tick) || tick < 0) {
      throw new Error('send requires an explicit non-negative integer tick');
    }
    this.stats.sent += 1;
    const key = this.linkKey(from, to);
    if (!this.isConnected(from, to)) {
      this.stats.dropped += 1;
      return;
    }

    const policy = this.policies[key] || createLinkPolicy();
    const rng = this.rngs[key] || createRng(1);
    const fault = this.nextFault(from, to);

    if (fault === 'drop' || (policy.lossRate > 0 && rng() < policy.lossRate)) {
      this.stats.dropped += 1;
      return;
    }

    let delay = policy.baseDelay;
    if (policy.jitter > 0) delay += Math.floor(rng() * (policy.jitter + 1));
    if (fault && typeof fault === 'object' && fault.delay !== undefined) delay = fault.delay;

    const base = {
      envelopeSeq: envelopeSeq++,
      from,
      to,
      packet,
      deliverAt: tick + Math.max(0, delay),
      copies: 1,
      held: false,
    };

    if (fault === 'duplicate' || (fault && typeof fault === 'object' && fault.duplicate)) {
      base.copies = 2;
      this.stats.duplicated += 1;
    }
    if (fault === 'reorder' || (fault && typeof fault === 'object' && fault.reorder)) {
      base.held = true;
      base.holdUntil = tick + (fault && typeof fault === 'object' && fault.holdTicks ? fault.holdTicks : 2);
      this.stats.held += 1;
    } else if (policy.reorderHold > 0 && rng() < 0.5) {
      base.held = true;
      base.holdUntil = tick + policy.reorderHold;
      this.stats.held += 1;
    }

    if (!this.queues[to]) this.queues[to] = [];
    this.queues[to].push(base);
  }

  // 取出当前 tick 可投递的全部包；按入队顺序返回，乱序由 hold 机制制造。
  receive(to, tick) {
    const queue = this.queues[to];
    if (!queue) return [];
    const ready = [];
    const remaining = [];
    for (const item of queue) {
      if (item.held && tick < item.holdUntil) {
        remaining.push(item);
        continue;
      }
      if (tick >= item.deliverAt) {
        for (let i = 0; i < item.copies; i++) ready.push(item.packet);
        if (item.copies > 1) this.stats.delivered += item.copies - 1;
      } else {
        remaining.push(item);
      }
    }
    this.queues[to] = remaining;
    this.stats.delivered += ready.length;
    return ready;
  }

  // 测试辅助：强制释放被暂存的乱序包。
  flushHeld(to) {
    const queue = this.queues[to];
    if (!queue) return;
    for (const item of queue) {
      if (item.held) item.held = false;
    }
  }

  pendingCount(to) {
    return this.queues[to] ? this.queues[to].length : 0;
  }
}
