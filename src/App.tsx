import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Archive,
  ArrowUp,
  Check,
  ChevronDown,
  CircleUserRound,
  Eye,
  Menu,
  MessageCircleMore,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'

type ChatMessage = {
  id: number
  role: 'user' | 'assistant'
  content: string
}

type Conversation = {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
}

type ConnectionStatus = 'success' | 'failure'

const CONVERSATIONS_STORAGE_KEY = 'mira-conversations'
const SELECTED_MODEL_STORAGE_KEY = 'mira-selected-model'
const FALLBACK_MODELS = ['obsidian/Qwen3.8-27B', 'qwen/qwen3.8-27b-free']

function loadConversations(): Conversation[] {
  try {
    const stored = window.localStorage.getItem(CONVERSATIONS_STORAGE_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed.filter(
      (conversation): conversation is Conversation =>
        typeof conversation === 'object' &&
        conversation !== null &&
        'id' in conversation &&
        typeof conversation.id === 'string' &&
        'title' in conversation &&
        typeof conversation.title === 'string' &&
        'updatedAt' in conversation &&
        typeof conversation.updatedAt === 'number' &&
        'messages' in conversation &&
        Array.isArray(conversation.messages),
    )
  } catch {
    return []
  }
}

function formatConversationTime(updatedAt: number) {
  const elapsed = Date.now() - updatedAt
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  if (hours < 48) return '어제'
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(updatedAt)
}

function createConversationTitle(content: string) {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized
}

function Logo() {
  return (
    <div className="px-1">
      <p className="font-display text-[22px] leading-none tracking-[0.13em] text-[#fffaf0]">
        MIRA
      </p>
      <p className="mt-1 text-[9px] font-semibold tracking-[0.25em] text-white/55 uppercase">
        Personal Intelligence
      </p>
    </div>
  )
}

type SidebarProps = {
  mobile?: boolean
  onClose?: () => void
  onNewChat: () => void
  conversations: Conversation[]
  activeConversationId: string | null
  onSelectConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
}

function Sidebar({
  mobile = false,
  onClose,
  onNewChat,
  conversations,
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
}: SidebarProps) {
  return (
    <aside
      className={`glass-panel flex h-full w-[280px] shrink-0 flex-col rounded-[28px] p-4 ${
        mobile ? 'shadow-2xl' : 'hidden lg:flex'
      }`}
    >
      <div className="flex items-center justify-between px-2 pb-6 pt-2">
        <Logo />
        {mobile && (
          <button className="icon-button" type="button" onClick={onClose} aria-label="사이드바 닫기">
            <X className="size-[18px]" />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onNewChat}
        className="group flex h-12 w-full items-center justify-between rounded-2xl border border-white/25 bg-[#edf7f3]/90 px-4 text-[13px] font-semibold text-[#19343a] shadow-[0_12px_30px_rgba(16,45,50,0.12)] transition hover:-translate-y-0.5 hover:bg-white"
      >
        <span className="flex items-center gap-2.5">
          <Plus className="size-4 transition-transform group-hover:rotate-90" />
          새로운 대화
        </span>
        <span className="rounded-lg border border-[#19343a]/10 bg-white/60 px-1.5 py-0.5 text-[9px] text-[#19343a]/55">
          ⌘ N
        </span>
      </button>

      <nav aria-label="주요 메뉴" className="mt-3 space-y-1">
        <button className="sidebar-link" type="button">
          <Search className="size-4" />
          대화 검색
        </button>
        <button className="sidebar-link" type="button">
          <Archive className="size-4" />
          보관함
        </button>
      </nav>

      <div className="mt-7 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-2">
          <p className="text-[10px] font-semibold tracking-[0.18em] text-white/45 uppercase">
            Recent
          </p>
          <button type="button" className="text-white/40 transition hover:text-white" aria-label="대화 목록 메뉴">
            <MoreHorizontal className="size-4" />
          </button>
        </div>
        <div className="mt-2 space-y-1 overflow-y-auto pr-1">
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`group flex w-full items-center rounded-2xl transition ${
                conversation.id === activeConversationId
                  ? 'bg-white/14 text-white'
                  : 'text-white/65 hover:bg-white/10 hover:text-white'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectConversation(conversation.id)}
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left"
              >
                <MessageCircleMore className="size-[15px] shrink-0 opacity-65" strokeWidth={1.6} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{conversation.title}</span>
                  <span className="mt-0.5 block text-[9px] text-white/35">
                    {formatConversationTime(conversation.updatedAt)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDeleteConversation(conversation.id)}
                className="mr-2 grid size-8 shrink-0 place-items-center rounded-xl text-white/35 opacity-70 transition hover:bg-white/10 hover:text-[#ffc4bd] sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                aria-label={`${conversation.title} 대화 삭제`}
              >
                <Trash2 className="size-3.5" strokeWidth={1.6} />
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="px-3 py-4 text-[10px] leading-5 text-white/30">
              저장된 대화가 없습니다.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 border-t border-white/12 pt-3">
        <button type="button" className="flex w-full items-center gap-3 rounded-2xl p-2 text-left transition hover:bg-white/10">
          <div className="grid size-9 place-items-center rounded-xl border border-white/20 bg-white/12 text-white/75">
            <CircleUserRound className="size-[18px]" strokeWidth={1.5} />
          </div>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold text-white/85">나의 공간</span>
            <span className="block text-[9px] text-white/35">개인 워크스페이스</span>
          </span>
          <Settings className="size-[15px] text-white/35" strokeWidth={1.6} />
        </button>
      </div>
    </aside>
  )
}

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto flex w-full items-center justify-center px-4 text-center"
    >
      <h1 className="font-display text-[clamp(76px,15vw,156px)] leading-none tracking-[0.12em] text-[#fff9eb] drop-shadow-[0_14px_46px_rgba(4,19,24,0.34)]">
        MIRA
      </h1>
    </motion.div>
  )
}

function MessageList({ messages, isThinking }: { messages: ChatMessage[]; isThinking: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-[780px] flex-col gap-6 px-1 py-8 md:px-6">
      <AnimatePresence initial={false}>
        {messages.map((message) => (
          <motion.article
            key={message.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {message.role === 'assistant' && (
              <div className="grid size-8 shrink-0 place-items-center rounded-xl border border-white/25 bg-white/15 text-white/80 backdrop-blur-xl">
                <Eye className="size-4" strokeWidth={1.5} />
              </div>
            )}
            <div
              className={`max-w-[80%] rounded-[22px] px-4 py-3 text-[13px] leading-6 shadow-lg backdrop-blur-2xl md:text-sm ${
                message.role === 'user'
                  ? 'rounded-br-md border border-[#effbf5]/45 bg-[#edf7f3]/88 text-[#1e3b40]'
                  : 'rounded-bl-md border border-white/20 bg-[#17383e]/46 text-white/85'
              }`}
            >
              {message.content}
            </div>
          </motion.article>
        ))}
      </AnimatePresence>
      {isThinking && messages.at(-1)?.role !== 'assistant' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
          <div className="grid size-8 place-items-center rounded-xl border border-white/25 bg-white/15 text-white/80">
            <Eye className="size-4" strokeWidth={1.5} />
          </div>
          <div className="flex gap-1 rounded-2xl border border-white/20 bg-[#17383e]/40 px-4 py-3 backdrop-blur-2xl">
            {[0, 1, 2].map((dot) => (
              <motion.span
                key={dot}
                className="size-1.5 rounded-full bg-white/70"
                animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
                transition={{ duration: 1, repeat: Infinity, delay: dot * 0.14 }}
              />
            ))}
          </div>
        </motion.div>
      )}
    </div>
  )
}

export default function App() {
  const prefersReducedMotion = useReducedMotion()
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('success')
  const [modelName, setModelName] = useState(
    () => window.localStorage.getItem(SELECTED_MODEL_STORAGE_KEY) ?? FALLBACK_MODELS[0],
  )
  const [availableModels, setAvailableModels] = useState<string[]>(FALLBACK_MODELS)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const requestControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false)
        setModelMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => () => requestControllerRef.current?.abort(), [])

  useEffect(() => {
    window.localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(conversations))
  }, [conversations])

  useEffect(() => {
    window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, modelName)
  }, [modelName])

  useEffect(() => {
    if (!activeConversationId || messages.length === 0) return

    const firstUserMessage = messages.find((message) => message.role === 'user')
    const updatedConversation: Conversation = {
      id: activeConversationId,
      title: createConversationTitle(firstUserMessage?.content ?? '새로운 대화'),
      updatedAt: Date.now(),
      messages,
    }

    setConversations((current) => [
      updatedConversation,
      ...current.filter((conversation) => conversation.id !== activeConversationId),
    ])
  }, [activeConversationId, messages])

  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/status', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('status request failed')
        return response.json() as Promise<{ configured: boolean; model: string; models?: string[] }>
      })
      .then((status) => {
        const models = status.models?.length ? status.models : FALLBACK_MODELS
        setConnectionStatus(status.configured ? 'success' : 'failure')
        setAvailableModels(models)
        setModelName((current) => (models.includes(current) ? current : status.model))
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setConnectionStatus('failure')
      })

    return () => controller.abort()
  }, [])

  const newChat = () => {
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    setActiveConversationId(null)
    setMessages([])
    setDraft('')
    setIsThinking(false)
    setSidebarOpen(false)
    window.setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const selectConversation = (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId)
    if (!conversation) return

    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    setActiveConversationId(conversation.id)
    setMessages(conversation.messages)
    setDraft('')
    setIsThinking(false)
    setSidebarOpen(false)
    setWorkspaceOpen(true)
  }

  const deleteConversation = (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId)
    if (!conversation || !window.confirm(`“${conversation.title}” 대화를 삭제할까요?`)) return

    setConversations((current) => current.filter((item) => item.id !== conversationId))

    if (conversationId === activeConversationId) {
      requestControllerRef.current?.abort()
      requestControllerRef.current = null
      setActiveConversationId(null)
      setMessages([])
      setDraft('')
      setIsThinking(false)
    }
  }

  const submitMessage = async (event?: FormEvent) => {
    event?.preventDefault()
    const content = draft.trim()
    if (!content || isThinking) return

    const messageId = Date.now()
    const assistantId = messageId + 1
    const userMessage: ChatMessage = { id: messageId, role: 'user', content }
    const requestMessages = [...messages, userMessage]
    const conversationId = activeConversationId ?? crypto.randomUUID()

    if (!activeConversationId) setActiveConversationId(conversationId)
    setMessages(requestMessages)
    setDraft('')
    setIsThinking(true)

    const controller = new AbortController()
    requestControllerRef.current = controller
    let assistantContent = ''

    const appendAssistantContent = (contentDelta: string) => {
      assistantContent += contentDelta
      setMessages((current) => {
        const assistantExists = current.some((message) => message.id === assistantId)
        if (!assistantExists) {
          return [...current, { id: assistantId, role: 'assistant', content: assistantContent }]
        }
        return current.map((message) =>
          message.id === assistantId ? { ...message, content: assistantContent } : message,
        )
      })
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: requestMessages.map(({ role, content: messageContent }) => ({
            role,
            content: messageContent,
          })),
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(errorBody?.error ?? '응답을 가져오지 못했습니다.')
      }
      if (!response.body) throw new Error('스트리밍 응답을 읽을 수 없습니다.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamFinished = false

      const consumeLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) return

        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          streamFinished = true
          return
        }
        if (!data) return

        const streamEvent = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const contentDelta = streamEvent.choices?.[0]?.delta?.content
        if (typeof contentDelta === 'string' && contentDelta) appendAssistantContent(contentDelta)
      }

      while (!streamFinished) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })

        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) consumeLine(line)

        if (done) {
          if (buffer.trim()) consumeLine(buffer)
          break
        }
      }

      if (!assistantContent.trim()) throw new Error('모델이 빈 응답을 반환했습니다.')
      setConnectionStatus('success')
    } catch (error) {
      if (controller.signal.aborted) return

      setConnectionStatus('failure')
      const errorMessage = error instanceof Error ? error.message : '응답을 가져오지 못했습니다.'
      setMessages((current) => {
        const withoutIncompleteResponse = current.filter((message) => message.id !== assistantId)
        return [
          ...withoutIncompleteResponse,
          { id: assistantId, role: 'assistant', content: `오류: ${errorMessage}` },
        ]
      })
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null
      setIsThinking(false)
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitMessage()
    }
  }

  const openWorkspace = () => {
    setWorkspaceOpen(true)
    window.setTimeout(() => textareaRef.current?.focus(), prefersReducedMotion ? 0 : 420)
  }

  return (
    <main className="app-background relative h-[100dvh] min-h-[620px] overflow-hidden p-2.5 text-white md:p-4">
      <div className="background-wash absolute inset-0" />
      <div className="background-grain absolute inset-0 opacity-20" />

      <AnimatePresence mode="wait">
        {!workspaceOpen ? (
          <motion.section
            key="intro"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.985 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.35 }}
            className="relative z-10 mx-auto flex h-full w-full max-w-[980px] flex-col items-center px-3 pb-[138px]"
          >
            <motion.div
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.7, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center pt-[9vh] text-center md:pt-[10vh]"
            >
              <h1 className="font-display text-[clamp(64px,11vw,118px)] leading-[0.82] tracking-[0.09em] text-[#fff9eb] drop-shadow-[0_10px_35px_rgba(7,27,34,0.2)]">
                MIRA
              </h1>
              <p className="mt-5 text-[9px] font-semibold tracking-[0.42em] text-white/55 uppercase md:text-[11px]">
                Personal Intelligence
              </p>
            </motion.div>
          </motion.section>
        ) : (
          <motion.div
            key="workspace"
            initial={{ opacity: 0, scale: 0.985, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 mx-auto flex h-full w-full max-w-[1680px] gap-3 pb-[126px] md:gap-4 md:pb-[138px]"
          >
            <Sidebar
              onNewChat={newChat}
              conversations={conversations}
              activeConversationId={activeConversationId}
              onSelectConversation={selectConversation}
              onDeleteConversation={deleteConversation}
            />

            <AnimatePresence>
              {sidebarOpen && (
                <>
                  <motion.button
                    type="button"
                    aria-label="사이드바 닫기"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setSidebarOpen(false)}
                    className="fixed inset-0 z-40 bg-[#071b20]/45 backdrop-blur-sm lg:hidden"
                  />
                  <motion.div
                    initial={{ x: -320 }}
                    animate={{ x: 0 }}
                    exit={{ x: -320 }}
                    transition={{ type: 'spring', stiffness: 310, damping: 30 }}
                    className="fixed bottom-[132px] left-2.5 top-2.5 z-50 md:bottom-[144px] lg:hidden"
                  >
                    <Sidebar
                      mobile
                      onClose={() => setSidebarOpen(false)}
                      onNewChat={newChat}
                      conversations={conversations}
                      activeConversationId={activeConversationId}
                      onSelectConversation={selectConversation}
                      onDeleteConversation={deleteConversation}
                    />
                  </motion.div>
                </>
              )}
            </AnimatePresence>

            <section className="glass-main flex min-w-0 flex-1 flex-col overflow-hidden rounded-[28px]">
              <header className="flex h-[68px] shrink-0 items-center justify-between border-b border-white/12 px-3 md:px-5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <button
                    className="icon-button lg:hidden"
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    aria-label="사이드바 열기"
                  >
                    <Menu className="size-[18px]" />
                  </button>
                  <div className="relative min-w-0">
                    <button
                      type="button"
                      onClick={() => setModelMenuOpen((open) => !open)}
                      className="flex max-w-[270px] items-center gap-2 text-left"
                      aria-haspopup="listbox"
                      aria-expanded={modelMenuOpen}
                      aria-label="AI 모델 선택"
                    >
                      <h2 className="truncate text-[11px] font-semibold text-white/90 md:text-[13px]">
                        {modelName}
                      </h2>
                      <ChevronDown
                        className={`size-3.5 shrink-0 text-white/35 transition-transform ${
                          modelMenuOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-white/38">
                      <span
                        className={`size-1.5 rounded-full ${
                          connectionStatus === 'success'
                            ? 'bg-[#b9ecd7] shadow-[0_0_8px_rgba(185,236,215,0.8)]'
                            : 'bg-[#f49b91] shadow-[0_0_8px_rgba(244,155,145,0.72)]'
                        }`}
                      />
                      {connectionStatus === 'success' ? '연결 성공' : '연결 실패'}
                    </div>

                    <AnimatePresence>
                      {modelMenuOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: -6, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -6, scale: 0.98 }}
                          transition={{ duration: 0.16 }}
                          role="listbox"
                          aria-label="사용할 AI 모델"
                          className="absolute left-0 top-[44px] z-40 w-[270px] overflow-hidden rounded-2xl border border-white/20 bg-[#15383e]/95 p-1.5 shadow-[0_18px_50px_rgba(3,17,21,0.38)] backdrop-blur-2xl"
                        >
                          {availableModels.map((model) => (
                            <button
                              key={model}
                              type="button"
                              role="option"
                              aria-selected={model === modelName}
                              onClick={() => {
                                setModelName(model)
                                setModelMenuOpen(false)
                              }}
                              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[10px] transition hover:bg-white/10 ${
                                model === modelName ? 'bg-white/12 text-white' : 'text-white/60'
                              }`}
                            >
                              <span className="min-w-0 flex-1 truncate">{model}</span>
                              {model.endsWith('-free') && (
                                <span className="rounded-md bg-[#b9ecd7]/12 px-1.5 py-0.5 text-[8px] font-semibold text-[#c8f2e0]">
                                  FREE
                                </span>
                              )}
                              {model === modelName && <Check className="size-3.5 shrink-0" />}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <button
                  className="icon-button"
                  type="button"
                  onClick={() => {
                    setWorkspaceOpen(false)
                    setSidebarOpen(false)
                  }}
                  aria-label="채팅 닫기"
                >
                  <X className="size-[18px]" />
                </button>
              </header>

              <div className="relative min-h-0 flex-1 overflow-y-auto px-3 md:px-6">
                <div className={`flex min-h-full ${messages.length === 0 ? 'items-center pb-[4vh]' : 'items-start'}`}>
                  {messages.length === 0 ? (
                    <EmptyState />
                  ) : (
                    <MessageList messages={messages} isThinking={isThinking} />
                  )}
                </div>
              </div>
            </section>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        layout
        className={`absolute bottom-2.5 left-2.5 right-2.5 z-30 transition-[padding] duration-500 md:bottom-4 md:left-4 md:right-4 ${
          workspaceOpen ? 'lg:pl-[296px]' : ''
        }`}
      >
        <form onSubmit={submitMessage} className="mx-auto w-full max-w-[820px]">
          <div className={`rounded-[24px] p-2 shadow-[0_22px_60px_rgba(5,22,28,0.18)] ${workspaceOpen ? 'composer-shell' : 'intro-composer'}`}>
            <textarea
              ref={textareaRef}
              value={draft}
              onFocus={() => {
                if (!workspaceOpen) openWorkspace()
              }}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={1}
              aria-label="MIRA에게 메시지 보내기"
              placeholder="MIRA에게 무엇이든 물어보세요"
              className="max-h-36 min-h-12 w-full resize-none bg-transparent px-3 py-3 text-[13px] leading-6 text-white/90 outline-none placeholder:text-white/38 md:text-sm"
            />
            <div className="flex items-center justify-end px-1 pb-1">
              <button
                type="submit"
                disabled={!draft.trim() || isThinking}
                aria-label="메시지 보내기"
                className="grid size-9 place-items-center rounded-2xl bg-[#edf7f3] text-[#16353a] shadow-[0_8px_20px_rgba(7,29,35,0.2)] transition hover:-translate-y-0.5 hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
              >
                <ArrowUp className="size-[17px]" strokeWidth={2} />
              </button>
            </div>
          </div>
        </form>
      </motion.div>
    </main>
  )
}
