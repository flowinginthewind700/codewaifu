// Live2D motion 名字 → 菜单标签。
//
// 与 expression.ts 同构的一层:motion 的原始名字是 Cubism 样例自带的中文文件名
// (`微笑-向前深鞠躬.motion3`),直接摆进英文界面就成了乱码般的方块字;而 slug
// (`m-tapbody-04.motion3.json`)是生成器编的序号,对用户毫无信息量。所以中文走
// 「去扩展名 + 分隔符美化」,英文走一张人工译名表,查不到的才回落到美化 slug。
//
// 这层是纯字符串函数,不碰 Cubism Framework(host.ts 那 720KB 在 vitest 里起不来),
// 所以能在单测里直接钉住全部 49 条 shipped 动作的译名。

import type { Lang } from './protocol'

/** 菜单只关心「叫什么」和「播哪一条」,所以入参收窄成这两个字段。 */
export type MotionLike = { slug: string; label: string }

/** 原始标签里的扩展名尾巴:`.motion3` / `.motion3.json` / `.json`。 */
const EXTENSION = /\.(motion3(\.json)?|json)$/i

/** 中文原名 → 英文译名。键是 `motionKey()` 的结果(去扩展名、去首尾空白)。 */
const MOTION_LABELS_EN: Record<string, string> = {
  '微笑-正常': 'Smile · Neutral',
  '俏皮-微微摇头': 'Playful · Slight head shake',
  '否定-微微摇头': 'Deny · Slight head shake',
  '否定-摆双手摇头': 'Deny · Wave both hands',
  '微笑-向前浅鞠躬': 'Smile · Shallow bow',
  '微笑-向前深鞠躬': 'Smile · Deep bow',
  '微笑-抬手往右指引': 'Smile · Point right',
  '微笑-抬手往左指引': 'Smile · Point left',
  '微笑-点头': 'Smile · Nod',
  '微笑-背手点头': 'Smile · Nod, hands behind',
  '惊吓-往后一仰': 'Startled · Lean back',
  '惊吓-闭眼张开双手后瞪眼': 'Startled · Hands up, then stare',
  '惊讶-叉手张嘴点头': 'Surprised · Arms crossed, mouth open',
  '惊讶-双手放开': 'Surprised · Hands released',
  '惊讶-张开双手点头': 'Surprised · Open-arms nod',
  '无奈-叉手点头': 'Resigned · Arms-crossed nod',
  '生气-被惊后埋头看地': 'Angry · Head down after a startle',
  '疑惑-张开双手定睛狠狠往前一看': 'Puzzled · Open arms, sharp look',
  '疑惑-张开双手定睛轻微往前一看': 'Puzzled · Open arms, slight look',
  '疑虑-手放嘴角': 'Doubtful · Hand at mouth',
  '脸红-眯眼埋头': 'Blushing · Eyes closed, head down',
  '脸红-眯眼笑': 'Blushing · Squinted smile',
  '脸红-身体往前倾': 'Blushing · Lean forward',
  '难过-双手放胸前': 'Sad · Hands on chest',
  '难过-睁眼瘪嘴': 'Sad · Wide eyes, pouting',
  '高兴-左右摇摆': 'Happy · Sway side to side',
  '高兴-身体前倾眯眼': 'Happy · Lean forward, squint',
  '微笑-看着你': 'Smile · Looking at you',
  '画画成功-爱心': 'Success · Heart hands',
  '画画失败-爱心': 'Failure · Heart hands',
  '微笑-挥动双手': 'Smile · Wave both hands',
  // v1 bundle, second wave (Hiyori / Chitose / Tsumiki / Epsilon / Hibiki / Rice)
  '难过-皱眉': 'Sad · Frown',
  '无聊-抬头望天摇摆': 'Bored · Look up and sway',
  '微笑-向左指引': 'Smile · Point left',
  '打招呼-挥手': 'Greet · Wave',
  '微笑-插单手': 'Smile · Hand on hip',
  '微笑-眨眼': 'Smile · Blink',
  '微笑-平淡': 'Smile · Composed',
  '生气-叉手': 'Angry · Arms crossed',
  '生气-皱眉': 'Angry · Frown',
  '生气-转无辜': 'Angry · Then innocent',
  '平淡': 'Calm · Still',
  '魔法-书点火': 'Magic · Light the book',
  '魔法-小能量攻击': 'Magic · Small blast',
  '魔法-大能量攻击': 'Magic · Big blast'
}

/** Cubism 惯例的分组名,美化 slug 时拆成两个词读着才像人话。 */
const SLUG_TOKENS: Record<string, string> = {
  tapbody: 'Tap Body',
  taphead: 'Tap Head',
  flickhead: 'Flick Head',
  pinchin: 'Pinch In',
  pinchout: 'Pinch Out',
  idle: 'Idle'
}

const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

/** `微笑-向前深鞠躬.motion3` → `微笑-向前深鞠躬`(查表与展示共用的键)。 */
export function motionKey(originalLabel: string): string {
  return String(originalLabel || '').trim().replace(EXTENSION, '')
}

/** 美化 slug:`m-tapbody-04.motion3.json` → `Tap Body 4`。 */
function prettifySlug(slug: string): string {
  const raw = String(slug || '').trim().replace(EXTENSION, '')
  // 第三方模型常带目录前缀(`motions/hand/wave`),目录名不是动作名
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1)
  const parts = base.split(/[-_.\s]+/).filter(Boolean)
  const words = parts
    // 生成器给每条 motion 加的 `m` 前缀不携带信息
    .filter((part) => part.toLowerCase() !== 'm')
    .map((part) => {
      const known = SLUG_TOKENS[part.toLowerCase()]
      if (known) return known
      // `04` → `4`:序号是从 0 编的,但菜单里显示 `04` 看着像文件名而不是条目
      if (/^\d+$/.test(part)) return String(Number(part))
      return cap(part)
    })
  return words.join(' ')
}

/**
 * 一条 motion 在菜单里的显示名。
 *
 * @param slug          生成器给的文件名(第三方模型的兜底信息来源)
 * @param originalLabel 模型自带的原始(中文)名
 */
export function motionLabel(slug: string, originalLabel: string, lang: Lang): string {
  const key = motionKey(originalLabel)
  if (!key) return prettifySlug(slug)
  if (lang === 'zh') return key.replace('-', ' · ')
  const known = MOTION_LABELS_EN[key]
  if (known) return known
  // 未收录的第三方动作:英文界面宁可给一个「Tap Body 12」也不印中文方块字。
  return prettifySlug(slug) || cap(key)
}

/**
 * 一整个菜单的标签,保证**逐条唯一**。
 *
 * 同一段动作可以被模型登记进多个分组(HaruGreeter 的 `微笑-正常` 同时是 Idle 0
 * 和 TapBody 7,两份是不同的文件),菜单里出现两行一模一样的名字就没法点了 ——
 * 重名的第二条起加 `2` / `3` 序号,比印 Cubism 的分组术语好懂。
 */
export function motionMenuLabels(motions: readonly MotionLike[], lang: Lang): string[] {
  const seen = new Map<string, number>()
  return motions.map((motion) => {
    const base = motionLabel(motion.slug, motion.label, lang)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base} ${count}`
  })
}
