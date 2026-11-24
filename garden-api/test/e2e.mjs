// garden-api 端到端测试。先启动：npx wrangler dev --local --port 8787
// 运行：node test/e2e.mjs   （Node 18+，内置 fetch）
// 每次运行使用随机后缀的用户名，只断言本次创建的留言。

const BASE = "http://localhost:8787";
const ORIGIN = "http://localhost:4000";
const THREAD = "guestbook";
const RAND = Math.random().toString(36).slice(2, 8) || "x1";
// /auth/dev 的 login 只允许 [A-Za-z0-9-]，所以不用下划线
const LOGIN = {
  alice: `alice-${RAND}`,
  bob: `bob-${RAND}`,
  carol: `carol-${RAND}`,
  admin: "aster-test",
};

// ---------- 计数与输出 ----------

let passCount = 0;
let failCount = 0;
const failedIds = [];

function ck(id, name, expected, actual, ok) {
  if (ok) passCount++;
  else {
    failCount++;
    failedIds.push(id);
  }
  console.log(`${ok ? "PASS" : "FAIL"} [${id}] ${name}`);
  console.log(`     期望: ${expected}`);
  console.log(`     实际: ${actual}`);
}

function snip(s, n = 160) {
  return String(s).replace(/\s+/g, " ").slice(0, n);
}

function sameSet(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}

// ---------- HTTP 工具 ----------

async function call(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    h["Content-Type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const r = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, headers: r.headers, text, json };
}

// 期望状态码，打印并返回响应
function expectStatus(id, name, want, r) {
  const ok = r.status === want;
  ck(id, name, `HTTP ${want}`, `HTTP ${r.status} ${snip(r.text)}`, ok);
  return r;
}

// 通过 /auth/dev 取会话令牌：从 Location 的 #garden_token= 后取值
async function devToken(login) {
  const ret = encodeURIComponent(`${ORIGIN}/x`);
  const r = await call("GET", `/auth/dev?login=${encodeURIComponent(login)}&return=${ret}`);
  const loc = r.headers.get("location") || "";
  const m = /#garden_token=([^&#]+)/.exec(loc);
  return m ? m[1] : null;
}

function enc(s) {
  return encodeURIComponent(s);
}

// 段落异常不中断整个脚本，记为 FAIL 后继续
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    ck(`${name}-exception`, `${name} 抛出异常`, "无异常", snip(e && e.message ? e.message : e), false);
  }
}

// ---------- 主流程 ----------

const T = {};

async function setup() {
  for (const k of Object.keys(LOGIN)) {
    T[k] = await devToken(LOGIN[k]);
    ck(`setup-${k}`, `取得 ${LOGIN[k]} 的令牌`, "非空", T[k] ? `非空(${T[k].length} 字符)` : "null", !!T[k]);
  }
}

async function sectionA() {
  expectStatus("a1", "/auth/login?return=https://evil.com/ → 400", 400,
    await call("GET", `/auth/login?return=${enc("https://evil.com/")}`));
  expectStatus("a2", "/auth/dev return=https://evil.com/ → 400", 400,
    await call("GET", `/auth/dev?login=${LOGIN.alice}&return=${enc("https://evil.com/")}`));
  expectStatus("a3", "/auth/dev return=https://asterclaude.github.io/other-repo/ → 400", 400,
    await call("GET", `/auth/dev?login=${LOGIN.alice}&return=${enc("https://asterclaude.github.io/other-repo/")}`));
  expectStatus("a4", "/auth/dev return=https://asterclaude.github.io/aster-garden/ → 302（新地址）", 302,
    await call("GET", `/auth/dev?login=${LOGIN.alice}&return=${enc("https://asterclaude.github.io/aster-garden/")}`));
  expectStatus("a5", "/auth/dev return=https://cake114.github.io/aster-garden/ → 400（旧地址已不放行）", 400,
    await call("GET", `/auth/dev?login=${LOGIN.alice}&return=${enc("https://cake114.github.io/aster-garden/")}`));
  expectStatus("a6", "/auth/dev return=https://other.github.io/aster-garden/ → 400（其他来源）", 400,
    await call("GET", `/auth/dev?login=${LOGIN.alice}&return=${enc("https://other.github.io/aster-garden/")}`));
}

async function sectionB() {
  expectStatus("b1", "GET /api/me 无令牌 → 401", 401, await call("GET", "/api/me"));

  const ra = expectStatus("b2", "GET /api/me alice → 200", 200, await call("GET", "/api/me", { token: T.alice }));
  ck("b2-body", "alice 的 login 与 is_admin=false",
    `login=${LOGIN.alice}, is_admin=false`,
    `login=${ra.json && ra.json.login}, is_admin=${ra.json && ra.json.is_admin}`,
    !!ra.json && ra.json.login === LOGIN.alice && ra.json.is_admin === false);

  const rs = expectStatus("b3", "GET /api/me aster-test → 200", 200, await call("GET", "/api/me", { token: T.admin }));
  ck("b3-body", "aster-test 的 is_admin=true",
    "is_admin=true", `is_admin=${rs.json && rs.json.is_admin}`,
    !!rs.json && rs.json.is_admin === true);

  // 篡改签名最后一个字符
  const last = T.alice.slice(-1);
  const tampered = T.alice.slice(0, -1) + (last === "A" ? "B" : "A");
  expectStatus("b4", "GET /api/me 篡改一个字符的令牌 → 401", 401, await call("GET", "/api/me", { token: tampered }));
}

async function sectionC() {
  const r1 = expectStatus("c1", "alice 发 guestbook「你好」→ 201", 201,
    await call("POST", "/api/comments", { token: T.alice, body: { thread: THREAD, body: "你好" } }));
  const A1 = r1.json && r1.json.id;

  expectStatus("c2", "空白 body → 400", 400,
    await call("POST", "/api/comments", { token: T.alice, body: { thread: THREAD, body: "   " } }));

  expectStatus("c3", "2001 字 body → 400", 400,
    await call("POST", "/api/comments", { token: T.alice, body: { thread: THREAD, body: "x".repeat(2001) } }));

  expectStatus("c4", "thread「../x」→ 400", 400,
    await call("POST", "/api/comments", { token: T.alice, body: { thread: "../x", body: "路径穿越" } }));

  const rp = expectStatus("c5", "thread「/2026/11/22/hello/」→ 201", 201,
    await call("POST", "/api/comments", { token: T.alice, body: { thread: "/2026/11/22/hello/", body: "页面留言" } }));
  if (rp.json && rp.json.id) {
    expectStatus("c6", "删除上一条页面留言（清理）→ 200", 200,
      await call("DELETE", `/api/comments/${rp.json.id}`, { token: T.alice }));
  } else {
    ck("c6", "删除页面留言（清理）", "HTTP 200", "上一步未拿到 id，跳过", false);
  }
  return { A1 };
}

async function sectionD(ctx) {
  const { A1 } = ctx;
  const rb = expectStatus("d1", "bob 回复 alice → 201", 201,
    await call("POST", "/api/comments", { token: T.bob, body: { thread: THREAD, body: "bob 回复 alice", parent_id: A1 } }));
  const B1 = rb.json && rb.json.id;
  ck("d1-parent", "bob 回复的 parent_id 等于 alice 那条",
    `parent_id=${A1}`, `parent_id=${rb.json && rb.json.parent_id}`,
    !!rb.json && rb.json.parent_id === A1);

  const rr = expectStatus("d2", "站主回复 bob 的回复 → 201", 201,
    await call("POST", "/api/comments", { token: T.admin, body: { thread: THREAD, body: "站主回复 bob", parent_id: B1 } }));
  const R1 = rr.json && rr.json.id;
  ck("d2-parent", "站主回复的 parent_id 等于 alice 那条（只有两层）",
    `parent_id=${A1}`, `parent_id=${rr.json && rr.json.parent_id}`,
    !!rr.json && rr.json.parent_id === A1);

  expectStatus("d3", "parent_id 为不存在的 id → 400", 400,
    await call("POST", "/api/comments", { token: T.alice, body: { thread: THREAD, body: "孤儿回复", parent_id: 987654321 } }));

  return { A1, B1, R1 };
}

async function sectionE(ctx) {
  const { A1, B1, R1 } = ctx;
  const ids = [A1, B1, R1];

  const rAnon = expectStatus("e1", "匿名 GET 列表 → 200", 200,
    await call("GET", `/api/comments?thread=${THREAD}`));
  const anonList = (rAnon.json && rAnon.json.comments) || [];
  const byId = (id) => anonList.find((c) => c.id === id);
  ck("e1-viewer", "匿名时 viewer 为 null",
    "viewer=null", `viewer=${JSON.stringify(rAnon.json && rAnon.json.viewer)}`,
    !!rAnon.json && rAnon.json.viewer === null);
  ck("e1-present", "匿名列表含本次三条留言（alice、bob 回复、站主回复）",
    "三条都在", `在列表中: ${ids.map((i) => (byId(i) ? "是" : "否")).join(",")}`,
    ids.every((i) => !!byId(i)));
  ck("e1-mine", "匿名时三条 mine 均为 false",
    "mine 全 false", ids.map((i) => `${i}:${byId(i) && byId(i).mine}`).join(" "),
    ids.every((i) => byId(i) && byId(i).mine === false));
  ck("e1-admin", "站主回复 is_admin=true，alice 那条 is_admin=false",
    "R1.is_admin=true, A1.is_admin=false",
    `R1.is_admin=${byId(R1) && byId(R1).is_admin}, A1.is_admin=${byId(A1) && byId(A1).is_admin}`,
    !!byId(R1) && byId(R1).is_admin === true && !!byId(A1) && byId(A1).is_admin === false);

  const rAlice = expectStatus("e2", "alice 令牌 GET 列表 → 200", 200,
    await call("GET", `/api/comments?thread=${THREAD}`, { token: T.alice }));
  const aliceMine = (rAlice.json && rAlice.json.comments || []).find((c) => c.id === A1);
  ck("e2-mine", "alice 令牌下 alice 那条 mine=true",
    "mine=true", `mine=${aliceMine && aliceMine.mine}`,
    !!aliceMine && aliceMine.mine === true);

  const rAdmin = expectStatus("e3", "站主令牌 GET 列表 → 200", 200,
    await call("GET", `/api/comments?thread=${THREAD}`, { token: T.admin }));
  const adminList = (rAdmin.json && rAdmin.json.comments) || [];
  const adminR = adminList.find((c) => c.id === R1);
  ck("e3-viewer", "站主令牌下 viewer.is_admin=true，站主那条 mine=true",
    "viewer.is_admin=true, R1.mine=true",
    `viewer=${JSON.stringify(rAdmin.json && rAdmin.json.viewer)}, R1.mine=${adminR && adminR.mine}`,
    !!rAdmin.json && !!rAdmin.json.viewer && rAdmin.json.viewer.is_admin === true && !!adminR && adminR.mine === true);
}

async function sectionF(ctx) {
  const { A1, B1, R1 } = ctx;
  expectStatus("f1", "bob 删除 alice 的留言 → 403", 403,
    await call("DELETE", `/api/comments/${A1}`, { token: T.bob }));

  const rd = expectStatus("f2", "alice 删除自己的留言 → 200，deleted 含三个 id", 200,
    await call("DELETE", `/api/comments/${A1}`, { token: T.alice }));
  ck("f2-deleted", "deleted 恰为 [A1, B1, R1]",
    `[${A1},${B1},${R1}]`, `${JSON.stringify(rd.json && rd.json.deleted)}`,
    !!rd.json && sameSet(rd.json.deleted, [A1, B1, R1]));

  const rl = await call("GET", `/api/comments?thread=${THREAD}`);
  const remain = ((rl.json && rl.json.comments) || []).filter((c) => [A1, B1, R1].includes(c.id)).map((c) => c.id);
  ck("f3", "删除后列表不再有这三条",
    "剩余 0 条", `剩余 ${remain.length} 条 ${remain.join(",")}`,
    rl.status === 200 && remain.length === 0);
}

async function sectionG() {
  const created = [];
  const statuses = [];
  for (let i = 1; i <= 5; i++) {
    const r = await call("POST", "/api/comments", { token: T.carol, body: { thread: THREAD, body: `carol 第${i}条` } });
    statuses.push(r.status);
    if (r.status === 201 && r.json) created.push(r.json.id);
  }
  ck("g1", "carol 前 5 条均 201", "5 次 201", `状态码 ${statuses.join(",")}`,
    statuses.length === 5 && statuses.every((s) => s === 201));

  expectStatus("g2", "carol 第 6 条 → 429", 429,
    await call("POST", "/api/comments", { token: T.carol, body: { thread: THREAD, body: "carol 第6条" } }));

  let delOk = true;
  const delStatuses = [];
  for (const id of created) {
    const r = await call("DELETE", `/api/comments/${id}`, { token: T.carol });
    delStatuses.push(r.status);
    if (r.status !== 200) delOk = false;
  }
  ck("g3-del", "carol 删光自己的 5 条 → 均 200", "均 200",
    `状态码 ${delStatuses.join(",")}`, delOk && created.length === 5);

  expectStatus("g4", "删光后 carol 再发一条 → 仍 429（限流不因删除绕过）", 429,
    await call("POST", "/api/comments", { token: T.carol, body: { thread: THREAD, body: "删后再发" } }));
}

async function sectionH() {
  const rx = expectStatus("h1", "alice 发留言 X → 201", 201,
    await call("POST", "/api/comments", { token: T.alice, body: { thread: THREAD, body: "将被隐藏的留言" } }));
  const X = rx.json && rx.json.id;

  expectStatus("h2", "站主 POST /api/comments/X/hide {hidden:true} → 200", 200,
    await call("POST", `/api/comments/${X}/hide`, { token: T.admin, body: { hidden: true } }));

  const ra = await call("GET", `/api/comments?thread=${THREAD}`);
  const anonHas = ((ra.json && ra.json.comments) || []).some((c) => c.id === X);
  ck("h3", "匿名列表看不到 X", "不含 X", anonHas ? "含 X" : "不含 X", ra.status === 200 && !anonHas);

  const rs = await call("GET", `/api/comments?thread=${THREAD}`, { token: T.admin });
  const hx = ((rs.json && rs.json.comments) || []).find((c) => c.id === X);
  ck("h4", "站主列表能看到 X 且 hidden 为真",
    "存在且 hidden 为真", `${hx ? `存在, hidden=${hx.hidden}` : "不存在"}`,
    !!hx && !!hx.hidden);

  expectStatus("h5", "alice 调 hide → 403", 403,
    await call("POST", `/api/comments/${X}/hide`, { token: T.alice, body: { hidden: true } }));

  expectStatus("h6", "站主 GET /api/recent → 200", 200,
    await call("GET", "/api/recent?limit=5", { token: T.admin }));
  expectStatus("h7", "alice GET /api/recent → 403", 403,
    await call("GET", "/api/recent?limit=5", { token: T.alice }));

  expectStatus("h8", "站主 DELETE X → 200", 200,
    await call("DELETE", `/api/comments/${X}`, { token: T.admin }));
}

async function sectionI() {
  const r1 = await call("OPTIONS", "/api/me", { headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" } });
  const acao1 = r1.headers.get("access-control-allow-origin");
  ck("i1", "OPTIONS 预检 Origin=localhost:4000 → 回显 Access-Control-Allow-Origin",
    `ACAO=${ORIGIN}`, `HTTP ${r1.status}, ACAO=${acao1}`, acao1 === ORIGIN);

  const r2 = await call("OPTIONS", "/api/me", { headers: { Origin: "https://evil.com", "Access-Control-Request-Method": "GET" } });
  const acao2 = r2.headers.get("access-control-allow-origin");
  ck("i2", "OPTIONS 预检 Origin=evil.com → 无 Access-Control-Allow-Origin",
    "无 ACAO 头", `HTTP ${r2.status}, ACAO=${acao2}`, acao2 === null);
}

async function sectionJ() {
  expectStatus("j1", "未知路径 GET /no-such-path → 404", 404, await call("GET", "/no-such-path"));
}

async function sectionK() {
  const fake = { Authorization: "Bearer ghp_fake123" };
  const r1 = await call("GET", "/api/me", { headers: fake });
  ck("k1", "假 GitHub 令牌 GET /api/me → 401（不是 500）",
    "HTTP 401", `HTTP ${r1.status} ${snip(r1.text)}`, r1.status === 401);

  const r2 = await call("GET", `/api/comments?thread=${THREAD}`, { headers: fake });
  ck("k2", "假 GitHub 令牌 GET 列表 → 200",
    "HTTP 200", `HTTP ${r2.status} ${snip(r2.text, 80)}`, r2.status === 200);
}

async function main() {
  console.log(`e2e 开始：${BASE}，本次后缀 ${RAND}`);
  await section("setup", setup);
  await section("A 重定向与 return 校验", sectionA);
  await section("B 身份", sectionB);

  let ctxC = {};
  await section("C 发帖校验", async () => { ctxC = await sectionC(); });
  let ctxD = {};
  await section("D 回复与父级", async () => { ctxD = await sectionD(ctxC); });
  await section("E 列表与可见性", () => sectionE(ctxD));
  await section("F 删除", () => sectionF(ctxD));
  await section("G 限流", sectionG);
  await section("H 隐藏与站主接口", sectionH);
  await section("I CORS", sectionI);
  await section("J 404", sectionJ);
  await section("K 假 GitHub 令牌", sectionK);

  console.log("");
  console.log(`汇总: 通过 ${passCount} / 总 ${passCount + failCount}，失败 ${failCount}`);
  if (failCount) console.log(`失败项: ${failedIds.join(", ")}`);
  process.exitCode = failCount ? 1 : 0;
}

main().catch((e) => {
  console.log(`FAIL [fatal] 脚本异常: ${snip(e && e.message ? e.message : e)}`);
  process.exitCode = 1;
});
