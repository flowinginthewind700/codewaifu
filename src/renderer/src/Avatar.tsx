import type { ReactElement } from 'react'
import type { Expression } from '@shared/ui'

interface AvatarProps {
  expression: Expression
  speaking: boolean
  scale: number
  imagePath: string
  imageMode: boolean
  /** Shrink for the chat layout, where the conversation owns the height. */
  compact?: boolean
}

/**
 * Built-in companion: a chibi head with headphones, drawn as inline SVG so it
 * stays crisp at any `scale` and needs no binary asset in the repo. Every
 * expression is a different eye/mouth pair on the same head geometry.
 */
export function Avatar({ expression, speaking, scale, imagePath, imageMode, compact }: AvatarProps): ReactElement {
  const size = compact ? Math.min(92, Math.round(132 * scale * 0.6)) : Math.round(132 * scale)

  if (imageMode && imagePath) {
    return (
      <img
        className="avatar-image"
        style={{ width: size, height: size }}
        src={toFileUrl(imagePath)}
        alt=""
        draggable={false}
      />
    )
  }

  const talking = speaking || expression === 'talk'

  return (
    <svg
      className={talking ? 'avatar speaking' : 'avatar'}
      style={{ width: size, height: size }}
      viewBox="0 0 132 132"
      role="img"
      aria-label="CodeWaifu companion"
    >
      <defs>
        <linearGradient id="cw-hair" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f290b4" />
          <stop offset="100%" stopColor="#c9548c" />
        </linearGradient>
        <linearGradient id="cw-band" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#59d7b3" />
          <stop offset="100%" stopColor="#4aa8d8" />
        </linearGradient>
      </defs>

      {/* hair mass behind the face */}
      <ellipse cx="66" cy="66" rx="44" ry="43" fill="url(#cw-hair)" />
      {/* side locks */}
      <ellipse cx="25" cy="78" rx="12" ry="26" fill="#d96ba0" />
      <ellipse cx="107" cy="78" rx="12" ry="26" fill="#d96ba0" />
      {/* face */}
      <ellipse cx="66" cy="72" rx="33" ry="31" fill="#ffe6d6" />
      {/* fringe */}
      <path
        d="M33 62 Q36 34 66 32 Q96 34 99 62 Q88 48 78 56 Q70 44 58 54 Q46 46 33 62 Z"
        fill="url(#cw-hair)"
      />
      {/* blush */}
      <ellipse cx="42" cy="82" rx="7" ry="4" fill="#ff96a0" opacity="0.55" />
      <ellipse cx="90" cy="82" rx="7" ry="4" fill="#ff96a0" opacity="0.55" />

      <Eyes expression={expression} />
      <Mouth expression={expression} talking={talking} />

      {expression === 'alert' && <path d="M100 46 l6 -9 l2 11 z" fill="#8fd8ff" opacity="0.85" />}

      {/* headphones: the "listening to your agents" motif */}
      <path d="M24 66 Q24 22 66 22 Q108 22 108 66" fill="none" stroke="url(#cw-band)" strokeWidth="7" strokeLinecap="round" />
      <rect x="12" y="58" width="20" height="30" rx="9" fill="#2b2436" stroke="#59d7b3" strokeWidth="2.5" />
      <rect x="100" y="58" width="20" height="30" rx="9" fill="#2b2436" stroke="#59d7b3" strokeWidth="2.5" />
      <circle cx="22" cy="73" r="3.4" fill="#ff7d96" />
      <circle cx="110" cy="73" r="3.4" fill="#ff7d96" />
    </svg>
  )
}

function Eyes({ expression }: { expression: Expression }): ReactElement {
  switch (expression) {
    case 'happy':
      return (
        <g stroke="#3a2f47" strokeWidth="3.4" strokeLinecap="round" fill="none">
          <path d="M47 70 q6 -7 12 0" />
          <path d="M73 70 q6 -7 12 0" />
        </g>
      )
    case 'sleepy':
      return (
        <g stroke="#3a2f47" strokeWidth="3.2" strokeLinecap="round" fill="none">
          <path d="M47 72 h12" />
          <path d="M73 72 h12" />
        </g>
      )
    case 'alert':
      return (
        <g className="eyes">
          <ellipse cx="53" cy="71" rx="7" ry="8.4" fill="#fff" />
          <ellipse cx="79" cy="71" rx="7" ry="8.4" fill="#fff" />
          <circle cx="53" cy="71" r="3.6" fill="#3a2f47" />
          <circle cx="79" cy="71" r="3.6" fill="#3a2f47" />
          <circle cx="54.6" cy="68.6" r="1.4" fill="#fff" />
          <circle cx="80.6" cy="68.6" r="1.4" fill="#fff" />
        </g>
      )
    default:
      return (
        <g className="eyes">
          <ellipse cx="53" cy="72" rx="5.6" ry="7.4" fill="#3a2f47" />
          <ellipse cx="79" cy="72" rx="5.6" ry="7.4" fill="#3a2f47" />
          <circle cx="55" cy="69" r="2" fill="#fff" opacity="0.92" />
          <circle cx="81" cy="69" r="2" fill="#fff" opacity="0.92" />
        </g>
      )
  }
}

function Mouth({ expression, talking }: { expression: Expression; talking: boolean }): ReactElement {
  if (talking) {
    return <ellipse className="mouth talking" cx="66" cy="88" rx="5.6" ry="5" fill="#b4556a" />
  }
  if (expression === 'happy') {
    return <path d="M59 85 q7 8 14 0" stroke="#b4556a" strokeWidth="3" strokeLinecap="round" fill="none" />
  }
  if (expression === 'alert') {
    return <ellipse className="mouth" cx="66" cy="88" rx="4" ry="4.6" fill="#b4556a" />
  }
  if (expression === 'sleepy') {
    return <path d="M61 88 q5 3 10 0" stroke="#b4556a" strokeWidth="2.6" strokeLinecap="round" fill="none" />
  }
  return <path d="M60 86 q6 5 12 0" stroke="#b4556a" strokeWidth="2.8" strokeLinecap="round" fill="none" />
}

/** Windows paths need a third slash; POSIX paths already start with one. */
function toFileUrl(path: string): string {
  if (/^file:\/\//i.test(path)) return path
  const normalized = path.replace(/\\/g, '/')
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`
}
