# dsh-shareone-plugin

<p align="center">
  <strong>把 Agent 生成的网页、文档和文字内容，一键发布成 ShareOne 分享链接。</strong>
</p>

<p align="center">
  <a href="https://shareone.vip"><img alt="Website" src="https://img.shields.io/badge/website-shareone.vip-0f766e"></a>
  <img alt="npm" src="https://img.shields.io/npm/v/dsh-shareone-plugin?label=npm&color=7c3aed">
  <img alt="DSH Plugin" src="https://img.shields.io/badge/DSH-plugin-2563eb">
  <img alt="ShareOne" src="https://img.shields.io/badge/ShareOne-share%20links-16a34a">
  <img alt="Free" src="https://img.shields.io/badge/free-90%20day%20active%20retention-f59e0b">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-64748b">
</p>

## ✨ 这是什么

`dsh-shareone-plugin` 是给 DeepSeek Harness / DSH 使用的 ShareOne 插件。它让 agent 可以把本地文件或生成内容发布到 ShareOne，并返回一个可以直接分享给别人访问的短链接。

支持发布这些内容：

| 类型 | 扩展名 | 分享能力 | 评论协作 |
| --- | --- | --- | --- |
| 📝 文本 | `.txt` | ✅ | ✅ |
| 📘 Markdown | `.md`, `.markdown` | ✅ | ✅ |
| 🌐 网页 | `.html`, `.htm` | ✅ | ✅ |
| 📊 PowerPoint | `.ppt`, `.pptx` | ✅ | - |
| 📄 PDF | `.pdf` | ✅ | - |
| 🧾 Word | `.doc`, `.docx` | ✅ | - |

常用能力：

- 🔗 发布为 ShareOne 分享链接
- 🔐 设置访问密码
- 💧 添加水印
- 🏷️ 自定义短链接
- 🔁 更新已有 TXT / Markdown / HTML 链接内容
- 💬 读取、回复和处理 TXT / Markdown / HTML 页面的评论
- 🗂️ 发布后在 ShareOne 平台统一管理

## 🎁 免费与 90 天规则

ShareOne 当前支持免费发布和分享。

普通分享链接按“最后活跃时间”保留：如果一个链接连续 90 天没有被访问，就可能被自动清理；只要 90 天内有人访问，保留时间会继续延后。被知识库引用的内容、以及符合 Explore 展示条件的公开 HTML 页面，不参与普通 90 天无活跃清理。

## 🚀 安装

```bash
dsh plugin --profile web add dsh-shareone-plugin
dsh --profile web
```

本仓库本地开发安装：

```bash
dsh plugin --profile web add ./dsh-shareone-plugin
dsh --profile web
```

## 🔑 第一次使用

### 没有 ShareOne 账号

第一次使用时，让 agent 先创建临时 guest key：

```txt
请先创建 ShareOne 临时 API Key，然后帮我发布这个文件。
```

插件会调用 `shareone_create_guest_key` 自动生成 guest key，并写入 DSH 的密钥管理中，后续 ShareOne 工具会直接复用这个 key。生成后建议打开 agent 返回的绑定链接，把临时 key 绑定到你的 ShareOne 账号，避免以后丢失管理权限。

### 已经有 ShareOne 账号

1. 打开 https://shareone.vip 并登录。
2. 进入 https://shareone.vip/settings。
3. 在设置页显示并复制你的 `API Key`。
4. 在 DSH 的密钥管理中新增或更新密钥：

```txt
名称：SHAREONE_API_KEY
值：从 ShareOne 设置页复制的 API Key
```

配置好后，插件会从 DSH 密钥管理读取 `SHAREONE_API_KEY`。

## 🧭 发布后怎么管理

发布成功后，可以打开 ShareOne 平台管理自己的链接：

- 🗂️ 文件管理中心：https://shareone.vip/manage
- ⚙️ 账号与 API Key：https://shareone.vip/settings

在文件管理中心可以查看已发布链接、搜索文件、查看访问量、调整访问密码、设置水印、修改短链接、开关评论、管理协作者，以及继续更新已有 TXT / Markdown / HTML 内容。

## 🧰 工具速览

### `shareone_publish_text`

发布 agent 生成的 HTML、Markdown 或纯文本内容。

常用参数：

- `filename`
- `content`
- `password`
- `watermark`
- `custom_slug`
- `allow_comments`
- `title`

传入 `ref` 或 `share_id` 时，会更新已有 TXT / Markdown / HTML 链接内容，而不是创建新链接。

### `shareone_publish_file`

发布本地 TXT、Markdown、HTML、PPT、PDF 或 Word 文件。

常用参数：

- `file_path`
- `filename`
- `password`
- `watermark`
- `custom_slug`
- `allow_comments`
- `title`

如果文件是 `.txt`、`.md`、`.markdown`、`.html` 或 `.htm`，传入 `ref` 或 `share_id` 可以原地更新已有链接内容。PPT、PDF、Word 会发布为新的文档分享链接。

### `shareone_update_settings`

修改已有分享链接的设置。

常用参数：

- `ref`
- `title`
- `password`
- `clear_password`
- `watermark`
- `clear_watermark`
- `custom_slug`
- `clear_custom_slug`
- `allow_comments`

### `shareone_get_comments`

读取 TXT / Markdown / HTML 分享页的评论和统计摘要。

常用参数：

- `ref`
- `status`: `all`, `open`, `in_progress`, `unresolved`, `resolved`, `dismissed`

返回内容包含评论 id、父评论 id、状态、作者、评论正文、选中的原文片段和定位数据，方便 agent 理解评论指向的位置。

### `shareone_reply_comment`

回复 TXT / Markdown / HTML 分享页上的评论。

常用参数：

- `ref`
- `parent_id`
- `content`
- `state`: `resolved-agree`, `open-disagree`, `open-need-input`

### `shareone_update_comment_status`

修改 TXT / Markdown / HTML 评论状态。

常用参数：

- `ref`
- `comment_id`
- `status`: `open`, `in_progress`, `resolved`, `dismissed`
- `note`

### `shareone_create_guest_key`

创建临时 ShareOne guest key，并自动保存到 DSH 密钥管理中，适合第一次使用 ShareOne 的用户。

## 🧪 本地开发

```bash
npm install
npm run check
npm run smoke
npm run test:credentials
npm run test:text-routing
npm run test:text-update
npm run test:comments-render
npm run test:reply-state
npm run pack:check
```

## 🚢 Release

这次 README 修改不要直接发新版。后续需要发布时，仍由 GitHub Actions 在推送版本 tag 后发布 npm 包。

```bash
npm version prerelease --preid beta
git push origin main --follow-tags
```

发布工作流会校验版本、安装依赖、运行检查，并把包发布到 npm。

## 🛡️ 安全说明

插件只会读取你明确传给 `shareone_publish_file` 的本地文件。发布内容会发送到配置的 ShareOne 服务，默认地址是 `https://shareone.vip`。不要发布密钥、私人 token、内部接口地址或不应公开的内容。
