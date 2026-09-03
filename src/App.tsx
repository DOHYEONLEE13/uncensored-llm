import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
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
const MarkdownResponse = lazy(() => import('./MarkdownResponse'))

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

function MiraAvatar({ className = '' }: { className?: string }) {
  return (
    <img
      src="/mira-avatar.svg"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`shrink-0 select-none ${className}`}
    />
  )
}

type ModelPickerProps = {
  value: string
  models: string[]
  onChange: (model: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  placement?: 'above' | 'below'
  compact?: boolean
}

function getModelPresentation(model: string) {
  const separatorIndex = model.indexOf('/')
  if (separatorIndex === -1) return { provider: 'MODEL', name: model }

  return {
    provider: model.slice(0, separatorIndex),
    name: model.slice(separatorIndex + 1),
  }
}

function ModelPicker({
  value,
  models,
  onChange,
  open,
  onOpenChange,
  placement = 'below',
  compact = false,
}: ModelPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false)
    }

    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onOpenChange, open])

  return (
    <div
      ref={rootRef}
      className={`relative min-w-0 ${compact ? 'compact-model-picker' : ''}`}
    >
      <button
        type="button"
        onMouseDown={(event) => {
          if (compact) event.preventDefault()
        }}
        onClick={() => onOpenChange(!open)}
        className={
          compact
            ? `grid size-9 shrink-0 place-items-center rounded-[14px] border transition duration-200 ${
                open
                  ? 'border-[#c8f2e0]/40 bg-[#c8f2e0]/12 shadow-[0_0_0_1px_rgba(200,242,224,0.06),0_9px_24px_rgba(5,22,28,0.22)]'
                  : 'border-white/15 bg-white/[0.075] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] hover:border-white/25 hover:bg-white/[0.11]'
              }`
            : 'flex min-w-0 max-w-[270px] items-center gap-2 text-left'
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={compact ? `AI 모델 선택. 현재 ${value}` : 'AI 모델 선택'}
        title={value}
      >
        {compact ? (
          <Eye className="size-4 text-[#d9f7e9]" strokeWidth={1.6} />
        ) : (
          <>
            <span className="truncate text-[11px] font-semibold text-white/90 md:text-[13px]">
              {value}
            </span>
            <ChevronDown
              className={`size-3.5 shrink-0 text-white/35 transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: placement === 'above' ? 6 : -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: placement === 'above' ? 6 : -6, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            role="listbox"
            aria-label="사용할 AI 모델"
            className={`absolute left-0 z-[80] w-[294px] max-w-[calc(100vw-40px)] overflow-hidden rounded-[20px] border border-white/18 bg-[#123238]/97 p-1.5 shadow-[0_24px_64px_rgba(3,17,21,0.48)] backdrop-blur-2xl ${
              placement === 'above' ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]'
            }`}
          >
            <div className="flex items-center justify-between px-3 pb-2 pt-2">
              <span className="text-[9px] font-semibold tracking-[0.16em] text-white/48 uppercase">
                모델 선택
              </span>
              <span className="text-[8px] font-semibold tracking-[0.12em] text-white/24 uppercase">
                {models.length} available
              </span>
            </div>
            <div className="mb-1 h-px bg-white/8" />
            {models.map((model) => {
              const presentation = getModelPresentation(model)
              const selected = model === value

              return (
                <button
                  key={model}
                  type="button"
                  onMouseDown={(event) => {
                    if (compact) event.preventDefault()
                  }}
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(model)
                    onOpenChange(false)
                  }}
                  className={`group/model flex w-full items-center gap-2.5 rounded-[14px] px-2.5 py-2.5 text-left transition ${
                    selected
                      ? 'bg-[#c8f2e0]/12 text-white shadow-[inset_0_0_0_1px_rgba(200,242,224,0.1)]'
                      : 'text-white/60 hover:bg-white/8 hover:text-white/88'
                  }`}
                >
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-[11px] border transition ${
                      selected
                        ? 'border-[#c8f2e0]/24 bg-[#c8f2e0]/12 text-[#d9f7e9]'
                        : 'border-white/10 bg-white/5 text-white/38 group-hover/model:border-white/18 group-hover/model:text-white/65'
                    }`}
                  >
                    <Eye className="size-3.5" strokeWidth={1.55} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[7px] font-semibold tracking-[0.14em] text-white/34 uppercase">
                      {presentation.provider}
                    </span>
                    <span className="mt-1 block truncate text-[10px] font-semibold leading-none">
                      {presentation.name}
                    </span>
                  </span>
                  {model.endsWith('-free') && (
                    <span className="rounded-md border border-[#b9ecd7]/15 bg-[#b9ecd7]/10 px-1.5 py-0.5 text-[7px] font-bold tracking-[0.08em] text-[#c8f2e0]">
                      FREE
                    </span>
                  )}
                  {selected && (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#c8f2e0]/12 text-[#c8f2e0]">
                      <Check className="size-3.5" strokeWidth={2.2} />
                    </span>
                  )}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
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
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-7 px-1 py-7 md:px-8 md:py-10">
      <AnimatePresence initial={false}>
        {messages.map((message) => (
          <motion.article
            key={message.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'w-full justify-start'}`}
          >
            {message.role === 'assistant' && (
              <MiraAvatar className="mt-0.5 size-8 drop-shadow-[0_7px_14px_rgba(4,19,24,0.28)]" />
            )}
            {message.role === 'user' ? (
              <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-[22px] rounded-br-md border border-[#effbf5]/45 bg-[#edf7f3]/88 px-4 py-3 text-[13px] leading-6 text-[#1e3b40] shadow-lg backdrop-blur-2xl md:max-w-[72%] md:text-sm">
                {message.content}
              </div>
            ) : (
              <div className="markdown-response min-w-0 flex-1 py-1 text-[14px] text-white/88 md:text-[15px]">
                <Suspense fallback={<p className="whitespace-pre-wrap">{message.content}</p>}>
                  <MarkdownResponse content={message.content} />
                </Suspense>
              </div>
            )}
          </motion.article>
        ))}
      </AnimatePresence>
      {isThinking && messages.at(-1)?.role !== 'assistant' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
          <MiraAvatar className="size-8 drop-shadow-[0_7px_14px_rgba(4,19,24,0.28)]" />
          <div className="flex gap-1 px-1 py-3">
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
  const [openModelPicker, setOpenModelPicker] = useState<'header' | 'composer' | null>(null)
  const [isThinking, setIsThinking] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesViewportRef = useRef<HTMLDivElement>(null)
  const messagesContentRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const requestControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const viewport = window.visualViewport
    let animationFrame = 0

    const updateViewport = () => {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(() => {
        if (viewport && viewport.scale !== 1) return

        const height = viewport?.height ?? window.innerHeight
        const offsetTop = viewport?.offsetTop ?? 0
        const composerFocused = document.activeElement === textareaRef.current

        document.documentElement.style.setProperty('--mira-viewport-height', `${height}px`)
        document.documentElement.style.setProperty('--mira-viewport-offset', `${offsetTop}px`)
        document.documentElement.toggleAttribute(
          'data-mira-keyboard-open',
          composerFocused && window.matchMedia('(max-width: 767px)').matches,
        )

        if (composerFocused && stickToBottomRef.current) {
          const messagesViewport = messagesViewportRef.current
          if (messagesViewport) messagesViewport.scrollTop = messagesViewport.scrollHeight
        }
      })
    }

    updateViewport()
    window.addEventListener('resize', updateViewport)
    viewport?.addEventListener('resize', updateViewport)
    viewport?.addEventListener('scroll', updateViewport)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', updateViewport)
      viewport?.removeEventListener('resize', updateViewport)
      viewport?.removeEventListener('scroll', updateViewport)
      document.documentElement.style.removeProperty('--mira-viewport-height')
      document.documentElement.style.removeProperty('--mira-viewport-offset')
      document.documentElement.removeAttribute('data-mira-keyboard-open')
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false)
        setOpenModelPicker(null)
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
    if (!workspaceOpen || !stickToBottomRef.current) return

    const animationFrame = window.requestAnimationFrame(() => {
      const messagesViewport = messagesViewportRef.current
      if (messagesViewport) messagesViewport.scrollTop = messagesViewport.scrollHeight
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [isThinking, messages, workspaceOpen])

  useEffect(() => {
    const content = messagesContentRef.current
    if (!workspaceOpen || !content || typeof ResizeObserver === 'undefined') return

    let animationFrame = 0
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(() => {
        const messagesViewport = messagesViewportRef.current
        if (messagesViewport) messagesViewport.scrollTop = messagesViewport.scrollHeight
      })
    })

    observer.observe(content)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      observer.disconnect()
    }
  }, [workspaceOpen])

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
    stickToBottomRef.current = true
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
    stickToBottomRef.current = true
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
    stickToBottomRef.current = true
    setMessages(requestMessages)
    setDraft('')
    setIsThinking(true)

    const controller = new AbortController()
    requestControllerRef.current = controller
    let assistantContent = ''
    let renderFrame = 0

    const renderAssistantContent = () => {
      renderFrame = 0
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

    const appendAssistantContent = (contentDelta: string) => {
      assistantContent += contentDelta
      if (!renderFrame) renderFrame = window.requestAnimationFrame(renderAssistantContent)
    }

    const flushAssistantContent = () => {
      if (renderFrame) window.cancelAnimationFrame(renderFrame)
      renderAssistantContent()
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

      flushAssistantContent()
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
      if (renderFrame) window.cancelAnimationFrame(renderFrame)
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
    if (window.matchMedia('(max-width: 767px)').matches) {
      document.documentElement.setAttribute('data-mira-keyboard-open', '')
    }
    setWorkspaceOpen(true)
    textareaRef.current?.focus({ preventScroll: true })
  }

  return (
    <>
      <div aria-hidden="true" className="app-scene-background">
        <div className="background-wash absolute inset-0" />
        <div className="background-grain absolute inset-0 opacity-20" />
      </div>

      <main className="app-viewport overflow-hidden p-2.5 text-white md:p-4">
        <AnimatePresence initial={false} mode="popLayout">
        {!workspaceOpen ? (
          <motion.section
            key="intro"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.16 }}
            className="relative z-10 mx-auto flex h-full w-full max-w-[980px] flex-col items-center px-3 pb-[82px]"
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
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.18 }}
            className="workspace-shell relative z-10 mx-auto flex h-full w-full max-w-[1680px] gap-3 md:gap-4"
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
                    className="mobile-sidebar-shell fixed left-2.5 top-2.5 z-50 lg:hidden"
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

            <section className="glass-main relative flex min-w-0 flex-1 flex-col rounded-[28px]">
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
                  <div className="min-w-0">
                    <ModelPicker
                      value={modelName}
                      models={availableModels}
                      onChange={setModelName}
                      open={openModelPicker === 'header'}
                      onOpenChange={(open) => setOpenModelPicker(open ? 'header' : null)}
                    />
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
                  </div>
                </div>

                <button
                  className="icon-button"
                  type="button"
                  onClick={() => {
                    setWorkspaceOpen(false)
                    setSidebarOpen(false)
                    setOpenModelPicker(null)
                  }}
                  aria-label="채팅 닫기"
                >
                  <X className="size-[18px]" />
                </button>
              </header>

              <div
                ref={messagesViewportRef}
                onScroll={(event) => {
                  const viewport = event.currentTarget
                  const distanceFromBottom =
                    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
                  stickToBottomRef.current = distanceFromBottom < 80
                }}
                className="relative min-h-0 flex-1 overscroll-contain overflow-y-auto px-3 md:px-6"
              >
                <div
                  ref={messagesContentRef}
                  className={`flex min-h-full ${messages.length === 0 ? 'items-center pb-[4vh]' : 'items-start'}`}
                >
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

        <div
          className={`composer-dock absolute left-2.5 right-2.5 z-30 md:left-4 md:right-4 lg:transition-[padding] lg:duration-500 ${
            workspaceOpen ? 'lg:pl-[296px]' : ''
          }`}
        >
        <form onSubmit={submitMessage} className="mx-auto w-full max-w-[820px]">
          <motion.div
            animate={{ height: workspaceOpen ? 108 : 60 }}
            transition={{
              duration: prefersReducedMotion ? 0 : 0.28,
              ease: [0.22, 1, 0.36, 1],
            }}
            onClick={() => {
              if (!workspaceOpen) openWorkspace()
            }}
            className={`rounded-[24px] shadow-[0_22px_60px_rgba(5,22,28,0.18)] ${
              workspaceOpen ? 'composer-shell p-2' : 'intro-composer p-1.5'
            }`}
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className={`flex min-h-0 items-center ${workspaceOpen ? 'flex-1' : 'h-full'}`}>
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onFocus={() => {
                    if (!workspaceOpen) openWorkspace()
                  }}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => document.documentElement.removeAttribute('data-mira-keyboard-open')}
                  onKeyDown={handleComposerKeyDown}
                  enterKeyHint="send"
                  rows={1}
                  aria-label="MIRA에게 메시지 보내기"
                  placeholder="MIRA에게 무엇이든 물어보세요"
                  className="h-full min-h-0 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-[16px] leading-6 text-white/90 outline-none placeholder:text-white/38 md:text-sm"
                />

                {!workspaceOpen && (
                  <button
                    type="submit"
                    onMouseDown={(event) => event.preventDefault()}
                    disabled={!draft.trim() || isThinking}
                    aria-label="메시지 보내기"
                    className="mr-0.5 grid size-9 shrink-0 place-items-center rounded-2xl bg-[#edf7f3] text-[#16353a] shadow-[0_8px_20px_rgba(7,29,35,0.2)] transition hover:-translate-y-0.5 hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowUp className="size-[17px]" strokeWidth={2} />
                  </button>
                )}
              </div>

              <AnimatePresence initial={false}>
                {workspaceOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    transition={{ duration: prefersReducedMotion ? 0 : 0.18 }}
                    className="flex h-9 shrink-0 items-center justify-between gap-2 px-1"
                  >
                    <ModelPicker
                      compact
                      placement="above"
                      value={modelName}
                      models={availableModels}
                      onChange={setModelName}
                      open={openModelPicker === 'composer'}
                      onOpenChange={(open) => setOpenModelPicker(open ? 'composer' : null)}
                    />
                    <button
                      type="submit"
                      onMouseDown={(event) => event.preventDefault()}
                      disabled={!draft.trim() || isThinking}
                      aria-label="메시지 보내기"
                      className="grid size-9 shrink-0 place-items-center rounded-2xl bg-[#edf7f3] text-[#16353a] shadow-[0_8px_20px_rgba(7,29,35,0.2)] transition hover:-translate-y-0.5 hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ArrowUp className="size-[17px]" strokeWidth={2} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </form>
        </div>
      </main>
    </>
  )
}
