// 线上包结构（纯数据，可 JSON 序列化；本项目不做真实 IO，只在模拟传输里传递）。
// 两类包：
//   input    客户端 -> 主机：某个 tick 的本地输入
//   host     主机 -> 客户端：权威 tick、状态哈希、全量状态、输入窗口与单调序号

export function createInputPacket(clientId, tick, input) {
  return {
    type: 'input',
    clientId,
    tick,
    input: {
      move: input && input.move === -1 ? -1 : input && input.move === 1 ? 1 : 0,
      attack: input && input.attack === 1 ? 1 : 0,
    },
  };
}

export function createHostPacket(seq, tick, state, stateHash, inputWindow) {
  return {
    type: 'host',
    seq,
    tick,
    state,
    hash: stateHash,
    inputs: inputWindow,
  };
}

export function createReconnectPacket(seq, tick, state, stateHash, inputWindow) {
  return {
    type: 'reconnect',
    seq,
    tick,
    state,
    hash: stateHash,
    inputs: inputWindow,
  };
}
