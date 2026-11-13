# rollback-netcode-core

零第三方依赖、不创建任何真实网络连接的 Node.js 固定 tick 多人对战回滚网络核心。
所有时间推进都由调用方显式传入整数 `tick`，内部不读取系统时钟；模拟只使用整数与定点数，
回放结果在相同输入下逐字节确定。

## 目录结构

- `src/game.js`：确定性游戏模拟（定点整数、固定步长、FNV-1a 状态哈希、整数插值）
- `src/ring-buffer.js`：按 tick 索引的定长环形缓存，用于输入与快照
- `src/sim-transport.js`：模拟网络，支持可控丢包、延迟、乱序、重复、断线重连
- `src/protocol.js`：输入包、主机确认包、重连包的纯数据结构
- `src/host.js`：权威主机，固定 tick 推进并广播状态哈希、全量状态与输入窗口
- `src/client.js`：回滚客户端（本地预测、确认、快照重放、追帧降级、显示插值）
- `src/index.js`：统一导出
- `test/`：基于 `node:test` 的 28 个测试

## 确定性保证

- 坐标使用放大 `SCALE = 1000` 的定点整数，移动、攻击、插值全部是整数运算。
- 状态序列化按玩家 id 排序后拼接，哈希为 FNV-1a 32 位无符号整数，
  不受对象键声明顺序、`Map`/`Set` 遍历顺序影响。
- 不使用 `Math.random`、`Date`、`performance` 等非确定来源；模拟网络的随机故障
  由 `mulberry32` 伪随机数发生器产生，固定种子可逐包复现。
- 所有集合遍历都先对 tick 或玩家 id 做显式排序。

## 核心机制

### 帧调度

每个显式 tick 的推荐顺序（见 `test/helpers.js` 的 `runTick`）：

1. 客户端 `setLocalInput(tick, input)` 并 `sendInput(tick)`；
2. 主机 `pumpInputs(tick)`、`advance(tick + 1)`、`broadcast(tick + 1)`；
3. 客户端 `pump(tick + 1)` 处理确认（可能回滚或追帧），再 `advance(tick + 1)` 预测。

### 回滚与确认

- 客户端为每个已模拟 tick 保存状态快照、本地输入、远端输入和实际使用输入。
- 主机确认包携带单调序号 `seq`、权威 tick、全量状态、状态哈希与输入窗口。
- 收到确认后对比实际使用输入与权威输入，记录最早分歧 tick `oldestDirty`：
  - 回滚跨度在 `maxRollback` 内且快照存在：回到分歧 tick 快照，用修正输入重放至当前 tick；
  - 快照缺失或跨度超限：进入明确的 `catch-up` 追帧模式，直接对齐权威全量状态，
    不会无声漂移；追上主机 tick 后自动恢复 `normal`。
- 即使无输入分歧，也会校验确认 tick 的状态哈希，哈希不一致同样触发追帧。

### 异常包处理

- 重复序号：计入 `duplicatePackets` 并丢弃，不重复触发回滚；
- 过期序号：计入 `stalePackets` 并丢弃；
- 未来 tick：输入窗口预填到远端输入缓存，确认本身缓冲到本地追上后处理；
- 空输入：缺失输入与显式空输入等价，计入 `emptyInputTicks`；
- 断线重连：主机通过 `handleReconnect` 下发全量状态与输入窗口，客户端整体重置对齐；
- 重放期间到达的新确认：在同一 `pump`/`advance` 周期内按序号与 tick 顺序处理。

### 显示插值

`renderState(alpha)` 在相邻两帧快照之间做定点整数线性插值，`alpha ∈ [0, 1000]`，
  仅用于渲染，不回写模拟状态。

## 模拟网络故障

`SimTransport` 全部由显式 tick 驱动，不打开 socket：

- 链路策略：`lossRate`（丢包率）、`baseDelay`、`jitter`、`reorderHold`；
- 确定性故障注入：`injectFault(from, to, 'drop' | 'duplicate' | 'reorder' | { delay, holdTicks })`；
- `disconnect` / `reconnect` 模拟链路中断与恢复，重连后随机源按种子重新播种。

## 运行测试

```bash
node --test
# 或
npm test
```

测试覆盖：正常确认、预测回滚、重复包、过期包、未来帧、空输入、快照缺口、
连续回滚、追帧降级、断线重连、确定性重放、重放期间新确认、状态插值与哈希不一致。

## 已知未覆盖的网络边界

- 真实字节序列化/压缩与带宽预算（当前包为内存中的纯对象，未做线编码）；
- NAT 穿透、TLS、连接握手与鉴权；
- 超过缓存窗口的超长断线（当前重连依赖主机仍保留输入窗口）；
- 时钟漂移与可变帧率（本项目要求外部固定 tick 驱动，不处理 wall-clock）；
- 多主机/主机迁移、观战者与晚加入玩家的初始世界同步；
- 拥塞控制、RTT 动态估计与自适应输入延迟；
- 作弊对抗与输入合法性校验。
