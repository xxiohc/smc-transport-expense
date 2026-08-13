import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3014);

const SALT = "smc-transport-expense-2026";
const JWT_SECRET = process.env.JWT_SECRET || "te-jwt-fallback-secret-2026";
if (!process.env.JWT_SECRET) {
  console.warn("[WARNING] JWT_SECRET 환경변수 미설정 — fallback 키 사용 중 (로컬 개발 전용)");
}
const JWT_TTL = 8 * 3600;
const GH_CACHE_MS = 10_000;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Login rate limiting ───────────────────────────────────────────────────────
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function checkRateLimit(key) {
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + LOCKOUT_MS };
    loginAttempts.set(key, entry);
  }
  return entry.count < MAX_ATTEMPTS;
}
function recordFail(key) { const e = loginAttempts.get(key); if (e) e.count++; }
function clearAttempts(key) { loginAttempts.delete(key); }

// ── JWT ───────────────────────────────────────────────────────────────────────
function b64url(data) {
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDec(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}
function hashPin(pin) {
  return crypto.createHash("sha256").update(String(pin) + SALT).digest("hex");
}
function genId() {
  return crypto.randomBytes(8).toString("hex");
}
function createToken(accountId) {
  const hdr = b64url({ alg: "HS256", typ: "JWT" });
  const pay = b64url({ sub: accountId, exp: Math.floor(Date.now() / 1000) + JWT_TTL });
  const sig = crypto.createHmac("sha256", JWT_SECRET)
    .update(`${hdr}.${pay}`).digest("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${hdr}.${pay}.${sig}`;
}
function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const sig = crypto.createHmac("sha256", JWT_SECRET)
      .update(`${parts[0]}.${parts[1]}`).digest("base64")
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (sig !== parts[2]) return null;
    const pay = JSON.parse(b64urlDec(parts[1]));
    if (pay.exp < Math.floor(Date.now() / 1000)) return null;
    return pay.sub;
  } catch { return null; }
}

// ── GitHub DB ─────────────────────────────────────────────────────────────────
const gh = { token: null, repo: null, cache: null, cacheSha: null, cacheAt: 0 };

function ghInit() {
  if (!gh.token) {
    gh.token = process.env.GITHUB_DB_TOKEN || null;
    gh.repo = process.env.GITHUB_DB_REPO || "xxiohc/smc-transport-expense";
  }
  return !!gh.token;
}

async function ghFetch(path, opts = {}) {
  const url = `https://api.github.com/repos/${gh.repo}${path}`;
  return fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${gh.token}`,
      "User-Agent": "smc-te-server",
    },
    ...opts,
  });
}

async function readDb() {
  const now = Date.now();
  if (gh.cache && now - gh.cacheAt < GH_CACHE_MS) return JSON.parse(JSON.stringify(gh.cache));
  if (!ghInit()) return getDefaultDb();
  try {
    const res = await ghFetch("/contents/db.json?ref=db");
    if (!res.ok) return getDefaultDb();
    const meta = await res.json();
    const content = Buffer.from(meta.content, "base64").toString("utf-8");
    gh.cache = JSON.parse(content);
    gh.cacheSha = meta.sha;
    gh.cacheAt = now;
    return JSON.parse(JSON.stringify(gh.cache));
  } catch { return getDefaultDb(); }
}

async function writeDb(snapshot) {
  gh.cache = snapshot;
  gh.cacheAt = Date.now();
  if (!ghInit()) return;
  if (!gh.cacheSha) {
    try {
      const r = await ghFetch("/contents/db.json?ref=db");
      if (r.ok) { const m = await r.json(); gh.cacheSha = m.sha; }
    } catch { /* sha 프리패치 실패 시 sha 없이 PUT 시도 */ }
  }
  const res = await ghFetch("/contents/db.json", {
    method: "PUT",
    body: JSON.stringify({
      message: `update db ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(snapshot, null, 2)).toString("base64"),
      branch: "db",
      sha: gh.cacheSha || undefined,
    }),
  });
  if (!res.ok) {
    console.error("writeDb failed:", res.status);
    throw new Error(`DB 저장에 실패했습니다. (GitHub ${res.status})`);
  }
  const m = await res.json();
  gh.cacheSha = m.content?.sha || gh.cacheSha;
}

function getDefaultDb() {
  return {
    accounts: [
      {
        id: "admin",
        name: "최지석",
        dept: "재무관리파트",
        role: "admin",
        pin_hash: hashPin("1234"),
        car: null,
        created_at: "2026-08-13T00:00:00.000Z",
      },
    ],
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}
function err(res, msg, status = 400) { json(res, { ok: false, error: msg }, status); }
async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"); }
  catch { return {}; }
}
function getCallerId(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace("Bearer ", "").trim();
  return verifyToken(token);
}
function sanitize(a) {
  const { pin_hash, ...rest } = a;
  rest.pin_is_default = pin_hash === hashPin("0000");
  return rest;
}

// ── API Handlers ──────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const { name, pin } = await parseBody(req);
  if (!name || !pin) return err(res, "이름과 PIN을 입력하세요.");
  if (!checkRateLimit(name)) return err(res, "로그인 시도 횟수를 초과했습니다. 15분 후 다시 시도하세요.", 429);
  const db = await readDb();
  const account = db.accounts.find(a => a.name === name || a.id === name);
  if (!account || account.pin_hash !== hashPin(pin)) {
    recordFail(name);
    return err(res, "성명 또는 PIN이 올바르지 않습니다.", 401);
  }
  clearAttempts(name);
  const token = createToken(account.id);
  json(res, { ok: true, token, account: sanitize(account) });
}

async function handleInitialPin(req, res) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const { new_pin } = await parseBody(req);
  if (!new_pin) return err(res, "새 PIN을 입력하세요.");
  if (!/^\d{4,8}$/.test(String(new_pin))) return err(res, "PIN은 4~8자리 숫자여야 합니다.");
  if (String(new_pin) === "0000") return err(res, "초기 PIN(0000)은 사용할 수 없습니다.");
  const db = await readDb();
  const account = db.accounts.find(a => a.id === callerId);
  if (!account) return err(res, "계정을 찾을 수 없습니다.", 404);
  if (account.pin_hash !== hashPin("0000")) return err(res, "이미 PIN이 설정된 계정입니다.", 400);
  account.pin_hash = hashPin(String(new_pin));
  await writeDb(db);
  const token = createToken(account.id);
  json(res, { ok: true, token, account: sanitize(account) });
}

async function handleChangePin(req, res) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const { old_pin, new_pin } = await parseBody(req);
  if (!old_pin || !new_pin) return err(res, "현재 PIN과 새 PIN을 모두 입력하세요.");
  if (!/^\d{4,8}$/.test(String(new_pin))) return err(res, "새 PIN은 4~8자리 숫자여야 합니다.");
  if (String(new_pin) === "0000") return err(res, "초기 PIN(0000)은 사용할 수 없습니다.");
  const db = await readDb();
  const account = db.accounts.find(a => a.id === callerId);
  if (!account) return err(res, "계정을 찾을 수 없습니다.", 404);
  if (account.pin_hash !== hashPin(String(old_pin))) return err(res, "현재 PIN이 올바르지 않습니다.", 400);
  account.pin_hash = hashPin(String(new_pin));
  await writeDb(db);
  json(res, { ok: true });
}

async function handleGetMe(req, res) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const db = await readDb();
  const account = db.accounts.find(a => a.id === callerId);
  if (!account) return err(res, "계정을 찾을 수 없습니다.", 404);
  json(res, { ok: true, account: sanitize(account) });
}

async function handleUpdateMyCar(req, res) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const { plate, fuel, displacement } = await parseBody(req);
  if (!plate) return err(res, "차량번호를 입력하세요.");
  const db = await readDb();
  const account = db.accounts.find(a => a.id === callerId);
  if (!account) return err(res, "계정을 찾을 수 없습니다.", 404);
  account.car = { plate, fuel: fuel || "휘발유", displacement: displacement || "1500cc 이하" };
  await writeDb(db);
  json(res, { ok: true, account: sanitize(account) });
}

async function handleGetUsers(req, res) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const db = await readDb();
  const caller = db.accounts.find(a => a.id === callerId);
  if (!caller || caller.role !== "admin") return err(res, "관리자만 접근할 수 있습니다.", 403);
  json(res, { ok: true, accounts: db.accounts.map(sanitize) });
}

async function handleAddUser(req, res) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const db = await readDb();
  const caller = db.accounts.find(a => a.id === callerId);
  if (!caller || caller.role !== "admin") return err(res, "관리자만 접근할 수 있습니다.", 403);
  const { name, dept, role = "user" } = await parseBody(req);
  if (!name || !dept) return err(res, "성명과 부서를 입력하세요.");
  if (db.accounts.some(a => a.name === name)) return err(res, "이미 등록된 성명입니다.");
  const newAcc = { id: genId(), name, dept, role, pin_hash: hashPin("0000"), car: null, created_at: new Date().toISOString() };
  db.accounts.push(newAcc);
  await writeDb(db);
  json(res, { ok: true, account: sanitize(newAcc) });
}

async function handleUpdateUser(req, res, id) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const db = await readDb();
  const caller = db.accounts.find(a => a.id === callerId);
  if (!caller || caller.role !== "admin") return err(res, "관리자만 접근할 수 있습니다.", 403);
  const account = db.accounts.find(a => a.id === id);
  if (!account) return err(res, "계정을 찾을 수 없습니다.", 404);
  const { car } = await parseBody(req);
  if (car !== undefined) account.car = car;
  await writeDb(db);
  json(res, { ok: true, account: sanitize(account) });
}

async function handleResetPin(req, res, id) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const db = await readDb();
  const caller = db.accounts.find(a => a.id === callerId);
  if (!caller || caller.role !== "admin") return err(res, "관리자만 접근할 수 있습니다.", 403);
  const account = db.accounts.find(a => a.id === id);
  if (!account) return err(res, "계정을 찾을 수 없습니다.", 404);
  account.pin_hash = hashPin("0000");
  await writeDb(db);
  json(res, { ok: true });
}

async function handleResetCar(req, res, id) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const db = await readDb();
  const caller = db.accounts.find(a => a.id === callerId);
  if (!caller || caller.role !== "admin") return err(res, "관리자만 접근할 수 있습니다.", 403);
  const account = db.accounts.find(a => a.id === id);
  if (!account) return err(res, "계정을 찾을 수 없습니다.", 404);
  account.car = null;
  await writeDb(db);
  json(res, { ok: true });
}

async function handleDeleteUser(req, res, id) {
  const callerId = getCallerId(req);
  if (!callerId) return err(res, "인증이 필요합니다.", 401);
  const db = await readDb();
  const caller = db.accounts.find(a => a.id === callerId);
  if (!caller || caller.role !== "admin") return err(res, "관리자만 접근할 수 있습니다.", 403);
  const account = db.accounts.find(a => a.id === id);
  if (!account) return err(res, "계정을 찾을 수 없습니다.", 404);
  if (account.role === "admin") return err(res, "관리자 계정은 삭제할 수 없습니다.");
  db.accounts = db.accounts.filter(a => a.id !== id);
  await writeDb(db);
  json(res, { ok: true });
}

// ── Static file serving ───────────────────────────────────────────────────────
async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const file = join(PUBLIC, safePath.replace(/^\/+/, ""));
  try {
    const data = await readFile(file);
    const ext = extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(PUBLIC, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    } catch { res.writeHead(404); res.end("Not Found"); }
  }
}

// ── Main request handler ──────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    return res.end();
  }

  try {
    if (path === "/api/login"       && method === "POST") return handleLogin(req, res);
    if (path === "/api/initial-pin" && method === "POST") return handleInitialPin(req, res);
    if (path === "/api/change-pin"  && method === "POST") return handleChangePin(req, res);
    if (path === "/api/me"          && method === "GET")  return handleGetMe(req, res);
    if (path === "/api/me/car"      && method === "PUT")  return handleUpdateMyCar(req, res);
    if (path === "/api/users"       && method === "GET")  return handleGetUsers(req, res);
    if (path === "/api/users"       && method === "POST") return handleAddUser(req, res);

    const mResetPin = path.match(/^\/api\/users\/([^/]+)\/reset-pin$/);
    if (mResetPin && method === "POST") return handleResetPin(req, res, mResetPin[1]);

    const mResetCar = path.match(/^\/api\/users\/([^/]+)\/reset-car$/);
    if (mResetCar && method === "POST") return handleResetCar(req, res, mResetCar[1]);

    const mUser = path.match(/^\/api\/users\/([^/]+)$/);
    if (mUser && method === "PUT")    return handleUpdateUser(req, res, mUser[1]);
    if (mUser && method === "DELETE") return handleDeleteUser(req, res, mUser[1]);

    if (!path.startsWith("/api/")) return serveStatic(res, path);
    err(res, "Not found", 404);
  } catch (e) {
    console.error(e);
    err(res, "서버 오류", 500);
  }
}

export default handle;

// 직접 실행 시에만 HTTP 서버 기동
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  createServer(handle).listen(PORT, () =>
    console.log(`교통비정산서 server :${PORT}`)
  );
}
