// 端到端测试运行器：起 wrangler dev → 跑 test/e2e.mjs → 结束时杀掉整棵进程树。
// 用法：npm run test:e2e（在 garden-api 目录内执行）。路径都相对本文件，不依赖工作目录。
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(DIR, ".wrangler", "e2e"); // .wrangler 已在 .gitignore 中
const WR_LOG = join(OUT_DIR, "wrangler-dev.log");
const E2E_OUT = join(OUT_DIR, "e2e-out.txt");
const BASE = "http://localhost:8787/";

mkdirSync(OUT_DIR, { recursive: true });
// 两个日志都写文件而不是管道，避免无人读管道时子进程阻塞
const logFd = openSync(WR_LOG, "w");
const outFd = openSync(E2E_OUT, "w");

// shell: true 让 Windows 能找到 npx.cmd；wrangler 的子进程靠杀进程树回收
const wr = spawn("npx wrangler dev --local --port 8787", {
  cwd: DIR,
  shell: true,
  stdio: ["ignore", logFd, logFd],
});

function stopTree() {
  if (!wr.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(wr.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-wr.pid, "SIGTERM");
    } catch {
      try {
        wr.kill("SIGTERM");
      } catch {}
    }
  }
}

async function waitReady(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function runE2e() {
  return new Promise((resolveRun) => {
    const p = spawn(process.execPath, ["test/e2e.mjs"], {
      cwd: DIR,
      stdio: ["ignore", outFd, outFd],
    });
    p.on("exit", (code) => resolveRun(code ?? 1));
    p.on("error", () => resolveRun(1));
  });
}

let code = 1;
try {
  const ready = await waitReady(90000);
  if (!ready) {
    console.log("RUNNER: wrangler dev 90 秒内未就绪，见 " + WR_LOG);
  } else {
    console.log("RUNNER: wrangler dev 已就绪，开始 e2e");
    code = await runE2e();
    console.log(`RUNNER: e2e 退出码 ${code}，输出见 ${E2E_OUT}`);
  }
} finally {
  stopTree();
  closeSync(logFd);
  closeSync(outFd);
  // 给系统一点时间回收子进程后，再确认端口已释放
  await new Promise((r) => setTimeout(r, 1500));
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(2000) });
    console.log("RUNNER: 警告，8787 端口仍有服务在响应");
    code = code || 1;
  } catch {
    console.log("RUNNER: wrangler dev 已停止，8787 端口已释放");
  }
}
process.exitCode = code;
