import { describe, expect, it } from 'vitest'
import { desktopPresence } from '../src/shared/desktopPresence'

describe('desktopPresence', () => {
  it('keeps the macOS Dock even when the status item is constructed', () => {
    expect(desktopPresence({ platform: 'darwin', trayCreated: true })).toEqual({
      mode: 'dock',
      hideFromTaskbar: false,
      macActivationPolicy: 'regular',
      keepAliveWithoutWindows: true,
      reason: 'tray-ready'
    })
  })

  it('keeps the macOS Dock when the status item cannot be made', () => {
    expect(desktopPresence({ platform: 'darwin', trayCreated: false })).toEqual({
      mode: 'dock',
      hideFromTaskbar: false,
      macActivationPolicy: 'regular',
      keepAliveWithoutWindows: true,
      reason: 'tray-construction-failed'
    })
  })

  it('never lets a macOS Tray object become the only observable entry', () => {
    for (const trayCreated of [false, true]) {
      const presence = desktopPresence({ platform: 'darwin', trayCreated })
      expect(presence.mode).toBe('dock')
      expect(presence.hideFromTaskbar).toBe(false)
      expect(presence.macActivationPolicy).toBe('regular')
    }
  })

  it('uses a Windows tray without retaining a destroyed window lifecycle', () => {
    expect(desktopPresence({ platform: 'win32', trayCreated: true })).toEqual({
      mode: 'tray',
      hideFromTaskbar: true,
      macActivationPolicy: null,
      keepAliveWithoutWindows: false,
      reason: 'tray-ready'
    })
  })

  it('puts a tray-less Windows window back on the taskbar', () => {
    expect(desktopPresence({ platform: 'win32', trayCreated: false })).toEqual({
      mode: 'taskbar',
      hideFromTaskbar: false,
      macActivationPolicy: null,
      keepAliveWithoutWindows: false,
      reason: 'tray-construction-failed'
    })
  })

  it('does not mistake a Linux Tray object for a visible icon', () => {
    expect(
      desktopPresence({
        platform: 'linux',
        trayCreated: true,
        statusNotifierHost: false
      })
    ).toEqual({
      mode: 'taskbar',
      hideFromTaskbar: false,
      macActivationPolicy: null,
      keepAliveWithoutWindows: false,
      reason: 'linux-no-status-notifier'
    })
  })

  it('uses the Linux tray only when both pieces exist', () => {
    expect(
      desktopPresence({
        platform: 'linux',
        trayCreated: true,
        statusNotifierHost: true
      })
    ).toMatchObject({
      mode: 'tray',
      hideFromTaskbar: true,
      keepAliveWithoutWindows: true
    })
    expect(
      desktopPresence({
        platform: 'linux',
        trayCreated: false,
        statusNotifierHost: true
      })
    ).toMatchObject({
      mode: 'taskbar',
      hideFromTaskbar: false,
      reason: 'tray-construction-failed'
    })
  })
})
