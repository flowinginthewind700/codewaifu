import { describe, expect, it } from 'vitest'
import {
  EMPTY_MEDIA,
  linuxMediaInvocation,
  macCommandScript,
  macStateScript,
  MAC_FIELD_SEP,
  MAC_PLAYERS,
  parseLinuxState,
  parseMacState,
  prettyApp,
  windowsMediaScript,
  type MediaCommand
} from '../src/shared/media'

const COMMANDS: MediaCommand[] = ['toggle', 'play', 'pause', 'next', 'previous']

describe('parseMacState', () => {
  const line = ['Spotify', 'playing', 'Song', 'Artist', 'Album'].join(MAC_FIELD_SEP)

  it('reads the five fields AppleScript returns', () => {
    expect(parseMacState(line)).toEqual({
      available: true,
      playing: true,
      app: 'Spotify',
      title: 'Song',
      artist: 'Artist',
      album: 'Album'
    })
  })

  it('treats anything but "playing" as paused', () => {
    expect(parseMacState(['Music', 'paused', 'a', 'b', 'c'].join(MAC_FIELD_SEP))?.playing).toBe(false)
    expect(parseMacState(['Music', 'PLAYING', '', '', ''].join(MAC_FIELD_SEP))?.playing).toBe(true)
  })

  it('tolerates a track with no metadata, which is what an ad looks like', () => {
    const state = parseMacState(['Spotify', 'playing'].join(MAC_FIELD_SEP))
    expect(state).toMatchObject({ available: true, playing: true, title: '', artist: '', album: '' })
  })

  it('returns null for no player at all, so the bar can say "nothing playing"', () => {
    expect(parseMacState('')).toBeNull()
    expect(parseMacState('   ')).toBeNull()
    expect(parseMacState(undefined as unknown as string)).toBeNull()
    expect(parseMacState('garbage without separators')).toBeNull()
  })
})

describe('macStateScript', () => {
  it('guards on "is running" so asking for state never launches the app', () => {
    for (const app of MAC_PLAYERS) {
      const script = macStateScript(app)
      expect(script).toContain(`if application "${app}" is running then`)
      expect(script.startsWith(`if application`)).toBe(true)
      expect(script).toContain('ASCII character 1')
      // player state is read before current track, or an empty queue throws.
      expect(script.indexOf('player state')).toBeLessThan(script.indexOf('current track'))
    }
  })

  it('prefers Spotify over Apple Music', () => {
    expect(MAC_PLAYERS[0]).toBe('Spotify')
  })
})

describe('macCommandScript', () => {
  it.each<[MediaCommand, string]>([
    ['toggle', 'playpause'],
    ['play', 'play'],
    ['pause', 'pause'],
    ['next', 'next track'],
    ['previous', 'previous track']
  ])('maps %s to the %s verb', (command, verb) => {
    const script = macCommandScript('Music', command)
    expect(script).toContain(`to ${verb}`)
    expect(script).toContain('is running')
  })
})

describe('parseLinuxState', () => {
  it('reads playerctl metadata output', () => {
    const raw = ['Playing', 'spotify', 'Song', 'Artist', 'Album'].join('\u0001')
    expect(parseLinuxState(raw)).toMatchObject({ available: true, playing: true, app: 'spotify', title: 'Song' })
  })

  it('returns null when playerctl reports no player', () => {
    expect(parseLinuxState('No player could be found')).toBeNull()
    expect(parseLinuxState('')).toBeNull()
  })

  it('maps the transport verbs', () => {
    expect(linuxMediaInvocation('state').args[0]).toBe('metadata')
    expect(linuxMediaInvocation('toggle').args).toEqual(['play-pause'])
    expect(linuxMediaInvocation('next').args).toEqual(['next'])
    expect(linuxMediaInvocation('previous').args).toEqual(['previous'])
  })
})

describe('windowsMediaScript', () => {
  const ps1 = windowsMediaScript()

  it('validates the action against the exact set the UI can send', () => {
    expect(ps1).toContain('ValidateSet("state"')
    for (const command of COMMANDS) expect(ps1).toContain(`"${command}"`)
  })

  it('emits compact JSON on stdout and never throws out of the script', () => {
    expect(ps1).toContain('ConvertTo-Json -Compress')
    expect(ps1).toContain('} catch {')
    expect(ps1).toContain('$ErrorActionPreference = "Stop"')
  })

  it('bridges the WinRT async calls, which PowerShell cannot await directly', () => {
    expect(ps1).toContain('AsTask')
    expect(ps1).toContain('GlobalSystemMediaTransportControlsSessionManager')
    expect(ps1).toContain('GetCurrentSession')
  })
})

describe('prettyApp', () => {
  it.each([
    ['com.spotify.client', 'Spotify'],
    ['Spotify.exe', 'Spotify'],
    ['com.apple.music', 'Music'],
    ['Music', 'Music'],
    ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'Chrome'],
    ['Microsoft.ZuneMusic_8wekyb3d8bbwe!App', 'Music'],
    ['msedge.exe', 'Edge'],
    ['/usr/lib/firefox', 'Firefox'],
    ['SomeUnknownPlayer', 'SomeUnknownPlayer'],
    ['', '']
  ])('turns %s into %s', (raw, label) => {
    expect(prettyApp(raw)).toBe(label)
  })
})

describe('EMPTY_MEDIA', () => {
  it('is the shape the bar renders before anything is detected', () => {
    expect(EMPTY_MEDIA).toEqual({ available: false, playing: false, app: '', title: '', artist: '', album: '' })
  })
})
