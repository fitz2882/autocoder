/** Bootstrap a host-only HTTP session before every new socket, including reconnects. */
export async function openLocalWebSocket(url: string, signal: AbortSignal): Promise<WebSocket | null> {
  const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal })
  if (!response.ok) throw new Error('Local session unavailable')
  if (signal.aborted) return null
  const socket = new WebSocket(url)
  const close = () => socket.close()
  signal.addEventListener('abort', close, { once: true })
  socket.addEventListener('close', () => signal.removeEventListener('abort', close), { once: true })
  return socket
}
