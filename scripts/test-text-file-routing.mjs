import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let pageRequest = null
let fileCredentialRequested = false

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/pages') {
    const chunks = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      pageRequest = {
        apiKey: req.headers['x-api-key'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        share_id: 'html-share',
        share_url: 'https://shareone.vip/s/html-share',
        filename: pageRequest.body.filename,
      }))
    })
    return
  }

  if (req.url?.startsWith('/api/v1/files')) {
    fileCredentialRequested = true
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shareone-plugin-'))
const htmlPath = path.join(tempDir, 'index.html')
fs.writeFileSync(htmlPath, '<!doctype html><title>ok</title>')

try {
  const registered = []
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    credentials: {
      async resolve() {
        return { value: 'test-api-key' }
      },
      async set() {},
    },
  }

  apply(ctx, {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKeyEnv: 'SHAREONE_API_KEY',
    timeoutMs: 1000,
  })

  const publishFile = registered.find(tool => tool.name === 'shareone_publish_file')
  if (!publishFile) throw new Error('shareone_publish_file was not registered')

  const result = await publishFile.execute({
    file_path: htmlPath,
    filename: 'index.html',
    title: 'HTML test',
    allow_comments: true,
  }, {})

  if (fileCredentialRequested) throw new Error('HTML file incorrectly used the file upload endpoint')
  if (!pageRequest) throw new Error('HTML file did not use the page endpoint')
  if (pageRequest.apiKey !== 'test-api-key') throw new Error('API key was not sent to the page endpoint')
  if (pageRequest.body.filename !== 'index.html') throw new Error('Filename was not forwarded')
  if (pageRequest.body.html_content !== '<!doctype html><title>ok</title>') throw new Error('HTML content was not forwarded')
  if (pageRequest.body.publish_source !== 'dsh') throw new Error('DSH publish_source was not forwarded')
  if (pageRequest.body.title !== 'HTML test') throw new Error('Title was not forwarded')
  if (pageRequest.body.allow_comments !== true) throw new Error('allow_comments was not forwarded')
  if (result.content_kind !== 'page') throw new Error('HTML publish_file result should be marked as page content')

  console.log('Text file routing smoke test passed.')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
  await new Promise(resolve => server.close(resolve))
}
