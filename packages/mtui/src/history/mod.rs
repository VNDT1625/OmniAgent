use anyhow::Context;
use chrono::Utc;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct OperationRecord {
    pub operation_id: String,
    pub command: String,
    pub operation_type: String,
    pub cwd: String,
    pub project_path: String,
    pub file_path: Option<String>,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub backup_path: Option<String>,
    pub diff_path: Option<String>,
    pub changed: bool,
    pub created_at: String,
    pub agent_id: Option<String>,
    pub task_id: Option<String>,
    pub plan_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandRecord {
    pub command: String,
    pub cwd: String,
    pub project_path: String,
    pub exit_code: i32,
    pub duration_ms: i64,
    pub used_count: i64,
    pub success_count: i64,
    pub failure_count: i64,
    pub last_used: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepairRule {
    pub id: i64,
    pub match_command: String,
    pub stderr_contains: Option<String>,
    pub suggested_command: String,
    pub message: String,
    pub source: String,
    pub risk: String,
    pub requires_confirm: bool,
}

pub fn db_path(project_root: &Path) -> std::path::PathBuf {
    crate::config::config_dir(project_root).join("mtui.db")
}

pub fn open_db(project_root: &Path) -> anyhow::Result<Connection> {
    let path = db_path(project_root);
    let conn = Connection::open(&path)
        .with_context(|| format!("Failed to open database: {}", path.display()))?;
    init_tables(&conn)?;
    Ok(conn)
}

fn init_tables(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS operations (
            operation_id TEXT PRIMARY KEY,
            command TEXT NOT NULL,
            operation_type TEXT NOT NULL,
            cwd TEXT NOT NULL,
            project_path TEXT NOT NULL,
            file_path TEXT,
            before_hash TEXT,
            after_hash TEXT,
            backup_path TEXT,
            diff_path TEXT,
            changed INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS command_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            command TEXT NOT NULL,
            cwd TEXT NOT NULL,
            project_path TEXT NOT NULL,
            exit_code INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            used_count INTEGER NOT NULL DEFAULT 1,
            success_count INTEGER NOT NULL DEFAULT 0,
            failure_count INTEGER NOT NULL DEFAULT 0,
            last_used TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS repair_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_command TEXT NOT NULL,
            stderr_contains TEXT,
            suggested_command TEXT NOT NULL,
            message TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'local_rule',
            risk TEXT NOT NULL DEFAULT 'unknown',
            requires_confirm INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_operations_created_at ON operations(created_at);
        CREATE INDEX IF NOT EXISTS idx_command_history_last_used ON command_history(last_used);
        CREATE INDEX IF NOT EXISTS idx_command_history_command ON command_history(command);
        ",
    )?;
    ensure_column(conn, "operations", "agent_id", "TEXT")?;
    ensure_column(conn, "operations", "task_id", "TEXT")?;
    ensure_column(conn, "operations", "plan_id", "TEXT")?;
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    column_type: &str,
) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|name| name == column) {
        conn.execute(
            &format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                table, column, column_type
            ),
            [],
        )?;
    }
    Ok(())
}

pub fn record_operation(conn: &Connection, record: &OperationRecord) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO operations (operation_id, command, operation_type, cwd, project_path, file_path, before_hash, after_hash, backup_path, diff_path, changed, created_at, agent_id, task_id, plan_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        rusqlite::params![
            record.operation_id,
            record.command,
            record.operation_type,
            record.cwd,
            record.project_path,
            record.file_path,
            record.before_hash,
            record.after_hash,
            record.backup_path,
            record.diff_path,
            record.changed as i32,
            record.created_at,
            record.agent_id,
            record.task_id,
            record.plan_id,
        ],
    )?;
    Ok(())
}

pub fn get_operation(
    conn: &Connection,
    operation_id: &str,
) -> anyhow::Result<Option<OperationRecord>> {
    let mut stmt = conn.prepare(
        "SELECT operation_id, command, operation_type, cwd, project_path, file_path, before_hash, after_hash, backup_path, diff_path, changed, created_at, agent_id, task_id, plan_id
         FROM operations WHERE operation_id = ?1",
    )?;

    let result = stmt.query_row(rusqlite::params![operation_id], |row| {
        Ok(OperationRecord {
            operation_id: row.get(0)?,
            command: row.get(1)?,
            operation_type: row.get(2)?,
            cwd: row.get(3)?,
            project_path: row.get(4)?,
            file_path: row.get(5)?,
            before_hash: row.get(6)?,
            after_hash: row.get(7)?,
            backup_path: row.get(8)?,
            diff_path: row.get(9)?,
            changed: row.get::<_, i32>(10)? != 0,
            created_at: row.get(11)?,
            agent_id: row.get(12)?,
            task_id: row.get(13)?,
            plan_id: row.get(14)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn get_last_operation(conn: &Connection) -> anyhow::Result<Option<OperationRecord>> {
    let mut stmt = conn.prepare(
        "SELECT operation_id, command, operation_type, cwd, project_path, file_path, before_hash, after_hash, backup_path, diff_path, changed, created_at, agent_id, task_id, plan_id
         FROM operations ORDER BY created_at DESC LIMIT 1",
    )?;

    let result = stmt.query_row([], |row| {
        Ok(OperationRecord {
            operation_id: row.get(0)?,
            command: row.get(1)?,
            operation_type: row.get(2)?,
            cwd: row.get(3)?,
            project_path: row.get(4)?,
            file_path: row.get(5)?,
            before_hash: row.get(6)?,
            after_hash: row.get(7)?,
            backup_path: row.get(8)?,
            diff_path: row.get(9)?,
            changed: row.get::<_, i32>(10)? != 0,
            created_at: row.get(11)?,
            agent_id: row.get(12)?,
            task_id: row.get(13)?,
            plan_id: row.get(14)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn list_operations(conn: &Connection, limit: usize) -> anyhow::Result<Vec<OperationRecord>> {
    let mut stmt = conn.prepare(
        "SELECT operation_id, command, operation_type, cwd, project_path, file_path, before_hash, after_hash, backup_path, diff_path, changed, created_at, agent_id, task_id, plan_id
         FROM operations ORDER BY created_at DESC LIMIT ?1",
    )?;

    let records = stmt
        .query_map(rusqlite::params![limit as i64], |row| {
            Ok(OperationRecord {
                operation_id: row.get(0)?,
                command: row.get(1)?,
                operation_type: row.get(2)?,
                cwd: row.get(3)?,
                project_path: row.get(4)?,
                file_path: row.get(5)?,
                before_hash: row.get(6)?,
                after_hash: row.get(7)?,
                backup_path: row.get(8)?,
                diff_path: row.get(9)?,
                changed: row.get::<_, i32>(10)? != 0,
                created_at: row.get(11)?,
                agent_id: row.get(12)?,
                task_id: row.get(13)?,
                plan_id: row.get(14)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(records)
}

pub fn record_command(
    conn: &Connection,
    cmd: &str,
    cwd: &str,
    project_path: &str,
    exit_code: i32,
    duration_ms: i64,
) -> anyhow::Result<()> {
    let now = Utc::now().to_rfc3339();
    let success = exit_code == 0;

    let existing = conn.query_row(
        "SELECT id, used_count, success_count, failure_count FROM command_history WHERE command = ?1 AND cwd = ?2",
        rusqlite::params![cmd, cwd],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    );

    match existing {
        Ok((id, used_count, success_count, failure_count)) => {
            let new_success = if success {
                success_count + 1
            } else {
                success_count
            };
            let new_failure = if !success {
                failure_count + 1
            } else {
                failure_count
            };
            conn.execute(
                "UPDATE command_history SET duration_ms = ?1, exit_code = ?2, used_count = ?3, success_count = ?4, failure_count = ?5, last_used = ?6 WHERE id = ?7",
                rusqlite::params![duration_ms, exit_code, used_count + 1, new_success, new_failure, now, id],
            )?;
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            let new_success = if success { 1i64 } else { 0i64 };
            let new_failure = if !success { 1i64 } else { 0i64 };
            conn.execute(
                "INSERT INTO command_history (command, cwd, project_path, exit_code, duration_ms, used_count, success_count, failure_count, last_used, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9)",
                rusqlite::params![cmd, cwd, project_path, exit_code, duration_ms, new_success, new_failure, now, now],
            )?;
        }
        Err(e) => return Err(e.into()),
    }

    Ok(())
}

pub fn list_commands(conn: &Connection, limit: usize) -> anyhow::Result<Vec<CommandRecord>> {
    let mut stmt = conn.prepare(
        "SELECT command, cwd, project_path, exit_code, duration_ms, used_count, success_count, failure_count, last_used
         FROM command_history ORDER BY last_used DESC LIMIT ?1",
    )?;

    let records = stmt
        .query_map(rusqlite::params![limit as i64], |row| {
            Ok(CommandRecord {
                command: row.get(0)?,
                cwd: row.get(1)?,
                project_path: row.get(2)?,
                exit_code: row.get(3)?,
                duration_ms: row.get(4)?,
                used_count: row.get(5)?,
                success_count: row.get(6)?,
                failure_count: row.get(7)?,
                last_used: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(records)
}

pub fn search_commands(conn: &Connection, prefix: &str) -> anyhow::Result<Vec<CommandRecord>> {
    let mut stmt = conn.prepare(
        "SELECT command, cwd, project_path, exit_code, duration_ms, used_count, success_count, failure_count, last_used
         FROM command_history WHERE command LIKE ?1 ORDER BY last_used DESC LIMIT 50",
    )?;

    let pattern = format!("{}%", prefix);
    let records = stmt
        .query_map(rusqlite::params![pattern], |row| {
            Ok(CommandRecord {
                command: row.get(0)?,
                cwd: row.get(1)?,
                project_path: row.get(2)?,
                exit_code: row.get(3)?,
                duration_ms: row.get(4)?,
                used_count: row.get(5)?,
                success_count: row.get(6)?,
                failure_count: row.get(7)?,
                last_used: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(records)
}

pub fn load_repair_rules(conn: &Connection) -> anyhow::Result<Vec<RepairRule>> {
    let mut stmt = conn.prepare(
        "SELECT id, match_command, stderr_contains, suggested_command, message, source, risk, requires_confirm
         FROM repair_rules",
    )?;

    let rules = stmt
        .query_map([], |row| {
            Ok(RepairRule {
                id: row.get(0)?,
                match_command: row.get(1)?,
                stderr_contains: row.get(2)?,
                suggested_command: row.get(3)?,
                message: row.get(4)?,
                source: row.get(5)?,
                risk: row.get(6)?,
                requires_confirm: row.get::<_, i32>(7)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rules)
}
