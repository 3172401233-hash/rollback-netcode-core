import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimTransport, createRng } from '../src/sim-transport.js';

test('显式 tick 驱动投递，无故障时按延迟到达', () => {
  const transport = new SimTransport();
  transport.addEndpoint('host');
  transport.addEndpoint('p1');
  transport.setLink('host', 'p1', { baseDelay: 2 }, 7);
  transport.send('host', 'p1', { seq: 1 }, 0);
  assert.deepEqual(transport.receive('p1', 1), []);
  const packets = transport.receive('p1', 2);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].seq, 1);
});

test('固定种子的丢包率序列可复现', () => {
  function run(seed) {
    const t = new SimTransport();
    t.addEndpoint('a');
    t.addEndpoint('b');
    t.setLink('a', 'b', { lossRate: 0.5 }, seed);
    const delivered = [];
    for (let tick = 0; tick < 10; tick++) {
      t.send('a', 'b', { tick }, tick);
      delivered.push(t.receive('b', tick).length);
    }
    return delivered;
  }
  assert.deepEqual(run(99), run(99));
  assert.notDeepEqual(run(1), run(2));
});

test('rng 为确定性整数序列且无系统时间依赖', () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 8; i++) assert.equal(a(), b());
});

test('故障注入可精确制造丢包、重复、延迟和乱序', () => {
  const transport = new SimTransport();
  transport.addEndpoint('a');
  transport.addEndpoint('b');
  transport.setLink('a', 'b', {}, 1);

  transport.injectFault('a', 'b', 'drop');
  transport.injectFault('a', 'b', 'duplicate');
  transport.injectFault('a', 'b', { delay: 5 });
  transport.injectFault('a', 'b', { reorder: true, holdTicks: 3 });
  transport.send('a', 'b', { id: 1 }, 0);
  transport.send('a', 'b', { id: 2 }, 0);
  transport.send('a', 'b', { id: 3 }, 0);
  transport.send('a', 'b', { id: 4 }, 1);

  assert.deepEqual(transport.receive('b', 0).map((p) => p.id), [2, 2]);
  assert.deepEqual(transport.receive('b', 1), []);
  transport.flushHeld('b');
  const flushed = transport.receive('b', 2).map((p) => p.id);
  assert.deepEqual(flushed, [4]);
  const delayed = transport.receive('b', 5).map((p) => p.id);
  assert.deepEqual(delayed, [3]);
  assert.equal(transport.stats.dropped, 1);
});

test('断线期间发送的包被丢弃，重连后恢复投递', () => {
  const transport = new SimTransport();
  transport.addEndpoint('a');
  transport.addEndpoint('b');
  transport.setLink('a', 'b', {}, 1);
  transport.disconnect('a', 'b');
  transport.send('a', 'b', { id: 1 }, 0);
  assert.equal(transport.pendingCount('b'), 0);
  transport.reconnect('a', 'b');
  transport.send('a', 'b', { id: 2 }, 1);
  assert.equal(transport.receive('b', 1)[0].id, 2);
});
