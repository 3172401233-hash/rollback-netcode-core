// 按 tick 索引的定长环形缓存。
// 仅使用数组下标访问，槽位按 tick 单调覆盖，回放时按 tick 顺序读取，结果确定。

export class RingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.slots = new Array(capacity).fill(null);
    this.oldestTick = 0;
  }

  indexOf(tick) {
    return ((tick % this.capacity) + this.capacity) % this.capacity;
  }

  has(tick) {
    if (!Number.isInteger(tick) || tick < 0) return false;
    const slot = this.slots[this.indexOf(tick)];
    return slot !== null && slot.tick === tick;
  }

  get(tick) {
    if (!this.has(tick)) return undefined;
    return this.slots[this.indexOf(tick)].value;
  }

  set(tick, value) {
    if (!Number.isInteger(tick) || tick < 0) {
      throw new Error('tick must be a non-negative integer');
    }
    this.slots[this.indexOf(tick)] = { tick, value };
    // oldestTick 只表示逻辑窗口下界；槽位是否有效由 slot.tick 精确判定，
    // 不能在写入时提前抬高，否则未写满前会把有效旧槽位误判为缺失。
    if (tick + 1 > this.capacity) {
      this.oldestTick = tick + 1 - this.capacity;
    }
  }

  // 追帧 / 重连时整体重置到某一 tick，旧 tick 全部作废。
  resetTo(tick) {
    this.slots.fill(null);
    this.oldestTick = tick;
  }
}
