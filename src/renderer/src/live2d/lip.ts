// 口型电平 → 开度包络(纯函数,无 GL / 无 React 依赖)。
//
// 为什么单独一层:数字人「不张嘴」的排查成本极高(要有 WebGL、要有音频、要 rAF
// 跑起来才能观察),而真正会坏的逻辑只有这一段增益+包络。抽出来就能在 vitest 里
// 用假 dt 步进直接断言「音节之间有回落、静音后闭嘴、不会超界」。
//
// ⛔ 不要把这几个函数塞回 host.ts:那里 import 了 vendored Cubism Framework
//    (~720KB + Core wasm),单测环境起不来,等于这段逻辑重新变成黑盒。

/** RMS → 0..1 的放大倍数。TTS 实测原始 RMS 峰值约 0.4,3.5 倍正好顶到 1。 */
export const DEFAULT_LIP_GAIN = 3.5;

/** 起音时间常数(秒):再长就会「音已到嘴未张」。 */
export const LIP_ATTACK = 0.022;

/** 收音时间常数(秒):再短音节之间会闪回全闭,嘴型抖成噪点。 */
export const LIP_RELEASE = 0.14;

/** 低于这个值直接归零:避免 analyser 的量化噪声让嘴停不住。 */
export const LIP_FLOOR = 0.002;

/** 单帧步长上限,与 host 的 MAX_DELTA 同口径(切回前台时 dt 可能是几十秒)。 */
export const MAX_FRAME_DELTA = 0.05;

/**
 * 推进一帧口型包络。
 *
 * @param current 上一帧的开度 0..1
 * @param level   本帧原始电平(引擎 getLevel(),RMS 0..~0.4);负数按 0 处理
 * @param dt      本帧步长(秒),会被夹到 MAX_FRAME_DELTA
 * @param gain    放大倍数,默认 DEFAULT_LIP_GAIN
 * @returns 本帧开度 0..1(起音快、收音慢的指数逼近)
 */
export function lipEnvelope(
  current: number,
  level: number,
  dt: number,
  gain: number = DEFAULT_LIP_GAIN,
): number {
  const safeLevel = Number.isFinite(level) ? level : 0;
  const safeDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_FRAME_DELTA) : 0;
  const target = Math.min(1, Math.max(0, safeLevel * gain));
  if (safeDt === 0) return clampUnit(current);
  const tau = target > current ? LIP_ATTACK : LIP_RELEASE;
  const rate = Math.min(1, safeDt / tau);
  const next = current + (target - current) * rate;
  return next < LIP_FLOOR ? 0 : clampUnit(next);
}

/** 一阶低通的稳态值(用于断言「持续出声时嘴会张开」)。 */
export function lipTarget(level: number, gain: number = DEFAULT_LIP_GAIN): number {
  const safeLevel = Number.isFinite(level) ? level : 0;
  return Math.min(1, Math.max(0, safeLevel * gain));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
