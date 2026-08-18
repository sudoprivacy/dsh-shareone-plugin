import http from 'node:http'
import { apply } from '../index.js'

const secret = 'shareone-test-secret'
let pageApiKey = null

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/agent-guest-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ api_key: secret }))
    return
  }

  if (req.method === 'POST' && req.url === '/api/v1/pages') {
    pageApiKey = req.headers['x-api-key']
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      share_id: 'test-share',
      share_url: 'https://shareone.vip/s/test-share',
      filename: 'index.html',
    }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

try {
  const registered = []
  const store = new Map()
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    credentials: {
      async resolve(ref) {
        const value = store.get(ref)
        return value ? { value, source: 'file' } : undefined
      },
      async set(ref, value) {
        store.set(ref, value)
      },
    },
  }

  apply(ctx, {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKeyEnv: 'SHAREONE_API_KEY',
    timeoutMs: 1000,
  })

  const createGuestKey = registered.find(tool => tool.name === 'shareone_create_guest_key')
  const publishText = registered.find(tool => tool.name === 'shareone_publish_text')
  if (!createGuestKey || !publishText) throw new Error('ShareOne credential test tools were not registered')

  const created = await createGuestKey.execute({}, {})
  if (created.api_key !== undefined) throw new Error('Guest key result exposed the API key')
  if (store.get('SHAREONE_API_KEY') !== secret) throw new Error('Guest key was not stored in DSH credentials')

  const rendered = createGuestKey.output.render({}, created).map(part => part.text || '').join('\n')
  if (rendered.includes(secret)) throw new Error('Rendered output exposed the API key')

  await publishText.execute({
    filename: 'index.html',
    content: '<!doctype html><title>ok</title>',
  }, {})

  if (pageApiKey !== secret) throw new Error('Publish did not resolve the stored credential')
  console.log('Credential storage smoke test passed.')
} finally {
  await new Promise(resolve => server.close(resolve))
}
