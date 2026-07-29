import pg from "pg";
import { randomBytes } from "node:crypto";
import { buildUsageStats, hashPassword, isCompanyEmail, isValidEmail, normalizeEmail, normalizeUsageRecord, sessionHash, temporaryPassword, verifyPassword } from "./auth-store.mjs";

const { Pool } = pg;

export class PostgresAuthStore {
  static async create(connectionString) {
    const pool = new Pool({ connectionString, ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }, max: 5 });
    const store = new PostgresAuthStore(pool);
    await store.initialize();
    return store;
  }

  constructor(pool) {
    this.pool = pool;
    this.sessions = new Map();
    this.userCache = new Map();
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS access_requests (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        reviewed_by BIGINT REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS allowed_emails (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by BIGINT REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS ai_usage_events (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        user_email TEXT NOT NULL,
        operation TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        total_tokens BIGINT NOT NULL DEFAULT 0,
        audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_access_requests_email ON access_requests(email);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expiry ON password_reset_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_allowed_emails_email ON allowed_emails(email);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user ON ai_usage_events(user_email);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_events_time ON ai_usage_events(occurred_at);
    `);
  }

  publicUser(row) {
    return { id: Number(row.id), email: row.email, role: row.role, mustChangePassword: Boolean(row.must_change_password) };
  }

  remember(row) {
    const next = this.publicUser(row);
    const user = this.userCache.get(next.id);
    if (user) {
      Object.assign(user, next);
      return user;
    }
    this.userCache.set(next.id, next);
    return next;
  }

  async isEmailAllowed(email) {
    email = normalizeEmail(email);
    if (isCompanyEmail(email)) return true;
    const result = await this.pool.query("SELECT id FROM allowed_emails WHERE email=$1", [email]);
    return Boolean(result.rows[0]);
  }

  async assertEmailAllowed(email) {
    email = normalizeEmail(email);
    if (!isValidEmail(email)) throw new Error("请输入有效邮箱地址");
    if (!await this.isEmailAllowed(email)) throw new Error("该外部邮箱尚未加入白名单，请先由管理员添加后再申请或开通");
  }

  async ensureAdmin(email, password) {
    email = normalizeEmail(email);
    if (!isCompanyEmail(email)) throw new Error("管理员邮箱必须使用 @hisunpharm.com");
    if (String(password || "").length < 12) throw new Error("ADMIN_PASSWORD 至少需要 12 位");
    const existing = await this.pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (existing.rows[0]) {
      const result = await this.pool.query("UPDATE users SET role='admin',active=TRUE,updated_at=NOW() WHERE id=$1 RETURNING *", [existing.rows[0].id]);
      this.remember(result.rows[0]);
      return;
    }
    const result = await this.pool.query("INSERT INTO users(email,password_hash,role,active,must_change_password) VALUES($1,$2,'admin',TRUE,FALSE) RETURNING *", [email, await hashPassword(password)]);
    this.remember(result.rows[0]);
  }

  async authenticate(email, password) {
    email = normalizeEmail(email);
    if (!await this.isEmailAllowed(email)) return null;
    const result = await this.pool.query("SELECT * FROM users WHERE email=$1 AND active=TRUE", [email]);
    const row = result.rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash))) return null;
    await this.pool.query("UPDATE users SET last_login_at=NOW() WHERE id=$1", [row.id]);
    return this.remember(row);
  }

  async createSession(userId, hours = 12) {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + hours * 60 * 60 * 1000);
    const user = this.userCache.get(Number(userId));
    this.sessions.set(token, { user, expires });
    await this.pool.query("DELETE FROM sessions WHERE expires_at < NOW()");
    await this.pool.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [sessionHash(token), Number(userId), expires]
    );
    return { token, expires };
  }

  async sessionUser(token) {
    const session = token ? this.sessions.get(token) : null;
    if (session && session.expires > new Date() && session.user && await this.isEmailAllowed(session.user.email)) return session.user;
    if (token) this.sessions.delete(token);
    if (!token) return null;
    const result = await this.pool.query(
      `SELECT u.*, s.expires_at AS session_expires_at FROM sessions s
       JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active=TRUE`,
      [sessionHash(token)]
    );
    const row = result.rows[0];
    if (!row) {
      await this.pool.query("DELETE FROM sessions WHERE token_hash=$1 OR expires_at < NOW()", [sessionHash(token)]);
      return null;
    }
    const user = this.remember(row);
    const expires = new Date(result.rows[0].session_expires_at || Date.now() + 12 * 60 * 60 * 1000);
    this.sessions.set(token, { user, expires });
    return user;
  }

  async deleteSession(token) {
    if (!token) return;
    this.sessions.delete(token);
    await this.pool.query("DELETE FROM sessions WHERE token_hash=$1", [sessionHash(token)]);
  }

  async changePassword(userId, currentPassword, newPassword) {
    if (String(newPassword || "").length < 12) throw new Error("新密码至少需要 12 位");
    const result = await this.pool.query("SELECT * FROM users WHERE id=$1 AND active=TRUE", [userId]);
    const row = result.rows[0];
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) throw new Error("当前密码不正确");
    const updated = await this.pool.query("UPDATE users SET password_hash=$1,must_change_password=FALSE,updated_at=NOW() WHERE id=$2 RETURNING *", [await hashPassword(newPassword), userId]);
    this.remember(updated.rows[0]);
  }

  async resetPasswordById(userId) {
    const password = temporaryPassword();
    const result = await this.pool.query(
      "UPDATE users SET password_hash=$1,must_change_password=TRUE,updated_at=NOW() WHERE id=$2 AND active=TRUE RETURNING *",
      [await hashPassword(password), Number(userId)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("账号不存在或已停用");
    await Promise.all([
      this.pool.query("DELETE FROM sessions WHERE user_id=$1", [row.id]),
      this.pool.query("DELETE FROM password_reset_tokens WHERE user_id=$1", [row.id])
    ]);
    for (const [token, session] of this.sessions) if (session.user?.id === Number(row.id)) this.sessions.delete(token);
    this.remember(row);
    return { email: row.email, temporaryPassword: password };
  }

  async createPasswordReset(email, minutes = 30) {
    email = normalizeEmail(email);
    if (!await this.isEmailAllowed(email)) return null;
    const result = await this.pool.query("SELECT id,email FROM users WHERE email=$1 AND active=TRUE", [email]);
    const user = result.rows[0];
    if (!user) return null;
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + Math.max(10, Number(minutes) || 30) * 60_000);
    await this.pool.query("DELETE FROM password_reset_tokens WHERE user_id=$1 OR expires_at<NOW()", [user.id]);
    await this.pool.query(
      "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,$3)",
      [user.id, sessionHash(token), expires]
    );
    return { email: user.email, token, expires };
  }

  async resetPasswordWithToken(token, newPassword) {
    if (String(newPassword || "").length < 12) throw new Error("新密码至少需要 12 位");
    const passwordHash = await hashPassword(newPassword);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(`SELECT p.id,p.user_id,u.email
        FROM password_reset_tokens p
        JOIN users u ON u.id=p.user_id
        WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at>NOW() AND u.active=TRUE
        FOR UPDATE`, [sessionHash(String(token || ""))]);
      const record = selected.rows[0];
      if (!record) throw new Error("重置链接无效或已过期，请重新申请");
      const updated = await client.query(
        "UPDATE users SET password_hash=$1,must_change_password=FALSE,updated_at=NOW() WHERE id=$2 RETURNING *",
        [passwordHash, record.user_id]
      );
      await client.query("UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1", [record.id]);
      await client.query("DELETE FROM password_reset_tokens WHERE user_id=$1 AND id<>$2", [record.user_id, record.id]);
      await client.query("DELETE FROM sessions WHERE user_id=$1", [record.user_id]);
      await client.query("COMMIT");
      for (const [sessionToken, session] of this.sessions) if (session.user?.id === Number(record.user_id)) this.sessions.delete(sessionToken);
      this.remember(updated.rows[0]);
      return { email: record.email };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listUsers() {
    const result = await this.pool.query("SELECT id,email,role,active,must_change_password,created_at,last_login_at FROM users ORDER BY role DESC,created_at DESC");
    return result.rows.map((row) => ({ ...row, id: Number(row.id), active: Boolean(row.active), must_change_password: Boolean(row.must_change_password) }));
  }

  async addUser(email, role = "user") {
    email = normalizeEmail(email);
    await this.assertEmailAllowed(email);
    const password = temporaryPassword();
    const result = await this.pool.query(`INSERT INTO users(email,password_hash,role,active,must_change_password)
      VALUES($1,$2,$3,TRUE,TRUE)
      ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,active=TRUE,must_change_password=TRUE,updated_at=NOW()
      RETURNING *`, [email, await hashPassword(password), role === "admin" ? "admin" : "user"]);
    this.remember(result.rows[0]);
    await Promise.all([
      this.pool.query("DELETE FROM sessions WHERE user_id=$1", [result.rows[0].id]),
      this.pool.query("DELETE FROM password_reset_tokens WHERE user_id=$1", [result.rows[0].id])
    ]);
    for (const [token, session] of this.sessions) if (session.user?.id === Number(result.rows[0].id)) this.sessions.delete(token);
    return { email, temporaryPassword: password };
  }

  async setUserActive(id, active) {
    const result = await this.pool.query("UPDATE users SET active=$1,updated_at=NOW() WHERE id=$2 RETURNING *", [Boolean(active), Number(id)]);
    const row = result.rows[0];
    if (row) this.remember(row);
    if (!active) for (const [token, session] of this.sessions) if (session.user?.id === Number(id)) this.sessions.delete(token);
  }

  async requestAccess(email, note = "") {
    email = normalizeEmail(email);
    await this.assertEmailAllowed(email);
    const existing = await this.pool.query("SELECT id FROM users WHERE email=$1 AND active=TRUE", [email]);
    if (existing.rows[0]) return { alreadyActive: true };
    const pending = await this.pool.query("SELECT id FROM access_requests WHERE email=$1 AND status='pending'", [email]);
    if (!pending.rows[0]) await this.pool.query("INSERT INTO access_requests(email,note) VALUES($1,$2)", [email, String(note || "").trim().slice(0, 500)]);
    return { alreadyActive: false };
  }

  async listRequests() {
    const result = await this.pool.query("SELECT id,email,note,status,requested_at,reviewed_at FROM access_requests ORDER BY (status='pending') DESC,requested_at DESC");
    return result.rows.map((row) => ({ ...row, id: Number(row.id) }));
  }

  async approveRequest(id, adminId) {
    const result = await this.pool.query("SELECT * FROM access_requests WHERE id=$1 AND status='pending'", [Number(id)]);
    if (!result.rows[0]) throw new Error("申请不存在或已处理");
    const credentials = await this.addUser(result.rows[0].email);
    await this.pool.query("UPDATE access_requests SET status='approved',reviewed_at=NOW(),reviewed_by=$1 WHERE id=$2", [adminId, Number(id)]);
    return credentials;
  }

  async rejectRequest(id, adminId) {
    await this.pool.query("UPDATE access_requests SET status='rejected',reviewed_at=NOW(),reviewed_by=$1 WHERE id=$2 AND status='pending'", [adminId, Number(id)]);
  }

  async listAllowedEmails() {
    const result = await this.pool.query("SELECT id,email,note,created_at,created_by FROM allowed_emails ORDER BY created_at DESC");
    return result.rows.map((row) => ({ ...row, id: Number(row.id), created_by: row.created_by == null ? null : Number(row.created_by) }));
  }

  async addAllowedEmail(email, note = "", adminId = null) {
    email = normalizeEmail(email);
    if (!isValidEmail(email)) throw new Error("请输入有效邮箱地址");
    if (isCompanyEmail(email)) throw new Error("@hisunpharm.com 公司邮箱无需加入外部白名单");
    const result = await this.pool.query(
      `INSERT INTO allowed_emails(email,note,created_by)
       VALUES($1,$2,$3)
       ON CONFLICT(email) DO UPDATE SET note=EXCLUDED.note,created_by=EXCLUDED.created_by
       RETURNING id,email,note,created_at,created_by`,
      [email, String(note || "").trim().slice(0, 300), adminId]
    );
    const row = result.rows[0];
    return { ...row, id: Number(row.id), created_by: row.created_by == null ? null : Number(row.created_by) };
  }

  async removeAllowedEmail(id) {
    const result = await this.pool.query("DELETE FROM allowed_emails WHERE id=$1 RETURNING email", [Number(id)]);
    const email = result.rows[0]?.email;
    if (email) {
      await this.pool.query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=$1)", [email]);
      for (const [token, session] of this.sessions) if (session.user?.email === email) this.sessions.delete(token);
    }
  }

  async recordUsage(record) {
    const usage = normalizeUsageRecord(record);
    await this.pool.query(`INSERT INTO ai_usage_events(
      user_id,user_email,operation,model,input_tokens,output_tokens,total_tokens,audio_seconds,occurred_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      usage.userId,
      usage.userEmail,
      usage.operation,
      usage.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.totalTokens,
      usage.audioSeconds,
      usage.occurredAt
    ]);
    return usage;
  }

  async usageStats(days = 14) {
    const safeDays = Math.min(90, Math.max(7, Number(days) || 14));
    const start = new Date(Date.now() - (safeDays + 1) * 86_400_000);
    const [users, totals, recent] = await Promise.all([
      this.listUsers(),
      this.pool.query(`SELECT user_email,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(total_tokens) AS total_tokens,
        COUNT(*) AS requests,
        SUM(audio_seconds) AS audio_seconds,
        MAX(occurred_at) AS last_used_at
        FROM ai_usage_events GROUP BY user_email`),
      this.pool.query(`SELECT user_email,input_tokens,output_tokens,total_tokens,audio_seconds,occurred_at
        FROM ai_usage_events WHERE occurred_at>=$1 ORDER BY occurred_at`, [start])
    ]);
    return buildUsageStats(users, totals.rows, recent.rows, safeDays);
  }
}
