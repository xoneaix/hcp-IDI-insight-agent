import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";

const { Pool } = pg;

function normalizeRespondentType(type, clientId = "", name = "") {
  const value = String(type || "").trim().toLowerCase();
  const label = `${clientId || ""} ${name || ""}`.trim();
  if (value === "patient" || value === "患者" || /^patient-\d+/i.test(label)) return "Patient";
  return "HCP";
}

function normalizePatch(patch = {}) {
  const clientId = String(patch.clientId || "").slice(0, 80);
  const name = String(patch.name || "").slice(0, 240);
  return {
    projectId: String(patch.projectId || patch.project_id || "default").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "default",
    projectName: String(patch.projectName || patch.project_name || "未命名访谈项目").slice(0, 80),
    clientId,
    name,
    type: normalizeRespondentType(patch.type, clientId, name),
    source: String(patch.source || "上传文件").slice(0, 80),
    recordedAt: String(patch.recordedAt || "").slice(0, 80),
    durationSeconds: Number.isFinite(Number(patch.durationSeconds)) ? Number(patch.durationSeconds) : null,
    status: String(patch.status || "待转录").slice(0, 80),
    progressText: String(patch.progressText || "").slice(0, 500),
    error: String(patch.error || "").slice(0, 2000),
    text: String(patch.text || ""),
    draftText: String(patch.draftText || ""),
    roleResult: patch.roleResult || null
  };
}

function publicItem(row) {
  const durationSeconds = row.duration_seconds == null ? null : Number(row.duration_seconds);
  const roleResult = typeof row.role_result === "string"
    ? JSON.parse(row.role_result || "null")
    : row.role_result || null;
  return {
    projectId: row.project_id || "default",
    projectName: row.project_name || "未命名访谈项目",
    serverId: String(row.id),
    id: row.client_id,
    name: row.name,
    type: normalizeRespondentType(row.respondent_type, row.client_id, row.name),
    source: row.source,
    recordedAt: row.recorded_at || "",
    durationSeconds,
    duration: Number.isFinite(durationSeconds) ? `${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, "0")}` : "—",
    status: row.status,
    progressText: row.progress_text || "",
    error: row.error || "",
    text: row.transcript_text || "",
    draftText: row.draft_text || "",
    roleResult,
    fileName: row.file_name,
    fileSize: Number(row.file_size || 0),
    mimeType: row.mime_type || "application/octet-stream",
    hasFile: Boolean(row.has_file),
    persisted: true,
    selected: true
  };
}

export class PostgresInterviewLibraryStore {
  static async create(connectionString) {
    const pool = new Pool({ connectionString, ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }, max: 5 });
    const store = new PostgresInterviewLibraryStore(pool);
    await store.initialize();
    return store;
  }

  constructor(pool) {
    this.pool = pool;
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS interview_assets (
        id UUID PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT 'default',
        project_name TEXT NOT NULL DEFAULT '未命名访谈项目',
        respondent_type TEXT NOT NULL DEFAULT 'HCP',
        source TEXT NOT NULL DEFAULT '上传文件',
        recorded_at TEXT NOT NULL DEFAULT '',
        duration_seconds DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT '待转录',
        progress_text TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        transcript_text TEXT NOT NULL DEFAULT '',
        draft_text TEXT NOT NULL DEFAULT '',
        role_result JSONB,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        file_size BIGINT NOT NULL DEFAULT 0,
        storage_path TEXT NOT NULL,
        has_file BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE interview_assets ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE interview_assets ADD COLUMN IF NOT EXISTS project_name TEXT NOT NULL DEFAULT '未命名访谈项目';
      CREATE INDEX IF NOT EXISTS idx_interview_assets_user ON interview_assets(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_interview_assets_project ON interview_assets(user_id, project_id, updated_at DESC);
    `);
  }

  async createItem(userId, id, patch, file) {
    const item = normalizePatch(patch);
    const result = await this.pool.query(
      `INSERT INTO interview_assets(id,user_id,client_id,name,project_id,project_name,respondent_type,source,recorded_at,duration_seconds,status,progress_text,error,transcript_text,draft_text,role_result,file_name,mime_type,file_size,storage_path,has_file)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,TRUE)
       RETURNING *`,
      [id, userId, item.clientId, item.name || file.fileName, item.projectId, item.projectName, item.type, item.source, item.recordedAt, item.durationSeconds, item.status, item.progressText, item.error, item.text, item.draftText, item.roleResult ? JSON.stringify(item.roleResult) : null, file.fileName, file.mimeType, file.fileSize, file.storagePath]
    );
    return publicItem(result.rows[0]);
  }

  async updateItem(userId, id, patch) {
    const item = normalizePatch(patch);
    const result = await this.pool.query(
      `UPDATE interview_assets SET client_id=COALESCE(NULLIF($3,''),client_id),name=COALESCE(NULLIF($4,''),name),project_id=$5,project_name=$6,respondent_type=$7,source=$8,recorded_at=$9,duration_seconds=$10,status=$11,progress_text=$12,error=$13,transcript_text=$14,draft_text=$15,role_result=$16::jsonb,updated_at=NOW()
       WHERE user_id=$1 AND id=$2 RETURNING *`,
      [userId, id, item.clientId, item.name, item.projectId, item.projectName, item.type, item.source, item.recordedAt, item.durationSeconds, item.status, item.progressText, item.error, item.text, item.draftText, item.roleResult ? JSON.stringify(item.roleResult) : null]
    );
    return result.rows[0] ? publicItem(result.rows[0]) : null;
  }

  async listItems(userId) {
    const result = await this.pool.query("SELECT * FROM interview_assets WHERE user_id=$1 ORDER BY created_at ASC", [userId]);
    return result.rows.map(publicItem);
  }

  async getItem(userId, id) {
    const result = await this.pool.query("SELECT * FROM interview_assets WHERE user_id=$1 AND id=$2", [userId, id]);
    const row = result.rows[0];
    return row ? { ...publicItem(row), storagePath: row.storage_path } : null;
  }

  async deleteItem(userId, id) {
    const result = await this.pool.query("DELETE FROM interview_assets WHERE user_id=$1 AND id=$2 RETURNING storage_path", [userId, id]);
    return result.rows.map((row) => row.storage_path);
  }

  async deleteAll(userId) {
    const result = await this.pool.query("DELETE FROM interview_assets WHERE user_id=$1 RETURNING storage_path", [userId]);
    return result.rows.map((row) => row.storage_path);
  }
}

export class SqliteInterviewLibraryStore {
  static async create(path) {
    await mkdir(dirname(path), { recursive: true });
    const store = new SqliteInterviewLibraryStore(path);
    await store.initialize();
    return store;
  }

  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  }

  async initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interview_assets (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT 'default',
        project_name TEXT NOT NULL DEFAULT '未命名访谈项目',
        respondent_type TEXT NOT NULL DEFAULT 'HCP',
        source TEXT NOT NULL DEFAULT '上传文件',
        recorded_at TEXT NOT NULL DEFAULT '',
        duration_seconds REAL,
        status TEXT NOT NULL DEFAULT '待转录',
        progress_text TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        transcript_text TEXT NOT NULL DEFAULT '',
        draft_text TEXT NOT NULL DEFAULT '',
        role_result TEXT,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        file_size INTEGER NOT NULL DEFAULT 0,
        storage_path TEXT NOT NULL,
        has_file INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(interview_assets)").all().map((column) => column.name));
    if (!columns.has("project_id")) this.db.exec("ALTER TABLE interview_assets ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'");
    if (!columns.has("project_name")) this.db.exec("ALTER TABLE interview_assets ADD COLUMN project_name TEXT NOT NULL DEFAULT '未命名访谈项目'");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_interview_assets_user ON interview_assets(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_interview_assets_project ON interview_assets(user_id, project_id, updated_at DESC);
    `);
  }

  async createItem(userId, id, patch, file) {
    const item = normalizePatch(patch);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO interview_assets(id,user_id,client_id,name,project_id,project_name,respondent_type,source,recorded_at,duration_seconds,status,progress_text,error,transcript_text,draft_text,role_result,file_name,mime_type,file_size,storage_path,has_file,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, item.clientId, item.name || file.fileName, item.projectId, item.projectName, item.type, item.source, item.recordedAt, item.durationSeconds, item.status, item.progressText, item.error, item.text, item.draftText, item.roleResult ? JSON.stringify(item.roleResult) : null, file.fileName, file.mimeType, file.fileSize, file.storagePath, 1, now, now);
    return this.getItem(userId, id);
  }

  async updateItem(userId, id, patch) {
    const item = normalizePatch(patch);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE interview_assets SET client_id=COALESCE(NULLIF(?,''),client_id),name=COALESCE(NULLIF(?,''),name),project_id=?,project_name=?,respondent_type=?,source=?,recorded_at=?,duration_seconds=?,status=?,progress_text=?,error=?,transcript_text=?,draft_text=?,role_result=?,updated_at=? WHERE user_id=? AND id=?`)
      .run(item.clientId, item.name, item.projectId, item.projectName, item.type, item.source, item.recordedAt, item.durationSeconds, item.status, item.progressText, item.error, item.text, item.draftText, item.roleResult ? JSON.stringify(item.roleResult) : null, now, userId, id);
    return this.getItem(userId, id);
  }

  async listItems(userId) {
    return this.db.prepare("SELECT * FROM interview_assets WHERE user_id=? ORDER BY created_at ASC").all(userId).map(publicItem);
  }

  async getItem(userId, id) {
    const row = this.db.prepare("SELECT * FROM interview_assets WHERE user_id=? AND id=?").get(userId, id);
    return row ? { ...publicItem(row), storagePath: row.storage_path } : null;
  }

  async deleteItem(userId, id) {
    const rows = this.db.prepare("SELECT storage_path FROM interview_assets WHERE user_id=? AND id=?").all(userId, id);
    this.db.prepare("DELETE FROM interview_assets WHERE user_id=? AND id=?").run(userId, id);
    return rows.map((row) => row.storage_path);
  }

  async deleteAll(userId) {
    const rows = this.db.prepare("SELECT storage_path FROM interview_assets WHERE user_id=?").all(userId);
    this.db.prepare("DELETE FROM interview_assets WHERE user_id=?").run(userId);
    return rows.map((row) => row.storage_path);
  }
}
