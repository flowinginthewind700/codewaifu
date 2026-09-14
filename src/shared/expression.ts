// 表情(exp3.json)里的口型参数剥离 —— 纯字符串函数,不碰 Cubism。
// 外加表情名字的本地化(菜单里给用户看的那一层)。
//
// 为什么单独一层:与 lip.ts 同理。host.ts import 了 vendored Cubism Framework
// (~720KB + Core wasm),单测环境起不来;这段逻辑只是「解析 JSON、按 id 删条目、
// 写回」,抽出来就能在 vitest 里直接断言。
//
// 背景(用户实测 bug:朗读时嘴一直张着、开度不变):
//   HaruGreeter 的 e-happy-01.exp3.json 里带 `ParamMouthOpenY: Value 1, Blend Add`。
//   说话时 widget 会挂 talk 表情(→ happy-01),于是每帧嘴先被表情 +1,再被口型
//   电平 +0.8*level,参数上限是 1 → 恒为「全开」,电平再怎么变都看不出来。
//   motion 那边早有对策(preloadMotions 里的 `motion.setEffectIds(...)`),但 Cubism
//   的表情类**没有**等价 API:CubismExpressionMotion.doUpdateParameters 直接遍历
//   自己的参数表,不看 effect ids。所以只能在喂给 loadExpression 之前把 JSON 里的
//   口型条目摘掉。
//
// ⛔ 只摘口型(LipSync 组),不摘 EyeBlink 组:表情主要靠眼睛成形(笑眼/眯眼),
//    而 CubismEyeBlink 用乘法混合、与表情天然共存;嘴是唯一必须完全交给音频电平
//    的参数。把眼睛也摘了会让「开心」表情变成死鱼眼。

import type { Lang } from './protocol'

/** Cubism 3+ 表情文件的参数数组字段名。 */
const PARAMETERS_KEY = 'Parameters'

/**
 * 摘掉表情 JSON 里由口型接管的参数条目。
 *
 * 认不出来的形状(解析失败、Cubism 2 的 exp.json、没有 Parameters 数组)一律
 * **原样返回**:剥口型是优化,不该让一个怪文件把整个表情加载弄崩。
 *
 * @param json       exp3.json 文本
 * @param lipSyncIds 要剥掉的参数 id(model3.json 的 LipSync 组,或兜底的 ParamMouthOpenY)
 * @returns 剥过的文本;没有命中任何条目时返回**同一个字符串**(不重新序列化)
 */
export function stripLipSyncFromExpression(json: string, lipSyncIds: readonly string[]): string {
  if (!json || lipSyncIds.length === 0) return json
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return json
  }
  if (!parsed || typeof parsed !== 'object') return json
  const record = parsed as Record<string, unknown>
  const parameters = record[PARAMETERS_KEY]
  if (!Array.isArray(parameters)) return json

  const drop = new Set(lipSyncIds)
  const kept = parameters.filter((entry) => {
    if (!entry || typeof entry !== 'object') return true
    const id = (entry as Record<string, unknown>).Id
    return !(typeof id === 'string' && drop.has(id))
  })
  if (kept.length === parameters.length) return json
  record[PARAMETERS_KEY] = kept
  return JSON.stringify(parsed)
}

/**
 * 字节版:loadExpression 只吃 ArrayBuffer。
 *
 * 没有命中时返回**原来那个 buffer**(不复制、不重编码),命中时返回一份新的
 * UTF-8 编码结果。
 */
export function stripLipSyncFromExpressionBytes(
  bytes: ArrayBuffer,
  lipSyncIds: readonly string[],
): ArrayBuffer {
  if (!bytes || bytes.byteLength === 0 || lipSyncIds.length === 0) return bytes
  let text: string
  try {
    text = new TextDecoder('utf-8').decode(bytes)
  } catch {
    return bytes
  }
  const stripped = stripLipSyncFromExpression(text, lipSyncIds)
  if (stripped === text) return bytes
  const encoded = new TextEncoder().encode(stripped)
  // TextEncoder 给的视图可能带偏移,交回一个干净的 ArrayBuffer
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

// ============================================================
// 表情名 → 菜单标签
// ============================================================

/**
 * 表情名来自每个模型的 `.exp3.json` 集合,词汇是开放的;随包的 Cubism 样例
 * 都从这一个小池子里取名。不认识的名字走「美化」而不是丢弃,这样第三方模型
 * 的菜单仍然可读。
 */
const EXPRESSION_LABELS: Record<string, { zh: string; en: string }> = {
  smile: { zh: '微笑', en: 'Smile' },
  happy: { zh: '开心', en: 'Happy' },
  'happy-01': { zh: '开心', en: 'Happy' },
  'happy-02': { zh: '大笑', en: 'Joyful' },
  angry: { zh: '生气', en: 'Angry' },
  sad: { zh: '难过', en: 'Sad' },
  surprise: { zh: '惊讶', en: 'Surprised' },
  surprised: { zh: '惊讶', en: 'Surprised' },
  scare: { zh: '受惊', en: 'Startled' },
  shy: { zh: '害羞', en: 'Shy' },
  blushing: { zh: '脸红', en: 'Blushing' },
  embarrass: { zh: '尴尬', en: 'Embarrassed' },
  coldness: { zh: '冷淡', en: 'Cool' }
}

/** `e-smile` / `happy-01` / `F03` → 能摆进菜单的字符串。 */
export function expressionLabel(name: string, lang: Lang): string {
  const key = String(name || '').trim()
  if (!key) return ''
  const known = EXPRESSION_LABELS[key.toLowerCase()]
  if (known) return known[lang] || known.en
  const cap = (part: string): string => (part ? part[0].toUpperCase() + part.slice(1) : part)
  const parts = key.replace(/^e[-_]/i, '').split(/[-_\s]+/).filter(Boolean)
  const words = parts.filter((part) => !/^\d+$/.test(part)).map(cap)
  // `F05` 根本没有词的部分;拆成 "F05 05" 比直接印模型自己的名字更蠢。
  if (!words.length) return cap(key)
  return [...words, ...parts.filter((part) => /^\d+$/.test(part))].join(' ')
}
