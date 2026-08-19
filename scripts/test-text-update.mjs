import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const requests = []

const server = http.createServer((req, res) => {
  if ((req.method === 'POST' && req.url === '/api/v1/pages') || (req.method === 'PUT' && req.url?.startsWith('/api/v1/pages/'))) {
    const chunks = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'], body })
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        share_id: req.url.split('/').pop() || 'new-share',
        share_url: `https://shareone.vip/s/${req.url.split('/').pop() || 'new-share'}`,
        filename: body.filename,
      }))
    })
    return
  }

  if (req.url?.startsWith('/api/v1/files')) {
    requests.push({ method: req.method, url: req.url, fileEndpoint: true })
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shareone-plugin-'))
const htmlPath = path.join(tempDir, 'index.html')
fs.writeFileSync(htmlPath, '<!doctype html><title>updated from file</title>')

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

  const publishText = registered.find(tool => tool.name === 'shareone_publish_text')
  const publishFile = registered.find(tool => tool.name === 'shareone_publish_file')
  if (!publishText || !publishFile) throw new Error('Publish tools were not registered')

  const textResult = await publishText.execute({
    ref: 'https://shareone.vip/s/existing-text',
    filename: 'index.html',
    content: '<!doctype html><title>updated from text</title>',
    title: 'Updated title',
  }, {})

  const fileResult = await publishFile.execute({
    ref: 'existing-file-text',
    file_path: htmlPath,
    filename: 'index.html',
  }, {})

  if (requests.some(request => request.fileEndpoint)) throw new Error('Text updates should not call file endpoints')

  const textUpdate = requests.find(request => request.method === 'PUT' && request.url === '/api/v1/pages/existing-text')
  if (!textUpdate) throw new Error('shareone_publish_text did not update the existing page')
  if (textUpdate.body.html_content !== '<!doctype html><title>updated from text</title>') throw new Error('Text update content was not forwarded')
  if (textUpdate.body.title !== 'Updated title') throw new Error('Text update title was not forwarded')
  if (textResult.operation !== 'update') throw new Error('Text update result should be marked as update')

  const fileUpdate = requests.find(request => request.method === 'PUT' && request.url === '/api/v1/pages/existing-file-text')
  if (!fileUpdate) throw new Error('shareone_publish_file did not update the existing text page')
  if (fileUpdate.body.html_content !== '<!doctype html><title>updated from file</title>') throw new Error('File text update content was not forwarded')
  if (fileResult.operation !== 'update') throw new Error('File text update result should be marked as update')

  const rendered = publishText.output.render({}, textResult).map(part => part.text || '').join('\n')
  if (!rendered.includes('Updated ShareOne share:')) throw new Error('Update render should use the Updated label')

  console.log('Text update smoke test passed.')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
  await new Promise(resolve => server.close(resolve))
}
