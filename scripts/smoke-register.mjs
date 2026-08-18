import { apply } from '../index.js'

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
  baseUrl: 'https://shareone.vip',
  apiKeyEnv: 'SHAREONE_API_KEY',
  timeoutMs: 60000,
})

const expected = [
  'shareone_publish_text',
  'shareone_publish_file',
  'shareone_update_settings',
  'shareone_get_comments',
  'shareone_reply_comment',
  'shareone_update_comment_status',
  'shareone_download',
  'shareone_create_guest_key',
]

const actual = registered.map(tool => tool.name)
const missing = expected.filter(name => !actual.includes(name))
if (missing.length > 0) {
  throw new Error(`Missing ShareOne tools: ${missing.join(', ')}`)
}

console.log(`Registered ${actual.length} ShareOne tools.`)
