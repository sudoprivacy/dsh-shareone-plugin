import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let credentialBody = null
let uploadReceived = false
let confirmBody = null

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/files/credential') {
    const chunks = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      credentialBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        share_id: 'pdf-share',
        upload_url: `http://127.0.0.1:${server.address().port}/upload`,
        upload_fields: {},
        filename: credentialBody.filename,
        upload_type: 's3',
      }))
    })
    return
  }

  if (req.method === 'POST' && req.url === '/upload') {
    req.on('data', () => {})
    req.on('end', () => {
      uploadReceived = true
      res.writeHead(204)
      res.end()
    })
    return
  }

  if (req.method === 'POST' && req.url === '/api/v1/files/confirm') {
    const chunks = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      confirmBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        share_id: confirmBody.share_id,
        share_url: 'https://shareone.vip/pdf/pdf-share',
        filename: confirmBody.filename,
      }))
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shareone-plugin-'))
const pdfPath = path.join(tempDir, 'demo.pdf')
fs.writeFileSync(pdfPath, '%PDF-1.4\n% test\n')

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
    file_path: pdfPath,
    filename: 'demo.pdf',
  }, {})

  if (credentialBody?.filename !== 'demo.pdf') throw new Error('Credential filename was not forwarded')
  if (!uploadReceived) throw new Error('Binary upload was not sent')
  if (confirmBody?.publish_source !== 'dsh') throw new Error('Binary confirm publish_source was not sent as dsh')
  if (result.content_kind !== 'file') throw new Error('Binary publish result should be marked as file content')

  console.log('Binary publish source smoke test passed.')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
  await new Promise(resolve => server.close(resolve))
}
