import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";
import {
  containsProductBrandName,
  redactProductNames,
  redactProductReferences
} from "../public/compliance-redaction.js";

const { Pool } = pg;

function normalizeProjectId(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "default";
}

function normalizeProjectName(value) {
  return redactProductNames(value || "未命名访谈项目").trim().slice(0, 80) || "未命名访谈项目";
}

function normalizeWorkspace(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? redactProductReferences(value)
    : {};
}

function publicWorkspace(row) {
  const workspace = typeof row.workspace === "string"
    ? JSON.parse(row.workspace || "{}")
    : row.workspace || {};
  return {
    projectId: row.project_id,
    projectName: redactProductNames(row.project_name),
    workspace: redactProductReferences(workspace),
    revision: Number(row.revision || 1),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || "")
  };
}

export class PostgresProjectWorkspaceStore {
  static async create(connectionString) {
    const pool = new Pool({
      connectionString,
      ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5
    });
    const store = new PostgresProjectWorkspaceStore(pool);
    await store.initialize();
    return store;
  }

  constructor(pool) {
    this.pool = pool;
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS project_workspaces (
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL DEFAULT '未命名访谈项目',
        workspace JSONB NOT NULL DEFAULT '{}'::jsonb,
        revision BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_workspaces_user_updated
        ON project_workspaces(user_id, updated_at DESC);
    `);
    await this.redactLegacyProductNames();
  }

  async redactLegacyProductNames() {
    const result = await this.pool.query(
      "SELECT user_id, project_id, project_name, workspace FROM project_workspaces"
    );
    for (const row of result.rows) {
      if (!containsProductBrandName(JSON.stringify(row))) continue;
      await this.pool.query(
        `UPDATE project_workspaces
         SET project_name=$3, workspace=$4::jsonb, revision=revision + 1, updated_at=NOW()
         WHERE user_id=$1 AND project_id=$2`,
        [
          row.user_id,
          row.project_id,
          redactProductNames(row.project_name),
          JSON.stringify(redactProductReferences(row.workspace || {}))
        ]
      );
    }
  }

  async list(userId) {
    const result = await this.pool.query(
      "SELECT project_id, project_name, workspace, revision, updated_at FROM project_workspaces WHERE user_id=$1 ORDER BY created_at ASC",
      [userId]
    );
    return result.rows.map(publicWorkspace);
  }

  async upsert(userId, projectId, projectName, workspace) {
    const result = await this.pool.query(
      `INSERT INTO project_workspaces(user_id, project_id, project_name, workspace)
       VALUES($1, $2, $3, $4::jsonb)
       ON CONFLICT(user_id, project_id) DO UPDATE SET
         project_name=EXCLUDED.project_name,
         workspace=EXCLUDED.workspace,
         revision=project_workspaces.revision + 1,
         updated_at=NOW()
       RETURNING project_id, project_name, workspace, revision, updated_at`,
      [
        userId,
        normalizeProjectId(projectId),
        normalizeProjectName(projectName),
        JSON.stringify(normalizeWorkspace(workspace))
      ]
    );
    return publicWorkspace(result.rows[0]);
  }

  async delete(userId, projectId) {
    const result = await this.pool.query(
      "DELETE FROM project_workspaces WHERE user_id=$1 AND project_id=$2",
      [userId, normalizeProjectId(projectId)]
    );
    return result.rowCount > 0;
  }
}

export class SqliteProjectWorkspaceStore {
  static async create(path) {
    await mkdir(dirname(path), { recursive: true });
    const store = new SqliteProjectWorkspaceStore(path);
    store.initialize();
    return store;
  }

  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_workspaces (
        user_id INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL DEFAULT '未命名访谈项目',
        workspace TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_workspaces_user_updated
        ON project_workspaces(user_id, updated_at DESC);
    `);
    this.redactLegacyProductNames();
  }

  redactLegacyProductNames() {
    const rows = this.db.prepare(
      "SELECT user_id, project_id, project_name, workspace FROM project_workspaces"
    ).all();
    const update = this.db.prepare(`
      UPDATE project_workspaces
      SET project_name=?, workspace=?, revision=revision + 1, updated_at=CURRENT_TIMESTAMP
      WHERE user_id=? AND project_id=?
    `);
    for (const row of rows) {
      if (!containsProductBrandName(JSON.stringify(row))) continue;
      let workspace = {};
      try { workspace = JSON.parse(row.workspace || "{}"); } catch {}
      update.run(
        redactProductNames(row.project_name),
        JSON.stringify(redactProductReferences(workspace)),
        row.user_id,
        row.project_id
      );
    }
  }

  async list(userId) {
    return this.db.prepare(
      "SELECT project_id, project_name, workspace, revision, updated_at FROM project_workspaces WHERE user_id=? ORDER BY created_at ASC"
    ).all(userId).map(publicWorkspace);
  }

  async upsert(userId, projectId, projectName, workspace) {
    const id = normalizeProjectId(projectId);
    this.db.prepare(`
      INSERT INTO project_workspaces(user_id, project_id, project_name, workspace)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(user_id, project_id) DO UPDATE SET
        project_name=excluded.project_name,
        workspace=excluded.workspace,
        revision=project_workspaces.revision + 1,
        updated_at=CURRENT_TIMESTAMP
    `).run(userId, id, normalizeProjectName(projectName), JSON.stringify(normalizeWorkspace(workspace)));
    return publicWorkspace(this.db.prepare(
      "SELECT project_id, project_name, workspace, revision, updated_at FROM project_workspaces WHERE user_id=? AND project_id=?"
    ).get(userId, id));
  }

  async delete(userId, projectId) {
    return this.db.prepare(
      "DELETE FROM project_workspaces WHERE user_id=? AND project_id=?"
    ).run(userId, normalizeProjectId(projectId)).changes > 0;
  }
}
