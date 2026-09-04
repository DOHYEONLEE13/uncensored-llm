import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownResponse from '../src/MarkdownResponse'
import { normalizeMathSyntax } from '../src/mathMarkdown'

function renderMarkdown(content: string) {
  return renderToStaticMarkup(createElement(MarkdownResponse, { content }))
}

test('renders display LaTeX instead of exposing the source delimiters', () => {
  const source = ['$$', '\\text{hello}', '$$'].join('\n')
  const html = renderMarkdown(source)

  assert.match(html, /class="katex-display"/)
  assert.match(html, /class="katex"/)
  assert.match(html, /<mtext>hello<\/mtext>/)
  assert.doesNotMatch(html, /\$\$/)
})

test('renders inline LaTeX inside ordinary prose', () => {
  const html = renderMarkdown('Euler: \\(e^{i\\pi} + 1 = 0\\)')

  assert.match(html, /Euler:/)
  assert.match(html, /class="katex"/)
  assert.doesNotMatch(html, /\\\(/)
})

test('does not promote standalone inline math to display math', () => {
  const backslashHtml = renderMarkdown('\\(x\\)')
  const dollarHtml = renderMarkdown('$x$')

  assert.match(backslashHtml, /class="katex"/)
  assert.doesNotMatch(backslashHtml, /class="katex-display"/)
  assert.match(dollarHtml, /class="katex"/)
  assert.doesNotMatch(dollarHtml, /class="katex-display"/)
})

test('renders safe single-dollar inline math without treating prices as math', () => {
  const html = renderMarkdown(
    'Euler: $e^{i\\pi} + 1 = 0$. Price is $5 and tax is $10, usually $5-$10.',
  )

  assert.match(html, /class="katex"/)
  assert.match(html, /Price is \$5 and tax is \$10, usually \$5-\$10\./)
  assert.equal(normalizeMathSyntax('Use $PATH/$HOME outside code.'), 'Use $PATH/$HOME outside code.')
  assert.equal(normalizeMathSyntax('Use ${PATH}/${HOME} outside code.'), 'Use ${PATH}/${HOME} outside code.')

  for (const formula of ['$a+b$', '$x-y$', '$x/y$', '$2x$']) {
    assert.match(renderMarkdown(formula), /class="katex"/)
  }
})

test('renders common bracket delimiters and one-line display math as display math', () => {
  const bracketHtml = renderMarkdown('\\[\\text{bracket display}\\]')
  const dollarHtml = renderMarkdown('$$\\text{one-line display}$$')

  assert.match(bracketHtml, /class="katex-display"/)
  assert.match(bracketHtml, /<mtext>bracket\u00a0display<\/mtext>/)
  assert.match(dollarHtml, /class="katex-display"/)
  assert.match(dollarHtml, /<mtext>one-line\u00a0display<\/mtext>/)
})

test('keeps math delimiters literal inside code fences', () => {
  const source = ['```text', '$$', 'x^2', '$$', '```'].join('\n')
  const html = renderMarkdown(source)

  assert.match(html, /<pre>/)
  assert.match(html, /\$\$/)
  assert.doesNotMatch(html, /class="katex-display"/)
})

test('keeps backslash math delimiters literal in inline and indented code', () => {
  const inlineHtml = renderMarkdown('`\\(x\\)` and \\(y\\)')
  const indentedHtml = renderMarkdown('    \\[x^2\\]')

  assert.match(inlineHtml, /<code>\\\(x\\\)<\/code>/)
  assert.match(inlineHtml, /class="katex"/)
  assert.match(indentedHtml, /<code>\\\[x\^2\\\]/)
  assert.doesNotMatch(indentedHtml, /class="katex"/)
})

test('preserves multiline, escaped, and incomplete code spans while streaming', () => {
  const multilineCode = ['`start', '\\(code\\)', 'end`'].join('\n')
  const incompleteFence = ['```text', '\\(code\\)'].join('\n')
  const escapedBackticks = '\\` \\(x\\) \\`'

  assert.equal(normalizeMathSyntax(multilineCode), multilineCode)
  assert.equal(normalizeMathSyntax(incompleteFence), incompleteFence)
  assert.doesNotMatch(renderMarkdown(multilineCode), /class="katex"/)
  assert.doesNotMatch(renderMarkdown(incompleteFence), /class="katex"/)
  assert.match(renderMarkdown(escapedBackticks), /class="katex"/)
})

test('uses Markdown parsing rules for code spans, list fences, and paragraph continuations', () => {
  const escapedClosingBacktick = '`code\\` and \\(x\\)'
  const listFence = ['- ~~~text', '  \\(code\\)', '  ~~~', '', 'After \\(math\\)'].join('\n')
  const paragraphContinuation = ['Paragraph', '    \\(x\\)'].join('\n')

  assert.match(normalizeMathSyntax(escapedClosingBacktick), /`code\\` and \$\$x\$\$/)
  assert.match(normalizeMathSyntax(listFence), /~~~text\n  \\\(code\\\)\n  ~~~/)
  assert.match(renderMarkdown(listFence), /class="katex"/)
  assert.match(renderMarkdown(paragraphContinuation), /class="katex"/)
})

test('does not close a code fence at a different block-quote depth', () => {
  const source = ['```text', '> ```', '\\(code\\)', '```', '\\(math\\)'].join('\n')
  const normalized = normalizeMathSyntax(source)

  assert.match(normalized, /> ```\n\\\(code\\\)\n```/)
  assert.match(renderMarkdown(source), /class="katex"/)
})

test('keeps incomplete LaTeX delimiters visible until their pair arrives', () => {
  const opening = normalizeMathSyntax('prefix \\(')
  const closing = normalizeMathSyntax('prefix \\)')

  assert.equal(opening, 'prefix \\\\(')
  assert.equal(closing, 'prefix \\\\)')
  assert.match(renderMarkdown('prefix \\('), /prefix \\\(/)
  assert.doesNotMatch(renderMarkdown('prefix \\('), /class="katex"/)
})

test('does not rewrite LaTeX-like delimiters inside link destinations or URLs', () => {
  const markdownLink = '[docs](https://example.com/\\(literal\\))'
  const bareUrl = 'https://example.com/\\(literal\\)'

  assert.equal(normalizeMathSyntax(markdownLink), markdownLink)
  assert.equal(normalizeMathSyntax(bareUrl), bareUrl)
  assert.doesNotMatch(renderMarkdown(markdownLink), /class="katex"/)
  assert.doesNotMatch(renderMarkdown(bareUrl), /class="katex"/)
})

test('does not let link syntax inside code or URLs hide later math', () => {
  const codeThenMath = '`[x](` then \\(y\\)'
  const urlThenMath = '[link](https://example.com/`) then \\(y\\)'

  assert.match(renderMarkdown(codeThenMath), /class="katex"/)
  assert.match(renderMarkdown(urlThenMath), /class="katex"/)
})

test('separates adjacent inline equations', () => {
  const html = renderMarkdown('\\(a\\)\\(b\\)')

  assert.equal((html.match(/class="katex"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /katex-error/)
})

test('renders one-line display math inside a block quote as display math', () => {
  const html = renderMarkdown('> $$x^2$$')

  assert.match(html, /<blockquote>/)
  assert.match(html, /class="katex-display"/)
})

test('keeps display math inside its list item', () => {
  const html = renderMarkdown('- \\[x^2\\]')

  assert.match(html, /<li>[\s\S]*class="katex-display"[\s\S]*<\/li>/)
})

test('keeps incomplete inline code and link destinations stable while streaming', () => {
  const incompleteCode = '`unfinished \\(x\\)'
  const incompleteLink = '[docs](/path/\\(literal\\)'

  assert.equal(normalizeMathSyntax(incompleteCode), incompleteCode)
  assert.equal(normalizeMathSyntax(incompleteLink), incompleteLink)
  assert.doesNotMatch(renderMarkdown(incompleteCode), /class="katex"/)
  assert.doesNotMatch(renderMarkdown(incompleteLink), /class="katex"/)
})

test('separates adjacent equations that use mixed delimiter styles', () => {
  const sources = [
    '$$a$$\\(b\\)',
    '\\(a\\)$$b$$',
    '$a$\\(b\\)',
    '\\(a\\)$b$',
  ]

  for (const source of sources) {
    const html = renderMarkdown(source)
    assert.equal((html.match(/class="katex"/g) ?? []).length, 2, source)
    assert.doesNotMatch(html, /katex-error/, source)
  }
})

test('preserves GFM www autolinks that contain delimiter-like URL text', () => {
  const source = 'www.example.com/\\(literal\\)'

  assert.equal(normalizeMathSyntax(source), source)
  assert.doesNotMatch(renderMarkdown(source), /class="katex"/)
})

test('does not treat backticks inside bare GFM URLs as incomplete code spans', () => {
  const sources = [
    'https://example.com/` then \\(x\\)',
    'www.example.com/` then \\(x\\)',
  ]

  for (const source of sources) {
    const html = renderMarkdown(source)
    assert.match(html, /<a\b/)
    assert.match(html, /class="katex"/, source)
  }
})

test('ignores stale link-label brackets when guarding incomplete destinations', () => {
  const sources = [
    '`[foo` text ]( unfinished then \\(x\\)',
    ['[old]', '', 'text ]( unfinished then \\(x\\)'].join('\n'),
  ]

  for (const source of sources) {
    assert.match(renderMarkdown(source), /class="katex"/, source)
  }
})

test('keeps rich multiline link destinations stable while streaming', () => {
  const sources = [
    ['[a', 'b](/docs/\\(literal\\)'].join('\n'),
    ['[a', 'b](/docs/\\(literal\\)'].join('\r\n'),
    '[a `code` b](/docs/\\(literal\\)',
    '[![alt](img.png)](/docs/\\(literal\\)',
    '[a <span>x</span> b](/docs/\\(literal\\)',
  ]

  for (const source of sources) {
    assert.equal(normalizeMathSyntax(source), source)
    assert.doesNotMatch(renderMarkdown(source), /class="katex"/, source)
  }
})

test('renders math inside Markdown link labels while preserving the destination', () => {
  const singleDollarHtml = renderMarkdown('[$x$](https://example.com)')
  const backslashHtml = renderMarkdown('[\\(x\\)](https://example.com)')

  assert.match(singleDollarHtml, /<a\b[^>]*>[\s\S]*class="katex"[\s\S]*<\/a>/)
  assert.match(backslashHtml, /<a\b[^>]*>[\s\S]*class="katex"[\s\S]*<\/a>/)
})

test('keeps display math as display math in nested and task-list containers', () => {
  const sources = ['- [ ] \\[x\\]', '- > \\[x\\]', '- 1. \\[x\\]']

  for (const source of sources) {
    const html = renderMarkdown(source)
    assert.match(
      html,
      /<li\b[^>]*>[\s\S]*class="katex-display"[\s\S]*<\/li>/,
      source,
    )
  }
})

test('shows malformed LaTeX safely instead of crashing the response', () => {
  const source = ['$$', '\\notARealCommand{x}', '$$'].join('\n')
  const html = renderMarkdown(source)

  assert.match(html, /class="katex-display"/)
  assert.match(html, /notARealCommand/)
})

test('limits oversized KaTeX layout commands', () => {
  const html = renderMarkdown('$$\\rule{1000000em}{1000000em}$$')

  assert.match(html, /class="katex-display"/)
  assert.doesNotMatch(html, /height:1000000em/)
  assert.doesNotMatch(html, /border-right-width:1000000em/)
})

test('does not allow untrusted KaTeX links', () => {
  const html = renderMarkdown('$$\\href{javascript:alert(1)}{click}$$')

  assert.match(html, /class="katex-display"/)
  assert.doesNotMatch(html, /<a\b/)
})
