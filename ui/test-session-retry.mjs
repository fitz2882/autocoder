// Offline tests of the actual bundled hooks; no server, provider, or wall-clock waits.
import { build } from 'esbuild'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'

async function harness(name, succeedsAfter = 1) {
  const { outputFiles } = await build({ entryPoints: [`src/hooks/${name}.ts`], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react'] })
  const timers = new Map(), cleanups = [], sockets = []
  let timerId = 0, attempts = 0
  const timeout = (fn) => { timers.set(++timerId, fn); return timerId }
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 0
    sent = []
    listeners = new Map()
    constructor() { sockets.push(this) }
    addEventListener(name, fn) { this.listeners.set(name, fn) }
    removeEventListener(name) { this.listeners.delete(name) }
    close() { this.readyState = 3; this.listeners.get('close')?.(); this.onclose?.() }
    send(message) { this.sent.push(JSON.parse(message)) }
    open() { this.readyState = 1; this.onopen?.() }
  }
  const module = { exports: {} }
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: () => ({ useState: value => [value, () => {}], useRef: value => ({ current: value }),
      useCallback: fn => fn, useEffect: fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } }),
    AbortController, WebSocket: Socket, console,
    fetch: async () => ({ ok: ++attempts > succeedsAfter }),
    setTimeout: timeout, clearTimeout: id => timers.delete(id),
    setInterval: () => 1, clearInterval: () => {},
    window: { location: { protocol: 'http:', host: '127.0.0.1:8888' },
      setTimeout: timeout, setInterval: () => 1 },
  })
  const hook = module.exports[name]({ projectName: 'synthetic' })
  timers.clear() // Discard unrelated spec status polling startup timers.
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const advance = async () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); await settle() }
  return { hook, sockets, timers, cleanups, settle, advance, attempts: () => attempts }
}

for (const name of ['useAssistantChat', 'useSpecChat']) {
  test(`${name}: failed bootstrap retries and delivers the pending start`, async () => {
    const h = await harness(name)
    h.hook.start(); await h.settle()
    assert.equal(h.attempts(), 1); assert.equal(h.sockets.length, 0)
    assert.equal(h.timers.size, 1)
    await h.advance()
    assert.equal(h.attempts(), 2); assert.equal(h.sockets.length, 1)
    h.sockets[0].open(); await h.advance()
    assert.equal(h.sockets[0].sent[0].type, 'start')
  })
  test(`${name}: repeated bootstrap failure stops after three retries`, async () => {
    const h = await harness(name, Infinity)
    h.hook.start(); await h.settle()
    for (let i = 0; i < 5; i++) await h.advance()
    assert.equal(h.attempts(), 4); assert.equal(h.timers.size, 0); assert.equal(h.sockets.length, 0)
  })
  for (const action of ['disconnect', 'cleanup']) {
    test(`${name}: ${action} cancels pending bootstrap retry`, async () => {
      const h = await harness(name)
      h.hook.start(); await h.settle()
      if (action === 'disconnect') h.hook.disconnect()
      else h.cleanups.forEach(fn => fn())
      await h.advance()
      assert.equal(h.attempts(), 1); assert.equal(h.sockets.length, 0)
    })
  }
}
