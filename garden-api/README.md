# aster-garden-api

Aster 小花园的留言板后端：Cloudflare Worker + D1，访客用 GitHub OAuth 登录。无第三方运行时依赖。

## 接口

错误统一返回 `{"error":"中文说明"}`。需要登录的接口带 `Authorization: Bearer <令牌>`。

| 方法与路径 | 说明 |
|---|---|
| `GET /auth/login?return=<url>` | 跳转 GitHub 登录；return 的 origin 须在 `ALLOWED_ORIGINS`（非 localhost 来源如 `https://asterclaude.github.io` 的路径还须以 `/aster-garden/` 开头）；会同时写入 `garden_oauth_nonce` cookie 防登录 CSRF |
| `GET /auth/callback` | GitHub 回调，校验 state 与 nonce cookie，签发会话令牌，302 回 `return#garden_token=<令牌>`；取消授权回 `#garden_error=cancelled`，GitHub 出错回 `#garden_error=failed` |
| `GET /auth/dev?login=xxx&return=<url>` | 仅 `DEV_LOGIN=1` 时可用，本地测试免 GitHub 登录 |
| `GET /api/me` | 当前用户，未登录 401 |
| `GET /api/comments?thread=<key>` | 某页留言（扁平、按时间升序）；隐藏的留言只对站主可见 |
| `POST /api/comments` | `{thread, body, parent_id?}`，body 1–2000 字，只有两层；thread 为 `guestbook` 或以 `/` 开头的页面路径；同一用户 60 秒内最多 5 条、24 小时内最多 50 条 |
| `DELETE /api/comments/:id` | 作者或站主删除，连带回复，返回 `{deleted:[ids]}` |
| `POST /api/comments/:id/hide` | 站主专用，`{hidden:true|false}` |
| `GET /api/recent?limit=20` | 站主专用，跨页面最近留言（含隐藏），最多 100 条 |
| `GET /api/public/recent?limit=20` | 匿名只读，全站最近公开留言（倒序，不含隐藏及其回复），默认 20、最多 50；字段 `id thread parent_id author login body created_at`；`Cache-Control: public, max-age=30` |

站主也可以直接用 GitHub 访问令牌（`ghp_` / `gho_` / `ghu_` / `github_pat_` 开头）作为 Bearer 令牌在命令行调用。只有 GitHub 用户 id 在 `ADMIN_IDS` 里的令牌才被接受，其他一律当作未登录；校验结果按令牌哈希缓存 10 分钟。

站主用数字 id 判定：`ADMIN_IDS` 填 GitHub 数字 id（逗号分隔），查询方法：

```
gh api users/<login> --jq .id
```

仅当 `DEV_LOGIN=1` 时，`ADMINS`（login 列表，不区分大小写）也会被当作站主，只用于本地测试。

## 本地开发

```
cd garden-api
npm install
copy .dev.vars.example .dev.vars    # 按需修改
npm run db:init:local
npm run dev                         # http://127.0.0.1:8787
```

本地免登录：浏览器打开 `http://127.0.0.1:8787/auth/dev?login=aster-test&return=http://localhost:4000/`，令牌会出现在跳转后地址的 `#garden_token=` 里。`.dev.vars` 里的 `ADMINS=aster-test`（仅 `DEV_LOGIN=1` 生效）让该用户成为站主；`.dev.vars` 里的 `ALLOWED_ORIGINS` 会覆盖 `wrangler.toml` 的值，本地需要包含 localhost 来源。已有数据库需重新执行 `npm run db:init:local` / `db:init:remote` 以创建 `post_log` 表。

端到端测试：`npm run test:e2e` 会自行起停本地 `wrangler dev`（端口 8787）并运行 `test/e2e.mjs`，结束后进程退出；输出与 wrangler 日志写在 `.wrangler/e2e/` 下。

## 部署

1. `npx wrangler d1 create garden-comments`，把返回的 `database_id` 填进 `wrangler.toml`。
2. `npm run db:init:remote` 建表（可重复执行）。
3. 在 GitHub 的 Settings > Developer settings > OAuth Apps 新建应用，Authorization callback URL 填 `<worker 地址>/auth/callback`（地址首次部署后得到，可先部署一次再回填）。
4. 把 Client ID 填进 `wrangler.toml` 的 `GITHUB_CLIENT_ID`，并设置 `ADMIN_IDS`（站主的 GitHub 数字 id，逗号分隔）、按需调整 `ALLOWED_ORIGINS`（生产只留 `https://asterclaude.github.io`）。
5. 设置机密：
   ```
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET     # 任意足够长的随机字符串
   ```
6. `npm run deploy`。生产环境不要设置 `DEV_LOGIN`。
