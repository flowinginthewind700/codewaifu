import zlib from 'node:zlib'

export type Rgba = [number, number, number, number]

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let crcTable: Int32Array | null = null

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * Minimal RGBA PNG encoder. Shipping the icon generator instead of a binary
 * asset keeps the repo text-only and lets the tray icon be produced at runtime
 * at whatever size the platform wants.
 */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgba): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y)
      raw[offset] = clampByte(r)
      raw[offset + 1] = clampByte(g)
      raw[offset + 2] = clampByte(b)
      raw[offset + 3] = clampByte(a)
      offset += 4
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}

type Painter = (x: number, y: number) => Rgba | null

function compose(painters: Painter[]): (x: number, y: number) => Rgba {
  return (x, y) => {
    let color: Rgba = [0, 0, 0, 0]
    for (const paint of painters) {
      const next = paint(x, y)
      if (!next) continue
      color = over(next, color)
    }
    return color
  }
}

/** Source-over compositing, straight alpha. */
function over(src: Rgba, dst: Rgba): Rgba {
  const sa = src[3] / 255
  const da = dst[3] / 255
  const outA = sa + da * (1 - sa)
  if (outA <= 0) return [0, 0, 0, 0]
  const channel = (i: number): number => (src[i] * sa + dst[i] * da * (1 - sa)) / outA
  return [channel(0), channel(1), channel(2), outA * 255]
}

function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: Rgba,
  softness = 1
): Painter {
  return (x, y) => {
    const dx = (x + 0.5 - cx) / rx
    const dy = (y + 0.5 - cy) / ry
    const d = Math.sqrt(dx * dx + dy * dy)
    const edge = softness / Math.max(rx, ry)
    if (d > 1 + edge) return null
    const alpha = d <= 1 - edge ? 1 : Math.max(0, Math.min(1, (1 + edge - d) / (2 * edge)))
    return [color[0], color[1], color[2], color[3] * alpha]
  }
}

/**
 * The CodeWaifu mark: a chibi head on a rounded tile. Drawn with signed
 * distances so it stays crisp from a 16px tray icon up to a 512px app icon.
 */
export function paintWaifuIcon(size: number): (x: number, y: number) => Rgba {
  const u = size / 64
  const tile = (x: number, y: number): Rgba | null => {
    const r = 14 * u
    const minX = 2 * u
    const maxX = size - 2 * u
    const minY = 2 * u
    const maxY = size - 2 * u
    if (x < minX || x >= maxX || y < minY || y >= maxY) return null
    const cx = Math.max(minX + r, Math.min(x + 0.5, maxX - r))
    const cy = Math.max(minY + r, Math.min(y + 0.5, maxY - r))
    const dx = x + 0.5 - cx
    const dy = y + 0.5 - cy
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > r + u) return null
    const alpha = d <= r - u ? 1 : Math.max(0, (r + u - d) / (2 * u))
    // Deep teal to plum, so the icon is not one flat hue.
    const t = (y - minY) / Math.max(1, maxY - minY)
    const top: Rgba = [24, 62, 82, 255]
    const bottom: Rgba = [62, 28, 74, 255]
    const mix = (a: number, b: number): number => a + (b - a) * t
    return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2]), 255 * alpha]
  }

  const painters: Painter[] = [
    tile,
    // hair back
    ellipse(32 * u, 30 * u, 21 * u, 20 * u, [236, 122, 168, 255], u),
    // face
    ellipse(32 * u, 34 * u, 16 * u, 15 * u, [255, 228, 214, 255], u),
    // fringe
    (x, y) => {
      const dx = (x + 0.5 - 32 * u) / (20 * u)
      const dy = (y + 0.5 - 24 * u) / (16 * u)
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > 1) return null
      if (y > 30 * u) return null
      return [236, 122, 168, 255]
    },
    // side locks
    ellipse(13 * u, 38 * u, 6 * u, 12 * u, [226, 104, 154, 255], u),
    ellipse(51 * u, 38 * u, 6 * u, 12 * u, [226, 104, 154, 255], u),
    // eyes
    ellipse(25 * u, 36 * u, 3.1 * u, 4.2 * u, [38, 32, 54, 255], u * 0.8),
    ellipse(39 * u, 36 * u, 3.1 * u, 4.2 * u, [38, 32, 54, 255], u * 0.8),
    ellipse(26 * u, 34.6 * u, 1.1 * u, 1.3 * u, [255, 255, 255, 235], u * 0.6),
    ellipse(40 * u, 34.6 * u, 1.1 * u, 1.3 * u, [255, 255, 255, 235], u * 0.6),
    // blush
    ellipse(20 * u, 41 * u, 3.4 * u, 2 * u, [255, 150, 160, 150], u),
    ellipse(44 * u, 41 * u, 3.4 * u, 2 * u, [255, 150, 160, 150], u),
    // mouth
    ellipse(32 * u, 43.5 * u, 1.6 * u, 1.1 * u, [190, 90, 100, 220], u * 0.6)
  ]
  return compose(painters)
}

/**
 * 3x5 bitmaps for the ten digits and a plus. A tray badge is drawn at 22-32px,
 * where a font is both unavailable and illegible, so the glyphs are pixels.
 */
const DIGIT_ROWS: Readonly<Record<string, readonly string[]>> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
}

/** The badge string for a count: '' hides it, ten and up collapse to '9+'. */
export function badgeDigits(count: number): string {
  const n = Math.trunc(Number(count))
  if (!Number.isFinite(n) || n <= 0) return ''
  return n > 9 ? '9+' : String(n)
}
/**
 * Below this icon size a digit is one pixel wide and reads as a smudge, so the
 * badge becomes a plain dot: the tray still says "something needs you" and the
 * tooltip carries the number. Drawing unreadable glyphs is worse than none.
 */
const BADGE_TEXT_MIN = 40

/** Red disc, white ring, white digits, bottom-right corner. */
export function paintBadge(size: number, label: string): Painter {
  const r = size * 0.26
  const cx = size - r - size * 0.03
  const cy = size - r - size * 0.03
  const soft = Math.max(0.6, size / 64)
  const glyph = size >= BADGE_TEXT_MIN ? label : ''
  const cell = glyph ? Math.max(1, Math.floor((r * 1.5) / (glyph.length * 3 + 2))) : 0
  const step = cell * 4
  const textW = glyph ? glyph.length * step - cell : 0
  const originX = cx - textW / 2
  const originY = cy - (cell * 5) / 2

  const digits: Painter = (x, y) => {
    if (!glyph || cell <= 0) return null
    const col = Math.floor((x + 0.5 - originX) / cell)
    const row = Math.floor((y + 0.5 - originY) / cell)
    if (row < 0 || row > 4 || col < 0) return null
    const at = Math.floor(col / 4)
    if (at >= glyph.length) return null
    const rows = DIGIT_ROWS[glyph[at]]
    if (!rows || rows[row][col - at * 4] !== '1') return null
    return [255, 255, 255, 255]
  }

  return compose([
    ellipse(cx, cy, r + soft * 1.6, r + soft * 1.6, [255, 255, 255, 235], soft),
    ellipse(cx, cy, r, r, [226, 68, 78, 255], soft),
    digits
  ])
}

/**
 * The tray/app icon, with the live attention count composited on when there is
 * one. One function, so the badge and the mark cannot disagree about the corner
 * they share.
 */
export function waifuIconPng(size: number, badge = 0): Buffer {
  const base = paintWaifuIcon(size)
  const label = badgeDigits(badge)
  if (!label) return encodePng(size, size, base)
  return encodePng(size, size, compose([base, paintBadge(size, label)]))
}
