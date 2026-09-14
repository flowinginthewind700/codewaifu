import type { ReactElement } from 'react'
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import type { MediaCommand, MediaState } from '@shared/media'

interface MediaBarProps {
  media: MediaState
  onCommand: (command: MediaCommand) => void
  unavailableText: string
}

/**
 * Transport controls for whatever currently owns the system media session
 * (Music/Spotify on macOS, SMTC on Windows, playerctl on Linux). Buttons stay
 * a fixed size so a long track title can never reflow the bar.
 */
export function MediaBar({ media, onCommand, unavailableText }: MediaBarProps): ReactElement {
  if (!media.available) {
    return (
      <div className="media" data-solid="1">
        <span className="media-unavailable">{unavailableText}</span>
      </div>
    )
  }

  return (
    <div className="media" data-solid="1">
      <button
        className="icon-btn"
        type="button"
        title="Previous track"
        aria-label="Previous track"
        onClick={() => onCommand('previous')}
      >
        <SkipBack size={15} strokeWidth={2.2} />
      </button>
      <button
        className="icon-btn primary"
        type="button"
        title={media.playing ? 'Pause' : 'Play'}
        aria-label={media.playing ? 'Pause' : 'Play'}
        onClick={() => onCommand('toggle')}
      >
        {media.playing ? <Pause size={16} strokeWidth={2.4} /> : <Play size={16} strokeWidth={2.4} />}
      </button>
      <button
        className="icon-btn"
        type="button"
        title="Next track"
        aria-label="Next track"
        onClick={() => onCommand('next')}
      >
        <SkipForward size={15} strokeWidth={2.2} />
      </button>
      <div className="media-text">
        <span className="media-title" title={media.title}>
          {media.title || '—'}
        </span>
        <span className="media-artist" title={media.artist}>
          {[media.artist, media.app].filter(Boolean).join(' · ') || '—'}
        </span>
      </div>
    </div>
  )
}
