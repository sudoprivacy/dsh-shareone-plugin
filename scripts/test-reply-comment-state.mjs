import http from 'node:http'
import { apply } from '../index.js'

let postedBody = null

const comments = [
  {
    id: 'parent-1',
    quote: 'selected text',
    highlighter_data: '{"startMeta":{"parentTagName":"P","parentIndex":1,"textOffset":0}}',
    content: 'Please update this.',
    status: 'open',
    author_role: 'visitor',
    replies: [],
  },
]

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/shares/demo/comments?status=all') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(comments))
    return
  }

  if (req.method === 'POST' && req.url === '/api/v1/shares/demo/comments') {
    const chunks = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      postedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'reply-1',
        parent_id: postedBody.parent_id,
        quote: postedBody.quote,
        highlighter_data: postedBody.highlighter_data,
        content: postedBody.content,
        author_role: postedBody.author_role,
        status: 'open',
      }))
    })
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

  const replyComment = registered.find(tool => tool.name === 'shareone_reply_comment')
  if (!replyComment) throw new Error('shareone_reply_comment was not registered')

  await replyComment.execute({
    ref: 'demo',
    parent_id: 'parent-1',
    content: 'Handled in the latest version.',
    state: 'resolved-agree',
  }, {})

  if (!postedBody) throw new Error('Reply request was not posted')
  if (postedBody.parent_id !== 'parent-1') throw new Error('Parent id was not forwarded')
  if (postedBody.quote !== 'selected text') throw new Error('Parent quote was not inherited')
  if (postedBody.highlighter_data !== comments[0].highlighter_data) throw new Error('Parent anchor was not inherited')
  if (postedBody.author_role !== 'agent') throw new Error('Reply was not posted as agent')
  if (postedBody.state !== 'resolved-agree') throw new Error('Agent reply state was not forwarded')

  for (const badState of [undefined, 'resolved', 'dismissed']) {
    let failed = false
    try {
      await replyComment.execute({
        ref: 'demo',
        parent_id: 'parent-1',
        content: 'Invalid state test.',
        state: badState,
      }, {})
    } catch (error) {
      failed = Boolean(error)
    }
    if (!failed) throw new Error(`Invalid state was not rejected: ${badState}`)
  }

  console.log('Reply comment state smoke test passed.')
} finally {
  await new Promise(resolve => server.close(resolve))
}
