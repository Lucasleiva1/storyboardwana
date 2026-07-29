use serde::Serialize;
use serde_json::Value;
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::Command,
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
    for entry in fs::read_dir(assets_dir)
        .map_err(|error| format!("No se pudo inspeccionar assets: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Asset inaccesible: {error}"))?;
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".manifest.json"))
        {
            manifests.push(read_json(&path)?);
        }
    }
    Ok(manifests)
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
    let migrations = vec![Migration {
        version: 1,
        description: "initial_framesync_schema",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
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
            get_browser_integration_status,
            prepare_browser_integration,
            open_extension_folder,
            open_chrome_extensions,
            open_edge_extensions
        ])
        .run(tauri::generate_context!())
        .expect("FrameSync desktop failed to start");
}
