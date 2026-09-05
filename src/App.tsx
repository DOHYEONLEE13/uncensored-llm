import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Archive,
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleUserRound,
  Eye,
  Globe2,
  MapPin,
  Menu,
  MessageCircleMore,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import {
  consumeChatStream,
  type MiraWebSearchMetadata,
  type WebSearchMode,
  type WebSearchSource,
  type WebSearchStatus,
} from './chatStream'
import CctvResults from './CctvResults'
import {
  CctvClientError,
  CCTV_LIMIT,
  CCTV_RADIUS_METERS,
  fetchNearbyCctvs,
  fetchCctvsByName,
  getCctvSearchQuery,
  getCurrentCoordinates,
  isExplicitCctvIntent,
  type Coordinates,
  type CctvCamera,
} from './cctv'

type TokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens?: number
}

type ChatMessage = {
  id: number
  role: 'user' | 'assistant'
  content: string
  model?: string
  usage?: TokenUsage
  tokenEstimate?: number
  webSearchMode?: WebSearchMode
  webSearchStatus?: WebSearchStatus
  webSearchSources?: WebSearchSource[]
  webSearchWarning?: string
  cctvs?: CctvCamera[]
  cctvSearch?: { query: string; total: number }
}

type Conversation = {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
}

type ConnectionStatus = 'success' | 'failure'

// GPS belongs only to the current CCTV view, never to chat/conversation history.
type CctvLocation = { messageId: number; coordinates: Coordinates }

type PublicModelMetadata = {
  id: string
  displayName: string
  provider: 'orcarouter' | 'openrouter' | 'nanogpt'
  contextWindow: number | null
  maxOutputTokens: number | null
  pricing: {
    promptPerMillion: number
    completionPerMillion: number
    currency: 'USD'
    unit: 'per_million_tokens'
    asOf: string
  } | null
  capabilities: {
    reasoning: boolean
    reasoningControl: boolean
  }
}

const CONVERSATIONS_STORAGE_KEY = 'mira-conversations'
const SELECTED_MODEL_STORAGE_KEY = 'mira-selected-model'
const REASONING_PREFERENCES_STORAGE_KEY = 'mira-reasoning-preferences'
const WEB_SEARCH_MODE_STORAGE_KEY = 'mira-web-search-mode'
const FALLBACK_MODELS = [
  'obsidian/Qwen3.8-27B',
  'qwen/qwen3.8-27b-free',
  'openrouter/free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition',
]
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

function getPersistableConversations(conversations: Conversation[]): Conversation[] {
  return conversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => {
      const persistedMessage = { ...message }
      delete persistedMessage.cctvs
      delete persistedMessage.cctvSearch
      return persistedMessage
    }),
  }))
}

function loadReasoningPreferences() {
  try {
    const stored = window.localStorage.getItem(REASONING_PREFERENCES_STORAGE_KEY)
    if (!stored) return {}
    const parsed = JSON.parse(stored) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    )
  } catch {
    return {}
  }
}

function loadWebSearchMode(): WebSearchMode {
  const stored = window.localStorage.getItem(WEB_SEARCH_MODE_STORAGE_KEY)
  return stored === 'on' || stored === 'off' ? stored : 'auto'
}

const WEB_SEARCH_MODE_PRESENTATION: Record<
  WebSearchMode,
  { label: string; badge: string; description: string }
> = {
  auto: { label: '자동', badge: 'A', description: '필요한 질문만 자동 검색' },
  on: { label: '켜짐', badge: '+', description: '다음 메시지는 항상 웹 검색' },
  off: { label: '꺼짐', badge: '−', description: '웹 검색을 사용하지 않음' },
}

function getNextWebSearchMode(mode: WebSearchMode): WebSearchMode {
  if (mode === 'auto') return 'on'
  if (mode === 'on') return 'off'
  return 'auto'
}

function getSafeSourceUrl(value: unknown) {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function estimateTextTokens(content: string) {
  let asciiCharacters = 0
  let nonAsciiCharacters = 0

  for (const character of content) {
    if (character.codePointAt(0)! <= 0x7f) asciiCharacters += 1
    else nonAsciiCharacters += 1
  }

  return Math.max(0, Math.ceil(asciiCharacters / 4 + nonAsciiCharacters))
}

function estimateConversationTokens(messages: ChatMessage[]) {
  return messages.reduce(
    (total, message) => total + (message.tokenEstimate ?? estimateTextTokens(message.content)) + 4,
    2,
  )
}

function formatPerMillionPrice(price: number) {
  if (price === 0) return '$0'
  const fractionDigits = price < 1 ? 3 : 2
  return `$${price.toFixed(fractionDigits).replace(/0+$/, '').replace(/\.$/, '')}`
}

function ContextMeter({ usedTokens, limit }: { usedTokens: number; limit: number | null }) {
  const rawPercentage = limit ? (usedTokens / limit) * 100 : 0
  const percentage = Math.min(100, Math.max(0, rawPercentage))
  const roundedPercentage = Math.round(percentage)
  const color = percentage >= 85 ? '#ff9d92' : percentage >= 60 ? '#e8c98a' : '#c8f2e0'
  const label = limit
    ? `예상 컨텍스트 사용량 ${usedTokens.toLocaleString()} / ${limit.toLocaleString()} 토큰, ${percentage.toFixed(1)}%`
    : '컨텍스트 한계 정보 없음'

  return (
    <span
      className="min-w-[42px] shrink-0 text-center text-[12px] font-bold tabular-nums tracking-[-0.02em]"
      style={{ color }}
      role="img"
      aria-label={label}
      title={label}
    >
      {limit ? `${roundedPercentage}%` : '—'}
    </span>
  )
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

function isFreeModel(model: string) {
  return model.endsWith('-free') || model === 'openrouter/free'
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
            ? `flex h-10 w-full shrink-0 items-center gap-2 rounded-[14px] border p-1 pr-3 text-left transition duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#c8f2e0]/40 ${
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
          <>
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-[#c8f2e0]/20 bg-[#c8f2e0]/[0.08]">
              <Eye className="size-3.5 text-[#d9f7e9]" strokeWidth={1.65} />
            </span>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[13px] font-semibold tracking-[-0.02em] text-white/78">
              모델 선택
            </span>
            <ChevronDown
              className={`size-3.5 shrink-0 text-white/35 transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </>
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
            initial={{ opacity: 0, y: placement === 'above' ? 5 : -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: placement === 'above' ? 5 : -5 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            role="listbox"
            aria-label="사용할 AI 모델"
            className={`model-picker-menu absolute z-[80] w-[316px] max-w-[calc(100vw-40px)] overflow-hidden rounded-[18px] p-1.5 ${
              compact ? 'left-0' : '-left-[46px] lg:left-0'
            } ${
              placement === 'above' ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]'
            }`}
          >
            <div className="relative flex items-center justify-between px-3 pb-2.5 pt-2.5">
              <span className="text-[10px] font-semibold tracking-[-0.01em] text-white/72">
                모델 선택
              </span>
              <span className="rounded-full border border-white/8 bg-white/[0.035] px-2 py-1 text-[7px] font-semibold tracking-[0.14em] text-white/30 uppercase">
                {models.length} models
              </span>
            </div>
            <div className="model-picker-list max-h-[min(360px,55vh)] space-y-1 overflow-y-auto">
              {models.map((model) => {
                const presentation = getModelPresentation(model)
                const selected = model === value
                const free = isFreeModel(model)

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
                    className={`group/model relative flex min-h-14 w-full items-center gap-2.5 rounded-[13px] border px-3 py-2.5 text-left transition duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 ${
                      selected
                        ? 'border-[#c8f2e0]/16 bg-[#c8f2e0]/[0.09] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.055)]'
                        : 'border-transparent text-white/62 hover:border-white/8 hover:bg-white/[0.055] hover:text-white/90'
                    }`}
                    title={model}
                  >
                    <span className="grid w-3 shrink-0 place-items-center" aria-hidden="true">
                      <span
                        className={`size-1.5 rounded-full shadow-[0_0_0_3px_rgba(255,255,255,0.035)] transition ${
                          selected
                            ? 'bg-[#c8f2e0] shadow-[0_0_0_3px_rgba(200,242,224,0.09)]'
                            : 'bg-white/28 group-hover/model:bg-white/50'
                        }`}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[8px] font-semibold tracking-[0.13em] text-white/35 uppercase">
                        {presentation.provider}
                      </span>
                      <span className="mt-1 block truncate text-[11px] font-semibold leading-none tracking-[-0.01em]">
                        {presentation.name}
                      </span>
                    </span>
                    {free && (
                      <span className="rounded-md border border-[#b9ecd7]/14 bg-[#b9ecd7]/[0.075] px-1.5 py-0.5 text-[7px] font-bold tracking-[0.08em] text-[#c8f2e0]/85">
                        FREE
                      </span>
                    )}
                    {selected && (
                      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#c8f2e0]/12 text-[#c8f2e0]">
                        <Check className="size-3" strokeWidth={2.2} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
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

function MessageList({
  messages,
  isThinking,
  pendingLabel,
  cctvLocation,
}: {
  messages: ChatMessage[]
  isThinking: boolean
  pendingLabel?: string
  cctvLocation: CctvLocation | null
}) {
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
              <div className="min-w-0 flex-1 py-1 text-[14px] text-white/88 md:text-[15px]">
                <div className="markdown-response">
                  <Suspense fallback={<p className="whitespace-pre-wrap">{message.content}</p>}>
                    <MarkdownResponse content={message.content} />
                  </Suspense>
                </div>
                {message.webSearchStatus === 'used' && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3 text-[10px] text-white/46">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#c8f2e0]/16 bg-[#c8f2e0]/[0.055] px-2.5 py-1 font-medium text-[#d8f4e8]/72">
                      <Globe2 className="size-3" strokeWidth={1.7} />
                      웹 검색 사용
                    </span>
                    {(Array.isArray(message.webSearchSources)
                      ? message.webSearchSources
                      : []
                    ).map((source) => {
                      const safeUrl = getSafeSourceUrl(source?.url)
                      if (!safeUrl) return null
                      const sourceTitle =
                        typeof source.title === 'string' ? source.title : undefined
                      const sourceDomain =
                        typeof source.domain === 'string' ? source.domain : undefined
                      return (
                        <a
                          key={safeUrl}
                          href={safeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="max-w-[220px] truncate rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-white/52 transition hover:border-white/20 hover:text-white/78"
                          title={sourceTitle || safeUrl}
                        >
                          {sourceTitle || sourceDomain || '출처'}
                        </a>
                      )
                    })}
                  </div>
                )}
                {message.webSearchWarning && (
                  <p className="mt-3 border-l border-[#e8c98a]/35 pl-2.5 text-[10px] leading-5 text-[#f3ddb0]/60">
                    {message.webSearchWarning}
                  </p>
                )}
                {message.cctvs && (
                  <CctvResults
                    cctvs={message.cctvs}
                    search={message.cctvSearch}
                    coordinates={cctvLocation?.messageId === message.id ? cctvLocation.coordinates : undefined}
                  />
                )}
              </div>
            )}
          </motion.article>
        ))}
      </AnimatePresence>
      {isThinking && messages.at(-1)?.role !== 'assistant' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
          <MiraAvatar className="size-8 drop-shadow-[0_7px_14px_rgba(4,19,24,0.28)]" />
          {pendingLabel ? (
            <div className="inline-flex items-center gap-2 px-1 py-2.5 text-[11px] text-white/52">
              {/(?:위치|CCTV)/i.test(pendingLabel) ? (
                <MapPin className="size-3.5 animate-pulse text-[#c8f2e0]/75" strokeWidth={1.6} />
              ) : (
                <Globe2 className="size-3.5 animate-pulse text-[#c8f2e0]/75" strokeWidth={1.6} />
              )}
              {pendingLabel}
            </div>
          ) : (
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
          )}
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
  const [cctvLocation, setCctvLocation] = useState<CctvLocation | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('success')
  const [modelName, setModelName] = useState(
    () => window.localStorage.getItem(SELECTED_MODEL_STORAGE_KEY) ?? FALLBACK_MODELS[0],
  )
  const [availableModels, setAvailableModels] = useState<string[]>(FALLBACK_MODELS)
  const [modelMetadata, setModelMetadata] = useState<Record<string, PublicModelMetadata>>({})
  const [reasoningPreferences, setReasoningPreferences] = useState<Record<string, boolean>>(
    loadReasoningPreferences,
  )
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>(loadWebSearchMode)
  const [pendingLabel, setPendingLabel] = useState<string>()
  const [openModelPicker, setOpenModelPicker] = useState<'header' | 'composer' | null>(null)
  const [composerToolsOpen, setComposerToolsOpen] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerToolsRef = useRef<HTMLDivElement>(null)
  const messagesViewportRef = useRef<HTMLDivElement>(null)
  const messagesContentRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const requestControllerRef = useRef<AbortController | null>(null)
  const cctvRequestControllerRef = useRef<AbortController | null>(null)
  const operationGenerationRef = useRef(0)
  const selectedModelMetadata = modelMetadata[modelName]
  const supportsReasoning = Boolean(selectedModelMetadata?.capabilities.reasoningControl)
  const reasoningEnabled = supportsReasoning
    ? (reasoningPreferences[modelName] ?? modelName.endsWith(':thinking'))
    : false
  const contextUsage = useMemo(() => {
    const latestMessage = messages.at(-1)
    const reportedTokens =
      latestMessage?.role === 'assistant' && latestMessage.model === modelName
        ? latestMessage.usage
          ? Math.max(
              0,
              latestMessage.usage.totalTokens - (latestMessage.usage.reasoningTokens ?? 0),
            )
          : undefined
        : undefined
    const usedTokens = reportedTokens ?? estimateConversationTokens(messages)
    const draftTokens = draft.trim() ? estimateTextTokens(draft) + 4 : 0

    return {
      usedTokens: usedTokens + draftTokens,
      limit: selectedModelMetadata?.contextWindow ?? null,
    }
  }, [draft, messages, modelName, selectedModelMetadata?.contextWindow])
  const pricingLabel = useMemo(() => {
    const pricing = selectedModelMetadata?.pricing
    if (!pricing) return '요금 정보 없음'
    if (pricing.promptPerMillion === 0 && pricing.completionPerMillion === 0) return '무료 · 1M 토큰'
    return `IN ${formatPerMillionPrice(pricing.promptPerMillion)} · OUT ${formatPerMillionPrice(pricing.completionPerMillion)} / 1M`
  }, [selectedModelMetadata?.pricing])

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
        setComposerToolsOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!composerToolsOpen) return

    const closeOnPointerDown = (event: PointerEvent) => {
      if (composerToolsRef.current?.contains(event.target as Node)) return
      setComposerToolsOpen(false)
      setOpenModelPicker((current) => (current === 'composer' ? null : current))
    }

    document.addEventListener('pointerdown', closeOnPointerDown)
    return () => document.removeEventListener('pointerdown', closeOnPointerDown)
  }, [composerToolsOpen])

  useEffect(
    () => () => {
      operationGenerationRef.current += 1
      requestControllerRef.current?.abort()
    },
    [],
  )

  useEffect(() => {
    window.localStorage.setItem(
      CONVERSATIONS_STORAGE_KEY,
      JSON.stringify(getPersistableConversations(conversations)),
    )
  }, [conversations])

  useEffect(() => {
    window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, modelName)
  }, [modelName])

  useEffect(() => {
    window.localStorage.setItem(
      REASONING_PREFERENCES_STORAGE_KEY,
      JSON.stringify(reasoningPreferences),
    )
  }, [reasoningPreferences])

  useEffect(() => {
    window.localStorage.setItem(WEB_SEARCH_MODE_STORAGE_KEY, webSearchMode)
  }, [webSearchMode])

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
        return response.json() as Promise<{
          configured: boolean
          model: string
          models?: string[]
          modelMetadata?: Record<string, PublicModelMetadata>
        }>
      })
      .then((status) => {
        const models = status.models?.length ? status.models : FALLBACK_MODELS
        setConnectionStatus(status.configured ? 'success' : 'failure')
        setAvailableModels(models)
        setModelMetadata(status.modelMetadata ?? {})
        setModelName((current) => (models.includes(current) ? current : status.model))
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setConnectionStatus('failure')
      })

    return () => controller.abort()
  }, [])

  const newChat = () => {
    setCctvLocation(null)
    operationGenerationRef.current += 1
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    cctvRequestControllerRef.current = null
    setActiveConversationId(null)
    setMessages([])
    setDraft('')
    setIsThinking(false)
    setPendingLabel(undefined)
    setComposerToolsOpen(false)
    setOpenModelPicker(null)
    stickToBottomRef.current = true
    setSidebarOpen(false)
    window.setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const selectConversation = (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId)
    if (!conversation) return
    setCctvLocation(null)

    operationGenerationRef.current += 1
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    cctvRequestControllerRef.current = null
    setActiveConversationId(conversation.id)
    setMessages(conversation.messages)
    setDraft('')
    setIsThinking(false)
    setPendingLabel(undefined)
    setComposerToolsOpen(false)
    setOpenModelPicker(null)
    stickToBottomRef.current = true
    setSidebarOpen(false)
    setWorkspaceOpen(true)
  }

  const deleteConversation = (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId)
    if (!conversation || !window.confirm(`“${conversation.title}” 대화를 삭제할까요?`)) return

    setConversations((current) => current.filter((item) => item.id !== conversationId))

    if (conversationId === activeConversationId) {
      setCctvLocation(null)
      operationGenerationRef.current += 1
      requestControllerRef.current?.abort()
      requestControllerRef.current = null
      cctvRequestControllerRef.current = null
      setActiveConversationId(null)
      setMessages([])
      setDraft('')
      setIsThinking(false)
      setPendingLabel(undefined)
      setComposerToolsOpen(false)
      setOpenModelPicker(null)
    }
  }

  const submitCctvMessage = async (content: string) => {
    const normalizedContent = content.trim()
    if (!normalizedContent || isThinking) return
    const searchQuery = getCctvSearchQuery(normalizedContent)

    const operationGeneration = operationGenerationRef.current + 1
    setCctvLocation(null)
    operationGenerationRef.current = operationGeneration
    requestControllerRef.current?.abort()

    const messageId = Date.now()
    const assistantId = messageId + 1
    const userMessage: ChatMessage = {
      id: messageId,
      role: 'user',
      content: normalizedContent,
      tokenEstimate: estimateTextTokens(normalizedContent),
    }
    const requestMessages = [...messages, userMessage]
    const conversationId = activeConversationId ?? crypto.randomUUID()
    const controller = new AbortController()

    if (!activeConversationId) setActiveConversationId(conversationId)
    requestControllerRef.current = controller
    stickToBottomRef.current = true
    setMessages(requestMessages)
    setDraft('')
    setIsThinking(true)
    setPendingLabel(searchQuery ? '요청한 도로의 CCTV를 찾는 중…' : '현재 위치를 확인 중…')
    cctvRequestControllerRef.current = controller
    setComposerToolsOpen(false)
    setOpenModelPicker(null)

    try {
      if (searchQuery) {
        const result = await fetchCctvsByName(searchQuery, controller.signal)
        if (controller.signal.aborted || operationGenerationRef.current !== operationGeneration) return
        setMessages((current) => [...current, {
          id: assistantId, role: 'assistant',
          content: result.total
            ? `“${result.query}”에 일치하는 ITS CCTV ${result.total}곳${result.total > result.cctvs.length ? ` 중 ${result.cctvs.length}곳` : ''}입니다.`
            : `“${result.query}”에 일치하는 ITS CCTV를 찾지 못했습니다. 도로명이나 CCTV 이름을 확인해 주세요.`,
          tokenEstimate: 32,
          cctvs: result.cctvs,
          cctvSearch: { query: result.query, total: result.total },
        }])
        return
      }
      const coordinates = await getCurrentCoordinates()
      if (operationGenerationRef.current !== operationGeneration) return

      setPendingLabel('주변 CCTV를 찾는 중…')
      const result = await fetchNearbyCctvs(coordinates, {
        signal: controller.signal,
        radiusKm: CCTV_RADIUS_METERS / 1_000,
        limit: CCTV_LIMIT,
      })
      if (operationGenerationRef.current !== operationGeneration) return

      const count = result.cctvs.length
      setCctvLocation({ messageId: assistantId, coordinates })
      setMessages((current) => [
        ...current.filter((message) => message.id !== assistantId),
        {
          id: assistantId,
          role: 'assistant',
          content:
            count > 0
              ? `현재 위치 반경 2km 안의 ITS 도로 CCTV ${count}곳을 거리순으로 찾았습니다.`
              : '현재 위치 반경 2km 안의 ITS 도로 CCTV 조회 결과입니다.',
          tokenEstimate: 24,
          cctvs: result.cctvs,
        },
      ])
    } catch (error) {
      if (
        controller.signal.aborted ||
        operationGenerationRef.current !== operationGeneration ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        return
      }

      const errorMessage =
        error instanceof CctvClientError
          ? error.message
          : '주변 CCTV를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'
      setMessages((current) => [
        ...current.filter((message) => message.id !== assistantId),
        {
          id: assistantId,
          role: 'assistant',
          content: errorMessage,
          tokenEstimate: estimateTextTokens(errorMessage),
        },
      ])
    } finally {
      if (cctvRequestControllerRef.current === controller) cctvRequestControllerRef.current = null
      if (operationGenerationRef.current === operationGeneration) {
        if (requestControllerRef.current === controller) requestControllerRef.current = null
        setIsThinking(false)
        setPendingLabel(undefined)
      }
    }
  }

  const submitMessage = async (event?: FormEvent) => {
    event?.preventDefault()
    const content = draft.trim()
    if (!content || isThinking) return

    if (isExplicitCctvIntent(content)) {
      await submitCctvMessage(content)
      return
    }

    const requestModel = modelName
    const requestSupportsReasoning = Boolean(
      modelMetadata[requestModel]?.capabilities.reasoningControl,
    )
    const requestReasoningEnabled = requestSupportsReasoning ? reasoningEnabled : false
    const requestWebSearchMode = webSearchMode
    const messageId = Date.now()
    const assistantId = messageId + 1
    const userMessage: ChatMessage = {
      id: messageId,
      role: 'user',
      content,
      tokenEstimate: estimateTextTokens(content),
      webSearchMode: requestWebSearchMode,
    }
    const requestMessages = [...messages, userMessage]
    const conversationId = activeConversationId ?? crypto.randomUUID()

    if (!activeConversationId) setActiveConversationId(conversationId)
    stickToBottomRef.current = true
    setMessages(requestMessages)
    setDraft('')
    setIsThinking(true)
    setComposerToolsOpen(false)
    setOpenModelPicker(null)
    setPendingLabel(
      requestWebSearchMode === 'on'
        ? '웹에서 검색 중…'
        : requestWebSearchMode === 'auto'
          ? '검색 필요 여부를 확인 중…'
          : undefined,
    )

    const controller = new AbortController()
    requestControllerRef.current = controller
    let assistantContent = ''
    let assistantTokenEstimate = 0
    let assistantAsciiCharacters = 0
    let assistantNonAsciiCharacters = 0
    let assistantUsage: TokenUsage | undefined
    let assistantWebSearchMeta: MiraWebSearchMetadata | undefined
    let renderFrame = 0

    const renderAssistantContent = () => {
      renderFrame = 0
      setMessages((current) => {
        const assistantExists = current.some((message) => message.id === assistantId)
        if (!assistantExists) {
          return [
            ...current,
            {
              id: assistantId,
              role: 'assistant',
              content: assistantContent,
              model: requestModel,
              usage: assistantUsage,
              tokenEstimate: assistantTokenEstimate,
              webSearchMode: requestWebSearchMode,
              webSearchStatus: assistantWebSearchMeta?.status,
              webSearchSources: assistantWebSearchMeta?.sources,
              webSearchWarning: assistantWebSearchMeta?.warning,
            },
          ]
        }
        return current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: assistantContent,
                model: requestModel,
                usage: assistantUsage,
                tokenEstimate: assistantTokenEstimate,
                webSearchMode: requestWebSearchMode,
                webSearchStatus: assistantWebSearchMeta?.status,
                webSearchSources: assistantWebSearchMeta?.sources,
                webSearchWarning: assistantWebSearchMeta?.warning,
              }
            : message,
        )
      })
    }

    const appendAssistantContent = (contentDelta: string) => {
      setPendingLabel(undefined)
      assistantContent += contentDelta
      for (const character of contentDelta) {
        if (character.codePointAt(0)! <= 0x7f) assistantAsciiCharacters += 1
        else assistantNonAsciiCharacters += 1
      }
      assistantTokenEstimate = Math.ceil(
        assistantAsciiCharacters / 4 + assistantNonAsciiCharacters,
      )
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
          model: requestModel,
          messages: requestMessages.map(({ role, content: messageContent, webSearchMode: sentMode, webSearchStatus }) => ({
            role,
            content: messageContent,
            ...(sentMode ? { webSearchMode: sentMode } : {}),
            ...(webSearchStatus ? { webSearchStatus } : {}),
          })),
          reasoningEnabled: requestSupportsReasoning ? requestReasoningEnabled : undefined,
          webSearchMode: requestWebSearchMode,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(errorBody?.error ?? '응답을 가져오지 못했습니다.')
      }
      if (!response.body) throw new Error('스트리밍 응답을 읽을 수 없습니다.')

      await consumeChatStream(response.body, {
        onMeta(metadata) {
          assistantWebSearchMeta = metadata
          setPendingLabel(metadata.status === 'used' ? '웹에서 검색 중…' : undefined)
          if (assistantContent) renderAssistantContent()
        },
        onUsage(usage) {
          assistantUsage = {
            promptTokens: usage.inputTokens,
            completionTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            ...(usage.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: usage.reasoningTokens }),
          }
        },
        onContent: appendAssistantContent,
      })

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
          {
            id: assistantId,
            role: 'assistant',
            content: `오류: ${errorMessage}`,
            model: requestModel,
            tokenEstimate: estimateTextTokens(errorMessage) + 3,
            webSearchMode: requestWebSearchMode,
            webSearchStatus: assistantWebSearchMeta?.status,
            webSearchSources: assistantWebSearchMeta?.sources,
            webSearchWarning: assistantWebSearchMeta?.warning,
          },
        ]
      })
    } finally {
      if (renderFrame) window.cancelAnimationFrame(renderFrame)
      if (requestControllerRef.current === controller) requestControllerRef.current = null
      setIsThinking(false)
      setPendingLabel(undefined)
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
                    onClick={() => {
                      setSidebarOpen(true)
                      setComposerToolsOpen(false)
                      setOpenModelPicker(null)
                    }}
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
                      onOpenChange={(open) => {
                        setOpenModelPicker(open ? 'header' : null)
                        if (open) setComposerToolsOpen(false)
                      }}
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
                    setCctvLocation(null)
                    if (cctvRequestControllerRef.current && cctvRequestControllerRef.current === requestControllerRef.current) {
                      operationGenerationRef.current += 1
                      cctvRequestControllerRef.current.abort()
                      cctvRequestControllerRef.current = null
                      requestControllerRef.current = null
                      setIsThinking(false)
                      setPendingLabel(undefined)
                    }
                    setSidebarOpen(false)
                    setOpenModelPicker(null)
                    setComposerToolsOpen(false)
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
                    <MessageList
                      messages={messages}
                      isThinking={isThinking}
                      pendingLabel={pendingLabel}
                      cctvLocation={cctvLocation}
                    />
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
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <div ref={composerToolsRef} className="relative shrink-0">
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setOpenModelPicker(null)
                            setComposerToolsOpen((current) => !current)
                          }}
                          aria-haspopup="true"
                          aria-expanded={composerToolsOpen}
                          aria-controls="composer-tools-menu"
                          aria-label={composerToolsOpen ? '채팅 도구 닫기' : '채팅 도구 열기'}
                          title={composerToolsOpen ? '채팅 도구 닫기' : '채팅 도구 열기'}
                          className={`grid size-9 shrink-0 place-items-center rounded-full border transition duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#c8f2e0]/40 ${
                            composerToolsOpen
                              ? 'border-[#c8f2e0]/38 bg-[#c8f2e0]/14 text-[#e2faf0] shadow-[0_8px_22px_rgba(4,20,25,0.2)]'
                              : 'border-white/15 bg-white/[0.075] text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] hover:border-white/25 hover:bg-white/[0.11] hover:text-white'
                          }`}
                        >
                          <Plus
                            className={`size-[17px] transition-transform duration-200 ${composerToolsOpen ? 'rotate-45' : ''}`}
                            strokeWidth={1.8}
                          />
                        </button>

                        <AnimatePresence>
                          {composerToolsOpen && (
                            <motion.div
                              id="composer-tools-menu"
                              initial={{ opacity: 0, y: 6, scale: 0.98 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: 6, scale: 0.98 }}
                              transition={{ duration: prefersReducedMotion ? 0 : 0.16 }}
                              role="group"
                              aria-label="채팅 도구"
                              className="composer-tools-menu absolute bottom-[calc(100%+10px)] left-0 z-[70] w-[220px] space-y-1.5 rounded-[19px] p-2"
                            >
                              <ModelPicker
                                compact
                                placement="above"
                                value={modelName}
                                models={availableModels}
                                onChange={(model) => {
                                  setModelName(model)
                                  setComposerToolsOpen(false)
                                }}
                                open={openModelPicker === 'composer'}
                                onOpenChange={(open) =>
                                  setOpenModelPicker(open ? 'composer' : null)
                                }
                              />
                              <button
                                type="button"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  setReasoningPreferences((current) => ({
                                    ...current,
                                    [modelName]: !reasoningEnabled,
                                  }))
                                }}
                                disabled={isThinking || !supportsReasoning}
                                aria-pressed={supportsReasoning ? reasoningEnabled : undefined}
                                aria-label={
                                  supportsReasoning
                                    ? `심화 추론 ${reasoningEnabled ? '끄기' : '켜기'}`
                                    : '심화 추론을 지원하지 않는 모델'
                                }
                                title={
                                  supportsReasoning
                                    ? `심화 추론: ${reasoningEnabled ? '켜짐' : '꺼짐'} · 추론 토큰은 출력 요금에 포함됩니다`
                                    : '현재 모델은 심화 추론 제어를 지원하지 않습니다'
                                }
                                className={`flex h-10 w-full items-center gap-2 rounded-[14px] border p-1 pr-3 text-left transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#c8f2e0]/40 disabled:cursor-not-allowed disabled:opacity-35 ${
                                  reasoningEnabled
                                    ? 'border-[#c8f2e0]/28 bg-[#c8f2e0]/10 text-[#d9f7e9]'
                                    : 'border-white/10 bg-white/[0.045] text-white/58 hover:border-white/18 hover:bg-white/[0.07] hover:text-white/82'
                                }`}
                              >
                                <span className="relative grid size-7 shrink-0 place-items-center rounded-full border border-current/15 bg-white/[0.035]">
                                  <BrainCircuit className="size-3.5" strokeWidth={1.65} />
                                  <span
                                    className={`absolute right-0.5 top-0.5 size-1 rounded-full ${
                                      reasoningEnabled ? 'bg-[#c8f2e0]' : 'bg-white/20'
                                    }`}
                                  />
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.02em]">
                                  심화 추론
                                </span>
                                <span className="text-[10px] font-semibold text-current/55">
                                  {supportsReasoning ? (reasoningEnabled ? 'ON' : 'OFF') : '미지원'}
                                </span>
                              </button>
                              <button
                                type="button"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  setWebSearchMode((current) => getNextWebSearchMode(current))
                                }}
                                disabled={isThinking}
                                aria-label={`웹 검색: ${WEB_SEARCH_MODE_PRESENTATION[webSearchMode].label}. ${WEB_SEARCH_MODE_PRESENTATION[webSearchMode].description}`}
                                title={`웹 검색: ${WEB_SEARCH_MODE_PRESENTATION[webSearchMode].label} · 클릭하여 변경`}
                                className={`flex h-10 w-full items-center gap-2 rounded-[14px] border p-1 pr-3 text-left transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#c8f2e0]/40 disabled:cursor-not-allowed disabled:opacity-40 ${
                                  webSearchMode === 'on'
                                    ? 'border-[#c8f2e0]/34 bg-[#c8f2e0]/12 text-[#d9f7e9]'
                                    : webSearchMode === 'off'
                                      ? 'border-white/8 bg-white/[0.025] text-white/38 hover:border-white/15 hover:text-white/58'
                                      : 'border-white/12 bg-white/[0.055] text-white/62 hover:border-white/20 hover:bg-white/[0.075] hover:text-white/82'
                                }`}
                              >
                                <span className="relative grid size-7 shrink-0 place-items-center rounded-full border border-current/15 bg-white/[0.035]">
                                  <Globe2 className="size-3.5" strokeWidth={1.6} />
                                  <span
                                    aria-hidden="true"
                                    className={`absolute -right-0.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full border px-0.5 text-[7px] font-bold leading-3 ${
                                      webSearchMode === 'on'
                                        ? 'border-[#d8f4e8]/25 bg-[#c8f2e0] text-[#16353a]'
                                        : 'border-white/12 bg-[#29484d] text-white/62'
                                    }`}
                                  >
                                    {WEB_SEARCH_MODE_PRESENTATION[webSearchMode].badge}
                                  </span>
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.02em]">
                                  웹 서치
                                </span>
                                <span className="text-[10px] font-semibold text-current/55">
                                  {WEB_SEARCH_MODE_PRESENTATION[webSearchMode].label}
                                </span>
                              </button>
                              <button
                                type="button"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => void submitCctvMessage('내 주변 CCTV 보여줘')}
                                disabled={isThinking}
                                aria-label="현재 위치에서 가까운 ITS 도로 CCTV 찾기"
                                title="현재 위치를 한 번 확인해 가까운 ITS CCTV를 찾습니다"
                                className="flex h-10 w-full items-center gap-2 rounded-[14px] border border-white/10 bg-white/[0.045] p-1 pr-3 text-left text-white/58 transition hover:border-white/18 hover:bg-white/[0.07] hover:text-white/82 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#c8f2e0]/40 disabled:cursor-not-allowed disabled:opacity-35"
                              >
                                <span className="relative grid size-7 shrink-0 place-items-center rounded-full border border-current/15 bg-white/[0.035]">
                                  <MapPin className="size-3.5" strokeWidth={1.65} />
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.02em]">
                                  주변 CCTV
                                </span>
                                <span className="text-[10px] font-semibold text-current/55">ITS</span>
                              </button>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                      <p
                        className="min-w-0 truncate px-1 text-[12px] font-semibold tracking-[-0.015em] text-white/75"
                        title={`${modelName} 요금: ${pricingLabel}`}
                      >
                        {pricingLabel}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <ContextMeter usedTokens={contextUsage.usedTokens} limit={contextUsage.limit} />
                      <button
                        type="submit"
                        onMouseDown={(event) => event.preventDefault()}
                        disabled={!draft.trim() || isThinking}
                        aria-label="메시지 보내기"
                        className="grid size-9 shrink-0 place-items-center rounded-2xl bg-[#edf7f3] text-[#16353a] shadow-[0_8px_20px_rgba(7,29,35,0.2)] transition hover:-translate-y-0.5 hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        <ArrowUp className="size-[17px]" strokeWidth={2} />
                      </button>
                    </div>
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
