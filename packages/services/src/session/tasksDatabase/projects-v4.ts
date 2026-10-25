// 0004 多目录项目（docs/specs/multi-root-projects.md P1 数据层）。
// 只增：两张新表 + tasks 三个可空列；受 sqlite-schema-contract 只增门禁保护。
export const PROJECTS_MIGRATION_SQL = `
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL DEFAULT 'local',
        name TEXT NOT NULL,
        default_name TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_roots (
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        root_path TEXT NOT NULL,
        position INTEGER NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, root_path)
      );

      CREATE INDEX IF NOT EXISTS idx_project_roots_project
      ON project_roots (project_id, position);

      ALTER TABLE tasks ADD COLUMN root_path TEXT;
      ALTER TABLE tasks ADD COLUMN project_id TEXT;
      ALTER TABLE tasks ADD COLUMN execution_directories TEXT;
`;
