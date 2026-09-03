import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import MermaidDiagram from './MermaidDiagram'

type MarkdownSegment =
  | { type: 'markdown'; content: string }
  | { type: 'mermaid'; content: string }

const closedMermaidFence =
  /(?:^|\r?\n) {0,3}```[\t ]*mermaid[\t ]*\r?\n([\s\S]*?)(?:\r?\n) {0,3}```[\t ]*(?=\r?\n|$)/gi

const MAX_RENDERED_DIAGRAMS = 3
const MAX_TOTAL_DIAGRAM_BYTES = 24 * 1024

function splitMermaidBlocks(content: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  const encoder = new TextEncoder()
  let cursor = 0
  let renderedDiagrams = 0
  let renderedBytes = 0

  for (const match of content.matchAll(closedMermaidFence)) {
    const matchIndex = match.index
    if (matchIndex > cursor) {
      segments.push({ type: 'markdown', content: content.slice(cursor, matchIndex) })
    }
    const sourceBytes = encoder.encode(match[1]).byteLength
    const canRender =
      renderedDiagrams < MAX_RENDERED_DIAGRAMS &&
      renderedBytes + sourceBytes <= MAX_TOTAL_DIAGRAM_BYTES

    if (canRender) {
      segments.push({ type: 'mermaid', content: match[1] })
      renderedDiagrams += 1
      renderedBytes += sourceBytes
    } else {
      segments.push({ type: 'markdown', content: match[0] })
    }
    cursor = matchIndex + match[0].length
  }

  if (cursor < content.length || segments.length === 0) {
    segments.push({ type: 'markdown', content: content.slice(cursor) })
  }

  return segments
}

export default function MarkdownResponse({ content }: { content: string }) {
  return splitMermaidBlocks(content).map((segment, index) =>
    segment.type === 'mermaid' ? (
      <MermaidDiagram key={`mermaid-${index}`} source={segment.content} />
    ) : (
      <ReactMarkdown key={`markdown-${index}`} remarkPlugins={[remarkGfm, remarkBreaks]}>
        {segment.content}
      </ReactMarkdown>
    ),
  )
}
