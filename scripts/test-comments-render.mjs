import http from 'node:http'
import { apply } from '../index.js'

const anchor = JSON.stringify({
  startMeta: {
    parentTagName: 'P',
    parentIndex: 3,
    textOffset: 12,
  },
  endMeta: {
    parentTagName: 'P',
    parentIndex: 3,
    textOffset: 20,
  },
})

const comments = [
  {
    id: 'parent-1',
    quote: 'old copy',
    highlighter_data: anchor,
    content: 'Please update this copy.',
    status: 'open',
    author_role: 'visitor',
    user_id: 'user-1',
    user: { username: 'alice' },
    screenshot_url: 'https://shareone.vip/comment-screenshots/share/parent-1.png',
    created_at: '2026-08-19T00:00:00Z',
    updated_at: null,
    resolution_note: null,
    agent_stance: null,
    replies: [
      {
        id: 'reply-1',
        parent_id: 'parent-1',
        quote: 'old copy',
        highlighter_data: anchor,
        content: 'I agree with this request.',
        status: 'open',
        author_role: 'owner',
        user_id: 'user-2',
        user: { username: 'owner' },
        screenshot_url: null,
        created_at: '2026-08-19T00:01:00Z',
        updated_at: null,
        resolution_note: null,
        agent_stance: null,
        replies: [],
      },
    ],
  },
]

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/shares/demo/comments/summary') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      total: 1,
      open: 1,
      in_progress: 0,
      resolved: 0,
      dismissed: 0,
      last_activity_at: '2026-08-19T00:01:00Z',
    }))
    return
  }

  if (req.method === 'GET' && req.url === '/api/v1/shares/demo/comments?status=unresolved') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(comments))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

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
        return undefined
      },
      async set() {},
    },
  }

  apply(ctx, {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKeyEnv: 'SHAREONE_API_KEY',
    timeoutMs: 1000,
  })

  const getComments = registered.find(tool => tool.name === 'shareone_get_comments')
  if (!getComments) throw new Error('shareone_get_comments was not registered')

  const result = await getComments.execute({ ref: 'demo', status: 'unresolved' }, {})
  const rendered = getComments.output.render({}, result).map(part => part.text || '').join('\n')

  for (const expected of [
    'parent-1',
    'reply-1',
    'Please update this copy.',
    'old copy',
    'highlighter_data',
    'parentTagName',
    'textOffset',
    'alice',
    'open',
  ]) {
    if (!rendered.includes(expected)) throw new Error(`Rendered comments omitted ${expected}`)
  }

  console.log('Comments render smoke test passed.')
} finally {
  await new Promise(resolve => server.close(resolve))
}
