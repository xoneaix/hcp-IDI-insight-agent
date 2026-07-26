import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isCompanyEmail(email) {
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@hisunpharm\.com$/i.test(normalizeEmail(email));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt:${salt.toString("base64")}:${Buffer.from(derived).toString("base64")}`;
}

async function verifyPassword(password, encoded) {
  const [, saltText, hashText] = String(encoded || "").split(":");
  if (!saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64");
  const actual = Buffer.from(await scrypt(String(password), Buffer.from(saltText, "base64"), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sessionHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function temporaryPassword() {
  return `MV-${randomBytes(9).toString("base64url").slice(0, 12)}!`;
}

function usageNumber(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function usageDateKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function usageDateRange(days, now = new Date()) {
  return Array.from({ length: days }, (_, index) => usageDateKey(new Date(now.getTime() - (days - index - 1) * 86_400_000)));
}

function normalizeUsageRecord(record = {}) {
  const inputTokens = usageNumber(record.inputTokens ?? record.input_tokens);
  const outputTokens = usageNumber(record.outputTokens ?? record.output_tokens);
  const providedTotal = usageNumber(record.totalTokens ?? record.total_tokens);
  return {
    userId: Number(record.userId ?? record.user_id) > 0 ? Number(record.userId ?? record.user_id) : null,
    userEmail: normalizeEmail(record.userEmail ?? record.user_email) || "unknown",
    operation: String(record.operation || "AI 调用").trim().slice(0, 80) || "AI 调用",
    model: String(record.model || "unknown").trim().slice(0, 120) || "unknown",
    inputTokens,
    outputTokens,
    totalTokens: Math.max(providedTotal, inputTokens + outputTokens),
    audioSeconds: Math.max(0, Number(record.audioSeconds ?? record.audio_seconds) || 0),
    occurredAt: new Date(record.occurredAt ?? record.occurred_at ?? Date.now()).toISOString()
  };
}

function buildUsageStats(users = [], totals = [], recentEvents = [], requestedDays = 14) {
  const days = Math.min(90, Math.max(7, Number(requestedDays) || 14));
  const dateKeys = usageDateRange(days);
  const todayKey = dateKeys.at(-1);
  const dailyMap = new Map(dateKeys.map((date) => [date, { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, audioSeconds: 0 }]));
  const recentByEmail = new Map();
  for (const raw of recentEvents) {
    const event = normalizeUsageRecord(raw);
    const date = usageDateKey(event.occurredAt);
    const daily = dailyMap.get(date);
    if (daily) {
      daily.inputTokens += event.inputTokens;
      daily.outputTokens += event.outputTokens;
      daily.totalTokens += event.totalTokens;
      daily.requests += 1;
      daily.audioSeconds += event.audioSeconds;
      const email = event.userEmail;
      const recent = recentByEmail.get(email) || { recentTokens: 0, todayTokens: 0 };
      recent.recentTokens += event.totalTokens;
      if (date === todayKey) recent.todayTokens += event.totalTokens;
      recentByEmail.set(email, recent);
    }
  }
  const totalsByEmail = new Map(totals.map((row) => {
    const email = normalizeEmail(row.user_email);
    return [email, {
      totalTokens: usageNumber(row.total_tokens),
      inputTokens: usageNumber(row.input_tokens),
      outputTokens: usageNumber(row.output_tokens),
      requests: usageNumber(row.requests),
      audioSeconds: Math.max(0, Number(row.audio_seconds) || 0),
      lastUsedAt: row.last_used_at || null
    }];
  }));
  const knownEmails = new Set([...users.map((user) => normalizeEmail(user.email)), ...totalsByEmail.keys()]);
  const userRows = [...knownEmails].filter(Boolean).map((email) => {
    const user = users.find((item) => normalizeEmail(item.email) === email);
    const total = totalsByEmail.get(email) || { totalTokens: 0, inputTokens: 0, outputTokens: 0, requests: 0, audioSeconds: 0, lastUsedAt: null };
    const recent = recentByEmail.get(email) || { recentTokens: 0, todayTokens: 0 };
    return {
      id: user?.id ?? null,
      email,
      role: user?.role || "user",
      active: user ? Boolean(user.active) : false,
      ...total,
      recentTokens: recent.recentTokens,
      todayTokens: recent.todayTokens
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens || a.email.localeCompare(b.email));
  const daily = dateKeys.map((date) => dailyMap.get(date));
  const summary = userRows.reduce((result, user) => ({
    totalTokens: result.totalTokens + user.totalTokens,
    inputTokens: result.inputTokens + user.inputTokens,
    outputTokens: result.outputTokens + user.outputTokens,
    requests: result.requests + user.requests,
    audioSeconds: result.audioSeconds + user.audioSeconds
  }), { totalTokens: 0, inputTokens: 0, outputTokens: 0, requests: 0, audioSeconds: 0 });
  summary.todayTokens = daily.at(-1)?.totalTokens || 0;
  summary.recentTokens = daily.reduce((total, day) => total + day.totalTokens, 0);
  summary.activeUsers = userRows.filter((user) => user.totalTokens > 0).length;
  return { days, summary, daily, users: userRows };
}

export class AuthStore {
  static async create(path) {
    await mkdir(dirname(path), { recursive: true });
    return new AuthStore(path);
  }

  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        active INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by INTEGER REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS allowed_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS ai_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        user_email TEXT NOT NULL,
        operation TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        audio_seconds REAL NOT NULL DEFAULT 0,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_access_requests_email ON access_requests(email);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_allowed_emails_email ON allowed_emails(email);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user ON ai_usage_events(user_email);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_events_time ON ai_usage_events(occurred_at);
    `);
  }

  isEmailAllowed(email) {
    email = normalizeEmail(email);
    if (isCompanyEmail(email)) return true;
    return Boolean(this.db.prepare("SELECT id FROM allowed_emails WHERE email=?").get(email));
  }

  assertEmailAllowed(email) {
    email = normalizeEmail(email);
    if (!isValidEmail(email)) throw new Error("请输入有效邮箱地址");
    if (!this.isEmailAllowed(email)) throw new Error("该外部邮箱尚未加入白名单，请先由管理员添加后再申请或开通");
  }

  async ensureAdmin(email, password) {
    email = normalizeEmail(email);
    if (!isCompanyEmail(email)) throw new Error("管理员邮箱必须使用 @hisunpharm.com");
    if (String(password || "").length < 12) throw new Error("ADMIN_PASSWORD 至少需要 12 位");
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email);
    if (existing) {
      this.db.prepare("UPDATE users SET role='admin', active=1, updated_at=? WHERE id=?").run(now, existing.id);
      return;
    }
    this.db.prepare("INSERT INTO users(email,password_hash,role,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(email, await hashPassword(password), "admin", 1, 0, now, now);
  }

  async authenticate(email, password) {
    email = normalizeEmail(email);
    if (!this.isEmailAllowed(email)) return null;
    const user = this.db.prepare("SELECT * FROM users WHERE email=? AND active=1").get(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) return null;
    this.db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(new Date().toISOString(), user.id);
    return this.publicUser(user);
  }

  createSession(userId, hours = 12) {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expires = new Date(now.getTime() + hours * 60 * 60 * 1000);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
    this.db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
      .run(sessionHash(token), userId, expires.toISOString(), now.toISOString());
    return { token, expires };
  }

  sessionUser(token) {
    if (!token) return null;
    const row = this.db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(sessionHash(token), new Date().toISOString());
    return row ? this.publicUser(row) : null;
  }

  deleteSession(token) {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sessionHash(token));
  }

  async changePassword(userId, currentPassword, newPassword) {
    if (String(newPassword || "").length < 12) throw new Error("新密码至少需要 12 位");
    const user = this.db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(userId);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) throw new Error("当前密码不正确");
    this.db.prepare("UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?")
      .run(await hashPassword(newPassword), new Date().toISOString(), userId);
  }

  listUsers() {
    return this.db.prepare("SELECT id,email,role,active,must_change_password,created_at,last_login_at FROM users ORDER BY role DESC, created_at DESC").all()
      .map((row) => ({ ...row, active: Boolean(row.active), must_change_password: Boolean(row.must_change_password) }));
  }

  async addUser(email, role = "user") {
    email = normalizeEmail(email);
    this.assertEmailAllowed(email);
    const now = new Date().toISOString();
    const password = temporaryPassword();
    const existing = this.db.prepare("SELECT id FROM users WHERE email=?").get(email);
    const passwordHash = await hashPassword(password);
    if (existing) {
      this.db.prepare("UPDATE users SET password_hash=?, role=?, active=1, must_change_password=1, updated_at=? WHERE id=?")
        .run(passwordHash, role === "admin" ? "admin" : "user", now, existing.id);
    } else {
      this.db.prepare("INSERT INTO users(email,password_hash,role,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(email, passwordHash, role === "admin" ? "admin" : "user", 1, 1, now, now);
    }
    return { email, temporaryPassword: password };
  }

  setUserActive(id, active) {
    this.db.prepare("UPDATE users SET active=?, updated_at=? WHERE id=?").run(active ? 1 : 0, new Date().toISOString(), Number(id));
    if (!active) this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(Number(id));
  }

  async requestAccess(email, note = "") {
    email = normalizeEmail(email);
    this.assertEmailAllowed(email);
    const existingUser = this.db.prepare("SELECT id,active FROM users WHERE email=?").get(email);
    if (existingUser?.active) return { alreadyActive: true };
    const pending = this.db.prepare("SELECT id FROM access_requests WHERE email=? AND status='pending'").get(email);
    if (!pending) this.db.prepare("INSERT INTO access_requests(email,note,status,requested_at) VALUES(?,?,?,?)")
      .run(email, String(note || "").trim().slice(0, 500), "pending", new Date().toISOString());
    return { alreadyActive: false };
  }

  listRequests() {
    return this.db.prepare("SELECT id,email,note,status,requested_at,reviewed_at FROM access_requests ORDER BY status='pending' DESC, requested_at DESC").all();
  }

  async approveRequest(id, adminId) {
    const request = this.db.prepare("SELECT * FROM access_requests WHERE id=? AND status='pending'").get(Number(id));
    if (!request) throw new Error("申请不存在或已处理");
    const credentials = await this.addUser(request.email);
    this.db.prepare("UPDATE access_requests SET status='approved', reviewed_at=?, reviewed_by=? WHERE id=?")
      .run(new Date().toISOString(), adminId, Number(id));
    return credentials;
  }

  rejectRequest(id, adminId) {
    this.db.prepare("UPDATE access_requests SET status='rejected', reviewed_at=?, reviewed_by=? WHERE id=? AND status='pending'")
      .run(new Date().toISOString(), adminId, Number(id));
  }

  listAllowedEmails() {
    return this.db.prepare("SELECT id,email,note,created_at,created_by FROM allowed_emails ORDER BY created_at DESC").all();
  }

  addAllowedEmail(email, note = "", adminId = null) {
    email = normalizeEmail(email);
    if (!isValidEmail(email)) throw new Error("请输入有效邮箱地址");
    if (isCompanyEmail(email)) throw new Error("@hisunpharm.com 公司邮箱无需加入外部白名单");
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id FROM allowed_emails WHERE email=?").get(email);
    if (existing) {
      this.db.prepare("UPDATE allowed_emails SET note=?, created_by=? WHERE id=?").run(String(note || "").trim().slice(0, 300), adminId, existing.id);
      return this.db.prepare("SELECT id,email,note,created_at,created_by FROM allowed_emails WHERE id=?").get(existing.id);
    }
    const result = this.db.prepare("INSERT INTO allowed_emails(email,note,created_at,created_by) VALUES(?,?,?,?) RETURNING id,email,note,created_at,created_by")
      .get(email, String(note || "").trim().slice(0, 300), now, adminId);
    return result;
  }

  removeAllowedEmail(id) {
    const row = this.db.prepare("SELECT * FROM allowed_emails WHERE id=?").get(Number(id));
    if (!row) return;
    this.db.prepare("DELETE FROM allowed_emails WHERE id=?").run(Number(id));
    this.db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=?)").run(row.email);
  }

  recordUsage(record) {
    const usage = normalizeUsageRecord(record);
    this.db.prepare(`INSERT INTO ai_usage_events(
      user_id,user_email,operation,model,input_tokens,output_tokens,total_tokens,audio_seconds,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      usage.userId,
      usage.userEmail,
      usage.operation,
      usage.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.totalTokens,
      usage.audioSeconds,
      usage.occurredAt
    );
    return usage;
  }

  usageStats(days = 14) {
    const safeDays = Math.min(90, Math.max(7, Number(days) || 14));
    const start = new Date(Date.now() - (safeDays + 1) * 86_400_000).toISOString();
    const totals = this.db.prepare(`SELECT user_email,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(total_tokens) AS total_tokens,
      COUNT(*) AS requests,
      SUM(audio_seconds) AS audio_seconds,
      MAX(occurred_at) AS last_used_at
      FROM ai_usage_events GROUP BY user_email`).all();
    const recentEvents = this.db.prepare(`SELECT user_email,input_tokens,output_tokens,total_tokens,audio_seconds,occurred_at
      FROM ai_usage_events WHERE occurred_at>=? ORDER BY occurred_at`).all(start);
    return buildUsageStats(this.listUsers(), totals, recentEvents, safeDays);
  }

  publicUser(row) {
    return {
      id: Number(row.id),
      email: row.email,
      role: row.role,
      mustChangePassword: Boolean(row.must_change_password)
    };
  }
}

export { buildUsageStats, hashPassword, isCompanyEmail, isValidEmail, normalizeEmail, normalizeUsageRecord, sessionHash, temporaryPassword, verifyPassword };
