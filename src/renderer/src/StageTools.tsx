import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react'
import { Activity, PersonStanding, Shuffle, Smile } from 'lucide-react'
import { expressionLabel } from '@shared/expression'
import { motionMenuLabels } from '@shared/motion'
import type { Live2DMotionRef } from '@shared/live2dCatalog'
import type { Lang } from '@shared/protocol'
import type { Translate } from './i18n'

type Menu = 'expression' | 'motion' | null

interface StageToolsProps {
  t: Translate
  lang: Lang
  /** Empty for the image and built-in avatars: nothing to pick a face from. */
  expressions: readonly string[]
  /** Empty for every avatar but Live2D: only a real model ships motion files. */
  motions: readonly Live2DMotionRef[]
  onReport: () => void
  /** `null` asks for a random face. */
  onExpression: (name: string | null) => void
  /** `null` asks for a random gesture. */
  onMotion: (motion: Live2DMotionRef | null) => void
}

/**
 * The things you do *to* her rather than to your agents, kept off the status bar
 * (already full at 320px) and floating on the stage instead: ask for a spoken
 * status report, pick a face, or name an animation to play.
 *
 * It is `data-solid` so the click-through logic keeps the pointer here while
 * the rest of the stage stays transparent to whatever is underneath.
 */
export function StageTools({
  t,
  lang,
  expressions,
  motions,
  onReport,
  onExpression,
  onMotion
}: StageToolsProps): ReactElement {
  const [open, setOpen] = useState<Menu>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (name: string | null): void => {
    setOpen(null)
    onExpression(name)
  }

  const pickMotion = (motion: Live2DMotionRef | null): void => {
    setOpen(null)
    onMotion(motion)
  }

  const toggle = (which: Exclude<Menu, null>): void => setOpen((value) => (value === which ? null : which))

  // Motion names read `Emotion · Action`, so that menu is wider than the face
  // one; both are derived from the same language.
  const motionLabels = motionMenuLabels(motions, lang)

  return (
    <div className="stage-tools" data-solid="1" ref={rootRef}>
      {open === 'expression' ? (
        <div className="stage-menu" role="menu" aria-label={t('expression')}>
          <button className="stage-menu-item" type="button" role="menuitem" onClick={() => pick(null)}>
            <Shuffle size={12} strokeWidth={2.2} />
            <span>{t('expressionRandom')}</span>
          </button>
          <div className="stage-menu-sep" />
          {expressions.map((name) => (
            <button
              className="stage-menu-item"
              type="button"
              role="menuitem"
              key={name}
              onClick={() => pick(name)}
            >
              <Smile size={12} strokeWidth={2.2} />
              <span>{expressionLabel(name, lang)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {open === 'motion' ? (
        <div className="stage-menu" data-wide="1" role="menu" aria-label={t('motion')}>
          <button className="stage-menu-item" type="button" role="menuitem" onClick={() => pickMotion(null)}>
            <Shuffle size={12} strokeWidth={2.2} />
            <span>{t('motionRandom')}</span>
          </button>
          <div className="stage-menu-sep" />
          {motions.map((motion, at) => (
            <Fragment key={`${motion.group}-${motion.index}`}>
              {/* One model registers several groups (Idle / TapBody); a hairline
                  between them keeps a 28-row list scannable. */}
              {at > 0 && motion.group !== motions[at - 1].group ? <div className="stage-menu-sep" /> : null}
              <button className="stage-menu-item" type="button" role="menuitem" onClick={() => pickMotion(motion)}>
                <PersonStanding size={12} strokeWidth={2.2} />
                <span title={motionLabels[at]}>{motionLabels[at]}</span>
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
      <button
        className="icon-btn"
        type="button"
        title={t('reportAria')}
        aria-label={t('reportAria')}
        onClick={onReport}
      >
        <Activity size={14} strokeWidth={2.2} />
      </button>
      {expressions.length ? (
        <button
          className="icon-btn"
          type="button"
          title={t('expression')}
          aria-label={t('expression')}
          aria-haspopup="menu"
          aria-expanded={open === 'expression'}
          data-on={open === 'expression' ? '1' : undefined}
          onClick={() => toggle('expression')}
        >
          <Smile size={14} strokeWidth={2.2} />
        </button>
      ) : null}
      {motions.length ? (
        <button
          className="icon-btn"
          type="button"
          title={t('motion')}
          aria-label={t('motion')}
          aria-haspopup="menu"
          aria-expanded={open === 'motion'}
          data-on={open === 'motion' ? '1' : undefined}
          onClick={() => toggle('motion')}
        >
          <PersonStanding size={14} strokeWidth={2.2} />
        </button>
      ) : null}
    </div>
  )
}
