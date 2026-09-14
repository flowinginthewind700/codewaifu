import { describe, expect, it } from 'vitest'
import {
  expressionLabel,
  stripLipSyncFromExpression,
  stripLipSyncFromExpressionBytes
} from '../src/shared/expression'

// ============================================================
// 表情里的口型参数必须被剥掉。这条钉的是用户实测 bug:朗读时嘴一直全开、
// 开度不随声音变 —— HaruGreeter 的 happy 表情带 `ParamMouthOpenY: 1 / Add`,
// 说话时挂上它,每帧先 +1 再叠口型电平,参数上限 1 就把嘴钉死了。
// ============================================================

/** 真实 HaruGreeter e-happy-01.exp3.json 的形状(含眉毛/眼形/嘴)。 */
const HAPPY = JSON.stringify({
  Type: 'Live2D Expression',
  Parameters: [
    { Id: 'ParamBrowLY', Value: -1, Blend: 'Add' },
    { Id: 'ParamBrowRY', Value: -1, Blend: 'Add' },
    { Id: 'ParamMouthOpenY', Value: 1, Blend: 'Add' },
    { Id: 'ParamEyeForm', Value: 0.54, Blend: 'Add' }
  ]
})

const MOUTH = ['ParamMouthOpenY']

function paramsOf(json: string): Array<Record<string, unknown>> {
  return (JSON.parse(json).Parameters ?? []) as Array<Record<string, unknown>>
}

describe('stripLipSyncFromExpression', () => {
  it('drops the mouth parameter and keeps everything else in order', () => {
    const out = stripLipSyncFromExpression(HAPPY, MOUTH)
    expect(paramsOf(out).map((p) => p.Id)).toEqual(['ParamBrowLY', 'ParamBrowRY', 'ParamEyeForm'])
    expect(JSON.parse(out).Type).toBe('Live2D Expression')
  })

  it('drops every lip-sync id the model declares', () => {
    const json = JSON.stringify({
      Parameters: [
        { Id: 'ParamMouthOpenY', Value: 1, Blend: 'Add' },
        { Id: 'ParamMouthForm', Value: 0.5, Blend: 'Add' },
        { Id: 'ParamBrowLY', Value: -1, Blend: 'Add' }
      ]
    })
    const out = stripLipSyncFromExpression(json, ['ParamMouthOpenY', 'ParamMouthForm'])
    expect(paramsOf(out).map((p) => p.Id)).toEqual(['ParamBrowLY'])
  })

  it('leaves eye parameters alone: expressions are shaped by the eyes', () => {
    const json = JSON.stringify({
      Parameters: [
        { Id: 'ParamEyeLOpen', Value: 0.6, Blend: 'Multiply' },
        { Id: 'ParamMouthOpenY', Value: 1, Blend: 'Add' }
      ]
    })
    expect(paramsOf(stripLipSyncFromExpression(json, MOUTH)).map((p) => p.Id)).toEqual([
      'ParamEyeLOpen'
    ])
  })

  it('returns the identical string when nothing matches (no needless re-serialize)', () => {
    const json = JSON.stringify({ Parameters: [{ Id: 'ParamBrowLY', Value: -1, Blend: 'Add' }] })
    expect(stripLipSyncFromExpression(json, MOUTH)).toBe(json)
  })

  it('keeps an expression whose only parameter is the mouth, as an empty list', () => {
    const out = stripLipSyncFromExpression(
      JSON.stringify({ Type: 'Live2D Expression', Parameters: [{ Id: 'ParamMouthOpenY', Value: 1 }] }),
      MOUTH,
    )
    expect(paramsOf(out)).toEqual([])
  })

  it('is a no-op without ids', () => {
    expect(stripLipSyncFromExpression(HAPPY, [])).toBe(HAPPY)
  })

  it('passes through anything it cannot recognise', () => {
    // 解析失败 / Cubism 2 的 exp.json / 没有 Parameters 数组:一律原样返回,
    // 剥口型是优化,不该让一个怪文件把整个表情加载弄崩。
    expect(stripLipSyncFromExpression('not json{', MOUTH)).toBe('not json{')
    expect(stripLipSyncFromExpression('', MOUTH)).toBe('')
    const legacy = JSON.stringify({ PARAMS: [{ ID: 'PARAM_MOUTH_OPEN_Y', VAL: 1 }] })
    expect(stripLipSyncFromExpression(legacy, MOUTH)).toBe(legacy)
    const scalar = JSON.stringify({ Parameters: 'nope' })
    expect(stripLipSyncFromExpression(scalar, MOUTH)).toBe(scalar)
  })

  it('keeps odd entries it cannot read an id from', () => {
    const json = JSON.stringify({ Parameters: [null, 7, { Value: 1 }, { Id: 'ParamMouthOpenY' }] })
    expect(paramsOf(stripLipSyncFromExpression(json, MOUTH))).toEqual([null, 7, { Value: 1 }])
  })

  it('matches ids exactly (no substring, no case folding)', () => {
    const json = JSON.stringify({
      Parameters: [{ Id: 'ParamMouthOpenYExtra' }, { Id: 'parammouthopeny' }]
    })
    expect(stripLipSyncFromExpression(json, MOUTH)).toBe(json)
  })
})

describe('stripLipSyncFromExpressionBytes', () => {
  const encode = (text: string): ArrayBuffer => {
    const view = new TextEncoder().encode(text)
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
  }
  const decode = (bytes: ArrayBuffer): string => new TextDecoder('utf-8').decode(bytes)

  it('filters utf-8 bytes and stays valid json', () => {
    const out = stripLipSyncFromExpressionBytes(encode(HAPPY), MOUTH)
    expect(paramsOf(decode(out)).map((p) => p.Id)).not.toContain('ParamMouthOpenY')
    expect(out.byteLength).toBeGreaterThan(0)
  })

  it('hands back the very same buffer when there is nothing to strip', () => {
    const bytes = encode(JSON.stringify({ Parameters: [{ Id: 'ParamBrowLY' }] }))
    expect(stripLipSyncFromExpressionBytes(bytes, MOUTH)).toBe(bytes)
    expect(stripLipSyncFromExpressionBytes(bytes, [])).toBe(bytes)
  })

  it('survives empty input', () => {
    const empty = new ArrayBuffer(0)
    expect(stripLipSyncFromExpressionBytes(empty, MOUTH)).toBe(empty)
  })

  it('keeps non-ascii ids intact elsewhere in the file', () => {
    const json = JSON.stringify({
      名前: '笑顔',
      Parameters: [{ Id: 'ParamMouthOpenY', Value: 1 }, { Id: 'ParamBrowLY', Value: -1 }]
    })
    const out = decode(stripLipSyncFromExpressionBytes(encode(json), MOUTH))
    expect(JSON.parse(out).名前).toBe('笑顔')
    expect(paramsOf(out).map((p) => p.Id)).toEqual(['ParamBrowLY'])
  })
})

// ============================================================
// 表情菜单的标签。模型自带的名字(e-smile / happy-01 / F03)不能直接摆给用户
// 看,但也不能因为不认识就把整个表情丢掉 —— 第三方模型必须仍然有一份可读菜单。
// ============================================================
describe('expressionLabel', () => {
  it('localises the names the shipped Cubism models use', () => {
    expect(expressionLabel('smile', 'zh')).toBe('微笑')
    expect(expressionLabel('smile', 'en')).toBe('Smile')
    expect(expressionLabel('surprised', 'zh')).toBe('惊讶')
    expect(expressionLabel('coldness', 'en')).toBe('Cool')
  })

  it('matches case-insensitively, as model files are not consistent about it', () => {
    expect(expressionLabel('Smile', 'en')).toBe('Smile')
    expect(expressionLabel('HAPPY-01', 'zh')).toBe('开心')
  })

  it('prettifies unknown names instead of dropping them, keeping a numeric suffix', () => {
    expect(expressionLabel('e-joy', 'en')).toBe('Joy')
    expect(expressionLabel('happy-03', 'en')).toBe('Happy 03')
    expect(expressionLabel('F05', 'en')).toBe('F05')
    expect(expressionLabel('joy_02', 'en')).toBe('Joy 02')
  })

  it('never returns an empty label', () => {
    expect(expressionLabel('', 'en')).toBe('')
    expect(expressionLabel('  ', 'zh')).toBe('')
  })
})
