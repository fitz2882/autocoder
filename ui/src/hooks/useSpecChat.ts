/**
 * Hook for managing spec creation chat WebSocket connection
 */

import { openLocalWebSocket } from '../lib/localSession'
import { useState, useCallback, useRef, useEffect } from 'react'
import type { ChatMessage, ImageAttachment, SpecChatServerMessage, SpecQuestion } from '../lib/types'
import { getSpecStatus } from '../lib/api'

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface UseSpecChatOptions {
  projectName: string
  onComplete?: (specPath: string) => void
  onError?: (error: string) => void
}

interface UseSpecChatReturn {
  messages: ChatMessage[]
  isLoading: boolean
  isComplete: boolean
  connectionStatus: ConnectionStatus
  currentQuestions: SpecQuestion[] | null
  currentToolId: string | null
  start: () => void
  sendMessage: (content: string, attachments?: ImageAttachment[]) => void
  sendAnswer: (answers: Record<string, string | string[]>) => void
  disconnect: () => void
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

export function useSpecChat({
  projectName,
  onComplete,
  onError,
}: UseSpecChatOptions): UseSpecChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isComplete, setIsComplete] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [currentQuestions, setCurrentQuestions] = useState<SpecQuestion[] | null>(null)
  const [currentToolId, setCurrentToolId] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pendingConnectRef = useRef<AbortController | null>(null)
  const currentAssistantMessageRef = useRef<string | null>(null)
  const reconnectAttempts = useRef(0)
  const maxReconnectAttempts = 3
  const pingIntervalRef = useRef<number | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const isCompleteRef = useRef(false)

  // Keep isCompleteRef in sync with isComplete state
  useEffect(() => {
    isCompleteRef.current = isComplete
  }, [isComplete])

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

  // Poll status file as fallback completion detection
  // Claude writes .spec_status.json when done with all spec work
  useEffect(() => {
    // Don't poll if already complete
    if (isComplete) return

    // Start polling after initial delay (let WebSocket try first)
    const startDelay = setTimeout(() => {
      const pollInterval = setInterval(async () => {
        // Stop if already complete
        if (isCompleteRef.current) {
          clearInterval(pollInterval)
          return
        }

        try {
          const status = await getSpecStatus(projectName)

          if (status.exists && status.status === 'complete') {
            // Status file indicates completion - set complete state
            setIsComplete(true)
            setIsLoading(false)

            // Mark any streaming message as done
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

            // Add system message about completion
            setMessages((prev) => [
              ...prev,
              {
                id: generateId(),
                role: 'system',
                content: `Spec creation complete! Files written: ${status.files_written.join(', ')}${status.feature_count ? ` (${status.feature_count} features)` : ''}`,
                timestamp: new Date(),
              },
            ])

            clearInterval(pollInterval)
          }
        } catch {
          // Silently ignore polling errors - WebSocket is primary mechanism
        }
      }, 3000) // Poll every 3 seconds

      // Cleanup interval on unmount
      return () => clearInterval(pollInterval)
    }, 3000) // Start polling after 3 second delay

    return () => clearTimeout(startDelay)
  }, [projectName, isComplete])

  const connect = useCallback(async (): Promise<WebSocket | null> => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return wsRef.current
    }

    setConnectionStatus('connecting')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/api/spec/ws/${encodeURIComponent(projectName)}`

    pendingConnectRef.current?.abort()
    const pending = new AbortController()
    pendingConnectRef.current = pending
    const retry = async (): Promise<WebSocket | null> => {
      if (pending.signal.aborted || reconnectAttempts.current >= maxReconnectAttempts || isCompleteRef.current) return null
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
      if (!shouldRetry || pending.signal.aborted || isCompleteRef.current) return null
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
        const data = JSON.parse(event.data) as SpecChatServerMessage

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

          case 'question': {
            // Show structured question UI
            setCurrentQuestions(data.questions)
            setCurrentToolId(data.tool_id || null)
            setIsLoading(false)

            // Mark current message as done streaming
            setMessages((prev) => {
              const lastMessage = prev[prev.length - 1]
              if (lastMessage?.role === 'assistant' && lastMessage.isStreaming) {
                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    isStreaming: false,
                    questions: data.questions,
                  },
                ]
              }
              return prev
            })
            break
          }

          case 'spec_complete': {
            setIsComplete(true)
            setIsLoading(false)

            // Mark current message as done
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

            // Add system message about spec completion
            setMessages((prev) => [
              ...prev,
              {
                id: generateId(),
                role: 'system',
                content: `Specification file created: ${data.path}`,
                timestamp: new Date(),
              },
            ])

            // NOTE: Do NOT auto-call onComplete here!
            // User should click "Continue to Project" button to start the agent.
            // This matches the CLI behavior where user closes the chat manually.
            break
          }

          case 'file_written': {
            // Optional: notify about other files being written
            setMessages((prev) => [
              ...prev,
              {
                id: generateId(),
                role: 'system',
                content: `File created: ${data.path}`,
                timestamp: new Date(),
              },
            ])
            break
          }

          case 'complete': {
            setIsComplete(true)
            setIsLoading(false)

            // Mark current message as done
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

          case 'response_done': {
            // Response complete - hide loading indicator and mark message as done
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
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e)
      }
    }
    return ws
  }, [projectName, onComplete, onError])

  const start = useCallback(() => {
    void connect().then((socket) => {
      if (!socket) return
      const checkAndSend = () => {
        if (socket.readyState === WebSocket.OPEN) {
          setIsLoading(true)
          socket.send(JSON.stringify({ type: 'start' }))
        } else if (socket.readyState === WebSocket.CONNECTING) {
          setTimeout(checkAndSend, 100)
        }
      }
      checkAndSend()
    })
  }, [connect])

  const sendMessage = useCallback((content: string, attachments?: ImageAttachment[]) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      onError?.('Not connected')
      return
    }

    // Add user message to chat (with attachments for display)
    setMessages((prev) => [
      ...prev,
      {
        id: generateId(),
        role: 'user',
        content,
        attachments,
        timestamp: new Date(),
      },
    ])

    // Clear current questions
    setCurrentQuestions(null)
    setCurrentToolId(null)
    setIsLoading(true)

    // Build message payload
    const payload: { type: string; content: string; attachments?: Array<{ filename: string; mimeType: string; base64Data: string }> } = {
      type: 'message',
      content,
    }

    // Add attachments if present (send base64 data, not preview URL)
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        base64Data: a.base64Data,
      }))
    }

    // Send to server
    wsRef.current.send(JSON.stringify(payload))
  }, [onError])

  const sendAnswer = useCallback((answers: Record<string, string | string[]>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      onError?.('Not connected')
      return
    }

    // Format answers for display
    const answerText = Object.values(answers)
      .map((v) => (Array.isArray(v) ? v.join(', ') : v))
      .join('; ')

    // Add user message
    setMessages((prev) => [
      ...prev,
      {
        id: generateId(),
        role: 'user',
        content: answerText,
        timestamp: new Date(),
      },
    ])

    // Clear current questions
    setCurrentQuestions(null)
    setCurrentToolId(null)
    setIsLoading(true)

    // Send to server
    wsRef.current.send(
      JSON.stringify({
        type: 'answer',
        answers,
        tool_id: currentToolId,
      })
    )
  }, [currentToolId, onError])

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

  return {
    messages,
    isLoading,
    isComplete,
    connectionStatus,
    currentQuestions,
    currentToolId,
    start,
    sendMessage,
    sendAnswer,
    disconnect,
  }
}
