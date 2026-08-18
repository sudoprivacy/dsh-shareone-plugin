import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'shareone'
export const inject = ['tools']

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

function appendPath(baseUrl, apiPath) {
  const trimmedBase = String(baseUrl || '').replace(/\/+$/, '')
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
  return `${trimmedBase}${normalizedPath}`
}

function getMimeType(filePath, override) {
  if (override) return override
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function getApiKey(config, explicitApiKey) {
  if (explicitApiKey && String(explicitApiKey).trim()) return String(explicitApiKey).trim()
  if (config.apiKey && String(config.apiKey).trim()) return String(config.apiKey).trim()
  const envName = config.apiKeyEnv || 'SHAREONE_API_KEY'
  if (envName && process.env[envName] && process.env[envName].trim()) return process.env[envName].trim()
  return null
}

function requireApiKey(config, args = {}) {
  const apiKey = getApiKey(config, args.api_key)
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

async function requestAuthenticatedJson(config, apiPath, args, options = {}, payload = null, signal = null) {
  const apiKey = requireApiKey(config, args)
  return requestJson(config, apiPath, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-API-Key': apiKey,
    },
  }, payload, signal)
}

async function requestAuthenticatedBuffer(config, apiPath, args, options = {}, body = null, signal = null) {
  const apiKey = requireApiKey(config, args)
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

function pageResult(response, contentKind) {
  return {
    ok: true,
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

async function publishBinaryMultipart(config, filePath, filename, contentType, args, signal) {
  const fields = {}
  if (args.password) fields.password = args.password
  if (args.watermark) fields.watermark = args.watermark
  if (args.custom_slug) fields.custom_slug = args.custom_slug

  const { body, boundary } = buildMultipartBody(fields, filePath, filename, contentType)
  const res = await requestAuthenticatedBuffer(config, '/api/v1/files', args, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  }, body, signal)
  return parseJsonResponse(res)
}

function shouldFallbackToMultipart(error) {
  const text = `${error?.message || ''}\n${error?.responseText || ''}`
  return error?.statusCode === 400 && /Direct upload is only supported/i.test(text)
}

async function updateSettingsPayload(config, ref, payload, args, signal) {
  const parsed = parseRef(ref)
  const explicitApiPath = endpointForPrefix(parsed.prefix, parsed.shareRef)
  const pagePath = `/api/v1/pages/${encodeURIComponent(parsed.shareRef)}`
  const filePath = `/api/v1/files/${encodeURIComponent(parsed.shareRef)}`

  if (explicitApiPath) {
    return requestAuthenticatedJson(config, explicitApiPath, args, { method: 'PUT' }, payload, signal)
  }

  try {
    return await requestAuthenticatedJson(config, pagePath, args, { method: 'PUT' }, payload, signal)
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 404) {
      return requestAuthenticatedJson(config, filePath, args, { method: 'PUT' }, payload, signal)
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
  return [{ type: 'text', text: `Published to ShareOne: ${value.share_url}${warning}` }]
}

function renderSettings(value) {
  return [{ type: 'text', text: `Updated ShareOne settings: ${value.share_url}` }]
}

function renderJsonSummary(label) {
  return (_args, value) => [{ type: 'text', text: `${label}: ${JSON.stringify(value)}` }]
}

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'shareone_publish_text',
    description: 'Publish HTML, Markdown, or plain text content to ShareOne and return a public share link.',
    parameters: {
      filename: { type: 'string', required: true, description: 'Display filename, for example index.html, notes.md, or readme.txt.' },
      content: { type: 'string', required: true, description: 'HTML, Markdown, or plain text content to publish.' },
      password: { type: 'string', description: 'Optional access password.' },
      watermark: { type: 'string', description: 'Optional watermark text.' },
      custom_slug: { type: 'string', description: 'Optional custom short link slug, 3-64 lowercase letters, numbers, or hyphens.' },
      allow_comments: { type: 'boolean', description: 'Enable public review comments for this share.' },
      title: { type: 'string', description: 'Optional display title.' },
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer plugin config or environment variable.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderShare(value),
    },
    async execute(args, exec) {
      const payload = {
        filename: args.filename,
        html_content: args.content,
      }
      if (args.password) payload.password = args.password
      if (args.watermark) payload.watermark = args.watermark
      if (args.custom_slug) payload.custom_slug = args.custom_slug
      if (typeof args.allow_comments === 'boolean') payload.allow_comments = args.allow_comments
      if (args.title) payload.title = args.title

      const response = await requestAuthenticatedJson(config, '/api/v1/pages', args, { method: 'POST' }, payload, exec.signal)
      return pageResult(response, 'page')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shareone_publish_file',
    description: 'Publish a local PDF, Word, PowerPoint, or other file to ShareOne and return a public share link.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Local file path to upload. Absolute paths are preferred.' },
      filename: { type: 'string', description: 'Optional display filename override.' },
      content_type: { type: 'string', description: 'Optional MIME type override.' },
      password: { type: 'string', description: 'Optional access password.' },
      watermark: { type: 'string', description: 'Optional watermark text.' },
      custom_slug: { type: 'string', description: 'Optional custom short link slug.' },
      allow_comments: { type: 'boolean', description: 'Enable comments after upload if supported by the file type.' },
      title: { type: 'string', description: 'Optional display title.' },
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer plugin config or environment variable.' },
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

      try {
        const credential = await requestAuthenticatedJson(config, '/api/v1/files/credential', args, { method: 'POST' }, {
          filename,
          content_type: contentType,
          custom_slug: args.custom_slug || undefined,
        }, exec.signal)

        if (credential.upload_type === 'azure') {
          await uploadToAzure(credential, filePath, contentType, config.timeoutMs, exec.signal)
        } else {
          await uploadToS3(credential, filePath, filename, contentType, config.timeoutMs, exec.signal)
        }

        const confirmPayload = {
          share_id: credential.share_id,
          filename,
          content_type: contentType,
        }
        if (args.password) confirmPayload.password = args.password
        if (args.watermark) confirmPayload.watermark = args.watermark
        if (args.custom_slug) confirmPayload.custom_slug = args.custom_slug
        response = await requestAuthenticatedJson(config, '/api/v1/files/confirm', args, { method: 'POST' }, confirmPayload, exec.signal)
      } catch (error) {
        if (!shouldFallbackToMultipart(error)) throw error
        response = await publishBinaryMultipart(config, filePath, filename, contentType, args, exec.signal)
      }

      if (args.title || typeof args.allow_comments === 'boolean') {
        const payload = {}
        if (args.title) payload.title = args.title
        if (typeof args.allow_comments === 'boolean') payload.allow_comments = args.allow_comments
        response = await updateSettingsPayload(config, response.share_id, payload, args, exec.signal)
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
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer plugin config or environment variable.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderSettings(value),
    },
    async execute(args, exec) {
      const response = await updateSettingsPayload(config, args.ref, settingsPayload(args), args, exec.signal)
      return pageResult(response, 'share')
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
      render: (_args, value) => [{ type: 'text', text: `ShareOne comments: ${value.summary.total} total, ${value.summary.open} open, ${value.summary.in_progress} in progress.` }],
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
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer plugin config or environment variable.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderJsonSummary('Posted ShareOne comment reply'),
    },
    async execute(args, exec) {
      const { shareRef } = parseRef(args.ref)
      const encoded = encodeURIComponent(shareRef)
      const comments = await requestJson(config, `/api/v1/shares/${encoded}/comments?status=all`, { method: 'GET' }, null, exec.signal)
      const parent = (comments || []).find(comment => String(comment.id) === String(args.parent_id))
      if (!parent) throw new Error(`Comment not found: ${args.parent_id}`)

      const response = await requestAuthenticatedJson(config, `/api/v1/shares/${encoded}/comments`, args, { method: 'POST' }, {
        parent_id: parent.id,
        quote: parent.quote,
        highlighter_data: parent.highlighter_data,
        content: args.content,
        author_role: 'agent',
      }, exec.signal)
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
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer plugin config or environment variable.' },
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
        config,
        `/api/v1/shares/${encodeURIComponent(shareRef)}/comments/${encodeURIComponent(args.comment_id)}/status`,
        args,
        { method: 'PUT' },
        payload,
        exec.signal,
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
      api_key: { type: 'string', description: 'Optional ShareOne API key override. Prefer plugin config or environment variable.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `Downloaded ShareOne source to ${value.output_path}` }],
    },
    async execute(args, exec) {
      const { shareRef } = parseRef(args.ref)
      let res
      if (args.owner) {
        res = await requestAuthenticatedBuffer(config, `/api/v1/shares/${encodeURIComponent(shareRef)}/download`, args, { method: 'GET' }, null, exec.signal)
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
      render: (_args, value) => [{ type: 'text', text: `Created a ShareOne guest API key. Set ${value.api_key_env} to use it in future calls.` }],
    },
    async execute(_args, exec) {
      const response = await requestJson(config, '/api/v1/agent-guest-key', { method: 'POST' }, null, exec.signal)
      return {
        ok: true,
        api_key: response.api_key,
        api_key_env: config.apiKeyEnv || 'SHAREONE_API_KEY',
        bind_url: appendPath(config.baseUrl, '/account'),
      }
    },
  }))
}
