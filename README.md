# dsh-shareone-plugin

ShareOne tools for DeepSeek Harness. This bundle lets Harness agents publish
HTML, Markdown, TXT, PDF, Word, and PowerPoint files to ShareOne, update share
settings, download source files, and process comments.

## Install

```bash
dsh plugin --profile web add dsh-shareone-plugin
dsh --profile web
```

For local development from this repository:

```bash
dsh plugin --profile web add ./dsh-shareone-plugin
dsh --profile web
```

## Configure

The default bundle config reads the API key from the DSH credential reference
`SHAREONE_API_KEY`:

```bash
export SHAREONE_API_KEY=your_shareone_api_key
dsh --profile web
```

You can override config in your profile patch:

```yaml
- insert:
    - id: shareone
      name: dsh-shareone-plugin
      config:
        baseUrl: https://shareone.vip
        apiKeyEnv: SHAREONE_API_KEY
        timeoutMs: 60000
```

Credential precedence:

```txt
tool argument api_key > plugin config apiKey > DSH credential from apiKeyEnv
```

The plugin never renders configured API keys in tool output. The
`shareone_create_guest_key` tool stores the temporary key in DSH credentials
under `apiKeyEnv` so later ShareOne calls can use it without exposing the key to
the model. If the credential store rejects the write, the plugin keeps the key
in memory for the current DSH process only.

## Tools

### shareone_publish_text

Publish HTML, Markdown, or plain text content.

Main arguments:

- `filename`
- `content`
- `password`
- `watermark`
- `custom_slug`
- `allow_comments`
- `title`

Uses `POST /api/v1/pages`.

### shareone_publish_file

Publish a local file such as PDF, Word, PowerPoint, or other binary files.

Main arguments:

- `file_path`
- `filename`
- `content_type`
- `password`
- `watermark`
- `custom_slug`
- `allow_comments`
- `title`

Uses direct upload:

```txt
POST /api/v1/files/credential
upload to object storage
POST /api/v1/files/confirm
```

If direct upload is not available, the tool falls back to multipart
`POST /api/v1/files`.

### shareone_update_settings

Update settings for an existing share.

Main arguments:

- `ref`
- `filename`
- `title`
- `password`
- `clear_password`
- `watermark`
- `clear_watermark`
- `custom_slug`
- `clear_custom_slug`
- `allow_comments`
- `allow_data`
- `require_viewer_email`

The `ref` can be a full ShareOne URL, share id, or custom slug. The tool routes
to page or file metadata endpoints based on the URL prefix and falls back from
page update to file update when the type is unknown.

### shareone_get_comments

List comments and summary counts for a share.

Main arguments:

- `ref`
- `status`: `all`, `open`, `in_progress`, `unresolved`, `resolved`, or `dismissed`

This is a public read operation and does not require an API key.

### shareone_reply_comment

Reply to an existing parent comment as an agent. Requires owner API key.

Main arguments:

- `ref`
- `parent_id`
- `content`

The tool fetches the parent comment first and reuses its quote and anchor data.

### shareone_update_comment_status

Update a comment status. Requires owner API key.

Main arguments:

- `ref`
- `comment_id`
- `status`: `open`, `in_progress`, `resolved`, or `dismissed`
- `note`

### shareone_download

Download the original source file to a local path.

Main arguments:

- `ref`
- `output_path`
- `password`
- `owner`

Public download is used by default. Set `owner: true` to use the owner download
endpoint with an API key.

### shareone_create_guest_key

Create a temporary ShareOne guest API key for first-time use.

## Release

Publishing is handled by GitHub Actions when a version tag is pushed.

One-time setup:

```txt
GitHub repo secret NPM_TOKEN = npm automation token with publish access
```

Release a new version:

```bash
npm version patch
git push origin main --follow-tags
```

The workflow runs on tags matching `v*.*.*`. It checks that the tag version
matches `package.json`, installs dependencies with `npm ci`, runs syntax and
tool-registration checks, verifies package contents with `npm pack --dry-run`,
and publishes to npm with provenance.

For discovery, publish the source repository on GitHub and add these topics:

```txt
dsh-plugin
deepseek-harness
shareone
agent-tool
```

## Security Notes

This plugin can read files passed to `shareone_publish_file` or
`shareone_download.output_path`. Published content is sent to the configured
ShareOne server, which defaults to `https://shareone.vip`.
