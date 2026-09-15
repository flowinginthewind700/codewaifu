/**
 * A stand-in herdr socket.
 *
 * The transport is the one layer of Pro that cannot be tested against the real
 * thing in CI (there is no herdr on the runner), and its failure modes are all
 * about *when* bytes arrive: a reply split across two reads, an ack that never
 * comes, a peer that vanishes mid-call. So the fake is a duplex that the test
 * drives by hand, and it echoes the request id back the way a real server does -
 * which is what makes "a reply for somebody else must be ignored" assertable.
 */
import { EventEmitter } from 'node:events'
import type net from 'node:net'
import type { ConnectFn } from '../../src/main/pro/herdr/socket'

export interface WireRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

/** The slice of `net.Socket` that `socket.ts` actually touches. */
export class FakeSocket extends EventEmitter {
  readonly written: string[] = []
  ended = false
  destroyed = false
  encoding = ''
  /** Raw text handed to the client, kept so a test can prove framing. */
  fed = ''

  setEncoding(encoding: string): void {
    this.encoding = encoding
  }

  write(chunk: string): boolean {
    this.written.push(chunk)
    return true
  }

  end(): void {
    this.ended = true
  }

  destroy(): void {
    this.destroyed = true
  }

  /** What the client asked for on this connection. */
  requests(): WireRequest[] {
    return this.written
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line.replace(/\n$/, '')) as WireRequest)
  }

  request(): WireRequest | null {
    return this.requests()[0] ?? null
  }

  method(): string {
    return this.request()?.method ?? ''
  }

  params(): Record<string, unknown> {
    return this.request()?.params ?? {}
  }

  /* ------------------------------------------------------------- *
   * Server side: what herdr would have sent.
   * ------------------------------------------------------------- */

  /** Push bytes, optionally split so the client has to reassemble them. */
  feed(text: string, pieces = 1): void {
    this.fed += text
    if (pieces <= 1) {
      this.emit('data', text)
      return
    }
    const size = Math.max(1, Math.ceil(text.length / pieces))
    for (let at = 0; at < text.length; at += size) this.emit('data', text.slice(at, at + size))
  }

  /** One complete NDJSON line. */
  sendLine(value: unknown, pieces = 1): void {
    this.feed(`${JSON.stringify(value)}\n`, pieces)
  }

  /** A reply to the request on this connection, echoing its id. */
  reply(result: unknown, pieces = 1): void {
    this.sendLine({ id: this.request()?.id ?? '', result }, pieces)
  }

  /** A protocol error from herdr, echoing the request id. */
  fail(code: string, message: string, pieces = 1): void {
    this.sendLine({ id: this.request()?.id ?? '', error: { code, message } }, pieces)
  }

  connectNow(): void {
    this.emit('connect')
  }

  /** herdr closed the connection after replying. */
  peerClose(): void {
    this.emit('end')
    this.emit('close')
  }

  socketError(code: string, message = code): void {
    const error = new Error(message) as NodeJS.ErrnoException
    error.code = code
    this.emit('error', error)
  }
}

export interface FakeServerOptions {
  /** Result object to reply with once the request arrives (id is echoed). */
  result?: unknown
  /** Raw NDJSON lines to push after connect, verbatim: fixture playback. */
  script?: readonly string[]
  /** Split every push into this many reads. */
  pieces?: number
  /** Never answer at all, so the caller has to time out. */
  silent?: boolean
  /** Fail the connection with this errno, e.g. ENOENT when herdr is not up. */
  failConnect?: string
  /** Throw out of connect() itself. */
  throwOnConnect?: string
  /** Close the socket right after the script, without a reply. */
  closeAfterScript?: boolean
}

export interface FakeServer {
  connect: ConnectFn
  readonly sockets: FakeSocket[]
  socket(): FakeSocket
  /** Paths connect() was called with. */
  readonly paths: string[]
}

export function fakeServer(options: FakeServerOptions = {}): FakeServer {
  const sockets: FakeSocket[] = []
  const paths: string[] = []
  const pieces = options.pieces ?? 1

  const connect: ConnectFn = (path: string) => {
    paths.push(path)
    if (options.throwOnConnect) throw new Error(options.throwOnConnect)
    const socket = new FakeSocket()
    sockets.push(socket)
    // A real socket connects asynchronously; a synchronous 'connect' would let
    // the client write before it registered its own handlers.
    setImmediate(() => {
      if (options.failConnect) {
        socket.socketError(options.failConnect)
        return
      }
      socket.connectNow()
      for (const line of options.script ?? []) socket.feed(`${line}\n`, pieces)
      if (options.closeAfterScript) {
        socket.peerClose()
        return
      }
      if (!options.silent && options.result !== undefined) socket.reply(options.result, pieces)
    })
    return socket as unknown as net.Socket
  }

  return {
    connect,
    sockets,
    paths,
    socket: () => {
      const last = sockets[sockets.length - 1]
      if (!last) throw new Error('no connection was made')
      return last
    }
  }
}
