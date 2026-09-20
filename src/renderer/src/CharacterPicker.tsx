import { useEffect, useRef, type ReactElement } from 'react'
import { Check } from 'lucide-react'
import { LIVE2D_CATALOG, type Live2DCharacter } from '@shared/live2dCatalog'
import type { Lang } from '@shared/protocol'
import type { Translate } from './i18n'
import { assetUrl } from './live2d/assets'

interface Props {
  t: Translate
  lang: Lang
  /** Id of the character she is wearing right now. */
  selected: string
  onPick: (id: string) => void
  onClose: () => void
}

/**
 * The liquid-glass sheet for choosing who she is.
 *
 * The face and motion menus live on the stage because they are two columns of
 * short rows; a character is a portrait plus a line about her, and eight of
 * them do not fit anywhere near the 24px buttons that open the other menus.
 * So this one covers the card instead: two columns of thumbs, the current one
 * ticked, Esc or the backdrop closes it. It is rendered inside `.card` (which
 * is `position: relative` and clips), so it can never escape the widget.
 */
export function CharacterPicker({ t, lang, selected, onPick, onClose }: Props): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // The thumbs are the point of a picker: land the focus inside the sheet so
    // the first Tab reaches a character, not the stage behind it.
    rootRef.current?.querySelector<HTMLButtonElement>('button[data-char]')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // `data-solid` on the root, not the sheet: while the picker is open the
    // whole card must catch the pointer (the backdrop closes it), and on
    // Linux main shapes the window's input region from these boxes.
    <div className="char-picker" data-solid="1" role="dialog" aria-modal="true" aria-label={t('character')} ref={rootRef}>
      <button className="char-picker-backdrop" type="button" aria-label={t('characterClose')} onClick={onClose} />
      <div className="char-picker-sheet">
        <div className="char-picker-head">
          <span>{t('character')}</span>
          <span className="char-picker-count">{LIVE2D_CATALOG.characters.length}</span>
        </div>
        <div className="char-picker-grid">
          {LIVE2D_CATALOG.characters.map((character: Live2DCharacter) => {
            const isOn = character.id === selected
            return (
              <button
                key={character.id}
                type="button"
                data-char="1"
                className="char-picker-item"
                aria-pressed={isOn}
                title={lang === 'zh' ? character.blurbZh : character.blurbEn}
                onClick={() => onPick(character.id)}
              >
                {character.thumbUrl ? (
                  <img src={assetUrl(character.thumbUrl)} alt="" draggable={false} loading="lazy" />
                ) : (
                  <span className="char-picker-fallback" />
                )}
                <span className="char-picker-name">{lang === 'zh' ? character.labelZh : character.labelEn}</span>
                {isOn ? <Check size={11} strokeWidth={2.4} className="char-picker-tick" /> : null}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
