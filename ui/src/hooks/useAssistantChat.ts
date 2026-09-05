/**
 * Hook for managing assistant chat WebSocket connection
 */

import { openLocalWebSocket } from '../lib/localSession'
import { useState, useCallback, useRef, useEffect } from 'react'
import type { ChatMessage, AssistantChatServerMessage } from '../lib/types'

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface UseAssistantChatOptions {
  projectName: string
  onError?: (error: string) => void
}

interface UseAssistantChatReturn {
  messages: ChatMessage[]
  isLoading: boolean
  connectionStatus: ConnectionStatus
  conversationId: number | null
  start: (conversationId?: number | null) => void
  sendMessage: (content: string) => void
  disconnect: () => void
  clearMessages: () => void
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

export function useAssistantChat({
  projectName,
  onError,
}: UseAssistantChatOptions): UseAssistantChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [conversationId, setConversationId] = useState<number | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pendingConnectRef = useRef<AbortController | null>(null)
  const currentAssistantMessageRef = useRef<string | null>(null)
  const reconnectAttempts = useRef(0)
  const maxReconnectAttempts = 3
  const pingIntervalRef = useRef<number | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)

  // Clean up on unmount
  useEffect(() => {
    return () => {
      pendingConnectRef.current?.abort()
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current)
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [projectName])

  const connect = useCallback(async (): Promise<WebSocket | null> => {
    // Prevent multiple connection attempts
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING) {
      return wsRef.current
    }

    setConnectionStatus('connecting')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/api/assistant/ws/${encodeURIComponent(projectName)}`

    pendingConnectRef.current?.abort()
    const pending = new AbortController()
    pendingConnectRef.current = pending
    const retry = async (): Promise<WebSocket | null> => {
      if (pending.signal.aborted || reconnectAttempts.current >= maxReconnectAttempts) return null
      reconnectAttempts.current++
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 10000)
      const shouldRetry = await new Promise<boolean>((resolve) => {
        const cancel = () => {
          if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
          resolve(false)
        }
        pending.signal.addEventListener('abort', cancel, { once: true })
        reconnectTimeoutRef.current = window.setTimeout(() => {
          pending.signal.removeEventListener('abort', cancel)
          reconnectTimeoutRef.current = null
          resolve(true)
        }, delay)
      })
      if (!shouldRetry || pending.signal.aborted) return null
      return connect()
    }
    let connection: WebSocket | null
    try {
      connection = await openLocalWebSocket(wsUrl, pending.signal)
    } catch {
      if (!pending.signal.aborted) setConnectionStatus('error')
      return retry()
    }
    if (!connection) return null
    const ws = connection
    wsRef.current = ws

    ws.onopen = () => {
      if (pending.signal.aborted) return
      setConnectionStatus('connected')
      reconnectAttempts.current = 0

      // Start ping interval to keep connection alive
      pingIntervalRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30000)
    }

    ws.onclose = () => {
      if (pending.signal.aborted) return
      setConnectionStatus('disconnected')
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current)
        pingIntervalRef.current = null
      }

      void retry()
    }

    ws.onerror = () => {
      setConnectionStatus('error')
      onError?.('WebSocket connection error')
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as AssistantChatServerMessage

        switch (data.type) {
          case 'text': {
            // Append text to current assistant message or create new one
            setMessages((prev) => {
              const lastMessage = prev[prev.length - 1]
              if (lastMessage?.role === 'assistant' && lastMessage.isStreaming) {
                // Append to existing streaming message
                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    content: lastMessage.content + data.content,
                  },
                ]
              } else {
                // Create new assistant message
                currentAssistantMessageRef.current = generateId()
                return [
                  ...prev,
                  {
                    id: currentAssistantMessageRef.current,
                    role: 'assistant',
                    content: data.content,
                    timestamp: new Date(),
                    isStreaming: true,
                  },
                ]
              }
            })
            break
          }

          case 'tool_call': {
            // Show tool call as system message
            setMessages((prev) => [
              ...prev,
              {
                id: generateId(),
                role: 'system',
                content: `Using tool: ${data.tool}`,
                timestamp: new Date(),
              },
            ])
            break
          }

          case 'conversation_created': {
            setConversationId(data.conversation_id)
            break
          }

          case 'response_done': {
            setIsLoading(false)

            // Mark current message as done streaming
            setMessages((prev) => {
              const lastMessage = prev[prev.length - 1]
              if (lastMessage?.role === 'assistant' && lastMessage.isStreaming) {
                return [
                  ...prev.slice(0, -1),
                  { ...lastMessage, isStreaming: false },
                ]
              }
              return prev
            })
            break
          }

          case 'error': {
            setIsLoading(false)
            onError?.(data.content)

            // Add error as system message
            setMessages((prev) => [
              ...prev,
              {
                id: generateId(),
                role: 'system',
                content: `Error: ${data.content}`,
                timestamp: new Date(),
              },
            ])
            break
          }

          case 'pong': {
            // Keep-alive response, nothing to do
            break
          }
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e)
      }
    }
    return ws
  }, [projectName, onError])

  const start = useCallback((existingConversationId?: number | null) => {
    void connect().then((socket) => {
      if (!socket) return
      const checkAndSend = () => {
        if (socket.readyState === WebSocket.OPEN) {
          setIsLoading(true)
          const payload: { type: string; conversation_id?: number } = { type: 'start' }
          if (existingConversationId) {
            payload.conversation_id = existingConversationId
            setConversationId(existingConversationId)
          }
          socket.send(JSON.stringify(payload))
        } else if (socket.readyState === WebSocket.CONNECTING) {
          setTimeout(checkAndSend, 100)
        }
      }
      checkAndSend()
    })
  }, [connect])

  const sendMessage = useCallback((content: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      onError?.('Not connected')
      return
    }

    // Add user message to chat
    setMessages((prev) => [
      ...prev,
      {
        id: generateId(),
        role: 'user',
        content,
        timestamp: new Date(),
      },
    ])

    setIsLoading(true)

    // Send to server
    wsRef.current.send(
      JSON.stringify({
        type: 'message',
        content,
      })
    )
  }, [onError])

  const disconnect = useCallback(() => {
    pendingConnectRef.current?.abort()
    reconnectAttempts.current = maxReconnectAttempts // Prevent reconnection
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current)
      pingIntervalRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setConnectionStatus('disconnected')
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    setConversationId(null)
  }, [])

  return {
    messages,
    isLoading,
    connectionStatus,
    conversationId,
    start,
    sendMessage,
    disconnect,
    clearMessages,
  }
}
