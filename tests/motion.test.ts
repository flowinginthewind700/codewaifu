import { describe, expect, it } from 'vitest'
import { motionKey, motionLabel, motionMenuLabels } from '../src/shared/motion'
import { LIVE2D_CATALOG } from '../src/shared/live2dCatalog'

// ============================================================
// motion 名字 → 菜单标签。钉两件事:
//   1. 随包角色(HaruGreeter / Mao)的**每一条** motion 在英文界面都有人工译名,
//      不会回落到 `Tap Body 4` 这种序号兜底 —— 菜单是用户直接看的文案。
//   2. 兜底路径本身可用:第三方模型的怪名字既不能印中文方块字,也不能空着。
// ============================================================

const shipped = LIVE2D_CATALOG.characters.flatMap((character) =>
  character.motions.map((motion) => ({ ...motion, character: character.id })),
)

describe('motionLabel', () => {
  it('covers every shipped motion with a hand-written English name', () => {
    expect(shipped.length).toBeGreaterThan(0)
    // 兜底名长得像美化过的 slug(`Tap Body 12`,无分隔点);人工译名一律是
    // `Emotion · Action`,所以这一条同时钉住了「没有一条掉进兜底」。
    for (const motion of shipped) {
      const en = motionLabel(motion.slug, motion.label, 'en')
      expect(`${motion.character} ${motion.label} → ${en}`).toContain(' · ')
      expect(motionLabel(motion.slug, motion.label, 'zh')).not.toContain('.motion3')
    }
  })

  it('numbers the repeated ones so every menu row is clickable-distinct', () => {
    for (const character of LIVE2D_CATALOG.characters) {
      for (const lang of ['zh', 'en'] as const) {
        const names = motionMenuLabels(character.motions, lang)
        expect(new Set(names).size).toBe(names.length)
        expect(names.every((name) => name.length > 0)).toBe(true)
      }
    }
    // HaruGreeter 把 `微笑-正常` 同时登记成 Idle 0 与 TapBody 7
    const haru = LIVE2D_CATALOG.characters.find((character) => character.id === 'HaruGreeter')!
    const zh = motionMenuLabels(haru.motions, 'zh')
    expect(zh.filter((name) => name.startsWith('微笑 · 正常'))).toEqual(['微笑 · 正常', '微笑 · 正常 2'])
  })

  it('beautifies the Chinese original instead of showing a filename', () => {
    expect(motionKey('微笑-向前深鞠躬.motion3')).toBe('微笑-向前深鞠躬')
    expect(motionLabel('m-tapbody-04.motion3.json', '微笑-向前深鞠躬.motion3', 'zh')).toBe('微笑 · 向前深鞠躬')
    expect(motionLabel('m-tapbody-04.motion3.json', '微笑-向前深鞠躬.motion3', 'en')).toBe('Smile · Deep bow')
  })

  it('keeps a Chinese label that has no separator as-is', () => {
    expect(motionLabel('m-idle-00.motion3.json', '待机.motion3', 'zh')).toBe('待机')
  })

  it('falls back to a prettified slug for unknown third-party motions', () => {
    expect(motionLabel('m-tapbody-12.motion3.json', '奇怪的自定义动作.motion3', 'en')).toBe('Tap Body 12')
    expect(motionLabel('motions/wave_hands.motion3.json', '', 'en')).toBe('Wave Hands')
    expect(motionLabel('m-taphead-01.motion3.json', '点头.motion3', 'en')).toBe('Tap Head 1')
  })

  it('gives up to an empty label only when there is nothing to name', () => {
    expect(motionLabel('', '', 'en')).toBe('')
    expect(motionLabel('', '待机', 'en').length).toBeGreaterThan(0)
  })
})
