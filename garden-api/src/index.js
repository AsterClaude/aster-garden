// aster-garden 留言板后端：Cloudflare Worker + D1，GitHub OAuth 登录。
// 无第三方依赖，只用 Web Crypto 与 fetch。

const enc = new TextEncoder();
const dec = new TextDecoder();
const SESSION_TTL = 30 * 24 * 3600; // 秒
const STATE_TTL = 10 * 60;
const GH_TOKEN_PREFIXES = ["ghp_", "gho_", "ghu_", "github_pat_"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- 基础工具 ----------

function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function csv(s) {
  return (s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

// 站主按 GitHub 数字 id 判定（ADMIN_IDS）；仅 DEV_LOGIN=1 时额外接受 ADMINS（login）用于本地测试
function isAdminId(env, uid) {
  const id = String(uid);
  return csv(env.ADMIN_IDS).some((a) => a === id);
}

function isAdmin(env, uid, login) {
  if (uid !== undefined && uid !== null && isAdminId(env, uid)) return true;
  if (env.DEV_LOGIN === "1") {
    const l = String(login || "").toLowerCase();
    return csv(env.ADMINS).some((a) => a.toLowerCase() === l);
  }
  return false;
}

function timingSafeEqualStr(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

function allowedOrigins(env) {
  return csv(env.ALLOWED_ORIGINS);
}

function hmacKey(env, usage) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET 未设置");
  return crypto.subtle.importKey(
    "raw", enc.encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, [usage]
  );
}

// 签发 base64url(JSON).base64url(HMAC)
async function signToken(env, payload) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(env, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return body + "." + b64urlEncode(sig);
}

// 校验签名（subtle.verify 为常量时间比较）、类型与过期，失败返回 null
async function verifyToken(env, token, typ) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 2) return null;
    const key = await hmacKey(env, "verify");
    const ok = await crypto.subtle.verify(
      "HMAC", key, b64urlDecode(parts[1]), enc.encode(parts[0])
    );
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    if (payload.typ !== typ) return null;
    return payload;
  } catch {
    return null;
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function stableUid(login) {
  // FNV-1a 32 位，加偏移避开真实 GitHub id 的低位段
  let h = 0x811c9dc5;
  for (const c of String(login).toLowerCase()) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 2000000000 + (h % 1000000000);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins(env).includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
  }
  return {};
}

function jsonResponse(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
  });
}

async function readJson(request) {
  try {
    const v = await request.json();
    if (v && typeof v === "object") return v;
  } catch {}
  throw new HttpError(400, "请求内容不是有效的 JSON");
}

// ---------- 身份 ----------

async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return null;
  const token = m[1];
  if (GH_TOKEN_PREFIXES.some((p) => token.startsWith(p))) {
    return githubTokenAdmin(env, token);
  }
  const p = await verifyToken(env, token, "session");
  if (!p || typeof p.uid !== "number" || typeof p.login !== "string" || !p.login) return null;
  return { uid: p.uid, login: p.login, name: p.name || null, avatar: p.avatar || null };
}

// GitHub 令牌只给站主用：解析出的用户 id 不在 ADMIN_IDS 里就当作未登录。
// 结果（含“否”）按令牌 SHA-256 缓存 10 分钟。
async function githubTokenAdmin(env, token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token)));
  let hash = "";
  for (const b of digest) hash += b.toString(16).padStart(2, "0");
  const cacheKey = new Request("https://cache.internal/gh/" + hash);
  const cache = caches.default;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const v = await hit.json();
      return v && v.uid ? v : null;
    }
  } catch {}
  let result = null;
  const u = await fetchGithubUser(token);
  if (u && isAdminId(env, u.uid)) result = u;
  try {
    await cache.put(cacheKey, new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" },
    }));
  } catch {}
  return result;
}

// 失败（网络错误、非 200、数据不完整）一律返回 null
async function fetchGithubUser(accessToken) {
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + accessToken,
        "User-Agent": "aster-garden-api",
        Accept: "application/vnd.github+json",
      },
    });
    if (r.status !== 200) return null;
    const u = await r.json();
    if (!u || typeof u.id !== "number" || !u.login) return null;
    return { uid: u.id, login: u.login, name: u.name || null, avatar: u.avatar_url || null };
  } catch {
    return null;
  }
}

function requireUser(user) {
  if (!user) throw new HttpError(401, "请先登录");
  return user;
}

// ---------- OAuth ----------

function checkReturn(env, raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "return 地址无效");
  }
  if (!allowedOrigins(env).includes(u.origin)) throw new HttpError(400, "return 地址不在允许范围内");
  // 站点已搬到 asterclaude.github.io：不再把域名写死在代码里，来源以 ALLOWED_ORIGINS 为准。
  // github.io 是用户级站点，同一来源下还有该账号的其他仓库页面，所以非 localhost 来源要求路径落在 /aster-garden/ 下；
  // localhost 规则保持原样（不限路径）。
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!isLocal && !u.pathname.startsWith("/aster-garden/")) {
    throw new HttpError(400, "return 地址不在允许范围内");
  }
  return u;
}

function redirectWithHash(returnUrl, hash, extraHeaders) {
  const u = new URL(returnUrl);
  u.hash = hash; // 已有 fragment 会被替换
  return new Response(null, {
    status: 302,
    headers: { Location: u.toString(), "Cache-Control": "no-store", ...(extraHeaders || {}) },
  });
}

function redirectWithToken(returnUrl, token, extraHeaders) {
  return redirectWithHash(returnUrl, "garden_token=" + token, extraHeaders);
}

async function issueSession(env, user) {
  return signToken(env, {
    typ: "session",
    uid: user.uid, login: user.login, name: user.name, avatar: user.avatar,
    exp: nowSec() + SESSION_TTL,
  });
}

const NONCE_COOKIE = "garden_oauth_nonce";
const CLEAR_NONCE_COOKIE = NONCE_COOKIE + "=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

async function authLogin(url, env) {
  const ret = checkReturn(env, url.searchParams.get("return") || "");
  if (!env.GITHUB_CLIENT_ID) throw new HttpError(500, "服务器未配置 GitHub 登录");
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
  const state = await signToken(env, { typ: "state", return: ret.toString(), nonce, exp: nowSec() + STATE_TTL });
  const q = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: url.origin + "/auth/callback",
    state,
    scope: "",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: "https://github.com/login/oauth/authorize?" + q.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": NONCE_COOKIE + "=" + nonce + "; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
    },
  });
}

async function authCallback(request, url, env) {
  const st = await verifyToken(env, url.searchParams.get("state") || "", "state");
  if (!st || typeof st.return !== "string" || typeof st.nonce !== "string") {
    throw new HttpError(400, "登录状态无效或已过期");
  }
  let ret;
  try {
    ret = checkReturn(env, st.return);
  } catch {
    throw new HttpError(400, "登录状态无效或已过期");
  }

  // 用户在 GitHub 取消授权
  if (url.searchParams.get("error")) {
    return redirectWithHash(ret.toString(), "garden_error=cancelled", { "Set-Cookie": CLEAR_NONCE_COOKIE });
  }

  const cookieNonce = getCookie(request, NONCE_COOKIE);
  if (!cookieNonce || !timingSafeEqualStr(cookieNonce, st.nonce)) {
    return new Response("登录校验没通过，请回到原页面重新登录。", {
      status: 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": CLEAR_NONCE_COOKIE,
      },
    });
  }

  const failed = () => redirectWithHash(ret.toString(), "garden_error=failed", { "Set-Cookie": CLEAR_NONCE_COOKIE });

  const code = url.searchParams.get("code");
  if (!code) throw new HttpError(400, "缺少授权码");
  let td = {};
  try {
    const tr = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "aster-garden-api" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: url.origin + "/auth/callback",
      }),
    });
    td = await tr.json().catch(() => ({}));
  } catch {
    return failed();
  }
  if (!td || !td.access_token) return failed();
  const gu = await fetchGithubUser(td.access_token);
  if (!gu) return failed();
  return redirectWithToken(ret.toString(), await issueSession(env, gu), { "Set-Cookie": CLEAR_NONCE_COOKIE });
}

async function authDev(url, env) {
  if (env.DEV_LOGIN !== "1") throw new HttpError(404, "没有这个页面");
  const ret = checkReturn(env, url.searchParams.get("return") || "");
  const login = (url.searchParams.get("login") || "").trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new HttpError(400, "login 无效");
  const token = await issueSession(env, {
    uid: stableUid(login), login, name: login,
    avatar: "https://github.com/identicons/" + login + ".png",
  });
  return redirectWithToken(ret.toString(), token);
}

// ---------- 留言 ----------

function fmt(env, row, viewer, withThread) {
  const item = {
    id: row.id,
    parent_id: row.parent_id,
    login: row.login,
    name: row.name,
    avatar: row.avatar,
    body: row.body,
    created_at: row.created_at,
    is_admin: isAdmin(env, row.user_id, row.login),
    hidden: row.hidden ? 1 : 0,
    mine: !!viewer && viewer.uid === row.user_id,
  };
  if (withThread) item.thread = row.thread;
  return item;
}

function viewerInfo(env, user) {
  return user ? { login: user.login, is_admin: isAdmin(env, user.uid, user.login) } : null;
}

function parseId(s) {
  const id = Number(s);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "留言 ID 无效");
  return id;
}

async function getMe(env, user) {
  requireUser(user);
  return { login: user.login, name: user.name, avatar: user.avatar, is_admin: isAdmin(env, user.uid, user.login) };
}

// 文章的 page.url 不含 baseurl（见 _layouts/post.html 传 page.url），所以路径不带 /aster-garden 前缀
const THREAD_RE = /^\/[A-Za-z0-9/_\-.%]{1,190}$/;

function checkThread(thread) {
  if (typeof thread !== "string" || !(thread === "guestbook" || THREAD_RE.test(thread))) {
    throw new HttpError(400, "thread 无效");
  }
  return thread;
}

async function listComments(url, env, user) {
  const thread = checkThread(url.searchParams.get("thread") || "");
  const { results } = await env.DB.prepare(
    "SELECT * FROM comments WHERE thread = ?1 ORDER BY created_at ASC, id ASC LIMIT 1000"
  ).bind(thread).all();
  const viewer = viewerInfo(env, user);
  let rows = results;
  if (!(viewer && viewer.is_admin)) {
    const hiddenIds = new Set(rows.filter((r) => r.hidden).map((r) => r.id));
    rows = rows.filter((r) => !r.hidden && !hiddenIds.has(r.parent_id));
  }
  return { comments: rows.map((r) => fmt(env, r, user, false)), viewer };
}

async function createComment(request, env, user) {
  requireUser(user);
  const data = await readJson(request);
  const thread = checkThread(data.thread);
  const body = typeof data.body === "string" ? data.body.trim() : "";
  if (body.length < 1 || body.length > 2000) throw new HttpError(400, "留言需为 1 到 2000 个字符");

  let parentId = null;
  if (data.parent_id !== undefined && data.parent_id !== null) {
    const pid = parseId(data.parent_id);
    const parent = await env.DB.prepare("SELECT * FROM comments WHERE id = ?1").bind(pid).first();
    const admin = isAdmin(env, user.uid, user.login);
    if (!parent || parent.thread !== thread || (parent.hidden && !admin)) {
      throw new HttpError(400, "要回复的留言不存在");
    }
    parentId = parent.parent_id || parent.id; // 只有两层
  }

  // 频率限制：查 post_log（登录名统一小写）
  const loginKey = String(user.login).toLowerCase();
  const nowMs = Date.now();
  const cutMin = new Date(nowMs - 60 * 1000).toISOString();
  const cutDay = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const cnt = await env.DB.prepare(
    "SELECT " +
    "(SELECT COUNT(*) FROM post_log WHERE login = ?1 AND at > ?2) AS n_min, " +
    "(SELECT COUNT(*) FROM post_log WHERE login = ?1 AND at > ?3) AS n_day"
  ).bind(loginKey, cutMin, cutDay).first();
  if (cnt && cnt.n_min >= 5) throw new HttpError(429, "留言太频繁了，请稍后再试");
  if (cnt && cnt.n_day >= 50) throw new HttpError(429, "今天留言太多了，明天再来吧");

  const createdAt = new Date(nowMs).toISOString();
  let row;
  if (parentId === null) {
    row = await env.DB.prepare(
      "INSERT INTO comments (thread, parent_id, user_id, login, name, avatar, body, created_at, hidden) " +
      "VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, 0) RETURNING *"
    ).bind(thread, user.uid, user.login, user.name, user.avatar, body, createdAt).first();
  } else {
    // 单条语句：父留言仍存在且在同一 thread 才插入，避免与删除并发
    row = await env.DB.prepare(
      "INSERT INTO comments (thread, parent_id, user_id, login, name, avatar, body, created_at, hidden) " +
      "SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0 " +
      "WHERE EXISTS (SELECT 1 FROM comments WHERE id = ?2 AND thread = ?1) RETURNING *"
    ).bind(thread, parentId, user.uid, user.login, user.name, user.avatar, body, createdAt).first();
  }
  if (!row) throw new HttpError(400, "要回复的留言已经不在了");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO post_log (login, at) VALUES (?1, ?2)").bind(loginKey, createdAt),
    env.DB.prepare("DELETE FROM post_log WHERE at < ?1").bind(new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString()),
  ]);
  return fmt(env, row, user, false);
}

async function deleteComment(env, user, id) {
  requireUser(user);
  const row = await env.DB.prepare("SELECT * FROM comments WHERE id = ?1").bind(id).first();
  if (!row) throw new HttpError(404, "留言不存在");
  if (row.user_id !== user.uid && !isAdmin(env, user.uid, user.login)) throw new HttpError(403, "无权删除这条留言");
  // 逐层收集全部后代
  const ids = [id];
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const pid of frontier) {
      const { results } = await env.DB.prepare("SELECT id FROM comments WHERE parent_id = ?1").bind(pid).all();
      for (const r of results) if (!ids.includes(r.id)) { ids.push(r.id); next.push(r.id); }
    }
    frontier = next;
  }
  await env.DB.batch(ids.map((i) => env.DB.prepare("DELETE FROM comments WHERE id = ?1").bind(i)));
  return { deleted: ids };
}

async function hideComment(request, env, user, id) {
  requireUser(user);
  if (!isAdmin(env, user.uid, user.login)) throw new HttpError(403, "只有站主可以操作");
  const data = await readJson(request);
  if (typeof data.hidden !== "boolean") throw new HttpError(400, "hidden 需为 true 或 false");
  const row = await env.DB.prepare("UPDATE comments SET hidden = ?1 WHERE id = ?2 RETURNING *")
    .bind(data.hidden ? 1 : 0, id).first();
  if (!row) throw new HttpError(404, "留言不存在");
  return fmt(env, row, user, false);
}

async function recent(url, env, user) {
  requireUser(user);
  if (!isAdmin(env, user.uid, user.login)) throw new HttpError(403, "只有站主可以查看");
  let limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  limit = Math.min(limit, 100);
  const { results } = await env.DB.prepare(
    "SELECT * FROM comments ORDER BY created_at DESC, id DESC LIMIT ?1"
  ).bind(limit).all();
  return { comments: results.map((r) => fmt(env, r, user, true)) };
}

// 匿名只读：全站最近的公开留言（不含隐藏、不含隐藏留言的回复），字段只给公开列表已有的信息
async function publicRecent(url, env, cors) {
  let limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  limit = Math.min(limit, 50);
  const { results } = await env.DB.prepare(
    "SELECT c.id, c.thread, c.parent_id, c.login, c.name, c.body, c.created_at FROM comments c " +
      "WHERE c.hidden = 0 AND (c.parent_id IS NULL OR c.parent_id NOT IN (SELECT id FROM comments WHERE hidden = 1)) " +
      "ORDER BY c.created_at DESC, c.id DESC LIMIT ?1"
  ).bind(limit).all();
  const comments = results.map((r) => ({
    id: r.id, thread: r.thread, parent_id: r.parent_id,
    author: r.name || r.login, login: r.login, body: r.body, created_at: r.created_at,
  }));
  return new Response(JSON.stringify({ comments }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30",
      "Access-Control-Allow-Origin": "*",
      ...cors,
    },
  });
}

// ---------- 路由 ----------

async function route(request, env, url, cors) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "GET" && path === "/auth/login") return authLogin(url, env);
  if (method === "GET" && path === "/auth/callback") return authCallback(request, url, env);
  if (method === "GET" && path === "/auth/dev") return authDev(url, env);

  if (!path.startsWith("/api/")) throw new HttpError(404, "没有这个页面");
  if (path === "/api/public/recent" && method === "GET") return publicRecent(url, env, cors);
  const user = await getUser(request, env);
  const J = (d, s) => jsonResponse(d, s, cors);

  if (path === "/api/me" && method === "GET") return J(await getMe(env, user));
  if (path === "/api/comments" && method === "GET") return J(await listComments(url, env, user));
  if (path === "/api/comments" && method === "POST") return J(await createComment(request, env, user), 201);
  if (path === "/api/recent" && method === "GET") return J(await recent(url, env, user));

  let m = /^\/api\/comments\/([^/]+)$/.exec(path);
  if (m && method === "DELETE") return J(await deleteComment(env, user, parseId(m[1])));
  m = /^\/api\/comments\/([^/]+)\/hide$/.exec(path);
  if (m && method === "POST") return J(await hideComment(request, env, user, parseId(m[1])));

  throw new HttpError(404, "没有这个接口");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, url, cors);
      // 重定向等非 JSON 响应也补上 CORS 头
      for (const [k, v] of Object.entries(cors)) if (!res.headers.has(k)) res.headers.set(k, v);
      return res;
    } catch (e) {
      if (e instanceof HttpError) return jsonResponse({ error: e.message }, e.status, cors);
      console.error(e && e.message);
      return jsonResponse({ error: "服务器出错了" }, 500, cors);
    }
  },
};
