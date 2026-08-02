use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{
    ConnectOptions, Connection, Row, SqliteConnection,
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
};
use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::{AppHandle, Manager, path::BaseDirectory};
use tauri_plugin_sql::{Migration, MigrationKind};

const EXTENSION_ID: &str = "kdmgiohkeeehnpaccfmjgiccfbaodlhg";
const NATIVE_HOST_NAME: &str = "com.framesync.capture";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboxCaptureSummary {
    capture_id: String,
    conversation_title: Option<String>,
    platform: String,
    captured_at: String,
    message_count: usize,
    asset_count: usize,
    processed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserIntegrationStatus {
    mode: &'static str,
    extension_id: &'static str,
    extension_path: Option<String>,
    extension_available: bool,
    host_path: Option<String>,
    host_available: bool,
    host_registered: bool,
    edge_registered: bool,
    chrome_registered: bool,
    manifest_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaFolderImportResult {
    discovered: usize,
    imported: usize,
    duplicates: usize,
    assigned: usize,
    unassigned: usize,
    images: usize,
    videos: usize,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceDocumentImportResult {
    original_filename: String,
    stored_path: String,
    sha256: String,
    byte_size: u64,
    mime_type: String,
    page_count: Option<usize>,
    text: String,
    warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShotMediaImportResult {
    imported: usize,
    duplicates: usize,
    assigned: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectWorkspaceResult {
    root_path: String,
    sources_path: String,
    multimedia_inbox_path: String,
    shots_path: String,
    unassigned_path: String,
    exports_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MultimediaInboxItem {
    id: String,
    original_filename: String,
    staged_path: String,
    kind: String,
    mime_type: String,
    byte_size: i64,
    sha256: String,
    shot_id: Option<String>,
    shot_code: Option<String>,
    shot_title: Option<String>,
    role: Option<String>,
    status: String,
    detection_note: String,
    error_message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MultimediaStageResult {
    discovered: usize,
    staged: usize,
    duplicates: usize,
    ignored: usize,
    ready: usize,
    needs_review: usize,
    items: Vec<MultimediaInboxItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MultimediaProcessResult {
    processed: usize,
    failed: usize,
    errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShotWorkspaceResult {
    root_path: String,
    storyboard_path: String,
    first_frame_path: String,
    video_path: String,
}

fn safe_folder_component(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, ' ' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        "Sin titulo".to_owned()
    } else {
        cleaned.chars().take(80).collect()
    }
}

fn ensure_project_workspace(
    app: &AppHandle,
    project_number: i64,
    project_name: &str,
) -> Result<ProjectWorkspaceResult, String> {
    if project_number <= 0 {
        return Err("El numero de proyecto no es valido.".to_owned());
    }
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("No se encontro la carpeta Documentos: {error}"))?;
    let general_root = documents.join("Storyboard Wana");
    fs::create_dir_all(&general_root)
        .map_err(|error| format!("No se pudo crear {}: {error}", general_root.display()))?;
    let prefix = format!("Proyecto {project_number:03} - ");
    let desired_root =
        general_root.join(format!("{prefix}{}", safe_folder_component(project_name)));
    if !desired_root.exists()
        && let Ok(entries) = fs::read_dir(&general_root)
    {
        let previous = entries.flatten().map(|entry| entry.path()).find(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix))
        });
        if let Some(previous) = previous
            && previous != desired_root
        {
            fs::rename(&previous, &desired_root).map_err(|error| {
                format!(
                    "No se pudo actualizar el nombre de la carpeta {}: {error}",
                    previous.display()
                )
            })?;
        }
    }
    let sources = desired_root.join("Fuentes");
    let multimedia_inbox = desired_root.join("Bandeja multimedia");
    let shots = desired_root.join("Planos");
    let unassigned = desired_root.join("Sin asignar");
    let exports = desired_root.join("Exportaciones");
    for path in [
        &desired_root,
        &sources,
        &multimedia_inbox,
        &shots,
        &unassigned,
        &exports,
    ] {
        fs::create_dir_all(path)
            .map_err(|error| format!("No se pudo crear {}: {error}", path.display()))?;
    }
    Ok(ProjectWorkspaceResult {
        root_path: desired_root.to_string_lossy().to_string(),
        sources_path: sources.to_string_lossy().to_string(),
        multimedia_inbox_path: multimedia_inbox.to_string_lossy().to_string(),
        shots_path: shots.to_string_lossy().to_string(),
        unassigned_path: unassigned.to_string_lossy().to_string(),
        exports_path: exports.to_string_lossy().to_string(),
    })
}

fn ensure_shot_workspace(
    workspace: &ProjectWorkspaceResult,
    shot_code: &str,
    shot_title: &str,
) -> Result<ShotWorkspaceResult, String> {
    let shots_root = PathBuf::from(&workspace.shots_path);
    fs::create_dir_all(&shots_root)
        .map_err(|error| format!("No se pudo crear {}: {error}", shots_root.display()))?;
    let safe_code = safe_folder_component(shot_code);
    let prefix = format!("{safe_code} - ");
    let desired_root = shots_root.join(format!("{prefix}{}", safe_folder_component(shot_title)));
    if !desired_root.exists()
        && let Ok(entries) = fs::read_dir(&shots_root)
    {
        let previous = entries.flatten().map(|entry| entry.path()).find(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == safe_code || name.starts_with(&prefix))
        });
        if let Some(previous) = previous
            && previous != desired_root
        {
            fs::rename(&previous, &desired_root).map_err(|error| {
                format!(
                    "No se pudo actualizar la carpeta del plano {}: {error}",
                    previous.display()
                )
            })?;
        }
    }
    let video = desired_root.join("Video");
    for path in [&desired_root, &video] {
        fs::create_dir_all(path)
            .map_err(|error| format!("No se pudo crear {}: {error}", path.display()))?;
    }
    Ok(ShotWorkspaceResult {
        root_path: desired_root.to_string_lossy().to_string(),
        storyboard_path: desired_root.to_string_lossy().to_string(),
        first_frame_path: desired_root.to_string_lossy().to_string(),
        video_path: video.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn prepare_project_workspace(
    app: AppHandle,
    project_number: i64,
    project_name: String,
) -> Result<ProjectWorkspaceResult, String> {
    ensure_project_workspace(&app, project_number, &project_name)
}

#[tauri::command]
fn open_project_workspace(
    app: AppHandle,
    project_number: i64,
    project_name: String,
) -> Result<(), String> {
    let workspace = ensure_project_workspace(&app, project_number, &project_name)?;
    Command::new("explorer.exe")
        .arg(&workspace.root_path)
        .spawn()
        .map_err(|error| format!("No se pudo abrir la carpeta del proyecto: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn open_shot_workspace(
    app: AppHandle,
    project_id: String,
    project_number: i64,
    project_name: String,
    shot_id: String,
    video_only: bool,
) -> Result<(), String> {
    validate_id(&project_id)?;
    validate_id(&shot_id)?;
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No se encontro la base local: {error}"))?
        .join("framesync.db");
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;
    let shot = sqlx::query("SELECT code, title FROM shots WHERE id = ? AND project_id = ? LIMIT 1")
        .bind(&shot_id)
        .bind(&project_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(database_error)?;
    let Some(shot) = shot else {
        return Err("El plano ya no existe en este proyecto.".to_owned());
    };
    let shot_code = shot.try_get::<String, _>("code").map_err(database_error)?;
    let shot_title = shot.try_get::<String, _>("title").map_err(database_error)?;
    let workspace = ensure_project_workspace(&app, project_number, &project_name)?;
    let shot_workspace = ensure_shot_workspace(&workspace, &shot_code, &shot_title)?;
    let target = if video_only {
        &shot_workspace.video_path
    } else {
        &shot_workspace.root_path
    };
    Command::new("explorer.exe")
        .arg(target)
        .spawn()
        .map_err(|error| format!("No se pudo abrir la carpeta del plano: {error}"))?;
    Ok(())
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("El identificador contiene caracteres inseguros.".to_owned());
    }
    Ok(())
}

fn database_error(error: sqlx::Error) -> String {
    format!("No se pudo actualizar la base local: {error}")
}

#[tauri::command]
async fn delete_capture_source(
    app: AppHandle,
    project_id: String,
    capture_id: String,
    remove_imported_content: bool,
) -> Result<(), String> {
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No se encontró la carpeta de datos: {error}"))?
        .join("framesync.db");
    delete_capture_source_in_database(
        database_path,
        project_id,
        capture_id,
        remove_imported_content,
    )
    .await
}

async fn delete_capture_source_in_database(
    database_path: PathBuf,
    project_id: String,
    capture_id: String,
    remove_imported_content: bool,
) -> Result<(), String> {
    validate_id(&project_id)?;
    validate_id(&capture_id)?;

    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;

    let exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM capture_sources WHERE id = ? AND project_id = ? LIMIT 1",
    )
    .bind(&capture_id)
    .bind(&project_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(database_error)?;
    if exists.is_none() {
        return Err("La fuente ya no existe dentro de este proyecto.".to_owned());
    }

    let mut transaction = connection.begin().await.map_err(database_error)?;
    if remove_imported_content {
        sqlx::query("DELETE FROM shots WHERE project_id = ? AND source_capture_id = ?")
            .bind(&project_id)
            .bind(&capture_id)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
        sqlx::query(
            "DELETE FROM scenes
             WHERE project_id = ? AND source_capture_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM shots shot WHERE shot.scene_id = scenes.id
               )",
        )
        .bind(&project_id)
        .bind(&capture_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE scenes SET source_capture_id = NULL
             WHERE project_id = ? AND source_capture_id = ?",
        )
        .bind(&project_id)
        .bind(&capture_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "DELETE FROM episodes
             WHERE project_id = ? AND source_capture_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM scenes scene WHERE scene.episode_id = episodes.id
               )",
        )
        .bind(&project_id)
        .bind(&capture_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE episodes SET source_capture_id = NULL
             WHERE project_id = ? AND source_capture_id = ?",
        )
        .bind(&project_id)
        .bind(&capture_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "DELETE FROM script_versions
             WHERE source_capture_id = ?
               AND script_id IN (
                 SELECT id FROM scripts WHERE project_id = ?
               )",
        )
        .bind(&capture_id)
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "DELETE FROM scripts
             WHERE project_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM script_versions version
                 WHERE version.script_id = scripts.id
               )",
        )
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE scripts
             SET canonical_version_id = (
               SELECT version.id
               FROM script_versions version
               WHERE version.script_id = scripts.id
               ORDER BY version.version_number DESC
               LIMIT 1
             )
             WHERE project_id = ?
               AND canonical_version_id NOT IN (
                 SELECT id FROM script_versions
               )",
        )
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "DELETE FROM character_versions
             WHERE source_capture_id = ?
               AND character_id IN (
                 SELECT id FROM characters WHERE project_id = ?
               )",
        )
        .bind(&capture_id)
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "DELETE FROM characters
             WHERE project_id = ? AND source_capture_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM character_versions version
                 WHERE version.character_id = characters.id
               )",
        )
        .bind(&project_id)
        .bind(&capture_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE characters
             SET canonical_version_id = (
                   SELECT version.id
                   FROM character_versions version
                   WHERE version.character_id = characters.id
                   ORDER BY version.version_number DESC
                   LIMIT 1
                 ),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE project_id = ?
               AND canonical_version_id NOT IN (
                 SELECT id FROM character_versions
               )",
        )
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE characters
             SET source_capture_id = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE project_id = ? AND source_capture_id = ?",
        )
        .bind(&project_id)
        .bind(&capture_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "DELETE FROM location_versions
             WHERE source_capture_id = ?
               AND location_id IN (
                 SELECT id FROM locations WHERE project_id = ?
               )",
        )
        .bind(&capture_id)
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "DELETE FROM locations
             WHERE project_id = ? AND source_capture_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM location_versions version
                 WHERE version.location_id = locations.id
               )",
        )
        .bind(&project_id)
        .bind(&capture_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE locations
             SET canonical_version_id = (
                   SELECT version.id
                   FROM location_versions version
                   WHERE version.location_id = locations.id
                   ORDER BY version.version_number DESC
                   LIMIT 1
                 ),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE project_id = ?
               AND canonical_version_id NOT IN (
                 SELECT id FROM location_versions
               )",
        )
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE locations
             SET source_capture_id = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE project_id = ? AND source_capture_id = ?",
        )
        .bind(&project_id)
        .bind(&capture_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "DELETE FROM assets
             WHERE project_id = ? AND capture_source_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM shot_assets link WHERE link.asset_id = assets.id
               )",
        )
        .bind(&project_id)
        .bind(&capture_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }

    sqlx::query("DELETE FROM capture_sources WHERE id = ? AND project_id = ?")
        .bind(&capture_id)
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query(
        "UPDATE projects
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?",
    )
    .bind(&project_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)
}

#[tauri::command]
async fn delete_shot(app: AppHandle, project_id: String, shot_id: String) -> Result<Value, String> {
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No se encontró la carpeta de datos: {error}"))?
        .join("framesync.db");
    delete_shot_in_database(database_path, project_id, shot_id).await?;
    refresh_workspace_context(app).await
}

async fn delete_shot_in_database(
    database_path: PathBuf,
    project_id: String,
    shot_id: String,
) -> Result<(), String> {
    validate_id(&project_id)?;
    validate_id(&shot_id)?;
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;
    let shot = sqlx::query(
        "SELECT shot_type, global_number
         FROM shots
         WHERE id = ? AND project_id = ?
         LIMIT 1",
    )
    .bind(&shot_id)
    .bind(&project_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(database_error)?
    .ok_or("El plano ya no existe dentro de este proyecto.")?;
    let shot_type = shot
        .try_get::<String, _>("shot_type")
        .map_err(database_error)?;
    let global_number = shot
        .try_get::<Option<i64>, _>("global_number")
        .map_err(database_error)?;

    let mut transaction = connection.begin().await.map_err(database_error)?;
    sqlx::query("DELETE FROM shots WHERE project_id = ? AND variant_of_shot_id = ?")
        .bind(&project_id)
        .bind(&shot_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query("DELETE FROM shots WHERE id = ? AND project_id = ?")
        .bind(&shot_id)
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;

    if shot_type == "normal"
        && let Some(deleted_number) = global_number
    {
        sqlx::query(
            "UPDATE shots
             SET global_number = -global_number,
                 code = '__SHIFT__' || id
             WHERE project_id = ?
               AND shot_type = 'normal'
               AND global_number > ?",
        )
        .bind(&project_id)
        .bind(deleted_number)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE shots
             SET global_number = (-global_number) - 1,
                 code = 'P' || printf('%03d', (-global_number) - 1),
                 order_index = MAX(0, (-global_number) - 2),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE project_id = ?
               AND shot_type = 'normal'
               AND global_number < 0",
        )
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE shots AS variant
             SET code = 'P' || printf(
               '%03d',
               (SELECT parent.global_number
                  FROM shots parent
                 WHERE parent.id = variant.variant_of_shot_id)
             ) || SUBSTR(variant.code, 5),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE variant.project_id = ?
               AND variant.shot_type = 'variant'
               AND variant.variant_of_shot_id IS NOT NULL",
        )
        .bind(&project_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE assets
             SET related_shot_code = 'P' || printf(
               '%03d',
               CAST(SUBSTR(related_shot_code, 2) AS INTEGER) - 1
             )
             WHERE project_id = ?
               AND related_shot_code GLOB 'P[0-9][0-9][0-9]*'
               AND CAST(SUBSTR(related_shot_code, 2) AS INTEGER) > ?",
        )
        .bind(&project_id)
        .bind(deleted_number)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    sqlx::query(
        "UPDATE projects
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?",
    )
    .bind(&project_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(())
}

fn collect_media_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("No se pudo leer {}: {error}", directory.display()))?
        {
            let path = entry
                .map_err(|error| format!("No se pudo leer una entrada: {error}"))?
                .path();
            if path.is_dir() {
                if !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("Bandeja multimedia"))
                {
                    pending.push(path);
                }
            } else if media_kind_and_mime(&path).is_some() {
                files.push(path);
            }
        }
    }
    files.sort_by_key(|path| path.to_string_lossy().to_ascii_lowercase());
    Ok(files)
}

fn collect_selected_media_files(paths: &[String]) -> Result<(Vec<PathBuf>, usize), String> {
    let mut pending = paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut ignored = 0;
    while let Some(path) = pending.pop() {
        if path.is_dir() {
            for entry in fs::read_dir(&path)
                .map_err(|error| format!("No se pudo leer {}: {error}", path.display()))?
            {
                pending.push(
                    entry
                        .map_err(|error| format!("No se pudo leer una entrada: {error}"))?
                        .path(),
                );
            }
        } else if path.is_file() && media_kind_and_mime(&path).is_some() {
            files.push(path);
        } else {
            ignored += 1;
        }
    }
    files.sort_by_key(|path| path.to_string_lossy().to_ascii_lowercase());
    Ok((files, ignored))
}

fn media_kind_and_mime(path: &Path) -> Option<(&'static str, &'static str)> {
    match path
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "webp" => Some(("image", "image/webp")),
        "gif" => Some(("image", "image/gif")),
        "avif" => Some(("image", "image/avif")),
        "mp4" => Some(("video", "video/mp4")),
        "webm" => Some(("video", "video/webm")),
        "mov" => Some(("video", "video/quicktime")),
        "m4v" => Some(("video", "video/x-m4v")),
        _ => None,
    }
}

fn source_document_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => Some("application/pdf"),
        "txt" => Some("text/plain"),
        "md" => Some("text/markdown"),
        "csv" => Some("text/csv"),
        "json" => Some("application/json"),
        _ => None,
    }
}

#[tauri::command]
async fn import_source_documents(
    app: AppHandle,
    project_id: String,
    project_number: i64,
    project_name: String,
    file_paths: Vec<String>,
) -> Result<Vec<SourceDocumentImportResult>, String> {
    validate_id(&project_id)?;
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }
    let destination_root =
        PathBuf::from(ensure_project_workspace(&app, project_number, &project_name)?.sources_path);
    fs::create_dir_all(&destination_root).map_err(|error| {
        format!(
            "No se pudo preparar {}: {error}",
            destination_root.display()
        )
    })?;

    let mut results = Vec::new();
    for file_path in file_paths {
        let source_path = PathBuf::from(&file_path);
        if !source_path.is_file() {
            return Err(format!(
                "El archivo ya no existe: {}",
                source_path.display()
            ));
        }
        let Some(mime_type) = source_document_mime(&source_path) else {
            return Err(format!(
                "Formato no compatible: {}. Usa PDF, TXT, MD, CSV o JSON.",
                source_path.display()
            ));
        };
        let bytes = fs::read(&source_path)
            .map_err(|error| format!("No se pudo leer {}: {error}", source_path.display()))?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let original_filename = source_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let safe_filename = original_filename
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let destination_path =
            destination_root.join(format!("{}_{}", &sha256[..12], safe_filename));
        if !destination_path.exists() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "No se pudo copiar {} a FrameSync: {error}",
                    source_path.display()
                )
            })?;
        }

        let (text, page_count, warning) = if mime_type == "application/pdf" {
            match pdf_extract::extract_text_by_pages(&source_path) {
                Ok(pages) => {
                    let text = pages
                        .iter()
                        .enumerate()
                        .map(|(index, page)| {
                            format!("--- PAGINA {} ---\n{}", index + 1, page.trim())
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    let warning = text.trim().is_empty().then(|| {
                        "El PDF no contiene texto extraible. Puede ser un escaneo; el original se guardo igualmente.".to_owned()
                    });
                    (text, Some(pages.len()), warning)
                }
                Err(error) => (
                    String::new(),
                    None,
                    Some(format!(
                        "El PDF se guardo, pero no se pudo extraer el texto: {error}"
                    )),
                ),
            }
        } else {
            (String::from_utf8_lossy(&bytes).into_owned(), None, None)
        };
        results.push(SourceDocumentImportResult {
            original_filename,
            stored_path: destination_path.to_string_lossy().to_string(),
            sha256,
            byte_size: bytes.len() as u64,
            mime_type: mime_type.to_owned(),
            page_count,
            text,
            warning,
        });
    }
    Ok(results)
}

#[tauri::command]
fn rescan_source_document(file_path: String) -> Result<SourceDocumentImportResult, String> {
    let source_path = PathBuf::from(&file_path);
    if !source_path.is_file() {
        return Err(format!(
            "El archivo ya no existe: {}",
            source_path.display()
        ));
    }
    let Some(mime_type) = source_document_mime(&source_path) else {
        return Err(format!(
            "Formato no compatible: {}. Usa PDF, TXT, MD, CSV o JSON.",
            source_path.display()
        ));
    };
    let bytes = fs::read(&source_path)
        .map_err(|error| format!("No se pudo leer {}: {error}", source_path.display()))?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let original_filename = source_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let (text, page_count, warning) = if mime_type == "application/pdf" {
        match pdf_extract::extract_text_by_pages(&source_path) {
            Ok(pages) => {
                let text = pages
                    .iter()
                    .enumerate()
                    .map(|(index, page)| format!("--- PAGINA {} ---\n{}", index + 1, page.trim()))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                let warning = text.trim().is_empty().then(|| {
                    "El PDF no contiene texto extraible. Puede ser un escaneo.".to_owned()
                });
                (text, Some(pages.len()), warning)
            }
            Err(error) => (
                String::new(),
                None,
                Some(format!("No se pudo volver a extraer el texto: {error}")),
            ),
        }
    } else {
        (String::from_utf8_lossy(&bytes).into_owned(), None, None)
    };

    Ok(SourceDocumentImportResult {
        original_filename,
        stored_path: source_path.to_string_lossy().to_string(),
        sha256,
        byte_size: bytes.len() as u64,
        mime_type: mime_type.to_owned(),
        page_count,
        text,
        warning,
    })
}

fn shot_code_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().to_ascii_uppercase();
    let tokens = stem
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        let number = if matches!(*token, "PLANO" | "SHOT" | "SH") {
            tokens.get(index + 1).copied().filter(|value| {
                !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
            })
        } else if let Some(value) = token.strip_prefix("PLANO") {
            (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())).then_some(value)
        } else if let Some(value) = token.strip_prefix("SHOT") {
            (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())).then_some(value)
        } else if let Some(value) = token.strip_prefix('P') {
            (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())).then_some(value)
        } else {
            None
        };
        if let Some(number) = number.and_then(|value| value.parse::<u32>().ok())
            && number > 0
        {
            return Some(format!("P{number:03}"));
        }
    }
    None
}

fn media_role(path: &Path, kind: &str) -> &'static str {
    if kind == "video" {
        return "video_final";
    }
    let parent = path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_string_lossy()
        .to_ascii_uppercase();
    if parent.contains("STORYBOARDS") {
        return "storyboard";
    }
    if parent.contains("PRIMEROS FRAMES") || parent.contains("FIRST FRAMES") {
        return "first_frame";
    }
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_uppercase();
    if stem.contains("PRIMER_FRAME") || stem.contains("FIRST_FRAME") {
        "first_frame"
    } else if stem.contains("ULTIMO_FRAME") || stem.contains("LAST_FRAME") {
        "last_frame"
    } else if stem.contains("STORYBOARD") {
        "storyboard"
    } else {
        "reference"
    }
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("No se pudo abrir {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("No se pudo leer {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn detected_shot_code(path: &Path) -> Option<String> {
    shot_code_from_filename(path).or_else(|| {
        path.ancestors()
            .skip(1)
            .take(4)
            .find_map(shot_code_from_filename)
    })
}

fn detected_media_role(path: &Path, kind: &str) -> Option<&'static str> {
    let role = media_role(path, kind);
    matches!(role, "storyboard" | "first_frame" | "video_final").then_some(role)
}

fn safe_staged_filename(filename: &str) -> String {
    let safe = filename
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let safe = if safe.is_empty() {
        "archivo".to_owned()
    } else {
        safe
    };
    if safe.chars().count() <= 110 {
        return safe;
    }
    let extension = Path::new(&safe)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let extension_length = extension.chars().count().min(12);
    let stem_length =
        110_usize.saturating_sub(extension_length + usize::from(!extension.is_empty()));
    let stem = Path::new(&safe)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("archivo")
        .chars()
        .take(stem_length)
        .collect::<String>();
    if extension.is_empty() {
        stem
    } else {
        format!(
            "{stem}.{}",
            extension.chars().take(extension_length).collect::<String>()
        )
    }
}

async fn multimedia_inbox_items(
    connection: &mut SqliteConnection,
    project_id: &str,
) -> Result<Vec<MultimediaInboxItem>, String> {
    let rows = sqlx::query(
        "SELECT inbox.id, inbox.original_filename, inbox.staged_path,
                inbox.kind, inbox.mime_type, inbox.byte_size, inbox.sha256,
                inbox.shot_id, COALESCE(shot.code, inbox.detected_shot_code) AS shot_code,
                shot.title AS shot_title, inbox.role, inbox.status,
                inbox.detection_note, inbox.error_message
           FROM multimedia_inbox inbox
           LEFT JOIN shots shot ON shot.id = inbox.shot_id
          WHERE inbox.project_id = ?
          ORDER BY CASE inbox.status WHEN 'needs_review' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,
                   inbox.created_at, inbox.original_filename",
    )
    .bind(project_id)
    .fetch_all(connection)
    .await
    .map_err(database_error)?;
    rows.into_iter()
        .map(|row| {
            Ok(MultimediaInboxItem {
                id: row.try_get("id").map_err(database_error)?,
                original_filename: row.try_get("original_filename").map_err(database_error)?,
                staged_path: row.try_get("staged_path").map_err(database_error)?,
                kind: row.try_get("kind").map_err(database_error)?,
                mime_type: row.try_get("mime_type").map_err(database_error)?,
                byte_size: row.try_get("byte_size").map_err(database_error)?,
                sha256: row.try_get("sha256").map_err(database_error)?,
                shot_id: row.try_get("shot_id").map_err(database_error)?,
                shot_code: row.try_get("shot_code").map_err(database_error)?,
                shot_title: row.try_get("shot_title").map_err(database_error)?,
                role: row.try_get("role").map_err(database_error)?,
                status: row.try_get("status").map_err(database_error)?,
                detection_note: row.try_get("detection_note").map_err(database_error)?,
                error_message: row.try_get("error_message").map_err(database_error)?,
            })
        })
        .collect()
}

fn database_options(app: &AppHandle) -> Result<SqliteConnectOptions, String> {
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No se encontro la base local: {error}"))?
        .join("framesync.db");
    Ok(SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging())
}

#[tauri::command]
async fn list_multimedia_inbox(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<MultimediaInboxItem>, String> {
    validate_id(&project_id)?;
    let mut connection = SqliteConnection::connect_with(&database_options(&app)?)
        .await
        .map_err(database_error)?;
    multimedia_inbox_items(&mut connection, &project_id).await
}

#[tauri::command]
async fn stage_multimedia_paths(
    app: AppHandle,
    project_id: String,
    project_number: i64,
    project_name: String,
    paths: Vec<String>,
) -> Result<MultimediaStageResult, String> {
    validate_id(&project_id)?;
    let (files, ignored) = collect_selected_media_files(&paths)?;
    let workspace = ensure_project_workspace(&app, project_number, &project_name)?;
    let inbox_root = PathBuf::from(&workspace.multimedia_inbox_path);
    let mut connection = SqliteConnection::connect_with(&database_options(&app)?)
        .await
        .map_err(database_error)?;
    let mut result = MultimediaStageResult {
        discovered: files.len(),
        staged: 0,
        duplicates: 0,
        ignored,
        ready: 0,
        needs_review: 0,
        items: Vec::new(),
    };
    for source_path in files {
        let Some((kind, mime_type)) = media_kind_and_mime(&source_path) else {
            continue;
        };
        let sha256 = file_sha256(&source_path)?;
        let duplicate = sqlx::query_scalar::<_, String>(
            "SELECT id FROM multimedia_inbox WHERE project_id = ? AND sha256 = ? LIMIT 1",
        )
        .bind(&project_id)
        .bind(&sha256)
        .fetch_optional(&mut connection)
        .await
        .map_err(database_error)?;
        if duplicate.is_some() {
            result.duplicates += 1;
            continue;
        }
        let original_filename = source_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let staged_path = inbox_root.join(format!(
            "{}_{}",
            &sha256[..24],
            safe_staged_filename(&original_filename)
        ));
        if source_path != staged_path {
            fs::copy(&source_path, &staged_path).map_err(|error| {
                format!(
                    "No se pudo copiar {} a la bandeja: {error}",
                    source_path.display()
                )
            })?;
        }
        let copied_hash = file_sha256(&staged_path)?;
        let byte_size = fs::metadata(&source_path)
            .map_err(|error| format!("No se pudo medir {}: {error}", source_path.display()))?
            .len() as i64;
        let staged_size = fs::metadata(&staged_path)
            .map_err(|error| format!("No se pudo verificar {}: {error}", staged_path.display()))?
            .len() as i64;
        if copied_hash != sha256 || staged_size != byte_size {
            let _ = fs::remove_file(&staged_path);
            return Err(format!(
                "La copia de {} no coincide byte por byte con el original.",
                original_filename
            ));
        }
        let shot_code = detected_shot_code(&source_path);
        let role = detected_media_role(&source_path, kind);
        let shot = if let Some(code) = &shot_code {
            sqlx::query("SELECT id, code FROM shots WHERE project_id = ? AND code = ? LIMIT 1")
                .bind(&project_id)
                .bind(code)
                .fetch_optional(&mut connection)
                .await
                .map_err(database_error)?
        } else {
            None
        };
        let shot_id = shot
            .as_ref()
            .map(|row| row.try_get::<String, _>("id"))
            .transpose()
            .map_err(database_error)?;
        let status = if shot_id.is_some() && role.is_some() {
            result.ready += 1;
            "ready"
        } else {
            result.needs_review += 1;
            "needs_review"
        };
        let detection_note = match (&shot_code, role, &shot_id) {
            (Some(code), Some(_), Some(_)) => {
                format!("Nombre reconocido de forma segura como {code}.")
            }
            (Some(code), _, None) => {
                format!("Se detecto {code}, pero ese plano no existe en el proyecto.")
            }
            (Some(code), None, _) => {
                format!("Se detecto {code}, pero no si es storyboard o primer frame.")
            }
            (None, Some(_), _) => "Se detecto el tipo de medio, pero no el plano.".to_owned(),
            _ => "El nombre no permite identificar plano y tipo con seguridad.".to_owned(),
        };
        let item_seed = format!("{project_id}:{sha256}");
        let item_hash = format!("{:x}", Sha256::digest(item_seed.as_bytes()));
        let item_id = format!("media-inbox-{}", &item_hash[..24]);
        sqlx::query(
            "INSERT INTO multimedia_inbox (
               id, project_id, original_path, staged_path, original_filename,
               kind, mime_type, byte_size, sha256, shot_id, detected_shot_code,
               role, status, detection_note
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&item_id)
        .bind(&project_id)
        .bind(source_path.to_string_lossy().to_string())
        .bind(staged_path.to_string_lossy().to_string())
        .bind(&original_filename)
        .bind(kind)
        .bind(mime_type)
        .bind(byte_size)
        .bind(&sha256)
        .bind(&shot_id)
        .bind(&shot_code)
        .bind(role)
        .bind(status)
        .bind(&detection_note)
        .execute(&mut connection)
        .await
        .map_err(database_error)?;
        result.staged += 1;
    }
    result.items = multimedia_inbox_items(&mut connection, &project_id).await?;
    Ok(result)
}

#[tauri::command]
async fn update_multimedia_inbox_assignment(
    app: AppHandle,
    project_id: String,
    item_id: String,
    shot_id: String,
    role: String,
) -> Result<Vec<MultimediaInboxItem>, String> {
    validate_id(&project_id)?;
    validate_id(&shot_id)?;
    if !matches!(role.as_str(), "storyboard" | "first_frame" | "video_final") {
        return Err("El tipo de medio no es valido.".to_owned());
    }
    let mut connection = SqliteConnection::connect_with(&database_options(&app)?)
        .await
        .map_err(database_error)?;
    let kind = sqlx::query_scalar::<_, String>(
        "SELECT kind FROM multimedia_inbox WHERE id = ? AND project_id = ? LIMIT 1",
    )
    .bind(&item_id)
    .bind(&project_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(database_error)?
    .ok_or("El archivo ya no esta en la bandeja.")?;
    if (kind == "video") != (role == "video_final") {
        return Err("El tipo elegido no coincide con el archivo.".to_owned());
    }
    let shot_code = sqlx::query_scalar::<_, String>(
        "SELECT code FROM shots WHERE id = ? AND project_id = ? LIMIT 1",
    )
    .bind(&shot_id)
    .bind(&project_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(database_error)?
    .ok_or("El plano elegido ya no existe.")?;
    sqlx::query(
        "UPDATE multimedia_inbox
            SET shot_id = ?, detected_shot_code = ?, role = ?, status = 'ready',
                detection_note = 'Asignacion revisada manualmente.', error_message = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND project_id = ?",
    )
    .bind(&shot_id)
    .bind(&shot_code)
    .bind(&role)
    .bind(&item_id)
    .bind(&project_id)
    .execute(&mut connection)
    .await
    .map_err(database_error)?;
    multimedia_inbox_items(&mut connection, &project_id).await
}

#[tauri::command]
async fn remove_multimedia_inbox_item(
    app: AppHandle,
    project_id: String,
    item_id: String,
) -> Result<Vec<MultimediaInboxItem>, String> {
    validate_id(&project_id)?;
    let mut connection = SqliteConnection::connect_with(&database_options(&app)?)
        .await
        .map_err(database_error)?;
    let staged_path = sqlx::query_scalar::<_, String>(
        "SELECT staged_path FROM multimedia_inbox WHERE id = ? AND project_id = ? LIMIT 1",
    )
    .bind(&item_id)
    .bind(&project_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(database_error)?;
    if let Some(staged_path) = staged_path {
        let path = PathBuf::from(staged_path);
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|error| format!("No se pudo quitar {}: {error}", path.display()))?;
        }
        sqlx::query("DELETE FROM multimedia_inbox WHERE id = ? AND project_id = ?")
            .bind(&item_id)
            .bind(&project_id)
            .execute(&mut connection)
            .await
            .map_err(database_error)?;
    }
    multimedia_inbox_items(&mut connection, &project_id).await
}

#[tauri::command]
async fn process_multimedia_inbox(
    app: AppHandle,
    project_id: String,
    project_number: i64,
    project_name: String,
    item_ids: Vec<String>,
) -> Result<MultimediaProcessResult, String> {
    validate_id(&project_id)?;
    for item_id in &item_ids {
        validate_id(item_id)?;
    }
    if item_ids.is_empty() {
        return Ok(MultimediaProcessResult {
            processed: 0,
            failed: 0,
            errors: Vec::new(),
        });
    }

    let options = database_options(&app)?;
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;
    let rows = sqlx::query(
        "SELECT id, staged_path, original_filename, sha256, shot_id, role
           FROM multimedia_inbox
          WHERE project_id = ? AND status = 'ready'
          ORDER BY created_at, original_filename",
    )
    .bind(&project_id)
    .fetch_all(&mut connection)
    .await
    .map_err(database_error)?;
    connection.close().await.map_err(database_error)?;

    let mut result = MultimediaProcessResult {
        processed: 0,
        failed: 0,
        errors: Vec::new(),
    };
    for row in rows {
        let item_id = row.try_get::<String, _>("id").map_err(database_error)?;
        if !item_ids.iter().any(|selected| selected == &item_id) {
            continue;
        }
        let staged_path = row
            .try_get::<String, _>("staged_path")
            .map_err(database_error)?;
        let original_filename = row
            .try_get::<String, _>("original_filename")
            .map_err(database_error)?;
        let expected_hash = row.try_get::<String, _>("sha256").map_err(database_error)?;
        let shot_id = row
            .try_get::<Option<String>, _>("shot_id")
            .map_err(database_error)?;
        let role = row
            .try_get::<Option<String>, _>("role")
            .map_err(database_error)?;
        let source_path = PathBuf::from(&staged_path);

        let import_result = async {
            let shot_id = shot_id.ok_or_else(|| "Falta elegir el plano de destino.".to_owned())?;
            let role = role.ok_or_else(|| "Falta elegir el tipo de medio.".to_owned())?;
            if !source_path.is_file() {
                return Err("La copia de la bandeja ya no existe.".to_owned());
            }
            if file_sha256(&source_path)? != expected_hash {
                return Err("La copia de la bandeja cambió desde que fue verificada.".to_owned());
            }
            import_shot_media(
                app.clone(),
                project_id.clone(),
                project_number,
                project_name.clone(),
                shot_id,
                vec![staged_path.clone()],
                role,
                false,
            )
            .await
            .map(|_| ())
        }
        .await;

        let mut item_connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(database_error)?;
        match import_result {
            Ok(()) => {
                sqlx::query(
                    "UPDATE assets SET original_filename = ?
                      WHERE project_id = ? AND sha256 = ?",
                )
                .bind(&original_filename)
                .bind(&project_id)
                .bind(&expected_hash)
                .execute(&mut item_connection)
                .await
                .map_err(database_error)?;
                sqlx::query("DELETE FROM multimedia_inbox WHERE id = ? AND project_id = ?")
                    .bind(&item_id)
                    .bind(&project_id)
                    .execute(&mut item_connection)
                    .await
                    .map_err(database_error)?;
                result.processed += 1;
                if let Err(error) = fs::remove_file(&source_path)
                    && error.kind() != io::ErrorKind::NotFound
                {
                    result.errors.push(format!(
                        "El archivo se importó, pero no se pudo limpiar su copia temporal: {error}"
                    ));
                }
            }
            Err(error) => {
                sqlx::query(
                    "UPDATE multimedia_inbox
                        SET status = 'error', error_message = ?,
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                      WHERE id = ? AND project_id = ?",
                )
                .bind(&error)
                .bind(&item_id)
                .bind(&project_id)
                .execute(&mut item_connection)
                .await
                .map_err(database_error)?;
                result.failed += 1;
                result.errors.push(format!("{original_filename}: {error}"));
            }
        }
        item_connection.close().await.map_err(database_error)?;
    }
    Ok(result)
}

#[tauri::command]
async fn import_media_folder(
    app: AppHandle,
    project_id: String,
    project_number: i64,
    project_name: String,
    folder_path: String,
) -> Result<MediaFolderImportResult, String> {
    validate_id(&project_id)?;
    let source_root = PathBuf::from(folder_path);
    if !source_root.is_dir() {
        return Err("La carpeta elegida ya no existe o no es accesible.".to_owned());
    }
    let files = collect_media_files(&source_root)?;
    let workspace = ensure_project_workspace(&app, project_number, &project_name)?;
    let destination_root = PathBuf::from(&workspace.root_path);
    fs::create_dir_all(&destination_root).map_err(|error| {
        format!(
            "No se pudo preparar {}: {error}",
            destination_root.display()
        )
    })?;

    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No se encontró la carpeta de datos: {error}"))?
        .join("framesync.db");
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;
    let project_exists =
        sqlx::query_scalar::<_, i64>("SELECT 1 FROM projects WHERE id = ? LIMIT 1")
            .bind(&project_id)
            .fetch_optional(&mut connection)
            .await
            .map_err(database_error)?;
    if project_exists.is_none() {
        return Err("El proyecto de destino ya no existe.".to_owned());
    }

    let mut result = MediaFolderImportResult {
        discovered: files.len(),
        imported: 0,
        duplicates: 0,
        assigned: 0,
        unassigned: 0,
        images: 0,
        videos: 0,
        warnings: Vec::new(),
    };
    let mut transaction = connection.begin().await.map_err(database_error)?;
    for source_path in files {
        let Some((kind, mime_type)) = media_kind_and_mime(&source_path) else {
            continue;
        };
        if kind == "video" {
            result.videos += 1;
        } else {
            result.images += 1;
        }
        let sha256 = file_sha256(&source_path)?;
        let original_filename = source_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let role = media_role(&source_path, kind);
        let shot_code = shot_code_from_filename(&source_path);
        let shot = if let Some(code) = &shot_code {
            sqlx::query(
                "SELECT id, code, title FROM shots WHERE project_id = ? AND code = ? LIMIT 1",
            )
            .bind(&project_id)
            .bind(code)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(database_error)?
        } else {
            None
        };
        let safe_filename = original_filename
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let role_root = if let Some(shot) = &shot {
            let code = shot.try_get::<String, _>("code").map_err(database_error)?;
            let title = shot.try_get::<String, _>("title").map_err(database_error)?;
            let shot_workspace = ensure_shot_workspace(&workspace, &code, &title)?;
            if role == "video_final" {
                PathBuf::from(shot_workspace.video_path)
            } else {
                PathBuf::from(shot_workspace.root_path)
            }
        } else {
            PathBuf::from(&workspace.unassigned_path)
        };
        fs::create_dir_all(&role_root)
            .map_err(|error| format!("No se pudo preparar {}: {error}", role_root.display()))?;
        let destination_path = if source_path
            .parent()
            .is_some_and(|parent| parent == role_root)
        {
            source_path.clone()
        } else {
            role_root.join(safe_filename)
        };
        let existing_asset =
            sqlx::query_scalar::<_, String>("SELECT id FROM assets WHERE sha256 = ? LIMIT 1")
                .bind(&sha256)
                .fetch_optional(&mut *transaction)
                .await
                .map_err(database_error)?;
        let asset_id = if let Some(asset_id) = existing_asset {
            result.duplicates += 1;
            if shot.is_some() {
                if source_path != destination_path && !destination_path.exists() {
                    fs::copy(&source_path, &destination_path).map_err(|error| {
                        format!(
                            "No se pudo ordenar {} dentro de su plano: {error}",
                            source_path.display()
                        )
                    })?;
                }
                sqlx::query(
                    "UPDATE assets
                        SET stored_path = ?, local_path = ?, related_shot_code = ?
                      WHERE id = ? AND project_id = ?",
                )
                .bind(destination_path.to_string_lossy().to_string())
                .bind(destination_path.to_string_lossy().to_string())
                .bind(&shot_code)
                .bind(&asset_id)
                .bind(&project_id)
                .execute(&mut *transaction)
                .await
                .map_err(database_error)?;
            }
            asset_id
        } else {
            if source_path != destination_path {
                fs::copy(&source_path, &destination_path).map_err(|error| {
                    format!(
                        "No se pudo copiar {} a Storyboard Wana: {error}",
                        source_path.display()
                    )
                })?;
            }
            let asset_id = format!("local-{}", &sha256[..24]);
            let byte_size = fs::metadata(&destination_path)
                .map_err(|error| format!("No se pudo medir el archivo copiado: {error}"))?
                .len() as i64;
            sqlx::query(
                "INSERT INTO assets (
                   id, project_id, capture_source_id, kind, role,
                   original_filename, stored_path, local_path,
                   related_shot_code, source_url, mime_type, byte_size,
                   width, height, duration_ms, sha256, quality_source, created_at
                 ) VALUES (
                   ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?,
                   NULL, NULL, NULL, ?, 'local_file',
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 )",
            )
            .bind(&asset_id)
            .bind(&project_id)
            .bind(kind)
            .bind(role)
            .bind(&original_filename)
            .bind(destination_path.to_string_lossy().to_string())
            .bind(destination_path.to_string_lossy().to_string())
            .bind(&shot_code)
            .bind(mime_type)
            .bind(byte_size)
            .bind(&sha256)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
            result.imported += 1;
            asset_id
        };

        let shot_id = shot
            .as_ref()
            .map(|row| row.try_get::<String, _>("id"))
            .transpose()
            .map_err(database_error)?;
        if let Some(shot_id) = shot_id {
            let is_detached = sqlx::query_scalar::<_, i64>(
                "SELECT 1 FROM detached_shot_assets
                  WHERE shot_id = ? AND asset_id = ? AND role = ? LIMIT 1",
            )
            .bind(&shot_id)
            .bind(&asset_id)
            .bind(role)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(database_error)?
            .is_some();
            if is_detached {
                continue;
            }
            let next_order = sqlx::query_scalar::<_, i64>(
                "SELECT COALESCE(MAX(order_index), -1) + 1
                   FROM shot_assets
                  WHERE shot_id = ? AND role = ?",
            )
            .bind(&shot_id)
            .bind(role)
            .fetch_one(&mut *transaction)
            .await
            .map_err(database_error)?;
            let inserted = sqlx::query(
                "INSERT OR IGNORE INTO shot_assets
                   (shot_id, asset_id, role, order_index)
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&shot_id)
            .bind(&asset_id)
            .bind(role)
            .bind(next_order)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?
            .rows_affected();
            if inserted > 0 {
                result.assigned += 1;
            }
        } else {
            result.unassigned += 1;
            if let Some(code) = shot_code {
                result.warnings.push(format!(
                    "{original_filename}: no existe el plano {code} en el proyecto."
                ));
            } else {
                result.warnings.push(format!(
                    "{original_filename}: el nombre no contiene un código como P001."
                ));
            }
        }
    }
    sqlx::query(
        "UPDATE shots
         SET status = CASE
           WHEN EXISTS (
             SELECT 1 FROM shot_assets link
              WHERE link.shot_id = shots.id AND link.role = 'video_final'
           ) THEN 'video'
           WHEN EXISTS (
             SELECT 1 FROM shot_assets link
              WHERE link.shot_id = shots.id AND link.role = 'first_frame'
           ) THEN 'first_frame'
           ELSE status
         END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE project_id = ?",
    )
    .bind(&project_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        "UPDATE projects
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?",
    )
    .bind(&project_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    let _ = refresh_workspace_context(app).await?;
    Ok(result)
}

#[tauri::command]
async fn prepare_project_shot_workspaces(
    app: AppHandle,
    project_id: String,
    project_number: i64,
    project_name: String,
) -> Result<(), String> {
    let workspace = ensure_project_workspace(&app, project_number, &project_name)?;
    ensure_project_shot_workspaces(&app, &project_id, &workspace).await
}

#[tauri::command]
async fn sync_project_workspace(
    app: AppHandle,
    project_id: String,
    project_number: i64,
    project_name: String,
) -> Result<MediaFolderImportResult, String> {
    let workspace = ensure_project_workspace(&app, project_number, &project_name)?;
    ensure_project_shot_workspaces(&app, &project_id, &workspace).await?;
    migrate_project_assets(&app, &project_id, &workspace).await?;
    import_media_folder(
        app,
        project_id,
        project_number,
        project_name,
        workspace.root_path,
    )
    .await
}

async fn ensure_project_shot_workspaces(
    app: &AppHandle,
    project_id: &str,
    workspace: &ProjectWorkspaceResult,
) -> Result<(), String> {
    validate_id(project_id)?;
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No se encontro la base local: {error}"))?
        .join("framesync.db");
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;
    let rows =
        sqlx::query("SELECT code, title FROM shots WHERE project_id = ? ORDER BY order_index")
            .bind(project_id)
            .fetch_all(&mut connection)
            .await
            .map_err(database_error)?;
    for row in rows {
        let code = row.try_get::<String, _>("code").map_err(database_error)?;
        let title = row.try_get::<String, _>("title").map_err(database_error)?;
        ensure_shot_workspace(workspace, &code, &title)?;
    }
    Ok(())
}

async fn migrate_project_assets(
    app: &AppHandle,
    project_id: &str,
    workspace: &ProjectWorkspaceResult,
) -> Result<(), String> {
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No se encontro la base local: {error}"))?
        .join("framesync.db");
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;
    let rows = sqlx::query(
        "SELECT asset.id, asset.local_path, asset.kind, asset.role AS asset_role,
                asset.original_filename, asset.sha256,
                link.role AS link_role, link.order_index,
                COALESCE(shot.code, related_shot.code) AS shot_code,
                COALESCE(shot.title, related_shot.title) AS shot_title
         FROM assets asset
         LEFT JOIN shot_assets link ON link.asset_id = asset.id
         LEFT JOIN shots shot ON shot.id = link.shot_id
         LEFT JOIN shots related_shot
           ON related_shot.project_id = asset.project_id
          AND related_shot.code = asset.related_shot_code
         WHERE asset.project_id = ? AND asset.local_path IS NOT NULL",
    )
    .bind(project_id)
    .fetch_all(&mut connection)
    .await
    .map_err(database_error)?;
    for row in rows {
        let asset_id = row.try_get::<String, _>("id").map_err(database_error)?;
        let local_path = row
            .try_get::<String, _>("local_path")
            .map_err(database_error)?;
        let source = PathBuf::from(&local_path);
        if !source.is_file() {
            continue;
        }
        let role = row
            .try_get::<Option<String>, _>("link_role")
            .map_err(database_error)?
            .unwrap_or(
                row.try_get::<String, _>("asset_role")
                    .map_err(database_error)?,
            );
        let kind = row.try_get::<String, _>("kind").map_err(database_error)?;
        let shot_code = row
            .try_get::<Option<String>, _>("shot_code")
            .map_err(database_error)?;
        let shot_title = row
            .try_get::<Option<String>, _>("shot_title")
            .map_err(database_error)?;
        let order = row
            .try_get::<Option<i64>, _>("order_index")
            .map_err(database_error)?
            .unwrap_or(0);
        let original = row
            .try_get::<Option<String>, _>("original_filename")
            .map_err(database_error)?
            .unwrap_or_else(|| "archivo.bin".to_owned());
        let extension = source
            .extension()
            .or_else(|| Path::new(&original).extension())
            .and_then(|value| value.to_str())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let sha256 = row.try_get::<String, _>("sha256").map_err(database_error)?;
        let shot_workspace = match (shot_code.as_deref(), shot_title.as_deref()) {
            (Some(code), Some(title)) => Some(ensure_shot_workspace(workspace, code, title)?),
            _ => None,
        };
        let (directory, filename) = if kind == "document" {
            (PathBuf::from(&workspace.sources_path), original.clone())
        } else {
            match (role.as_str(), shot_code.as_deref(), shot_workspace.as_ref()) {
                ("storyboard", Some(code), Some(shot_workspace)) => (
                    PathBuf::from(&shot_workspace.storyboard_path),
                    format!("{code}_storyboard_{:02}.{extension}", order + 1),
                ),
                ("first_frame", Some(code), Some(shot_workspace)) => (
                    PathBuf::from(&shot_workspace.first_frame_path),
                    format!("{code}_primer_frame.{extension}"),
                ),
                ("video_final", Some(code), Some(shot_workspace)) => (
                    PathBuf::from(&shot_workspace.video_path),
                    format!("{code}_video_v{:02}.{extension}", order + 1),
                ),
                _ => (
                    PathBuf::from(&workspace.unassigned_path),
                    format!("{}_{}", &sha256[..12], safe_folder_component(&original)),
                ),
            }
        };
        let destination = directory.join(filename);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("No se pudo preparar {}: {error}", directory.display()))?;
        if source != destination && !destination.exists() {
            fs::copy(&source, &destination)
                .map_err(|error| format!("No se pudo migrar {}: {error}", source.display()))?;
        }
        sqlx::query("UPDATE assets SET stored_path = ?, local_path = ? WHERE id = ?")
            .bind(destination.to_string_lossy().to_string())
            .bind(destination.to_string_lossy().to_string())
            .bind(asset_id)
            .execute(&mut connection)
            .await
            .map_err(database_error)?;
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn import_shot_media(
    app: AppHandle,
    project_id: String,
    project_number: i64,
    project_name: String,
    shot_id: String,
    file_paths: Vec<String>,
    role: String,
    replace_existing: bool,
) -> Result<ShotMediaImportResult, String> {
    validate_id(&project_id)?;
    validate_id(&shot_id)?;
    if !matches!(role.as_str(), "storyboard" | "first_frame" | "video_final") {
        return Err("El tipo de imagen no es compatible.".to_owned());
    }
    if file_paths.is_empty() {
        return Ok(ShotMediaImportResult {
            imported: 0,
            duplicates: 0,
            assigned: 0,
        });
    }
    let workspace = ensure_project_workspace(&app, project_number, &project_name)?;
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No se encontro la base local: {error}"))?
        .join("framesync.db");
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;
    let shot = sqlx::query("SELECT code, title FROM shots WHERE id = ? AND project_id = ? LIMIT 1")
        .bind(&shot_id)
        .bind(&project_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(database_error)?;
    let Some(shot) = shot else {
        return Err("El plano ya no existe en este proyecto.".to_owned());
    };
    let shot_code = shot.try_get::<String, _>("code").map_err(database_error)?;
    let shot_title = shot.try_get::<String, _>("title").map_err(database_error)?;
    let shot_workspace = ensure_shot_workspace(&workspace, &shot_code, &shot_title)?;
    let destination_root = match role.as_str() {
        "video_final" => PathBuf::from(&shot_workspace.video_path),
        _ => PathBuf::from(&shot_workspace.root_path),
    };
    fs::create_dir_all(&destination_root).map_err(|error| {
        format!(
            "No se pudo preparar {}: {error}",
            destination_root.display()
        )
    })?;
    let mut transaction = connection.begin().await.map_err(database_error)?;
    if replace_existing {
        sqlx::query(
            "INSERT OR IGNORE INTO detached_shot_assets (shot_id, asset_id, role)
             SELECT shot_id, asset_id, role FROM shot_assets
              WHERE shot_id = ? AND role = ?",
        )
        .bind(&shot_id)
        .bind(&role)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query("DELETE FROM shot_assets WHERE shot_id = ? AND role = ?")
            .bind(&shot_id)
            .bind(&role)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
    }
    let mut result = ShotMediaImportResult {
        imported: 0,
        duplicates: 0,
        assigned: 0,
    };
    for file_path in file_paths {
        let source_path = PathBuf::from(&file_path);
        let Some((kind, mime_type)) = media_kind_and_mime(&source_path) else {
            return Err(format!(
                "{} no es una imagen compatible.",
                source_path.display()
            ));
        };
        if role == "video_final" && kind != "video" {
            return Err("La casilla de video solo acepta archivos de video.".to_owned());
        }
        if role != "video_final" && kind != "image" {
            return Err("Storyboard y primer frame solo aceptan imagenes.".to_owned());
        }
        let sha256 = file_sha256(&source_path)?;
        let original_filename = source_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let next_order = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(order_index), -1) + 1 FROM shot_assets WHERE shot_id = ? AND role = ?",
        )
        .bind(&shot_id)
        .bind(&role)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database_error)?;
        let extension = source_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let destination_path = destination_root.join(match role.as_str() {
            "storyboard" => format!("{shot_code}_storyboard_{:02}.{extension}", next_order + 1),
            "video_final" => format!("{shot_code}_video_v{:02}.{extension}", next_order + 1),
            _ => format!("{shot_code}_primer_frame.{extension}"),
        });
        if destination_path.is_file() && source_path != destination_path {
            let destination_hash = file_sha256(&destination_path)?;
            if destination_hash != sha256 && !replace_existing {
                return Err(format!(
                    "{} ya tiene un archivo distinto. Revisalo antes de reemplazarlo.",
                    shot_code
                ));
            }
        }
        let existing_asset =
            sqlx::query_scalar::<_, String>("SELECT id FROM assets WHERE sha256 = ? LIMIT 1")
                .bind(&sha256)
                .fetch_optional(&mut *transaction)
                .await
                .map_err(database_error)?;
        let asset_id = if let Some(asset_id) = existing_asset {
            result.duplicates += 1;
            asset_id
        } else {
            if source_path != destination_path {
                fs::copy(&source_path, &destination_path).map_err(|error| {
                    format!(
                        "No se pudo copiar {} a Storyboard Wana: {error}",
                        source_path.display()
                    )
                })?;
                if file_sha256(&destination_path)? != sha256 {
                    let _ = fs::remove_file(&destination_path);
                    return Err(format!(
                        "La copia de {} no coincide byte por byte con el original.",
                        original_filename
                    ));
                }
            }
            let asset_id = format!("local-{}", &sha256[..24]);
            let byte_size = fs::metadata(&destination_path)
                .map_err(|error| format!("No se pudo medir la imagen: {error}"))?
                .len() as i64;
            sqlx::query(
                "INSERT INTO assets (
                   id, project_id, capture_source_id, kind, role,
                   original_filename, stored_path, local_path,
                   related_shot_code, source_url, mime_type, byte_size,
                   width, height, duration_ms, sha256, quality_source, created_at
                 ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?,
                   NULL, NULL, NULL, ?, 'local_file', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            )
            .bind(&asset_id)
            .bind(&project_id)
            .bind(kind)
            .bind(&role)
            .bind(&original_filename)
            .bind(destination_path.to_string_lossy().to_string())
            .bind(destination_path.to_string_lossy().to_string())
            .bind(&shot_code)
            .bind(mime_type)
            .bind(byte_size)
            .bind(&sha256)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
            result.imported += 1;
            asset_id
        };
        sqlx::query(
            "DELETE FROM detached_shot_assets
              WHERE shot_id = ? AND asset_id = ? AND role = ?",
        )
        .bind(&shot_id)
        .bind(&asset_id)
        .bind(&role)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO shot_assets (shot_id, asset_id, role, order_index) VALUES (?, ?, ?, ?)",
        )
        .bind(&shot_id)
        .bind(&asset_id)
        .bind(&role)
        .bind(next_order)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
        .rows_affected();
        result.assigned += inserted as usize;
    }
    sqlx::query(
        "UPDATE shots SET status = CASE
           WHEN ? = 'video_final' THEN 'video'
           WHEN ? = 'first_frame' THEN 'first_frame'
           WHEN status IN ('empty', 'structured', 'incomplete') THEN 'storyboard'
           ELSE status END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
    .bind(&role)
    .bind(&role)
    .bind(&shot_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    let _ = refresh_workspace_context(app).await?;
    Ok(result)
}

fn inbox_root() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA no está configurado.")?;
    Ok(PathBuf::from(local_app_data)
        .join("FrameSync")
        .join("inbox"))
}

fn local_framesync_root() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA no está configurado.")?;
    Ok(PathBuf::from(local_app_data).join("FrameSync"))
}

fn workspace_context_path() -> Result<PathBuf, String> {
    Ok(local_framesync_root()?.join("workspace-context.json"))
}

#[tauri::command]
async fn refresh_workspace_context(app: AppHandle) -> Result<Value, String> {
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No se encontró la carpeta de datos: {error}"))?
        .join("framesync.db");
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(database_error)?;
    let rows = sqlx::query(
        "SELECT
           project.id,
           project.project_number,
           project.name,
           project.description,
           project.updated_at,
           (SELECT COUNT(*) FROM capture_sources source
             WHERE source.project_id = project.id) AS source_count,
           (SELECT COUNT(*) FROM episodes episode
             WHERE episode.project_id = project.id) AS episode_count,
           (SELECT COUNT(*) FROM scenes scene
             WHERE scene.project_id = project.id) AS scene_count,
           (SELECT COUNT(*) FROM shots shot
             WHERE shot.project_id = project.id
               AND shot.shot_type = 'normal') AS shot_count,
           (SELECT COUNT(*) FROM shots shot
             WHERE shot.project_id = project.id
               AND shot.shot_type = 'special') AS special_shot_count,
           (SELECT COUNT(*)
              FROM analysis_runs run
              JOIN capture_sources source ON source.id = run.capture_source_id
              JOIN json_each(run.proposal_json, '$.shots') item
             WHERE source.project_id = project.id
               AND json_extract(item.value, '$.reviewStatus') <> 'rejected'
               AND run.id = (
                 SELECT latest.id
                   FROM analysis_runs latest
                  WHERE latest.capture_source_id = source.id
                  ORDER BY latest.started_at DESC
                  LIMIT 1
               )) AS detected_shot_count,
           (SELECT COUNT(*)
              FROM analysis_runs run
              JOIN capture_sources source ON source.id = run.capture_source_id
              JOIN json_each(run.proposal_json, '$.shots') item
             WHERE source.project_id = project.id
               AND json_extract(item.value, '$.reviewStatus') <> 'rejected'
               AND run.id = (
                 SELECT latest.id
                   FROM analysis_runs latest
                  WHERE latest.capture_source_id = source.id
                  ORDER BY latest.started_at DESC
                  LIMIT 1
               )
               AND NOT EXISTS (
                 SELECT 1 FROM shot_import_events event
                  WHERE event.project_id = project.id
                    AND event.detected_item_id =
                        json_extract(item.value, '$.id')
               )) AS pending_shot_count,
           (SELECT COUNT(*) FROM assets asset
             WHERE asset.project_id = project.id
               AND asset.kind = 'image') AS image_count,
           (SELECT COUNT(*) FROM assets asset
             WHERE asset.project_id = project.id
               AND asset.kind = 'video') AS video_count,
           (SELECT COUNT(*) FROM assets asset
             WHERE asset.project_id = project.id
               AND asset.kind = 'image'
               AND NOT EXISTS (
                 SELECT 1 FROM shot_assets link WHERE link.asset_id = asset.id
               )) AS unassigned_image_count,
           (SELECT COUNT(*) FROM assets asset
             WHERE asset.project_id = project.id
               AND asset.kind = 'video'
               AND NOT EXISTS (
                 SELECT 1 FROM shot_assets link WHERE link.asset_id = asset.id
               )) AS unassigned_video_count,
           (SELECT COUNT(*) FROM shots shot
             WHERE shot.project_id = project.id
               AND EXISTS (
                 SELECT 1 FROM shot_assets link
                  WHERE link.shot_id = shot.id
                    AND link.role = 'first_frame'
               )) AS shots_with_first_frame_count,
           (SELECT COUNT(*) FROM shots shot
             WHERE shot.project_id = project.id
               AND EXISTS (
                 SELECT 1 FROM shot_assets link
                  WHERE link.shot_id = shot.id
                    AND link.role = 'video_final'
               )) AS shots_with_video_count,
           (SELECT COUNT(*)
              FROM shot_assets link
              JOIN shots shot ON shot.id = link.shot_id
             WHERE shot.project_id = project.id
               AND link.role = 'video_final') AS video_variant_count,
           (SELECT MAX(episode.number) FROM episodes episode
             WHERE episode.project_id = project.id) AS last_episode_number,
           (SELECT MAX(scene.number) FROM scenes scene
             WHERE scene.project_id = project.id) AS last_scene_number,
           (SELECT MAX(shot.global_number) FROM shots shot
             WHERE shot.project_id = project.id
               AND shot.shot_type = 'normal') AS last_shot_number
         FROM projects project
         ORDER BY project.updated_at DESC",
    )
    .fetch_all(&mut connection)
    .await
    .map_err(database_error)?;
    let generated_at =
        sqlx::query_scalar::<_, String>("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
            .fetch_one(&mut connection)
            .await
            .map_err(database_error)?;
    let mut projects = Vec::with_capacity(rows.len());
    for row in rows {
        let last_shot_number = row
            .try_get::<Option<i64>, _>("last_shot_number")
            .map_err(database_error)?
            .unwrap_or(0);
        projects.push(json!({
            "id": row.try_get::<String, _>("id").map_err(database_error)?,
            "projectNumber": row.try_get::<i64, _>("project_number").map_err(database_error)?,
            "name": row.try_get::<String, _>("name").map_err(database_error)?,
            "description": row.try_get::<Option<String>, _>("description").map_err(database_error)?,
            "sourceCount": row.try_get::<i64, _>("source_count").map_err(database_error)?,
            "episodeCount": row.try_get::<i64, _>("episode_count").map_err(database_error)?,
            "sceneCount": row.try_get::<i64, _>("scene_count").map_err(database_error)?,
            "shotCount": row.try_get::<i64, _>("shot_count").map_err(database_error)?,
            "specialShotCount": row.try_get::<i64, _>("special_shot_count").map_err(database_error)?,
            "detectedShotCount": row.try_get::<i64, _>("detected_shot_count").map_err(database_error)?,
            "pendingShotCount": row.try_get::<i64, _>("pending_shot_count").map_err(database_error)?,
            "imageCount": row.try_get::<i64, _>("image_count").map_err(database_error)?,
            "videoCount": row.try_get::<i64, _>("video_count").map_err(database_error)?,
            "unassignedImageCount": row.try_get::<i64, _>("unassigned_image_count").map_err(database_error)?,
            "unassignedVideoCount": row.try_get::<i64, _>("unassigned_video_count").map_err(database_error)?,
            "shotsWithFirstFrameCount": row.try_get::<i64, _>("shots_with_first_frame_count").map_err(database_error)?,
            "shotsWithVideoCount": row.try_get::<i64, _>("shots_with_video_count").map_err(database_error)?,
            "videoVariantCount": row.try_get::<i64, _>("video_variant_count").map_err(database_error)?,
            "lastEpisodeNumber": row.try_get::<Option<i64>, _>("last_episode_number").map_err(database_error)?,
            "lastSceneNumber": row.try_get::<Option<i64>, _>("last_scene_number").map_err(database_error)?,
            "lastShotNumber": last_shot_number,
            "nextShotNumber": last_shot_number + 1,
            "updatedAt": row.try_get::<String, _>("updated_at").map_err(database_error)?,
        }));
    }
    let context = json!({
        "protocolVersion": 1,
        "generatedAt": generated_at,
        "projects": projects,
    });
    write_workspace_context(context.clone())?;
    Ok(context)
}

fn manifest_path() -> Result<PathBuf, String> {
    Ok(local_framesync_root()?
        .join("native-host")
        .join(format!("{NATIVE_HOST_NAME}.json")))
}

#[cfg(debug_assertions)]
fn development_repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .components()
        .collect()
}

fn native_host_source(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let candidate = development_repository_root()
            .join("target")
            .join("debug")
            .join("framesync-native-host.exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    app.path()
        .resolve("framesync-native-host.exe", BaseDirectory::Resource)
        .map_err(|error| format!("No se pudo resolver el host incluido: {error}"))
}

fn extension_source(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let candidate = development_repository_root()
            .join("apps")
            .join("extension")
            .join(".output")
            .join("chrome-mv3");
        if candidate.join("manifest.json").is_file() {
            return Ok(candidate);
        }
    }

    app.path()
        .resolve("extension", BaseDirectory::Resource)
        .map_err(|error| format!("No se pudo resolver la extensión incluida: {error}"))
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("No se pudo crear {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("No se pudo leer {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("Archivo de extensión inaccesible: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "No se pudo copiar {} a {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn installed_extension_path(app: &AppHandle) -> Result<PathBuf, String> {
    let source = extension_source(app)?;
    if cfg!(debug_assertions) {
        return Ok(source);
    }
    let destination = local_framesync_root()?.join("extension").join("current");
    copy_directory(&source, &destination)?;
    Ok(destination)
}

fn installed_host_path(app: &AppHandle) -> Result<PathBuf, String> {
    let source = native_host_source(app)?;
    if cfg!(debug_assertions) {
        return Ok(source);
    }
    let destination_dir = local_framesync_root()?
        .join("native-host")
        .join(app.package_info().version.to_string());
    fs::create_dir_all(&destination_dir).map_err(|error| {
        format!(
            "No se pudo crear el directorio del host {}: {error}",
            destination_dir.display()
        )
    })?;
    let destination = destination_dir.join("framesync-native-host.exe");
    fs::copy(&source, &destination).map_err(|error| {
        format!(
            "No se pudo instalar el host {}: {error}",
            destination.display()
        )
    })?;
    Ok(destination)
}

#[cfg(windows)]
fn register_native_manifest(path: &Path) -> Result<(), String> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for browser_path in [
        r"Software\Microsoft\Edge\NativeMessagingHosts",
        r"Software\Google\Chrome\NativeMessagingHosts",
    ] {
        let (key, _) = hkcu
            .create_subkey(format!(r"{browser_path}\{NATIVE_HOST_NAME}"))
            .map_err(|error| format!("No se pudo abrir el registro HKCU: {error}"))?;
        key.set_value("", &path.display().to_string())
            .map_err(|error| format!("No se pudo registrar el host del navegador: {error}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn register_native_manifest(_path: &Path) -> Result<(), String> {
    Err("La integración con Edge y Chrome sólo está disponible en Windows.".to_owned())
}

#[cfg(windows)]
fn registered_manifest_path(browser_path: &str) -> Option<PathBuf> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(format!(r"{browser_path}\{NATIVE_HOST_NAME}"))
        .ok()?;
    key.get_value::<String, _>("").ok().map(PathBuf::from)
}

#[cfg(not(windows))]
fn registered_manifest_path(_browser_path: &str) -> Option<PathBuf> {
    None
}

fn write_native_manifest(host_path: &Path) -> Result<PathBuf, String> {
    let destination = manifest_path()?;
    let parent = destination
        .parent()
        .ok_or("La ruta del manifest no tiene directorio padre.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("No se pudo crear {}: {error}", parent.display()))?;
    let manifest = serde_json::json!({
        "name": NATIVE_HOST_NAME,
        "description": "FrameSync Capture Native Messaging Host",
        "path": host_path.display().to_string(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")]
    });
    let mut bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("No se pudo serializar el manifest: {error}"))?;
    bytes.push(b'\n');
    fs::write(&destination, bytes)
        .map_err(|error| format!("No se pudo escribir {}: {error}", destination.display()))?;
    Ok(destination)
}

fn integration_status(app: &AppHandle, prepare: bool) -> Result<BrowserIntegrationStatus, String> {
    let extension_path = if prepare {
        installed_extension_path(app).ok()
    } else {
        extension_source(app).ok().and_then(|source| {
            if cfg!(debug_assertions) {
                Some(source)
            } else {
                let installed = local_framesync_root()
                    .ok()?
                    .join("extension")
                    .join("current");
                installed
                    .join("manifest.json")
                    .is_file()
                    .then_some(installed)
            }
        })
    };

    let host_path = if prepare {
        let host = installed_host_path(app)?;
        let manifest = write_native_manifest(&host)?;
        register_native_manifest(&manifest)?;
        Some(host)
    } else {
        registered_manifest_path(r"Software\Microsoft\Edge\NativeMessagingHosts")
            .or_else(|| registered_manifest_path(r"Software\Google\Chrome\NativeMessagingHosts"))
            .filter(|path| path.is_file())
            .and_then(|path| read_json(&path).ok())
            .and_then(|manifest| manifest.get("path")?.as_str().map(PathBuf::from))
    };
    let expected_manifest = manifest_path()?;
    let edge_manifest = registered_manifest_path(r"Software\Microsoft\Edge\NativeMessagingHosts");
    let chrome_manifest = registered_manifest_path(r"Software\Google\Chrome\NativeMessagingHosts");
    let registration_is_valid = |registered: &Option<PathBuf>| {
        registered.as_ref().is_some_and(|path| {
            path == &expected_manifest
                && path.is_file()
                && host_path.as_ref().is_some_and(|host| host.is_file())
        })
    };
    let edge_registered = registration_is_valid(&edge_manifest);
    let chrome_registered = registration_is_valid(&chrome_manifest);

    Ok(BrowserIntegrationStatus {
        mode: if cfg!(debug_assertions) {
            "development"
        } else {
            "installed"
        },
        extension_id: EXTENSION_ID,
        extension_available: extension_path
            .as_ref()
            .is_some_and(|path| path.join("manifest.json").is_file()),
        extension_path: extension_path.map(|path| path.display().to_string()),
        host_available: host_path.as_ref().is_some_and(|path| path.is_file()),
        host_path: host_path.map(|path| path.display().to_string()),
        host_registered: edge_registered || chrome_registered,
        edge_registered,
        chrome_registered,
        manifest_path: expected_manifest.display().to_string(),
    })
}

#[tauri::command]
fn get_browser_integration_status(app: AppHandle) -> Result<BrowserIntegrationStatus, String> {
    integration_status(&app, false)
}

#[tauri::command]
fn prepare_browser_integration(app: AppHandle) -> Result<BrowserIntegrationStatus, String> {
    integration_status(&app, true)
}

#[tauri::command]
fn open_extension_folder(app: AppHandle) -> Result<(), String> {
    let status = integration_status(&app, false)?;
    let path = status
        .extension_path
        .ok_or("La extensión todavía no fue preparada.")?;
    Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|error| format!("No se pudo abrir la carpeta: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_chrome_extensions() -> Result<(), String> {
    let local_app_data = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let program_files = env::var_os("PROGRAMFILES").map(PathBuf::from);
    let program_files_x86 = env::var_os("PROGRAMFILES(X86)").map(PathBuf::from);
    let chrome = [
        local_app_data.map(|path| {
            path.join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe")
        }),
        program_files.map(|path| {
            path.join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe")
        }),
        program_files_x86.map(|path| {
            path.join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe")
        }),
    ]
    .into_iter()
    .flatten()
    .find(|path| path.is_file())
    .ok_or("No se encontró Google Chrome en las rutas habituales.")?;
    Command::new(chrome)
        .arg("chrome://extensions/")
        .spawn()
        .map_err(|error| format!("No se pudo abrir Chrome: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_edge_extensions() -> Result<(), String> {
    let local_app_data = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let program_files = env::var_os("PROGRAMFILES").map(PathBuf::from);
    let program_files_x86 = env::var_os("PROGRAMFILES(X86)").map(PathBuf::from);
    let edge = [
        local_app_data.map(|path| {
            path.join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe")
        }),
        program_files.map(|path| {
            path.join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe")
        }),
        program_files_x86.map(|path| {
            path.join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe")
        }),
    ]
    .into_iter()
    .flatten()
    .find(|path| path.is_file())
    .ok_or("No se encontró Microsoft Edge en las rutas habituales.")?;
    Command::new(edge)
        .arg("edge://extensions/")
        .spawn()
        .map_err(|error| format!("No se pudo abrir Edge: {error}"))?;
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("No se pudo leer {}: {error}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("El paquete contiene JSON inválido: {error}"))
}

fn asset_manifests(capture_dir: &Path) -> Result<Vec<Value>, String> {
    let assets_dir = capture_dir.join("assets");
    if !assets_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut manifests = Vec::new();
    for entry in fs::read_dir(&assets_dir)
        .map_err(|error| format!("No se pudo inspeccionar assets: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Asset inaccesible: {error}"))?;
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".manifest.json"))
        {
            let mut manifest = read_json(&path)?;
            if let Some(object) = manifest.as_object_mut() {
                let asset_id = object
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let stored_path = asset_id.and_then(|id| {
                    fs::read_dir(&assets_dir)
                        .ok()?
                        .filter_map(Result::ok)
                        .find_map(|asset_entry| {
                            let candidate = asset_entry.path();
                            let file_name = candidate.file_name()?.to_str()?;
                            (candidate.is_file()
                                && file_name.starts_with(&format!("{id}."))
                                && !file_name.ends_with(".manifest.json"))
                            .then(|| candidate.display().to_string())
                        })
                });
                object.insert(
                    "localPath".to_owned(),
                    stored_path.map(Value::String).unwrap_or(Value::Null),
                );
            }
            manifests.push(manifest);
        }
    }
    Ok(manifests)
}

#[tauri::command]
fn write_workspace_context(context: Value) -> Result<(), String> {
    let object = context
        .as_object()
        .ok_or("El contexto de proyectos no es un objeto válido.")?;
    if object.get("protocolVersion").and_then(Value::as_u64) != Some(1)
        || !object.get("projects").is_some_and(Value::is_array)
    {
        return Err("El contexto de proyectos no cumple el protocolo FrameSync.".to_owned());
    }
    let path = workspace_context_path()?;
    let parent = path
        .parent()
        .ok_or("La ruta de contexto no tiene directorio padre.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("No se pudo crear {}: {error}", parent.display()))?;
    let mut bytes = serde_json::to_vec_pretty(&context)
        .map_err(|error| format!("No se pudo serializar el contexto: {error}"))?;
    bytes.push(b'\n');
    fs::write(&path, bytes)
        .map_err(|error| format!("No se pudo escribir {}: {error}", path.display()))
}

#[tauri::command]
fn get_spool_path() -> Result<String, String> {
    inbox_root().map(|path| path.display().to_string())
}

#[tauri::command]
fn list_inbox_captures() -> Result<Vec<InboxCaptureSummary>, String> {
    let root = inbox_root()?;
    if !root.exists() {
        fs::create_dir_all(&root)
            .map_err(|error| format!("No se pudo crear la bandeja local: {error}"))?;
    }
    let mut captures = Vec::new();
    for entry in
        fs::read_dir(root).map_err(|error| format!("No se pudo abrir la bandeja: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Entrada inaccesible: {error}"))?;
        let path = entry.path();
        if !path.is_dir() || !path.join("commit.json").is_file() {
            continue;
        }
        let Some(capture_id) = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        validate_id(&capture_id)?;
        let capture = read_json(&path.join("capture.json"))?;
        let messages = capture
            .get("messages")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        captures.push(InboxCaptureSummary {
            capture_id,
            conversation_title: capture
                .get("conversationTitle")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            platform: capture
                .get("platform")
                .and_then(Value::as_str)
                .unwrap_or("generic")
                .to_owned(),
            captured_at: capture
                .get("capturedAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            message_count: messages,
            asset_count: asset_manifests(&path)?.len(),
            processed: path.join("processed.json").is_file(),
        });
    }
    captures.sort_by(|left, right| right.captured_at.cmp(&left.captured_at));
    Ok(captures)
}

#[tauri::command]
fn read_inbox_capture(capture_id: String) -> Result<Value, String> {
    validate_id(&capture_id)?;
    let capture_dir = inbox_root()?.join(&capture_id);
    if !capture_dir.join("commit.json").is_file() {
        return Err("La captura todavía no fue comprometida por completo.".to_owned());
    }
    let mut capture = read_json(&capture_dir.join("capture.json"))?;
    let assets = asset_manifests(&capture_dir)?;
    let object = capture
        .as_object_mut()
        .ok_or("capture.json no contiene un objeto válido.")?;
    object.insert("assets".to_owned(), Value::Array(assets));
    Ok(capture)
}

#[tauri::command]
fn mark_inbox_capture_processed(capture_id: String) -> Result<(), String> {
    validate_id(&capture_id)?;
    let capture_dir = inbox_root()?.join(&capture_id);
    if !capture_dir.join("commit.json").is_file() {
        return Err("No se puede marcar una captura incompleta.".to_owned());
    }
    let temporary = capture_dir.join("processed.tmp");
    let destination = capture_dir.join("processed.json");
    fs::write(
        &temporary,
        b"{\"processed\":true,\"consumer\":\"framesync-desktop\"}\n",
    )
    .map_err(|error| format!("No se pudo escribir el marcador: {error}"))?;
    match fs::rename(&temporary, &destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!("No se pudo confirmar la ingesta: {error}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial_framesync_schema",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "project_episode_global_shot_continuity",
            sql: include_str!("../migrations/0002_project_continuity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "human_readable_project_numbers",
            sql: include_str!("../migrations/0003_project_numbers.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "detached_shot_assets",
            sql: include_str!("../migrations/0004_detached_shot_assets.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "video_technical_details",
            sql: include_str!("../migrations/0005_video_technical_details.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "multimedia_inbox",
            sql: include_str!("../migrations/0006_multimedia_inbox.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:framesync.db", migrations)
                .build(),
        )
        .setup(|app| {
            if let Err(error) = integration_status(app.handle(), true) {
                eprintln!("framesync-desktop: browser integration setup failed: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_spool_path,
            list_inbox_captures,
            read_inbox_capture,
            mark_inbox_capture_processed,
            write_workspace_context,
            refresh_workspace_context,
            prepare_project_workspace,
            prepare_project_shot_workspaces,
            open_project_workspace,
            open_shot_workspace,
            import_source_documents,
            rescan_source_document,
            list_multimedia_inbox,
            stage_multimedia_paths,
            update_multimedia_inbox_assignment,
            remove_multimedia_inbox_item,
            process_multimedia_inbox,
            import_media_folder,
            sync_project_workspace,
            import_shot_media,
            get_browser_integration_status,
            prepare_browser_integration,
            delete_capture_source,
            delete_shot,
            open_extension_folder,
            open_chrome_extensions,
            open_edge_extensions
        ])
        .run(tauri::generate_context!())
        .expect("Storyboard Wana desktop failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn media_names_resolve_to_the_same_shot_across_video_variants() {
        assert_eq!(
            shot_code_from_filename(Path::new("P001_VIDEO_V01.mp4")).as_deref(),
            Some("P001")
        );
        assert_eq!(
            shot_code_from_filename(Path::new("P001_VIDEO_V03.mp4")).as_deref(),
            Some("P001")
        );
        assert_eq!(
            shot_code_from_filename(Path::new("PLANO_27_PRIMER_FRAME.png")).as_deref(),
            Some("P027")
        );
        assert_eq!(shot_code_from_filename(Path::new("resultado.mp4")), None);
        assert_eq!(
            detected_shot_code(Path::new(
                "C:/Produccion/P042 - Llegada/Video/render_final.mp4"
            ))
            .as_deref(),
            Some("P042")
        );
    }

    #[test]
    fn staged_media_names_are_safe_and_bounded() {
        assert_eq!(safe_staged_filename("Plano 01?.png"), "Plano_01_.png");
        let long_name = format!("{}.png", "fotograma ".repeat(30));
        let staged_name = safe_staged_filename(&long_name);
        assert!(staged_name.chars().count() <= 110);
        assert!(staged_name.ends_with(".png"));
    }

    #[test]
    fn multimedia_inbox_migration_enforces_a_valid_review_queue() {
        tauri::async_runtime::block_on(async {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos();
            let database_path = env::temp_dir().join(format!(
                "storyboard-wana-multimedia-inbox-{}-{nonce}.db",
                std::process::id()
            ));
            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true)
                .foreign_keys(true);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("create test database");
            sqlx::raw_sql(
                "CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
                 CREATE TABLE shots (
                   id TEXT PRIMARY KEY NOT NULL,
                   project_id TEXT NOT NULL,
                   code TEXT NOT NULL,
                   title TEXT NOT NULL,
                   FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                 );",
            )
            .execute(&mut connection)
            .await
            .expect("create migration prerequisites");
            sqlx::raw_sql(include_str!("../migrations/0006_multimedia_inbox.sql"))
                .execute(&mut connection)
                .await
                .expect("apply multimedia inbox migration");
            sqlx::raw_sql(
                "INSERT INTO projects (id) VALUES ('project-test');
                 INSERT INTO shots (id, project_id, code, title)
                   VALUES ('shot-test', 'project-test', 'P001', 'Inicio');
                 INSERT INTO multimedia_inbox (
                   id, project_id, original_path, staged_path, original_filename,
                   kind, mime_type, byte_size, sha256, shot_id,
                   detected_shot_code, role, status, detection_note
                 ) VALUES (
                   'inbox-test', 'project-test', 'original.png', 'staged.png',
                   'P001_PRIMER_FRAME.png', 'image', 'image/png', 4, 'hash-test',
                   'shot-test', 'P001', 'first_frame', 'ready', 'Coincidencia segura.'
                 );",
            )
            .execute(&mut connection)
            .await
            .expect("insert a valid inbox item");
            let count = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM multimedia_inbox
                  WHERE project_id = 'project-test' AND status = 'ready'",
            )
            .fetch_one(&mut connection)
            .await
            .expect("read inbox item");
            assert_eq!(count, 1);
            connection.close().await.expect("close test database");

            let _ = fs::remove_file(&database_path);
            let _ = fs::remove_file(database_path.with_extension("db-wal"));
            let _ = fs::remove_file(database_path.with_extension("db-shm"));
        });
    }

    #[test]
    fn media_roles_keep_first_frames_and_videos_separate() {
        assert_eq!(
            media_role(Path::new("P004_PRIMER_FRAME.png"), "image"),
            "first_frame"
        );
        assert_eq!(
            media_role(Path::new("P004_VIDEO_V02.mp4"), "video"),
            "video_final"
        );
        assert_eq!(
            media_role(
                Path::new("C:/Documentos/Storyboard Wana/Proyecto/Storyboards/P004.png"),
                "image"
            ),
            "storyboard"
        );
        assert_eq!(
            media_role(
                Path::new("C:/Documentos/Storyboard Wana/Proyecto/Primeros frames/P004.png"),
                "image"
            ),
            "first_frame"
        );
    }

    #[test]
    fn project_folder_names_are_human_readable_and_safe() {
        assert_eq!(
            safe_folder_component("VIDEO: REMERAS / 2026"),
            "VIDEO_ REMERAS _ 2026"
        );
        assert_eq!(safe_folder_component("   "), "Sin titulo");
    }

    #[test]
    fn shot_workspace_keeps_images_in_the_shot_and_videos_in_their_own_folder() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "storyboard-wana-shot-folder-{}-{nonce}",
            std::process::id()
        ));
        let shots = root.join("Planos");
        let workspace = ProjectWorkspaceResult {
            root_path: root.to_string_lossy().to_string(),
            sources_path: root.join("Fuentes").to_string_lossy().to_string(),
            multimedia_inbox_path: root
                .join("Bandeja multimedia")
                .to_string_lossy()
                .to_string(),
            shots_path: shots.to_string_lossy().to_string(),
            unassigned_path: root.join("Sin asignar").to_string_lossy().to_string(),
            exports_path: root.join("Exportaciones").to_string_lossy().to_string(),
        };

        let shot = ensure_shot_workspace(&workspace, "P001", "La mansion").expect("shot folder");
        let expected_root = shots.join("P001 - La mansion");
        assert_eq!(PathBuf::from(&shot.root_path), expected_root);
        assert_eq!(PathBuf::from(&shot.storyboard_path), expected_root);
        assert_eq!(PathBuf::from(&shot.first_frame_path), expected_root);
        assert_eq!(PathBuf::from(&shot.video_path), expected_root.join("Video"));
        assert!(expected_root.join("Video").is_dir());
        assert!(!expected_root.join("Storyboard").exists());
        assert!(!expected_root.join("Primer frame").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_only_deletion_commits_on_one_native_connection() {
        tauri::async_runtime::block_on(async {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos();
            let database_path = env::temp_dir().join(format!(
                "framesync-delete-source-{}-{nonce}.db",
                std::process::id()
            ));
            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true)
                .foreign_keys(true);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("create test database");
            sqlx::raw_sql(
                "CREATE TABLE projects (
                   id TEXT PRIMARY KEY NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE capture_sources (
                   id TEXT PRIMARY KEY NOT NULL,
                   project_id TEXT,
                   FOREIGN KEY (project_id) REFERENCES projects(id)
                 );
                 CREATE TABLE capture_messages (
                   id TEXT PRIMARY KEY NOT NULL,
                   capture_source_id TEXT NOT NULL,
                   FOREIGN KEY (capture_source_id)
                     REFERENCES capture_sources(id) ON DELETE CASCADE
                 );
                 INSERT INTO projects (id, updated_at)
                   VALUES ('project-test', 'before');
                 INSERT INTO capture_sources (id, project_id)
                   VALUES ('capture-test', 'project-test');
                 INSERT INTO capture_messages (id, capture_source_id)
                   VALUES ('message-test', 'capture-test');",
            )
            .execute(&mut connection)
            .await
            .expect("seed test database");
            connection.close().await.expect("close seed connection");

            delete_capture_source_in_database(
                database_path.clone(),
                "project-test".to_owned(),
                "capture-test".to_owned(),
                false,
            )
            .await
            .expect("delete source transaction");

            let mut verification = SqliteConnection::connect_with(&options)
                .await
                .expect("reopen test database");
            let source_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM capture_sources")
                .fetch_one(&mut verification)
                .await
                .expect("count sources");
            let message_count =
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM capture_messages")
                    .fetch_one(&mut verification)
                    .await
                    .expect("count messages");
            assert_eq!(source_count, 0);
            assert_eq!(message_count, 0);
            verification.close().await.expect("close test database");

            let _ = fs::remove_file(&database_path);
            let _ = fs::remove_file(database_path.with_extension("db-wal"));
            let _ = fs::remove_file(database_path.with_extension("db-shm"));
        });
    }

    #[test]
    fn deleting_a_middle_shot_keeps_global_numbers_consecutive() {
        tauri::async_runtime::block_on(async {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos();
            let database_path = env::temp_dir().join(format!(
                "framesync-delete-shot-{}-{nonce}.db",
                std::process::id()
            ));
            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true)
                .foreign_keys(true);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("create test database");
            sqlx::raw_sql(
                "CREATE TABLE projects (
                   id TEXT PRIMARY KEY NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE shots (
                   id TEXT PRIMARY KEY NOT NULL,
                   project_id TEXT NOT NULL,
                   shot_type TEXT NOT NULL,
                   global_number INTEGER,
                   code TEXT,
                   variant_of_shot_id TEXT,
                   order_index INTEGER NOT NULL,
                   updated_at TEXT NOT NULL,
                   FOREIGN KEY (project_id) REFERENCES projects(id),
                   FOREIGN KEY (variant_of_shot_id)
                     REFERENCES shots(id) ON DELETE SET NULL
                 );
                 CREATE UNIQUE INDEX unique_normal_number
                   ON shots(project_id, global_number)
                   WHERE shot_type = 'normal' AND global_number IS NOT NULL;
                 CREATE TABLE assets (
                   id TEXT PRIMARY KEY NOT NULL,
                   project_id TEXT,
                   related_shot_code TEXT
                 );
                 INSERT INTO projects (id, updated_at)
                   VALUES ('project-test', 'before');
                 INSERT INTO shots (
                   id, project_id, shot_type, global_number, code,
                   variant_of_shot_id, order_index, updated_at
                 ) VALUES
                   ('shot-1', 'project-test', 'normal', 1, 'P001', NULL, 0, 'before'),
                   ('shot-2', 'project-test', 'normal', 2, 'P002', NULL, 1, 'before'),
                   ('shot-3', 'project-test', 'normal', 3, 'P003', NULL, 2, 'before'),
                   ('variant-3', 'project-test', 'variant', NULL, 'P003-V001', 'shot-3', 3, 'before');
                 INSERT INTO assets (id, project_id, related_shot_code)
                   VALUES ('asset-3', 'project-test', 'P003');",
            )
            .execute(&mut connection)
            .await
            .expect("seed test database");
            connection.close().await.expect("close seed connection");

            delete_shot_in_database(
                database_path.clone(),
                "project-test".to_owned(),
                "shot-2".to_owned(),
            )
            .await
            .expect("delete and renumber shot");

            let mut verification = SqliteConnection::connect_with(&options)
                .await
                .expect("reopen test database");
            let shots = sqlx::query(
                "SELECT id, global_number, code
                 FROM shots
                 ORDER BY CASE WHEN global_number IS NULL THEN 1 ELSE 0 END,
                          global_number, code",
            )
            .fetch_all(&mut verification)
            .await
            .expect("read renumbered shots");
            assert_eq!(shots.len(), 3);
            assert_eq!(
                shots[1].try_get::<Option<i64>, _>("global_number").unwrap(),
                Some(2)
            );
            assert_eq!(shots[1].try_get::<String, _>("code").unwrap(), "P002");
            assert_eq!(shots[2].try_get::<String, _>("code").unwrap(), "P002-V001");
            let related_code =
                sqlx::query_scalar::<_, String>("SELECT related_shot_code FROM assets")
                    .fetch_one(&mut verification)
                    .await
                    .expect("read related shot code");
            assert_eq!(related_code, "P002");
            verification.close().await.expect("close test database");

            let _ = fs::remove_file(&database_path);
            let _ = fs::remove_file(database_path.with_extension("db-wal"));
            let _ = fs::remove_file(database_path.with_extension("db-shm"));
        });
    }
}
