import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createNodeRequire } from "../nodeRequire.js";
// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const { DatabaseSync } = createNodeRequire()("node:sqlite") as typeof import("node:sqlite");
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import { getTasksIndexDatabasePath } from "../paths.js";
import { runTasksDatabaseMigrations } from "./tasksDatabase/migrations.js";

/** 多目录项目 P1 数据层（docs/specs/multi-root-projects.md）。宿主侧仓储，CLI 不感知。 */
export interface ProjectRoot {
  rootPath: string;
  position: number;
  isPrimary: boolean;
}

export interface ProjectRecord {
  projectId: string;
  hostId: string;
  name: string;
  defaultName: string | null;
  pinned: boolean;
  roots: ProjectRoot[];
}

export interface SaveProjectInput {
  projectId?: string;
  hostId?: string;
  name: string;
  defaultName?: string | null;
  pinned?: boolean;
  /** 有序 roots；重复项去重后保序。 */
  roots: string[];
  /** 主目录；缺省取首个 root，不在 roots 中即拒绝。 */
  primaryRoot?: string;
}

const PRIMARY_ROOT_MISSING = "project.primary-root-missing";
const ROOTS_EMPTY = "project.roots-empty";
const PRIMARY_NOT_IN_ROOTS = "project.primary-not-in-roots";

export class ProjectRepository {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  async ensureReady(): Promise<void> {
    const path = this.resolvedDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) this.close();
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    runTasksDatabaseMigrations(this.db);
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) throw new Error("ProjectRepository 未初始化：请先 await ensureReady()");
    return this.db;
  }

  /**
   * 保存即整组重写 roots（ZCodium 同型，无增量 UPDATE 分支）：单事务内 upsert 项目行、
   * DELETE project_roots 后按 position 重插，primary 恒好一个。
   */
  saveProject(input: SaveProjectInput): ProjectRecord {
    const roots = [...new Set(input.roots.map((root) => root.trim()).filter(Boolean))];
    if (roots.length === 0) throw new Error(ROOTS_EMPTY);
    const primary = input.primaryRoot?.trim() || roots[0];
    // roots 非空已由上一行保证，但 noUncheckedIndexedAccess 下 roots[0] 仍是
    // string | undefined；收窄做在判空上，不用非空断言（m5air 任务书修复要点 3）。
    if (primary === undefined || !roots.includes(primary)) throw new Error(PRIMARY_NOT_IN_ROOTS);
    const db = this.getDatabase();
    const projectId = input.projectId?.trim() || `proj_${randomUUID()}`;
    const hostId = input.hostId?.trim() || "local";
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare("SELECT created_at FROM projects WHERE project_id=?")
        .get(projectId) as { created_at: number } | undefined;
      db.prepare(
        `INSERT INTO projects (project_id, host_id, name, default_name, pinned, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET
           host_id=excluded.host_id, name=excluded.name, default_name=excluded.default_name,
           pinned=excluded.pinned, updated_at=excluded.updated_at`,
      ).run(
        projectId,
        hostId,
        input.name,
        input.defaultName ?? null,
        input.pinned ? 1 : 0,
        existing?.created_at ?? now,
        now,
      );
      db.prepare("DELETE FROM project_roots WHERE project_id=?").run(projectId);
      const insertRoot = db.prepare(
        "INSERT INTO project_roots (project_id, root_path, position, is_primary) VALUES(?,?,?,?)",
      );
      roots.forEach((root, position) =>
        insertRoot.run(projectId, root, position, root === primary ? 1 : 0),
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* 连接关闭路径自恢复。 */
      }
      throw error;
    }
    return this.getProject(projectId);
  }

  getProject(projectId: string): ProjectRecord {
    const db = this.getDatabase();
    const row = db
      .prepare(
        "SELECT project_id, host_id, name, default_name, pinned FROM projects WHERE project_id=?",
      )
      .get(projectId) as
      | {
          project_id: string;
          host_id: string;
          name: string;
          default_name: string | null;
          pinned: number;
        }
      | undefined;
    if (!row) throw new Error(`project.not-found: ${projectId}`);
    return {
      projectId: row.project_id,
      hostId: row.host_id,
      name: row.name,
      defaultName: row.default_name,
      pinned: row.pinned === 1,
      roots: this.readRoots(projectId),
    };
  }

  listProjects(): ProjectRecord[] {
    const db = this.getDatabase();
    const rows = db
      .prepare("SELECT project_id FROM projects ORDER BY updated_at DESC")
      .all() as Array<{ project_id: string }>;
    return rows.map((row) => this.getProject(row.project_id));
  }

  deleteProject(projectId: string): void {
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM project_roots WHERE project_id=?").run(projectId);
      db.prepare("DELETE FROM projects WHERE project_id=?").run(projectId);
      db.exec("COMMIT");
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* 连接关闭路径自恢复。 */
      }
      throw error;
    }
  }

  /** 项目主目录（新任务 cwd 的唯一来源）；缺失即拒绝，由调用方决定是否复活目录。 */
  primaryRootOf(projectId: string): string {
    const roots = this.getProject(projectId).roots;
    const primary = roots.find((root) => root.isPrimary)?.rootPath;
    if (!primary) throw new Error(PRIMARY_ROOT_MISSING);
    return primary;
  }

  /**
   * 存量迁移（一次性、幂等）：settings.recentProjects 的每个路径建一个单 root 项目
   * （首个 root 即 primary）；路径已是任何项目的 root 则跳过。
   */
  adoptRecentProjects(paths: readonly string[]): number {
    const db = this.getDatabase();
    const existingRoots = new Set(
      (db.prepare("SELECT root_path FROM project_roots").all() as Array<{ root_path: string }>).map(
        (row) => row.root_path,
      ),
    );
    let adopted = 0;
    for (const raw of paths) {
      const rootPath = raw.trim();
      if (!rootPath || existingRoots.has(rootPath)) continue;
      this.saveProject({
        name: basename(rootPath) || rootPath,
        roots: [rootPath],
        primaryRoot: rootPath,
      });
      existingRoots.add(rootPath);
      adopted++;
    }
    return adopted;
  }

  private readRoots(projectId: string): ProjectRoot[] {
    const rows = this.getDatabase()
      .prepare(
        "SELECT root_path, position, is_primary FROM project_roots WHERE project_id=? ORDER BY position",
      )
      .all(projectId) as Array<{ root_path: string; position: number; is_primary: number }>;
    return rows.map((row) => ({
      rootPath: row.root_path,
      position: row.position,
      isPrimary: row.is_primary === 1,
    }));
  }
}
