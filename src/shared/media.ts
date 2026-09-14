export type MediaCommand = 'toggle' | 'play' | 'pause' | 'next' | 'previous'

export interface MediaState {
  /** False when no controllable player was found. */
  available: boolean
  playing: boolean
  /** Human name of the app that owns the session, e.g. "Spotify". */
  app: string
  title: string
  artist: string
  album: string
  /** Raw error text, surfaced in the panel so failures are debuggable. */
  error?: string
}

export const EMPTY_MEDIA: MediaState = {
  available: false,
  playing: false,
  app: '',
  title: '',
  artist: '',
  album: ''
}

/**
 * macOS AppleScript per player. `tell application` would launch the app, so
 * every script is guarded by `is running` and the caller only asks players it
 * already saw running.
 */
export function macStateScript(app: 'Music' | 'Spotify'): string {
  return [
    `if application "${app}" is running then`,
    `  tell application "${app}"`,
    '    set s to player state as string',
    '    if s is "playing" or s is "paused" then',
    '      set t to ""',
    '      set a to ""',
    '      set al to ""',
    '      try',
    '        set t to name of current track',
    '        set a to artist of current track',
    '        set al to album of current track',
    '      end try',
    // AppleScript has no \u escapes, so build the separator from its char code.
    '      set sep to (ASCII character 1)',
    `      return "${app}" & sep & s & sep & t & sep & a & sep & al`,
    '    end if',
    '  end tell',
    'end if',
    'return ""'
  ].join('\n')
}

const MAC_VERB: Record<MediaCommand, string> = {
  toggle: 'playpause',
  play: 'play',
  pause: 'pause',
  next: 'next track',
  previous: 'previous track'
}

export function macCommandScript(app: 'Music' | 'Spotify', command: MediaCommand): string {
  return [
    `if application "${app}" is running then`,
    `  tell application "${app}" to ${MAC_VERB[command]}`,
    'end if',
    'return "ok"'
  ].join('\n')
}

export const MAC_PLAYERS: Array<'Music' | 'Spotify'> = ['Spotify', 'Music']

export const MAC_FIELD_SEP = '\u0001'

export function parseMacState(raw: string): MediaState | null {
  const text = String(raw || '').trim()
  if (!text) return null
  const [app, state, title, artist, album] = text.split(MAC_FIELD_SEP)
  if (!app || !state) return null
  return {
    available: true,
    playing: state.toLowerCase() === 'playing',
    app,
    title: (title || '').trim(),
    artist: (artist || '').trim(),
    album: (album || '').trim()
  }
}

/**
 * Windows: the System Media Transport Controls session manager is the only
 * cross-app way to drive whatever holds the media session (Spotify, Media
 * Player, browsers, ...). WinRT calls are async, so the script needs the
 * AsTask bridge. One script serves every action via `-Action`; `-Action state`
 * emits a single line of JSON on stdout.
 */
export function windowsMediaScript(): string {
  return [
    'param([ValidateSet("state","toggle","play","pause","next","previous")][string]$Action = "state")',
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'function Emit($obj) { Write-Output ($obj | ConvertTo-Json -Compress) }',
    'try {',
    '  Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
    "    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'",
    '  })[0]',
    '  function Await($WinRtTask, $ResultType) {',
    '    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)',
    '    $netTask = $asTask.Invoke($null, @($WinRtTask))',
    '    $netTask.Wait(-1) | Out-Null',
    '    $netTask.Result',
    '  }',
    '  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null',
    '  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
    '  $session = $manager.GetCurrentSession()',
    '  if (-not $session) { Emit ([ordered]@{ available = $false }); exit 0 }',
    '  switch ($Action) {',
    '    "state" {',
    '      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])',
    '      $info = $session.GetPlaybackInfo()',
    '      $status = if ($info) { $info.PlaybackStatus.ToString() } else { "Closed" }',
    '      Emit ([ordered]@{',
    '        available = $true',
    '        playing   = ($status -eq "Playing")',
    '        app       = [string]$session.SourceAppUserModelId',
    '        title     = [string]$props.Title',
    '        artist    = [string]$props.Artist',
    '        album     = [string]$props.AlbumTitle',
    '      })',
    '    }',
    '    "toggle"   { $null = Await ($session.TryTogglePlayPauseAsync()) ([System.Boolean]) }',
    '    "play"     { $null = Await ($session.TryPlayAsync()) ([System.Boolean]) }',
    '    "pause"    { $null = Await ($session.TryPauseAsync()) ([System.Boolean]) }',
    '    "next"     { $null = Await ($session.TrySkipNextAsync()) ([System.Boolean]) }',
    '    "previous" { $null = Await ($session.TrySkipPreviousAsync()) ([System.Boolean]) }',
    '  }',
    '} catch {',
    '  Emit ([ordered]@{ available = $false; error = ([string]$_.Exception.Message) })',
    '}',
    ''
  ].join('\r\n')
}

/** Linux: playerctl speaks MPRIS for essentially every desktop player. */
export function linuxMediaInvocation(
  action: MediaCommand | 'state'
): { cmd: string; args: string[] } {
  if (action === 'state') {
    return {
      cmd: 'playerctl',
      args: [
        'metadata',
        '--format',
        '{{status}}\u0001{{playerName}}\u0001{{title}}\u0001{{artist}}\u0001{{album}}'
      ]
    }
  }
  const verb: Record<MediaCommand, string> = {
    toggle: 'play-pause',
    play: 'play',
    pause: 'pause',
    next: 'next',
    previous: 'previous'
  }
  return { cmd: 'playerctl', args: [verb[action]] }
}

export function parseLinuxState(raw: string): MediaState | null {
  const text = String(raw || '').replace(/\s+$/, '')
  if (!text || /no player/i.test(text)) return null
  const [status, app, title, artist, album] = text.split('\u0001')
  if (!status) return null
  return {
    available: true,
    playing: status.toLowerCase() === 'playing',
    app: (app || '').trim(),
    title: (title || '').trim(),
    artist: (artist || '').trim(),
    album: (album || '').trim()
  }
}

/** Trim an app user model id / bundle id down to something readable. */
export function prettyApp(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  const tail = text.split(/[\\/]/).pop() || text
  const cleaned = tail.replace(/\.exe$/i, '').replace(/!.*$/, '')
  const known: Record<string, string> = {
    spotify: 'Spotify',
    music: 'Music',
    itunes: 'iTunes',
    'com.apple.music': 'Music',
    'com.spotify.client': 'Spotify',
    chrome: 'Chrome',
    msedge: 'Edge',
    firefox: 'Firefox'
  }
  const key = cleaned.toLowerCase()
  if (known[key]) return known[key]
  for (const [needle, label] of Object.entries(known)) {
    if (key.includes(needle)) return label
  }
  return cleaned
}
