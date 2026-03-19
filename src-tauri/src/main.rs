#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{path::PathBuf, sync::Mutex};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

struct AppState {
    db_path: Mutex<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    version: i64,
    saved_at: String,
    teams: serde_json::Value,
    weights: serde_json::Value,
}

fn db_path() -> PathBuf {
    PathBuf::from("madness_oracle.db")
}

fn initialize_db(db_path: &PathBuf) -> rusqlite::Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL,
            saved_at TEXT NOT NULL,
            teams_json TEXT NOT NULL,
            weights_json TEXT NOT NULL
        )",
        [],
    )?;
    Ok(())
}

fn load_state_from_db(db_path: &PathBuf) -> rusqlite::Result<Option<StoredState>> {
    let connection = Connection::open(db_path)?;
    let mut statement = connection.prepare(
        "SELECT version, saved_at, teams_json, weights_json FROM app_state WHERE id = 1",
    )?;

    statement
        .query_row([], |row| {
            let teams_json: String = row.get(2)?;
            let weights_json: String = row.get(3)?;
            Ok(StoredState {
                version: row.get(0)?,
                saved_at: row.get(1)?,
                teams: serde_json::from_str(&teams_json).map_err(to_sql_error)?,
                weights: serde_json::from_str(&weights_json).map_err(to_sql_error)?,
            })
        })
        .optional()
}

fn save_state_to_db(db_path: &PathBuf, payload: &StoredState) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO app_state (id, version, saved_at, teams_json, weights_json)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                version = excluded.version,
                saved_at = excluded.saved_at,
                teams_json = excluded.teams_json,
                weights_json = excluded.weights_json",
            params![
                payload.version,
                if payload.saved_at.is_empty() {
                    Utc::now().to_rfc3339()
                } else {
                    payload.saved_at.clone()
                },
                serde_json::to_string(&payload.teams).map_err(|error| error.to_string())?,
                serde_json::to_string(&payload.weights).map_err(|error| error.to_string())?,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn clear_state_in_db(db_path: &PathBuf) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM app_state WHERE id = 1", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

#[tauri::command]
fn get_state(state: tauri::State<AppState>) -> Result<Option<StoredState>, String> {
    let db_path = state
        .db_path
        .lock()
        .map_err(|_| "failed to lock db path")?
        .clone();
    load_state_from_db(&db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_state(payload: StoredState, state: tauri::State<AppState>) -> Result<(), String> {
    let db_path = state
        .db_path
        .lock()
        .map_err(|_| "failed to lock db path")?
        .clone();
    save_state_to_db(&db_path, &payload).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_state(state: tauri::State<AppState>) -> Result<(), String> {
    let db_path = state
        .db_path
        .lock()
        .map_err(|_| "failed to lock db path")?
        .clone();
    clear_state_in_db(&db_path).map_err(|error| error.to_string())
}

fn main() {
    let db_path = db_path();
    initialize_db(&db_path).expect("failed to initialize sqlite database");

    tauri::Builder::default()
        .manage(AppState {
            db_path: Mutex::new(db_path),
        })
        .invoke_handler(tauri::generate_handler![get_state, save_state, clear_state])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("valid time")
            .as_nanos();
        std::env::temp_dir().join(format!("{label}-{nanos}.db"))
    }

    fn sample_state() -> StoredState {
        StoredState {
            version: 1,
            saved_at: "2026-03-19T00:00:00Z".into(),
            teams: serde_json::json!([{"name": "Houston"}]),
            weights: serde_json::json!({"marketBlend": 18}),
        }
    }

    #[test]
    fn tauri_sqlite_round_trip_state() {
        let db_path = temp_db_path("oracle-tauri-roundtrip");
        initialize_db(&db_path).expect("db init");
        let state = sample_state();

        save_state_to_db(&db_path, &state).expect("save state");
        let loaded = load_state_from_db(&db_path)
            .expect("load state")
            .expect("stored state exists");

        assert_eq!(loaded.version, state.version);
        assert_eq!(loaded.teams, state.teams);
        assert_eq!(loaded.weights, state.weights);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn tauri_sqlite_clear_state_removes_row() {
        let db_path = temp_db_path("oracle-tauri-clear");
        initialize_db(&db_path).expect("db init");
        save_state_to_db(&db_path, &sample_state()).expect("save state");

        clear_state_in_db(&db_path).expect("clear state");
        let loaded = load_state_from_db(&db_path).expect("load state after clear");
        assert!(loaded.is_none());

        let _ = std::fs::remove_file(db_path);
    }
}
