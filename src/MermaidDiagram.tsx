import { useEffect, useId, useState } from 'react'

const MAX_SOURCE_BYTES = 12 * 1024
const MAX_SOURCE_LINES = 250

const blockedSourcePatterns = [
  /%%\s*\{/i,
  /<\s*\/?\s*(?:script|iframe|object|embed|foreignobject)\b/i,
  /\bjavascript\s*:/i,
  /(?:^|\r?\n)\s*click\s+\S+/i,
  /\bhref\b/i,
  /\bon(?:load|error|click)\s*=/i,
]

type MermaidApi = (typeof import('mermaid'))['default']

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string }

let mermaidLoader: Promise<MermaidApi> | undefined
let renderSequence = 0

function loadMermaid() {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      htmlLabels: false,
      suppressErrorRendering: true,
    })

    return mermaid
  })

  return mermaidLoader
}

function validateSource(source: string) {
  if (!source.trim()) return '비어 있는 다이어그램입니다.'
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    return '다이어그램 소스가 12KB 제한을 초과했습니다.'
  }
  if (source.split(/\r\n?|\n/).length > MAX_SOURCE_LINES) {
    return `다이어그램 소스가 ${MAX_SOURCE_LINES}줄 제한을 초과했습니다.`
  }
  if (blockedSourcePatterns.some((pattern) => pattern.test(source))) {
    return '안전하지 않은 지시문 또는 링크 패턴이 포함되어 있습니다.'
  }

  return null
}

export default function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [state, setState] = useState<RenderState>({ status: 'loading' })

  useEffect(() => {
    const validationError = validateSource(source)
    if (validationError) {
      setState({ status: 'error', message: validationError })
      return
    }

    let cancelled = false
    let objectUrl: string | undefined
    const renderId = `mermaid-${reactId}-${renderSequence++}`

    setState({ status: 'loading' })

    void loadMermaid()
      .then((mermaid) => mermaid.render(renderId, source))
      .then(({ svg }) => {
        if (cancelled) return

        objectUrl = URL.createObjectURL(
          new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
        )
        setState({ status: 'ready', url: objectUrl })
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: '다이어그램을 렌더링할 수 없습니다. Mermaid 문법을 확인해 주세요.',
          })
        }
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [reactId, source])

  if (state.status === 'ready') {
    return (
      <figure
        className="my-4 overflow-hidden rounded-2xl border border-white/10 bg-[#071a1d]/75 p-3 shadow-lg"
        aria-label="Mermaid 다이어그램"
      >
        <img
          className="block max-h-[32rem] w-full object-contain"
          src={state.url}
          alt="AI가 생성한 Mermaid 다이어그램"
          onError={() => {
            URL.revokeObjectURL(state.url)
            setState({
              status: 'error',
              message: '생성된 다이어그램 이미지를 표시할 수 없습니다.',
            })
          }}
        />
      </figure>
    )
  }

  if (state.status === 'loading') {
    return (
      <div
        className="my-4 rounded-2xl border border-white/10 bg-[#071a1d]/65 px-4 py-5 text-sm text-white/55"
        role="status"
        aria-live="polite"
      >
        다이어그램을 그리는 중…
      </div>
    )
  }

  return (
    <figure className="my-4 overflow-hidden rounded-2xl border border-amber-200/15 bg-[#071a1d]/75">
      <figcaption className="border-b border-white/10 px-4 py-3 text-xs text-amber-100/75">
        {state.message}
      </figcaption>
      <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-5 text-white/70">
        <code>{source}</code>
      </pre>
    </figure>
  )
}
