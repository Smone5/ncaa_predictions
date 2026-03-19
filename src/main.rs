use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, put},
    Json, Router,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tower_http::services::ServeDir;

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    version: i64,
    saved_at: String,
    teams: serde_json::Value,
    weights: serde_json::Value,
}

#[tokio::main]
async fn main() {
    let db_path = PathBuf::from("madness_oracle.db");
    initialize_db(&db_path).expect("failed to initialize sqlite database");

    let state = Arc::new(AppState { db_path });
    let api_routes = Router::new()
        .route("/state", get(get_state).put(put_state).delete(delete_state))
        .with_state(state);

    let app = Router::new()
        .nest("/api", api_routes)
        .fallback_service(ServeDir::new("."));

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    println!("Madness Oracle Pro running at http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind tcp listener");
    axum::serve(listener, app).await.expect("server failed");
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

async fn get_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Option<StoredState>>, ApiError> {
    let connection = Connection::open(&state.db_path)?;
    let mut statement = connection.prepare(
        "SELECT version, saved_at, teams_json, weights_json FROM app_state WHERE id = 1",
    )?;

    let row = statement
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
        .optional()?;

    Ok(Json(row))
}

async fn put_state(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<StoredState>,
) -> Result<impl IntoResponse, ApiError> {
    let connection = Connection::open(&state.db_path)?;
    connection.execute(
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
                payload.saved_at
            },
            serde_json::to_string(&payload.teams).map_err(ApiError::Json)?,
            serde_json::to_string(&payload.weights).map_err(ApiError::Json)?,
        ],
    )?;

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_state(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let connection = Connection::open(&state.db_path)?;
    connection.execute("DELETE FROM app_state WHERE id = 1", [])?;
    Ok(StatusCode::NO_CONTENT)
}

fn to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

#[derive(Debug)]
enum ApiError {
    Sql(rusqlite::Error),
    Json(serde_json::Error),
}

impl From<rusqlite::Error> for ApiError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let message = match self {
            ApiError::Sql(error) => format!("sqlite error: {error}"),
            ApiError::Json(error) => format!("json error: {error}"),
        };
        (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
    }
}
