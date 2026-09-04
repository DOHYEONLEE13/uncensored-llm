import { readFile, stat } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { config } from 'dotenv'
import { getOrcaRouterStatus, handleOrcaRouterChat } from './orcarouter.js'

const rootDirectory = process.cwd()
const isDevelopment = process.argv.includes('--dev')
const distDirectory = resolve(rootDirectory, 'dist')

config({ path: resolve(rootDirectory, '.env.local'), quiet: true })

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const vite = isDevelopment
  ? await (async () => {
      const { createServer: createViteServer } = await import('vite')
      return createViteServer({
        root: rootDirectory,
        server: { middlewareMode: true },
        appType: 'spa',
      })
    })()
  : undefined

async function serveProductionFile(pathname: string, method: string, response: ServerResponse) {
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    response.writeHead(400)
    response.end()
    return
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '')
  const candidatePath = resolve(distDirectory, relativePath)
  const safePrefix = `${distDirectory}${sep}`
  const safeCandidate = candidatePath === distDirectory || candidatePath.startsWith(safePrefix)

  let filePath = safeCandidate ? candidatePath : resolve(distDirectory, 'index.html')
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) filePath = resolve(distDirectory, 'index.html')
  } catch {
    filePath = resolve(distDirectory, 'index.html')
  }

  try {
    const file = await readFile(filePath)
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': file.length,
    })
    if (method === 'HEAD') response.end()
    else response.end(file)
  } catch {
    response.writeHead(404)
    response.end('Not found')
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (requestUrl.pathname === '/api/chat') {
    await handleOrcaRouterChat(request, response)
    return
  }

  if (requestUrl.pathname === '/api/status') {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' })
      response.end()
      return
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify(getOrcaRouterStatus()))
    return
  }

  if (vite) {
    vite.middlewares(request, response)
    return
  }

  await serveProductionFile(requestUrl.pathname, request.method ?? 'GET', response)
})

const port = Number(process.env.PORT ?? 5173)
const host = process.env.HOST ?? (isDevelopment ? '127.0.0.1' : '0.0.0.0')

server.listen(port, host, () => {
  console.log(`MIRA server listening on http://${host}:${port}`)
})
