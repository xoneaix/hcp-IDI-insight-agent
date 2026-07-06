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
      CREATE INDEX IF NOT EXISTS idx_access_requests_email ON access_requests(email);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
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
    if (!isCompanyEmail(email)) throw new Error("仅允许添加 @hisunpharm.com 公司邮箱");
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
    if (!isCompanyEmail(email)) throw new Error("请使用 @hisunpharm.com 公司邮箱申请");
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

  publicUser(row) {
    return {
      id: Number(row.id),
      email: row.email,
      role: row.role,
      mustChangePassword: Boolean(row.must_change_password)
    };
  }
}

export { isCompanyEmail, normalizeEmail };
