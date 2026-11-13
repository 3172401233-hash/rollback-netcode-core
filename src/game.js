// 确定性游戏模拟：全部使用整数 / 定点数，固定步长推进，禁止随机数与时间读取。
// 坐标与速度以定点数表示，SCALE 为小数位数的放大倍数。

export const SCALE = 1000;
export const ARENA_MIN = 0;
export const ARENA_MAX = 100 * SCALE;
export const MOVE_SPEED = 2 * SCALE;       // 每个 tick 的位移（定点）
export const ATTACK_RANGE = 8 * SCALE;
export const ATTACK_DAMAGE = 10;
export const MAX_HEALTH = 100;

const EMPTY_INPUT = Object.freeze({ move: 0, attack: 0 });

// FNV-1a 32 位哈希，输入为规范化字符串，保证跨对象键顺序稳定。
export function hashString(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function normalizeInput(input) {
  if (!input) return { ...EMPTY_INPUT };
  const move = input.move === -1 || input.move === 1 ? input.move : 0;
  const attack = input.attack === 1 ? 1 : 0;
  return { move, attack };
}

export function inputsEqual(a, b) {
  const na = normalizeInput(a);
  const nb = normalizeInput(b);
  return na.move === nb.move && na.attack === nb.attack;
}

export function createInitialState(playerIds) {
  const ids = [...playerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const spacing = Math.floor(ARENA_MAX / (ids.length + 1));
  const players = {};
  for (let i = 0; i < ids.length; i++) {
    players[ids[i]] = {
      id: ids[i],
      x: spacing * (i + 1),
      hp: MAX_HEALTH,
      cooldown: 0,
    };
  }
  return { tick: 0, players };
}

export function cloneState(state) {
  const players = {};
  for (const id of Object.keys(state.players).sort()) {
    const p = state.players[id];
    players[id] = { id: p.id, x: p.x, hp: p.hp, cooldown: p.cooldown };
  }
  return { tick: state.tick, players };
}

// 规范化序列化：玩家按 id 排序后拼接，避免对象键遍历顺序影响哈希。
export function canonicalStateString(state) {
  const ids = Object.keys(state.players).sort();
  let out = `t:${state.tick};`;
  for (const id of ids) {
    const p = state.players[id];
    out += `${id}(x=${p.x},hp=${p.hp},cd=${p.cooldown});`;
  }
  return out;
}

export function hashState(state) {
  return hashString(canonicalStateString(state));
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// inputs: { [playerId]: { move, attack } }，缺失或 null 视为空输入。
// 固定一个 tick = 一个步长；移动阶段与攻击阶段顺序固定。
export function stepState(prevState, inputs) {
  const state = cloneState(prevState);
  const ids = Object.keys(state.players).sort();

  for (const id of ids) {
    const input = normalizeInput(inputs ? inputs[id] : null);
    const player = state.players[id];
    player.x = clamp(player.x + input.move * MOVE_SPEED, ARENA_MIN, ARENA_MAX);
    if (player.cooldown > 0) player.cooldown -= 1;
  }

  for (const id of ids) {
    const input = normalizeInput(inputs ? inputs[id] : null);
    const attacker = state.players[id];
    if (input.attack !== 1 || attacker.cooldown > 0 || attacker.hp <= 0) continue;
    attacker.cooldown = 3;
    for (const targetId of ids) {
      if (targetId === id) continue;
      const target = state.players[targetId];
      if (target.hp <= 0) continue;
      const distance = target.x >= attacker.x ? target.x - attacker.x : attacker.x - target.x;
      if (distance <= ATTACK_RANGE) {
        target.hp = target.hp - ATTACK_DAMAGE < 0 ? 0 : target.hp - ATTACK_DAMAGE;
      }
    }
  }

  state.tick = prevState.tick + 1;
  return state;
}

// 定点整数线性插值：alpha 为 [0, SCALE] 的整数（0..1000），不产生浮点。
export function interpolateInt(from, to, alpha) {
  const a = clamp(alpha, 0, SCALE);
  return from + Math.floor(((to - from) * a) / SCALE);
}

// 在相邻两帧状态之间生成用于显示的插值结果（仅用于渲染，不回写模拟状态）。
export function interpolateState(prevState, nextState, alpha) {
  const ids = Object.keys(nextState.players).sort();
  const players = {};
  for (const id of ids) {
    const a = prevState.players[id] || nextState.players[id];
    const b = nextState.players[id];
    players[id] = {
      id,
      x: interpolateInt(a.x, b.x, alpha),
      hp: interpolateInt(a.hp, b.hp, alpha),
      cooldown: b.cooldown,
    };
  }
  return { tick: nextState.tick, alpha, players };
}
