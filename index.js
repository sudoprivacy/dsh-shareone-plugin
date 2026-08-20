import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'shareone'
export const inject = ['tools', 'credentials']

export const Config = Schema.object({
  baseUrl: Schema.string().default('https://shareone.vip'),
  apiKey: Schema.string().description('Optional ShareOne API key. Prefer apiKeyEnv for local use.'),
  apiKeyEnv: Schema.string().default('SHAREONE_API_KEY'),
  timeoutMs: Schema.number().default(60000),
})

const MIME_TYPES = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

const TEXT_FILE_EXTENSIONS = new Set(['.html', '.htm', '.md', '.markdown', '.txt'])
const AGENT_REPLY_STATES = new Set(['resolved-agree', 'open-disagree', 'open-need-input'])
const PUBLISH_SOURCE = 'dsh'

function appendPath(baseUrl, apiPath) {
  const trimmedBase = String(baseUrl || '').replace(/\/+$/, '')
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
  return `${trimmedBase}${normalizedPath}`
}

function getMimeType(filePath, override) {
  if (override) return override
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function isTextPageFile(filePath, filename) {
  return [filename, filePath].some(value => TEXT_FILE_EXTENSIONS.has(path.extname(String(value || '')).toLowerCase()))
}

function getApiKeyRef(config) {
  return credentialRef(config.apiKeyEnv || 'SHAREONE_API_KEY')
}

async function getApiKey(ctx, config, explicitApiKey, sessionApiKey) {
  if (explicitApiKey && String(explicitApiKey).trim()) return String(explicitApiKey).trim()
  if (config.apiKey && String(config.apiKey).trim()) return String(config.apiKey).trim()
  const ref = getApiKeyRef(config)
  const credential = await ctx.credentials.resolve(ref)
  if (credential?.value) return credential.value
  if (sessionApiKey && String(sessionApiKey).trim()) return String(sessionApiKey).trim()
  return null
}

async function requireApiKey(ctx, config, args = {}, sessionApiKey = null) {
  const apiKey = await getApiKey(ctx, config, args.api_key, sessionApiKey)
  if (!apiKey) {
    throw new Error(`ShareOne API key is not configured. Set ${config.apiKeyEnv || 'SHAREONE_API_KEY'} or configure shareone.apiKey.`)
  }
  return apiKey
}

function parseRef(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('ref is required')

  let pathPart = raw.split('?')[0].split('#')[0]
  try {
    if (raw.includes('://')) {
      pathPart = new URL(raw).pathname
    }
  } catch {
    pathPart = raw.split('?')[0].split('#')[0]
  }

  const parts = pathPart.split('/').filter(Boolean)
  const knownPrefixes = new Set(['s', 'md', 'pdf', 'ppt', 'word'])
  if (parts.length >= 2 && knownPrefixes.has(parts[0])) {
    return { prefix: parts[0], shareRef: parts[1] }
  }
  return { prefix: null, shareRef: parts[parts.length - 1] || raw }
}

function endpointForPrefix(prefix, shareRef) {
  const encoded = encodeURIComponent(shareRef)
  if (prefix === 's' || prefix === 'md') return `/api/v1/pages/${encoded}`
  if (prefix === 'pdf' || prefix === 'ppt' || prefix === 'word') return `/api/v1/files/${encoded}`
  return null
}

function requestBuffer(url, options = {}, body = null, signal = null) {
  const timeoutMs = options.timeoutMs || 60000
  const headers = options.headers || {}

  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'https:' ? https : http
    const req = client.request(target, {
      method: options.method || 'GET',
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        const data = Buffer.concat(chunks)
        const text = data.toString('utf8')
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, headers: res.headers, data, text })
          return
        }
        const error = new Error(`ShareOne HTTP ${res.statusCode}: ${text || res.statusMessage}`)
        error.statusCode = res.statusCode
        error.responseText = text
        reject(error)
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('ShareOne request timed out'))
    })
    req.on('error', reject)
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('ShareOne request aborted'))
      } else {
        signal.addEventListener('abort', () => req.destroy(new Error('ShareOne request aborted')), { once: true })
      }
    }
    if (body) req.write(body)
    req.end()
  })
}

async function requestJson(config, apiPath, options = {}, payload = null, signal = null) {
  const body = payload === null ? null : JSON.stringify(payload)
  const headers = {
    ...(options.headers || {}),
    'Content-Type': 'application/json',
  }
  if (body !== null) headers['Content-Length'] = Buffer.byteLength(body)

  const res = await requestBuffer(appendPath(config.baseUrl, apiPath), {
    ...options,
    timeoutMs: options.timeoutMs || config.timeoutMs,
    headers,
  }, body, signal)
  return parseJsonResponse(res)
}

async function requestAuthenticatedJson(ctx, config, apiPath, args, options = {}, payload = null, signal = null, sessionApiKey = null) {
  const apiKey = await requireApiKey(ctx, config, args, sessionApiKey)
  return requestJson(config, apiPath, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-API-Key': apiKey,
    },
  }, payload, signal)
}

async function requestAuthenticatedBuffer(ctx, config, apiPath, args, options = {}, body = null, signal = null, sessionApiKey = null) {
  const apiKey = await requireApiKey(ctx, config, args, sessionApiKey)
  return requestBuffer(appendPath(config.baseUrl, apiPath), {
    ...options,
    timeoutMs: options.timeoutMs || config.timeoutMs,
    headers: {
      ...(options.headers || {}),
      'X-API-Key': apiKey,
    },
  }, body, signal)
}

function parseJsonResponse(res) {
  try {
    return JSON.parse(res.text)
  } catch {
    throw new Error(`ShareOne returned invalid JSON with status ${res.statusCode}`)
  }
}

function pageResult(response, contentKind, operation = 'create') {
  return {
    ok: true,
    operation,
    share_id: response.share_id,
    custom_slug: response.custom_slug || null,
    share_url: response.share_url,
    canonical_url: response.canonical_url || null,
    filename: response.filename || null,
    content_kind: contentKind,
    custom_slug_warning: response.custom_slug_warning || null,
    custom_slug_suggestions: response.custom_slug_suggestions || null,
  }
}

function textPagePayload(args, filename, content) {
  const payload = {
    filename,
    html_content: content,
  }
  if (!textPageRef(args)) payload.publish_source = PUBLISH_SOURCE
  if (args.password) payload.password = args.password
  if (args.watermark) payload.watermark = args.watermark
  if (args.custom_slug) payload.custom_slug = args.custom_slug
  if (typeof args.allow_comments === 'boolean') payload.allow_comments = args.allow_comments
  if (args.title) payload.title = args.title
  return payload
}

function textPageRef(args) {
  const ref = args.ref || args.share_id
  return ref ? parseRef(ref).shareRef : null
}

async function publishTextPage(ctx, config, args, filename, content, signal, sessionApiKey) {
  const payload = textPagePayload(args, filename, content)
  const ref = textPageRef(args)
  if (ref) {
    return requestAuthenticatedJson(
      ctx,
      config,
      `/api/v1/pages/${encodeURIComponent(ref)}`,
      args,
      { method: 'PUT' },
      payload,
      signal,
      sessionApiKey,
    )
  }
  return requestAuthenticatedJson(ctx, config, '/api/v1/pages', args, { method: 'POST' }, payload, signal, sessionApiKey)
}

function buildMultipartBody(fields, filePath, filename, contentType) {
  const boundary = `----ShareOneBoundary${crypto.randomBytes(16).toString('hex')}`
  const fileData = fs.readFileSync(filePath)
  const parts = []

  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue
    parts.push(Buffer.from(`--${boundary}\r\n`))
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`))
    parts.push(Buffer.from(`${value}\r\n`))
  }

  parts.push(Buffer.from(`--${boundary}\r\n`))
  parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`))
  parts.push(Buffer.from(`Content-Type: ${contentType}\r\n\r\n`))
  parts.push(fileData)
  parts.push(Buffer.from('\r\n'))
  parts.push(Buffer.from(`--${boundary}--\r\n`))

  return { body: Buffer.concat(parts), boundary }
}

async function uploadToS3(credential, filePath, filename, contentType, timeoutMs, signal) {
  const { body, boundary } = buildMultipartBody(credential.upload_fields || {}, filePath, filename, contentType)
  await requestBuffer(credential.upload_url, {
    method: 'POST',
    timeoutMs,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  }, body, signal)
}

async function uploadToAzure(credential, filePath, contentType, timeoutMs, signal) {
  const fileData = fs.readFileSync(filePath)
  await requestBuffer(credential.upload_url, {
    method: 'PUT',
    timeoutMs,
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': contentType,
      'Content-Length': fileData.length,
    },
  }, fileData, signal)
}

async function publishBinaryMultipart(ctx, config, filePath, filename, contentType, args, signal, sessionApiKey) {
  const fields = {}
  fields.publish_source = PUBLISH_SOURCE
  if (args.password) fields.password = args.password
  if (args.watermark) fields.watermark = args.watermark
  if (args.custom_slug) fields.custom_slug = args.custom_slug

  const { body, boundary } = buildMultipartBody(fields, filePath, filename, contentType)
  const res = await requestAuthenticatedBuffer(ctx, config, '/api/v1/files', args, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  }, body, signal, sessionApiKey)
  return parseJsonResponse(res)
}

function shouldFallbackToMultipart(error) {
  const text = `${error?.message || ''}\n${error?.responseText || ''}`
  return error?.statusCode === 400 && /Direct upload is only supported/i.test(text)
}

async function updateSettingsPayload(ctx, config, ref, payload, args, signal, sessionApiKey) {
  const parsed = parseRef(ref)
  const explicitApiPath = endpointForPrefix(parsed.prefix, parsed.shareRef)
  const pagePath = `/api/v1/pages/${encodeURIComponent(parsed.shareRef)}`
  const filePath = `/api/v1/files/${encodeURIComponent(parsed.shareRef)}`

  if (explicitApiPath) {
    return requestAuthenticatedJson(ctx, config, explicitApiPath, args, { method: 'PUT' }, payload, signal, sessionApiKey)
  }

  try {
    return await requestAuthenticatedJson(ctx, config, pagePath, args, { method: 'PUT' }, payload, signal, sessionApiKey)
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 404) {
      return requestAuthenticatedJson(ctx, config, filePath, args, { method: 'PUT' }, payload, signal, sessionApiKey)
    }
    throw error
  }
}

function settingsPayload(args) {
  const payload = {}
  if (args.filename) payload.filename = args.filename
  if (args.title) payload.title = args.title
  if (args.password) payload.password = args.password
  if (args.clear_password) payload.password = null
  if (args.watermark) payload.watermark = args.watermark
  if (args.clear_watermark) payload.watermark = null
  if (args.custom_slug) payload.custom_slug = args.custom_slug
  if (args.clear_custom_slug) payload.custom_slug = null
  if (typeof args.allow_comments === 'boolean') payload.allow_comments = args.allow_comments
  if (typeof args.allow_data === 'boolean') payload.allow_data = args.allow_data
  if (typeof args.require_viewer_email === 'boolean') payload.require_viewer_email = args.require_viewer_email
  if (Object.keys(payload).length === 0) throw new Error('Provide at least one setting to update.')
  return payload
}

function renderShare(value) {
  const warning = value.custom_slug_warning ? `\nCustom slug warning: ${value.custom_slug_warning}` : ''
  const verb = value.operation === 'update' ? 'Updated' : 'Published'
  return [{ type: 'text', text: `${verb} ShareOne share: ${value.share_url}${warning}` }]
}

function renderSettings(value) {
  return [{ type: 'text', text: `Updated ShareOne settings: ${value.share_url}` }]
}

function renderJsonSummary(label) {
  return (_args, value) => [{ type: 'text', text: `${label}: ${JSON.stringify(value)}` }]
}

function parseAnchorSummary(highlighterData) {
  if (!highlighterData) return null
  try {
    const parsed = typeof highlighterData === 'string' ? JSON.parse(highlighterData) : highlighterData
    return {
      startMeta: parsed?.startMeta || null,
      endMeta: parsed?.endMeta || null,
      text: parsed?.text || null,
      id: parsed?.id || null,
    }
  } catch {
    return null
  }
}

function normalizeRenderedComment(comment, parentCommentId = null) {
  return {
    id: comment?.id || null,
    parent_comment_id: parentCommentId || comment?.id || null,
    status: comment?.status || null,
    author_role: comment?.author_role || null,
    author_username: comment?.user?.username || null,
    user_id: comment?.user_id || null,
    content: comment?.content || '',
    quote: comment?.quote || '',
    anchor_summary: parseAnchorSummary(comment?.highlighter_data),
    highlighter_data: comment?.highlighter_data || '',
    screenshot_url: comment?.screenshot_url || null,
    created_at: comment?.created_at || null,
    updated_at: comment?.updated_at || null,
    resolution_note: comment?.resolution_note || null,
    agent_stance: comment?.agent_stance || null,
    replies: (comment?.replies || []).map(reply => normalizeRenderedComment(reply, comment?.id || null)),
  }
}

function renderComments(_args, value) {
  const comments = (value.comments || []).map(comment => normalizeRenderedComment(comment))
  const summary = value.summary || {}
  const lines = [
    `ShareOne comments for ${value.ref || 'share'} (filter: ${value.status || 'all'}): ${summary.total || 0} total, ${summary.open || 0} open, ${summary.in_progress || 0} in progress, ${summary.resolved || 0} resolved, ${summary.dismissed || 0} dismissed.`,
    `Comments JSON:\n${JSON.stringify(comments, null, 2)}`,
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

export function apply(ctx, config) {
  let sessionApiKey = null

  ctx.tools.register(defineTool({
    name: 'shareone_publish_text',
    description: 'Publish HTML, Markdown, or plain text content to ShareOne and return a public share link. Provide ref or share_id to update an existing HTML/Markdown/TXT share instead of creating a new link.',
    parameters: {
      filename: { type: 'string', required: true, description: 'Display filename, for example index.html, notes.md, or readme.txt.' },
      content: { type: 'string', required: true, description: 'HTML, Markdown, or plain text content to publish.' },
      ref: { type: 'string', description: 'Existing ShareOne URL, share_id, or custom slug to update. Omit to create a new share.' },
      share_id: { type: 'string', description: 'Alias for ref. Existing ShareOne URL, share_id, or custom slug to update.' },
      password: { type: 'string', description: 'Optional access password.' },
      watermark: { type: 'string', description: 'Optional watermark text.' },
      custom_slug: { type: 'string', description: 'Optional custom short link slug, 3-64 lowercase letters, numbers, or hyphens.' },
      allow_comments: { type: 'boolean', description: 'Enable public review comments for this share.' },
      title: { type: 'string', description: 'Optional display title.' },
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer DSH credentials or plugin config.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderShare(value),
    },
    async execute(args, exec) {
      if (args.ref && args.share_id && parseRef(args.ref).shareRef !== parseRef(args.share_id).shareRef) {
        throw new Error('Provide only one update target: ref or share_id.')
      }
      const operation = textPageRef(args) ? 'update' : 'create'
      const response = await publishTextPage(ctx, config, args, args.filename, args.content, exec.signal, sessionApiKey)
      return pageResult(response, 'page', operation)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shareone_publish_file',
    description: 'Publish a local PDF, Word, or PowerPoint document to ShareOne and return a public share link. Use shareone_publish_text for HTML, Markdown, or TXT content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Local file path to upload. Absolute paths are preferred.' },
      filename: { type: 'string', description: 'Optional display filename override.' },
      content_type: { type: 'string', description: 'Optional MIME type override.' },
      ref: { type: 'string', description: 'For local HTML, Markdown, or TXT files only: existing ShareOne URL, share_id, or custom slug to update.' },
      share_id: { type: 'string', description: 'Alias for ref. For local HTML, Markdown, or TXT files only: existing ShareOne URL, share_id, or custom slug to update.' },
      password: { type: 'string', description: 'Optional access password.' },
      watermark: { type: 'string', description: 'Optional watermark text.' },
      custom_slug: { type: 'string', description: 'Optional custom short link slug.' },
      allow_comments: { type: 'boolean', description: 'Enable comments after upload if supported by the file type.' },
      title: { type: 'string', description: 'Optional display title.' },
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer DSH credentials or plugin config.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderShare(value),
    },
    async execute(args, exec) {
      const filePath = path.resolve(args.file_path)
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
      if (!fs.statSync(filePath).isFile()) throw new Error(`Not a file: ${filePath}`)

      const filename = args.filename || path.basename(filePath)
      const contentType = getMimeType(filePath, args.content_type)
      let response

      if (isTextPageFile(filePath, filename)) {
        if (args.ref && args.share_id && parseRef(args.ref).shareRef !== parseRef(args.share_id).shareRef) {
          throw new Error('Provide only one update target: ref or share_id.')
        }
        const operation = textPageRef(args) ? 'update' : 'create'
        response = await publishTextPage(ctx, config, args, filename, fs.readFileSync(filePath, 'utf8'), exec.signal, sessionApiKey)
        return pageResult(response, 'page', operation)
      }

      if (args.ref || args.share_id) {
        throw new Error('ref/share_id updates are only supported for local HTML, Markdown, or TXT files. Binary file content updates create a new ShareOne link.')
      }

      try {
        const credential = await requestAuthenticatedJson(ctx, config, '/api/v1/files/credential', args, { method: 'POST' }, {
          filename,
          content_type: contentType,
          custom_slug: args.custom_slug || undefined,
        }, exec.signal, sessionApiKey)

        if (credential.upload_type === 'azure') {
          await uploadToAzure(credential, filePath, contentType, config.timeoutMs, exec.signal)
        } else {
          await uploadToS3(credential, filePath, filename, contentType, config.timeoutMs, exec.signal)
        }

        const confirmPayload = {
          share_id: credential.share_id,
          filename,
          content_type: contentType,
          publish_source: PUBLISH_SOURCE,
        }
        if (args.password) confirmPayload.password = args.password
        if (args.watermark) confirmPayload.watermark = args.watermark
        if (args.custom_slug) confirmPayload.custom_slug = args.custom_slug
        response = await requestAuthenticatedJson(ctx, config, '/api/v1/files/confirm', args, { method: 'POST' }, confirmPayload, exec.signal, sessionApiKey)
      } catch (error) {
        if (!shouldFallbackToMultipart(error)) throw error
        response = await publishBinaryMultipart(ctx, config, filePath, filename, contentType, args, exec.signal, sessionApiKey)
      }

      if (args.title || typeof args.allow_comments === 'boolean') {
        const payload = {}
        if (args.title) payload.title = args.title
        if (typeof args.allow_comments === 'boolean') payload.allow_comments = args.allow_comments
        response = await updateSettingsPayload(ctx, config, response.share_id, payload, args, exec.signal, sessionApiKey)
      }

      return pageResult(response, 'file')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shareone_update_settings',
    description: 'Update settings for an existing ShareOne share, such as password, watermark, short slug, title, or comments.',
    parameters: {
      ref: { type: 'string', required: true, description: 'ShareOne URL, share_id, or custom slug.' },
      filename: { type: 'string', description: 'Optional display filename.' },
      title: { type: 'string', description: 'Optional display title.' },
      password: { type: 'string', description: 'Set or replace access password.' },
      clear_password: { type: 'boolean', description: 'Clear existing access password.' },
      watermark: { type: 'string', description: 'Set or replace watermark text.' },
      clear_watermark: { type: 'boolean', description: 'Clear existing watermark.' },
      custom_slug: { type: 'string', description: 'Set or replace custom short link slug.' },
      clear_custom_slug: { type: 'boolean', description: 'Clear existing custom short link slug.' },
      allow_comments: { type: 'boolean', description: 'Enable or disable public review comments.' },
      allow_data: { type: 'boolean', description: 'Enable or disable page data collection.' },
      require_viewer_email: { type: 'boolean', description: 'Require viewer email before access.' },
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer DSH credentials or plugin config.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderSettings(value),
    },
    async execute(args, exec) {
      const response = await updateSettingsPayload(ctx, config, args.ref, settingsPayload(args), args, exec.signal, sessionApiKey)
      return pageResult(response, 'share', 'update')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shareone_get_comments',
    description: 'List comments and summary counts for a ShareOne share. This public read operation does not require an API key.',
    parameters: {
      ref: { type: 'string', required: true, description: 'ShareOne URL, share_id, or custom slug.' },
      status: { type: 'string', description: 'Comment status filter: all, open, in_progress, unresolved, resolved, or dismissed.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderComments,
    },
    async execute(args, exec) {
      const { shareRef } = parseRef(args.ref)
      const encoded = encodeURIComponent(shareRef)
      const status = args.status || 'all'
      const [summary, comments] = await Promise.all([
        requestJson(config, `/api/v1/shares/${encoded}/comments/summary`, { method: 'GET' }, null, exec.signal),
        requestJson(config, `/api/v1/shares/${encoded}/comments?status=${encodeURIComponent(status)}`, { method: 'GET' }, null, exec.signal),
      ])
      return { ok: true, ref: shareRef, status, summary, comments }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shareone_reply_comment',
    description: 'Reply to a ShareOne comment as an agent. Requires owner API key.',
    parameters: {
      ref: { type: 'string', required: true, description: 'ShareOne URL, share_id, or custom slug.' },
      parent_id: { type: 'string', required: true, description: 'Parent comment id.' },
      content: { type: 'string', required: true, description: 'Reply content.' },
      state: { type: 'string', required: true, description: 'Agent reply state: resolved-agree resolves the parent comment, open-disagree keeps it open with an objection, open-need-input keeps it open while requesting clarification.' },
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer DSH credentials or plugin config.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJsonSummary('Posted ShareOne comment reply'),
    },
    async execute(args, exec) {
      const state = typeof args.state === 'string' ? args.state.trim() : ''
      if (!AGENT_REPLY_STATES.has(state)) {
        throw new Error(`Invalid ShareOne agent reply state: ${args.state || '(missing)'}. Use one of: ${Array.from(AGENT_REPLY_STATES).join(', ')}`)
      }
      const { shareRef } = parseRef(args.ref)
      const encoded = encodeURIComponent(shareRef)
      const comments = await requestJson(config, `/api/v1/shares/${encoded}/comments?status=all`, { method: 'GET' }, null, exec.signal)
      const parent = (comments || []).find(comment => String(comment.id) === String(args.parent_id))
      if (!parent) throw new Error(`Comment not found: ${args.parent_id}`)

      const response = await requestAuthenticatedJson(ctx, config, `/api/v1/shares/${encoded}/comments`, args, { method: 'POST' }, {
        parent_id: parent.id,
        quote: parent.quote,
        highlighter_data: parent.highlighter_data,
        content: args.content,
        author_role: 'agent',
        state,
      }, exec.signal, sessionApiKey)
      return { ok: true, ref: shareRef, comment: response }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shareone_update_comment_status',
    description: 'Update a ShareOne comment status to open, in_progress, resolved, or dismissed. Requires owner API key.',
    parameters: {
      ref: { type: 'string', required: true, description: 'ShareOne URL, share_id, or custom slug.' },
      comment_id: { type: 'string', required: true, description: 'Comment id to update.' },
      status: { type: 'string', required: true, description: 'New status: open, in_progress, resolved, or dismissed.' },
      note: { type: 'string', description: 'Optional resolution note.' },
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer DSH credentials or plugin config.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJsonSummary('Updated ShareOne comment status'),
    },
    async execute(args, exec) {
      const allowed = new Set(['open', 'in_progress', 'resolved', 'dismissed'])
      if (!allowed.has(args.status)) throw new Error(`Invalid status: ${args.status}`)
      const { shareRef } = parseRef(args.ref)
      const payload = { status: args.status }
      if (args.note) payload.note = args.note
      const response = await requestAuthenticatedJson(
        ctx,
        config,
        `/api/v1/shares/${encodeURIComponent(shareRef)}/comments/${encodeURIComponent(args.comment_id)}/status`,
        args,
        { method: 'PUT' },
        payload,
        exec.signal,
        sessionApiKey,
      )
      return { ok: true, ref: shareRef, comment_id: args.comment_id, status: args.status, result: response }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shareone_download',
    description: 'Download the original source file for a ShareOne share to a local path.',
    parameters: {
      ref: { type: 'string', required: true, description: 'ShareOne URL, share_id, or custom slug.' },
      output_path: { type: 'string', required: true, description: 'Local path where the downloaded file should be written.' },
      password: { type: 'string', description: 'Password for protected public downloads.' },
      owner: { type: 'boolean', description: 'Use owner API download endpoint. Requires API key.' },
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer DSH credentials or plugin config.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `Downloaded ShareOne source to ${value.output_path}` }],
    },
    async execute(args, exec) {
      const { shareRef } = parseRef(args.ref)
      let res
      if (args.owner) {
        res = await requestAuthenticatedBuffer(ctx, config, `/api/v1/shares/${encodeURIComponent(shareRef)}/download`, args, { method: 'GET' }, null, exec.signal, sessionApiKey)
      } else if (args.password) {
        const body = JSON.stringify({ ref: shareRef, password: args.password })
        res = await requestBuffer(appendPath(config.baseUrl, '/api/v1/public-download'), {
          method: 'POST',
          timeoutMs: config.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, body, exec.signal)
      } else {
        res = await requestBuffer(appendPath(config.baseUrl, `/api/v1/public-download?ref=${encodeURIComponent(shareRef)}`), {
          method: 'GET',
          timeoutMs: config.timeoutMs,
        }, null, exec.signal)
      }

      const outputPath = path.resolve(args.output_path)
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, res.data)
      return {
        ok: true,
        ref: shareRef,
        output_path: outputPath,
        bytes: res.data.length,
        content_type: res.headers['content-type'] || null,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shareone_create_guest_key',
    description: 'Create a temporary ShareOne guest API key for first-time use.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value.stored) {
          return [{ type: 'text', text: `Created and stored a ShareOne guest API key as ${value.api_key_env}. Future ShareOne calls can use it without exposing the key.` }]
        }
        return [{ type: 'text', text: `Created a ShareOne guest API key for this session. It could not be stored as ${value.api_key_env}: ${value.store_error}` }]
      },
    },
    async execute(_args, exec) {
      const response = await requestJson(config, '/api/v1/agent-guest-key', { method: 'POST' }, { source: PUBLISH_SOURCE }, exec.signal)
      const ref = getApiKeyRef(config)
      sessionApiKey = response.api_key
      let stored = false
      let storeError = null
      try {
        await ctx.credentials.set(ref, response.api_key)
        stored = true
        sessionApiKey = null
      } catch (error) {
        storeError = error?.message || String(error)
      }
      return {
        ok: true,
        stored,
        api_key_env: ref,
        store_error: storeError,
        bind_url: appendPath(config.baseUrl, '/account'),
      }
    },
  }))
}
