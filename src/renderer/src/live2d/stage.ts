// 舞台层的纯工具:目前只有「canvas 的身份」。
//
// ⛔ 与 frame.ts / lip.ts / prefs.ts 同一套理由单独成文件:AvatarStage.tsx 会
//    import host.ts → vendored Cubism Framework(~720KB + Core wasm),vitest 的
//    node 环境起不来。抽出来这条不变量才有回归网守着。
//
// 背景(2026-09-13 线上事故):切换角色时 React 复用同一个 <canvas> 元素,而上一个
// Live2DHost 释放时调了 WEBGL_lose_context.loseContext()(归还 GPU 资源,面板反复
// 开关不至于顶到浏览器每页上下文上限)。同一张 canvas 上再 getContext 只会拿回那个
// **已丢失**的上下文,帧循环第一行 isContextLost() 就 return,首帧回调永不触发 ——
// 而首帧是面板撤掉加载态的唯一信号,于是永久卡在「已读本地缓存 100%」,且再也切不
// 回去。修法就是给 canvas 一个随「角色 + 重试次数」变化的 key,强制换新元素。

/**
 * canvas 的 React key:角色或重试次数变了就必须换一张全新 canvas(= 全新 WebGL
 * 上下文)。⛔ 两个入参都不能省 —— 漏掉 attempt,「重试」按钮就是同角色重跑 effect,
 * 拿到的还是刚被 loseContext 的那个上下文,重试等于永远转圈。
 */
export function stageCanvasKey(characterId: string, attempt: number): string {
  const safeAttempt = Number.isFinite(attempt) && attempt >= 0 ? Math.floor(attempt) : 0;
  return `${characterId}-${safeAttempt}`;
}
