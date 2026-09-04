import { fromMarkdown } from 'mdast-util-from-markdown'

type SourceRange = { start: number; end: number }

const maxMathNormalizationCharacters = 200_000
const maxMarkdownStructureMarkers = 512

type PositionedNode = {
  type: string
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
  children?: PositionedNode[]
}

const protectedNodeTypes = new Set([
  'code',
  'definition',
  'html',
  'image',
  'imageReference',
  'inlineCode',
])

function isEscaped(value: string, index: number) {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function isLineBreak(value: string | undefined) {
  return value === '\n' || value === '\r'
}

function joinWithoutDollarCollision(left: string, right: string) {
  return left.endsWith('$') && right.startsWith('$') ? left + ' ' + right : left + right
}

function mergeRanges(ranges: SourceRange[]) {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: SourceRange[] = []

  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || range.start > previous.end) {
      merged.push({ ...range })
    } else if (range.end > previous.end) {
      previous.end = range.end
    }
  }

  return merged
}

function collectProtectedNodeRanges(
  node: PositionedNode,
  ranges: SourceRange[],
  content: string,
) {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (
    (node.type === 'link' || node.type === 'linkReference') &&
    typeof start === 'number' &&
    typeof end === 'number'
  ) {
    const rawLink = content.slice(start, end)
    const lastChildEnd = node.children?.at(-1)?.position?.end.offset

    // Autolinks have no separate Markdown label whose math should be rendered.
    if (rawLink.startsWith('<') || typeof lastChildEnd !== 'number') {
      ranges.push({ start, end })
      return
    }

    // Keep the destination/reference suffix opaque while allowing math in the label.
    if (lastChildEnd < end) ranges.push({ start: lastChildEnd, end })
    for (const child of node.children ?? []) {
      collectProtectedNodeRanges(child, ranges, content)
    }
    return
  }

  if (
    protectedNodeTypes.has(node.type) &&
    typeof start === 'number' &&
    typeof end === 'number'
  ) {
    ranges.push({ start, end })
    return
  }

  for (const child of node.children ?? []) {
    collectProtectedNodeRanges(child, ranges, content)
  }
}

function mightContainProtectedMarkdown(content: string) {
  return (
    content.includes('`') ||
    content.includes('[') ||
    content.includes('<') ||
    content.includes('\t') ||
    content.includes('    ') ||
    content.includes('~~~')
  )
}

function hasPotentialMathSyntax(content: string) {
  return (
    content.includes('$') ||
    content.includes('\\(') ||
    content.includes('\\)') ||
    content.includes('\\[') ||
    content.includes('\\]')
  )
}

function isTooComplexToNormalize(content: string) {
  if (content.length > maxMathNormalizationCharacters) return true

  let structureMarkers = 0
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    const isOrderedListMarker =
      (character === '.' || character === ')') &&
      /\d/.test(content[index - 1] ?? '') &&
      /[\t ]/.test(content[index + 1] ?? '')
    if ('[]`<>-+*~_'.includes(character) || isOrderedListMarker) {
      structureMarkers += 1
      if (structureMarkers > maxMarkdownStructureMarkers) return true
    }
  }
  return false
}

function isInsideRanges(index: number, ranges: SourceRange[]) {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function collectUnclosedCodeSpanRange(content: string, ranges: SourceRange[]) {
  let cursor = 0

  while (cursor < content.length) {
    const opening = content.indexOf('`', cursor)
    if (opening === -1) return
    if (isEscaped(content, opening) || isInsideRanges(opening, ranges)) {
      cursor = opening + 1
      continue
    }

    let openingEnd = opening
    while (content[openingEnd] === '`') openingEnd += 1
    const runLength = openingEnd - opening
    let search = openingEnd
    let closingEnd = -1

    while (search < content.length) {
      const candidate = content.indexOf('`', search)
      if (candidate === -1) break
      let candidateEnd = candidate
      while (content[candidateEnd] === '`') candidateEnd += 1
      if (
        !isEscaped(content, candidate) &&
        candidateEnd - candidate === runLength
      ) {
        closingEnd = candidateEnd
        break
      }
      search = candidateEnd
    }

    if (closingEnd === -1) {
      ranges.push({ start: opening, end: content.length })
      return
    }
    cursor = closingEnd
  }
}

function collectUnclosedLinkDestinationRange(content: string, ranges: SourceRange[]) {
  const labelStarts: number[] = []
  let rangeIndex = 0

  for (let cursor = 0; cursor < content.length; cursor += 1) {
    while (ranges[rangeIndex] && cursor >= ranges[rangeIndex].end) {
      rangeIndex += 1
    }
    const protectedRange = ranges[rangeIndex]
    if (
      protectedRange &&
      cursor >= protectedRange.start &&
      cursor < protectedRange.end
    ) {
      cursor = protectedRange.end - 1
      continue
    }

    if (isLineBreak(content[cursor])) {
      let nextLine = cursor + 1
      if (content[cursor] === '\r' && content[nextLine] === '\n') nextLine += 1
      while (content[nextLine] === ' ' || content[nextLine] === '\t') nextLine += 1
      if (isLineBreak(content[nextLine])) labelStarts.length = 0
      continue
    }
    if (content[cursor] === '[' && !isEscaped(content, cursor)) {
      labelStarts.push(cursor)
      continue
    }
    if (
      labelStarts.length === 0 ||
      content[cursor] !== ']' ||
      isEscaped(content, cursor)
    ) {
      continue
    }
    if (content[cursor + 1] !== '(') {
      labelStarts.pop()
      continue
    }

    let depth = 1
    let destinationCursor = cursor + 2
    for (; destinationCursor < content.length; destinationCursor += 1) {
      const character = content[destinationCursor]
      if (character === '(' && !isEscaped(content, destinationCursor)) depth += 1
      if (character === ')' && !isEscaped(content, destinationCursor)) {
        depth -= 1
        if (depth === 0) break
      }
    }

    if (depth > 0) {
      ranges.push({ start: cursor + 2, end: content.length })
      return
    }
    labelStarts.length = 0
    cursor = destinationCursor
  }
}

function getProtectedRanges(content: string) {
  const ranges: SourceRange[] = []
  if (mightContainProtectedMarkdown(content)) {
    try {
      collectProtectedNodeRanges(fromMarkdown(content) as PositionedNode, ranges, content)
    } catch {
      // Streaming can temporarily produce invalid Markdown; the linear guards below
      // still keep incomplete code/link fragments stable until parsing succeeds.
    }
  }

  let protectedRanges = mergeRanges(ranges)
  const bareUrlPattern =
    /\b(?:https?:\/\/|mailto:|www\.)[^\s<>\u0000-\u001f]+/gi
  const urlRanges: SourceRange[] = []
  let markdownRangeIndex = 0
  for (const match of content.matchAll(bareUrlPattern)) {
    while (
      protectedRanges[markdownRangeIndex] &&
      match.index >= protectedRanges[markdownRangeIndex].end
    ) {
      markdownRangeIndex += 1
    }
    const markdownRange = protectedRanges[markdownRangeIndex]
    if (
      !markdownRange ||
      match.index < markdownRange.start ||
      match.index >= markdownRange.end
    ) {
      urlRanges.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  protectedRanges = mergeRanges([...protectedRanges, ...urlRanges])
  collectUnclosedCodeSpanRange(content, protectedRanges)
  protectedRanges = mergeRanges(protectedRanges)
  collectUnclosedLinkDestinationRange(content, protectedRanges)
  return mergeRanges(protectedRanges)
}

function getContainerContinuation(prefix: string) {
  let continuation = ''
  let cursor = 0
  let sawListMarker = false

  while (cursor < prefix.length) {
    const whitespace = prefix.slice(cursor).match(/^[\t ]+/)?.[0]
    if (whitespace) {
      continuation += whitespace
      cursor += whitespace.length
      continue
    }

    if (prefix[cursor] === '>') {
      continuation += '>'
      cursor += 1
      if (prefix[cursor] === ' ' || prefix[cursor] === '\t') {
        continuation += prefix[cursor]
        cursor += 1
      }
      continue
    }

    const listMarker = prefix
      .slice(cursor)
      .match(/^(?:[-+*]|\d+[.)])[\t ]+/)?.[0]
    if (listMarker) {
      continuation += ' '.repeat(listMarker.length)
      cursor += listMarker.length
      sawListMarker = true
      continue
    }

    const taskMarker = sawListMarker
      ? prefix.slice(cursor).match(/^\[[ xX]\][\t ]+/)?.[0]
      : undefined
    if (taskMarker) {
      continuation += ' '.repeat(taskMarker.length)
      cursor += taskMarker.length
      continue
    }

    return null
  }

  return continuation
}

function getTaskListContinuation(prefix: string) {
  const taskPrefix = prefix.match(
    /^(.*(?:[-+*]|\d+[.)])[\t ]+)\[[ xX]\][\t ]*$/,
  )?.[1]
  return taskPrefix === undefined ? null : getContainerContinuation(taskPrefix)
}

function formatDisplayBlock(prefix: string, math: string, newline: string) {
  const continuation = getContainerContinuation(prefix)
  if (continuation === null) return null

  const taskContinuation = getTaskListContinuation(prefix)
  if (taskContinuation !== null) {
    return (
      prefix.trimEnd() +
      newline +
      newline +
      taskContinuation +
      '$$' +
      newline +
      taskContinuation +
      math.trim() +
      newline +
      taskContinuation +
      '$$'
    )
  }

  return (
    prefix +
    '$$' +
    newline +
    continuation +
    math.trim() +
    newline +
    continuation +
    '$$'
  )
}

function normalizeStandaloneDollarDisplay(
  value: string,
  startsAtLineBoundary: boolean,
  endsAtLineBoundary: boolean,
) {
  if (!value.includes('$$')) return value

  const leadingGuard = startsAtLineBoundary ? '' : '\uE000'
  const trailingGuard = endsAtLineBoundary ? '' : '\uE001'
  const guarded = leadingGuard + value + trailingGuard
  const newline = value.includes('\r\n') ? '\r\n' : '\n'
  const pattern =
    /(^|(?:\r\n|\r|\n))([^\r\n]*?)\$\$(?!\$)([^\r\n]+?)(?<!\$)\$\$[\t ]*(?=(?:\r\n|\r|\n)|$)/g
  let normalized = guarded.replace(
    pattern,
    (match, boundary: string, prefix: string, math: string) => {
      const block = formatDisplayBlock(prefix, math, newline)
      return block === null ? match : boundary + block
    },
  )

  if (leadingGuard) normalized = normalized.slice(leadingGuard.length)
  if (trailingGuard) normalized = normalized.slice(0, -trailingGuard.length)
  return normalized
}

function findBackslashDelimiter(value: string, delimiter: string, start: number) {
  for (let index = start; index < value.length - 1; index += 1) {
    if (
      value[index] === '\\' &&
      value[index + 1] === delimiter &&
      !isEscaped(value, index)
    ) {
      return index
    }
  }
  return -1
}

function replacePairedBackslashMath(
  value: string,
  openingDelimiter: '(' | '[',
  closingDelimiter: ')' | ']',
  display: boolean,
) {
  let normalized = ''
  let cursor = 0
  const newline = value.includes('\r\n') ? '\r\n' : '\n'

  while (cursor < value.length) {
    const opening = findBackslashDelimiter(value, openingDelimiter, cursor)
    if (opening === -1) {
      normalized += value.slice(cursor)
      break
    }
    const closing = findBackslashDelimiter(value, closingDelimiter, opening + 2)
    if (closing === -1) {
      normalized += value.slice(cursor)
      break
    }

    const between = value.slice(cursor, opening)
    normalized += between
    const math = value.slice(opening + 2, closing)
    if (!display) {
      normalized = joinWithoutDollarCollision(normalized, '$$' + math + '$$')
    } else {
      const previousNewline = Math.max(
        value.lastIndexOf('\n', opening),
        value.lastIndexOf('\r', opening),
      )
      let nextNewline = value.length
      for (let index = closing + 2; index < value.length; index += 1) {
        if (isLineBreak(value[index])) {
          nextNewline = index
          break
        }
      }
      const prefix = value.slice(previousNewline + 1, opening)
      const suffix = value.slice(closing + 2, nextNewline)
      const displayBlock = formatDisplayBlock(prefix, math, newline)
      const isIsolated = displayBlock !== null && /^[\t ]*$/.test(suffix)

      if (isIsolated) {
        const beforePrefix = prefix.length
          ? normalized.slice(0, -prefix.length)
          : normalized
        normalized = joinWithoutDollarCollision(beforePrefix, displayBlock)
      } else {
        normalized = joinWithoutDollarCollision(normalized, '$$' + math + '$$')
      }
    }
    if (value[closing + 2] === '$') normalized += ' '
    cursor = closing + 2
  }

  return normalized
}

function escapeUnpairedBackslashDelimiters(value: string) {
  let normalized = ''

  for (let index = 0; index < value.length; index += 1) {
    const next = value[index + 1]
    if (
      value[index] === '\\' &&
      (next === '(' || next === ')' || next === '[' || next === ']') &&
      !isEscaped(value, index)
    ) {
      normalized += '\\\\' + next
      index += 1
    } else {
      normalized += value[index]
    }
  }

  return normalized
}

function findSingleDollar(value: string, start: number, stopAtLineBreak: boolean) {
  for (let index = start; index < value.length; index += 1) {
    if (stopAtLineBreak && isLineBreak(value[index])) return -1
    if (
      value[index] === '$' &&
      value[index - 1] !== '$' &&
      value[index + 1] !== '$' &&
      !isEscaped(value, index)
    ) {
      return index
    }
  }
  return -1
}

function looksLikeInlineMath(value: string, nextCharacter: string | undefined) {
  if (!value || value.trim() !== value || /^\d+(?:[.,]\d+)?$/.test(value)) return false
  if (/^\d/.test(value) && nextCharacter !== undefined && /\d/.test(nextCharacter)) {
    return false
  }
  if (/[\\^_=]/.test(value) || /^[A-Za-z\u0370-\u03ff]$/.test(value)) return true

  const identifiers = value.match(/[A-Za-z]+/g) ?? []
  const isSimpleExpression = /^[A-Za-z0-9\u0370-\u03ff.\s+\-*/()[\]]+$/.test(value)
  return (
    isSimpleExpression &&
    identifiers.every((identifier) => identifier.length === 1) &&
    (/[+\-*/()]/.test(value) ||
      /\d[A-Za-z\u0370-\u03ff]|[A-Za-z\u0370-\u03ff]\d/.test(value))
  )
}

function normalizeSafeInlineMath(value: string) {
  let normalized = ''
  let cursor = 0

  while (cursor < value.length) {
    const opening = findSingleDollar(value, cursor, false)
    if (opening === -1) {
      normalized += value.slice(cursor)
      break
    }

    normalized += value.slice(cursor, opening)
    const closing = findSingleDollar(value, opening + 1, true)
    if (closing === -1) {
      normalized += '$'
      cursor = opening + 1
      continue
    }

    const math = value.slice(opening + 1, closing)
    if (looksLikeInlineMath(math, value[closing + 1])) {
      normalized = joinWithoutDollarCollision(normalized, '$$' + math + '$$')
      cursor = closing + 1
    } else {
      normalized += '$'
      cursor = opening + 1
    }
  }

  return normalized
}

function countDollarRun(value: string, start: number) {
  let end = start
  while (value[end] === '$') end += 1
  return end - start
}

function getDoubleDollarMathRanges(value: string) {
  const ranges: SourceRange[] = []
  let cursor = 0

  while (cursor < value.length) {
    const opening = value.indexOf('$$', cursor)
    if (opening === -1) break
    const runLength = countDollarRun(value, opening)
    if (isEscaped(value, opening)) {
      cursor = opening + runLength
      continue
    }

    let search = opening + runLength
    let closing = -1
    while (search < value.length) {
      const candidate = value.indexOf('$'.repeat(runLength), search)
      if (candidate === -1) break
      if (
        !isEscaped(value, candidate) &&
        countDollarRun(value, candidate) === runLength
      ) {
        closing = candidate + runLength
        break
      }
      search = candidate + runLength
    }

    if (closing === -1) {
      ranges.push({ start: opening, end: value.length })
      break
    }
    ranges.push({ start: opening, end: closing })
    cursor = closing
  }

  return ranges
}

function normalizeOutsideExistingMath(value: string) {
  const ranges = getDoubleDollarMathRanges(value)
  let normalized = ''
  let cursor = 0

  for (const range of ranges) {
    const prose = value.slice(cursor, range.start)
    let normalizedProse = replacePairedBackslashMath(prose, '[', ']', true)
    normalizedProse = replacePairedBackslashMath(normalizedProse, '(', ')', false)
    normalizedProse = escapeUnpairedBackslashDelimiters(normalizedProse)
    normalized = joinWithoutDollarCollision(
      normalized,
      normalizeSafeInlineMath(normalizedProse),
    )
    normalized = joinWithoutDollarCollision(
      normalized,
      value.slice(range.start, range.end),
    )
    cursor = range.end
  }

  let remaining = value.slice(cursor)
  remaining = replacePairedBackslashMath(remaining, '[', ']', true)
  remaining = replacePairedBackslashMath(remaining, '(', ')', false)
  remaining = escapeUnpairedBackslashDelimiters(remaining)
  return joinWithoutDollarCollision(normalized, normalizeSafeInlineMath(remaining))
}

function normalizeProse(
  value: string,
  startsAtLineBoundary: boolean,
  endsAtLineBoundary: boolean,
) {
  return normalizeOutsideExistingMath(
    normalizeStandaloneDollarDisplay(value, startsAtLineBoundary, endsAtLineBoundary),
  )
}

export function normalizeMathSyntax(content: string) {
  if (!hasPotentialMathSyntax(content) || isTooComplexToNormalize(content)) {
    return content
  }

  const protectedRanges = getProtectedRanges(content)
  let normalized = ''
  let cursor = 0

  for (const range of protectedRanges) {
    if (range.start > cursor) {
      normalized += normalizeProse(
        content.slice(cursor, range.start),
        cursor === 0 || isLineBreak(content[cursor - 1]),
        range.start === 0 || isLineBreak(content[range.start - 1]),
      )
    }
    normalized += content.slice(range.start, range.end)
    cursor = range.end
  }

  if (cursor < content.length) {
    normalized += normalizeProse(
      content.slice(cursor),
      cursor === 0 || isLineBreak(content[cursor - 1]),
      true,
    )
  }

  return normalized
}
