use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const PROTOCOL_VERSION: u8 = 1;
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 250 * 1024 * 1024;
const HOST_NAME: &str = "com.framesync.capture";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureMessage {
    id: String,
    order_index: u32,
    role: CaptureRole,
    text: String,
    html_snapshot: Option<String>,
    message_fingerprint: String,
    source_dom_id: Option<String>,
    created_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum CaptureRole {
    User,
    Assistant,
    Unknown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureDiagnostics {
    adapter_id: String,
    detected_message_count: u32,
    skipped_node_count: u32,
    warnings: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureEnvelopeWithoutAssets {
    protocol_version: u8,
    capture_id: String,
    platform: String,
    source_url: String,
    conversation_title: Option<String>,
    capture_mode: String,
    captured_at: String,
    destination_project_id: Option<String>,
    destination_project_name: Option<String>,
    messages: Vec<CaptureMessage>,
    diagnostics: CaptureDiagnostics,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetManifest {
    id: String,
    message_fingerprint: Option<String>,
    kind: String,
    role: String,
    original_filename: Option<String>,
    source_url: Option<String>,
    mime_type: String,
    byte_size: u64,
    width: Option<u32>,
    height: Option<u32>,
    duration_ms: Option<u64>,
    related_shot_code: Option<String>,
    local_path: Option<String>,
    sha256: String,
    quality_source: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum NativeRequest {
    #[serde(rename = "ping", rename_all = "camelCase")]
    Ping {
        protocol_version: u8,
        request_id: String,
    },
    #[serde(rename = "capture.begin", rename_all = "camelCase")]
    CaptureBegin {
        protocol_version: u8,
        request_id: String,
        capture: CaptureEnvelopeWithoutAssets,
    },
    #[serde(rename = "asset.begin", rename_all = "camelCase")]
    AssetBegin {
        protocol_version: u8,
        request_id: String,
        capture_id: String,
        asset: AssetManifest,
    },
    #[serde(rename = "asset.chunk", rename_all = "camelCase")]
    AssetChunk {
        protocol_version: u8,
        request_id: String,
        capture_id: String,
        asset_id: String,
        index: u32,
        data_base64: String,
    },
    #[serde(rename = "asset.end", rename_all = "camelCase")]
    AssetEnd {
        protocol_version: u8,
        request_id: String,
        capture_id: String,
        asset_id: String,
        sha256: String,
    },
    #[serde(rename = "capture.commit", rename_all = "camelCase")]
    CaptureCommit {
        protocol_version: u8,
        request_id: String,
        capture_id: String,
    },
    #[serde(rename = "workspace.list", rename_all = "camelCase")]
    WorkspaceList {
        protocol_version: u8,
        request_id: String,
    },
}

impl NativeRequest {
    fn protocol_version(&self) -> u8 {
        match self {
            Self::Ping {
                protocol_version, ..
            }
            | Self::CaptureBegin {
                protocol_version, ..
            }
            | Self::AssetBegin {
                protocol_version, ..
            }
            | Self::AssetChunk {
                protocol_version, ..
            }
            | Self::AssetEnd {
                protocol_version, ..
            }
            | Self::CaptureCommit {
                protocol_version, ..
            }
            | Self::WorkspaceList {
                protocol_version, ..
            } => *protocol_version,
        }
    }

    fn request_id(&self) -> &str {
        match self {
            Self::Ping { request_id, .. }
            | Self::CaptureBegin { request_id, .. }
            | Self::AssetBegin { request_id, .. }
            | Self::AssetChunk { request_id, .. }
            | Self::AssetEnd { request_id, .. }
            | Self::CaptureCommit { request_id, .. } => request_id,
            Self::WorkspaceList { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeResponse {
    protocol_version: u8,
    request_id: String,
    ok: bool,
    code: ResponseCode,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ResponseCode {
    Ok,
    InvalidPayload,
    UnsupportedProtocol,
    AssetHashMismatch,
    WriteFailed,
    HostNotConfigured,
    InternalError,
}

impl NativeResponse {
    fn ok(request_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: true,
            code: ResponseCode::Ok,
            message: message.into(),
            data: None,
        }
    }

    fn ok_with_data(
        request_id: impl Into<String>,
        message: impl Into<String>,
        data: Value,
    ) -> Self {
        let mut response = Self::ok(request_id, message);
        response.data = Some(data);
        response
    }

    fn error(
        request_id: impl Into<String>,
        code: ResponseCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: false,
            code,
            message: message.into(),
            data: None,
        }
    }
}

#[derive(Debug)]
struct PendingAsset {
    manifest: AssetManifest,
    path: PathBuf,
    next_index: u32,
    bytes_written: u64,
}

struct HostState {
    inbox_root: PathBuf,
    assets: HashMap<String, PendingAsset>,
}

impl HostState {
    fn new(inbox_root: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&inbox_root)?;
        Ok(Self {
            inbox_root,
            assets: HashMap::new(),
        })
    }

    fn handle(&mut self, request: NativeRequest) -> NativeResponse {
        let request_id = request.request_id().to_owned();
        if request.protocol_version() != PROTOCOL_VERSION {
            return NativeResponse::error(
                request_id,
                ResponseCode::UnsupportedProtocol,
                format!("FrameSync protocol {PROTOCOL_VERSION} is required."),
            );
        }

        let result = match request {
            NativeRequest::Ping { request_id, .. } => Ok(NativeResponse::ok_with_data(
                request_id,
                "FrameSync native host is ready.",
                json!({
                    "host": HOST_NAME,
                    "protocolVersion": PROTOCOL_VERSION,
                    "spoolRoot": self.inbox_root,
                }),
            )),
            NativeRequest::CaptureBegin {
                request_id,
                capture,
                ..
            } => self.capture_begin(request_id, capture),
            NativeRequest::AssetBegin {
                request_id,
                capture_id,
                asset,
                ..
            } => self.asset_begin(request_id, &capture_id, asset),
            NativeRequest::AssetChunk {
                request_id,
                capture_id,
                asset_id,
                index,
                data_base64,
                ..
            } => self.asset_chunk(request_id, &capture_id, &asset_id, index, &data_base64),
            NativeRequest::AssetEnd {
                request_id,
                capture_id,
                asset_id,
                sha256,
                ..
            } => self.asset_end(request_id, &capture_id, &asset_id, &sha256),
            NativeRequest::CaptureCommit {
                request_id,
                capture_id,
                ..
            } => self.capture_commit(request_id, &capture_id),
            NativeRequest::WorkspaceList { request_id, .. } => self.workspace_list(request_id),
        };

        result.unwrap_or_else(|error| {
            eprintln!("framesync-native-host: request failed: {error}");
            let code = if error.kind() == io::ErrorKind::InvalidData {
                ResponseCode::InternalError
            } else {
                ResponseCode::WriteFailed
            };
            NativeResponse::error(
                request_id,
                code,
                "FrameSync could not store the capture. Check LocalAppData access.",
            )
        })
    }

    fn workspace_list(&self, request_id: String) -> io::Result<NativeResponse> {
        let path = self
            .inbox_root
            .parent()
            .ok_or_else(|| io::Error::other("FrameSync root is unavailable."))?
            .join("workspace-context.json");
        if !path.is_file() {
            return Ok(NativeResponse::ok_with_data(
                request_id,
                "No FrameSync projects are published yet.",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "generatedAt": "",
                    "projects": [],
                }),
            ));
        }
        let bytes = fs::read(path)?;
        let context: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        Ok(NativeResponse::ok_with_data(
            request_id,
            "FrameSync project context loaded.",
            context,
        ))
    }

    fn capture_begin(
        &mut self,
        request_id: String,
        capture: CaptureEnvelopeWithoutAssets,
    ) -> io::Result<NativeResponse> {
        validate_capture(&capture).map_err(io::Error::other)?;
        let partial_dir = self.partial_dir(&capture.capture_id)?;
        let final_dir = self.final_dir(&capture.capture_id)?;

        if final_dir.exists() {
            return Ok(NativeResponse::ok_with_data(
                request_id,
                "Capture already exists; original was preserved.",
                json!({ "duplicate": true, "captureId": capture.capture_id }),
            ));
        }

        fs::create_dir_all(partial_dir.join("assets"))?;
        atomic_write_json(&partial_dir.join("capture.json"), &capture)?;
        Ok(NativeResponse::ok_with_data(
            request_id,
            "Capture header accepted.",
            json!({ "captureId": capture.capture_id }),
        ))
    }

    fn asset_begin(
        &mut self,
        request_id: String,
        capture_id: &str,
        asset: AssetManifest,
    ) -> io::Result<NativeResponse> {
        validate_id(capture_id).map_err(io::Error::other)?;
        validate_asset(&asset).map_err(io::Error::other)?;
        let partial_dir = self.partial_dir(capture_id)?;
        if !partial_dir.join("capture.json").is_file() {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::InvalidPayload,
                "capture.begin must be acknowledged before assets.",
            ));
        }

        let key = asset_key(capture_id, &asset.id);
        if self.assets.contains_key(&key) {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::InvalidPayload,
                "Asset transfer is already active.",
            ));
        }

        let path = partial_dir
            .join("assets")
            .join(format!("{}.part", asset.id));
        File::create(&path)?;
        atomic_write_json(
            &partial_dir
                .join("assets")
                .join(format!("{}.manifest.json", asset.id)),
            &asset,
        )?;
        self.assets.insert(
            key,
            PendingAsset {
                manifest: asset,
                path,
                next_index: 0,
                bytes_written: 0,
            },
        );

        Ok(NativeResponse::ok(
            request_id,
            "Asset transfer initialized.",
        ))
    }

    fn asset_chunk(
        &mut self,
        request_id: String,
        capture_id: &str,
        asset_id: &str,
        index: u32,
        data_base64: &str,
    ) -> io::Result<NativeResponse> {
        validate_id(capture_id).map_err(io::Error::other)?;
        validate_id(asset_id).map_err(io::Error::other)?;
        let key = asset_key(capture_id, asset_id);
        let Some(pending) = self.assets.get_mut(&key) else {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::InvalidPayload,
                "asset.begin is missing for this asset.",
            ));
        };
        if index != pending.next_index {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::InvalidPayload,
                format!(
                    "Unexpected asset chunk index. Expected {}.",
                    pending.next_index
                ),
            ));
        }

        let bytes = BASE64.decode(data_base64).map_err(io::Error::other)?;
        let new_size = pending.bytes_written + bytes.len() as u64;
        if new_size > pending.manifest.byte_size || new_size > MAX_ASSET_BYTES {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::InvalidPayload,
                "Asset exceeds its declared or configured size limit.",
            ));
        }

        OpenOptions::new()
            .append(true)
            .open(&pending.path)?
            .write_all(&bytes)?;
        pending.bytes_written = new_size;
        pending.next_index += 1;
        Ok(NativeResponse::ok_with_data(
            request_id,
            "Asset chunk accepted.",
            json!({
                "assetId": asset_id,
                "nextIndex": pending.next_index,
                "bytesWritten": pending.bytes_written,
            }),
        ))
    }

    fn asset_end(
        &mut self,
        request_id: String,
        capture_id: &str,
        asset_id: &str,
        expected_sha256: &str,
    ) -> io::Result<NativeResponse> {
        validate_id(capture_id).map_err(io::Error::other)?;
        validate_id(asset_id).map_err(io::Error::other)?;
        let key = asset_key(capture_id, asset_id);
        let Some(pending) = self.assets.remove(&key) else {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::InvalidPayload,
                "Asset transfer was not initialized.",
            ));
        };
        if pending.bytes_written != pending.manifest.byte_size {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::InvalidPayload,
                "Asset byte count does not match its manifest.",
            ));
        }

        let actual_hash = sha256_file(&pending.path)?;
        if !actual_hash.eq_ignore_ascii_case(expected_sha256)
            || !actual_hash.eq_ignore_ascii_case(&pending.manifest.sha256)
        {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::AssetHashMismatch,
                "Asset hash verification failed; the partial file was not imported.",
            ));
        }

        let extension = extension_for_mime(&pending.manifest.mime_type);
        let final_path = pending
            .path
            .with_file_name(format!("{asset_id}.{extension}"));
        fs::rename(&pending.path, &final_path)?;
        Ok(NativeResponse::ok_with_data(
            request_id,
            "Asset verified.",
            json!({
                "assetId": asset_id,
                "sha256": actual_hash,
            }),
        ))
    }

    fn capture_commit(
        &mut self,
        request_id: String,
        capture_id: &str,
    ) -> io::Result<NativeResponse> {
        validate_id(capture_id).map_err(io::Error::other)?;
        let partial_dir = self.partial_dir(capture_id)?;
        let final_dir = self.final_dir(capture_id)?;

        if final_dir.exists() {
            return Ok(NativeResponse::ok_with_data(
                request_id,
                "Capture was already committed.",
                json!({ "duplicate": true, "captureId": capture_id }),
            ));
        }
        if !partial_dir.join("capture.json").is_file() {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::InvalidPayload,
                "No capture header is available to commit.",
            ));
        }
        if fs::read_dir(partial_dir.join("assets"))?
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "part")
            })
        {
            return Ok(NativeResponse::error(
                request_id,
                ResponseCode::InvalidPayload,
                "One or more assets are incomplete.",
            ));
        }

        atomic_write_json(
            &partial_dir.join("commit.json"),
            &json!({
                "protocolVersion": PROTOCOL_VERSION,
                "captureId": capture_id,
                "committed": true,
            }),
        )?;
        fs::rename(&partial_dir, &final_dir)?;
        Ok(NativeResponse::ok_with_data(
            request_id,
            "Capture committed to the FrameSync inbox.",
            json!({ "captureId": capture_id }),
        ))
    }

    fn partial_dir(&self, capture_id: &str) -> io::Result<PathBuf> {
        validate_id(capture_id).map_err(io::Error::other)?;
        Ok(self.inbox_root.join(format!("{capture_id}.partial")))
    }

    fn final_dir(&self, capture_id: &str) -> io::Result<PathBuf> {
        validate_id(capture_id).map_err(io::Error::other)?;
        Ok(self.inbox_root.join(capture_id))
    }
}

fn validate_capture(capture: &CaptureEnvelopeWithoutAssets) -> Result<(), &'static str> {
    validate_id(&capture.capture_id)?;
    if capture.protocol_version != PROTOCOL_VERSION {
        return Err("Capture protocol version is unsupported.");
    }
    if capture.messages.is_empty() {
        return Err("Capture contains no messages.");
    }
    if !matches!(capture.platform.as_str(), "chatgpt" | "gemini" | "generic") {
        return Err("Capture platform is invalid.");
    }
    if !matches!(
        capture.capture_mode.as_str(),
        "full" | "loaded" | "selection" | "session"
    ) {
        return Err("Capture mode is invalid.");
    }
    if !capture.source_url.starts_with("http://") && !capture.source_url.starts_with("https://") {
        return Err("Capture URL must be HTTP or HTTPS.");
    }
    if capture.captured_at.is_empty() || capture.diagnostics.adapter_id.is_empty() {
        return Err("Capture metadata is incomplete.");
    }
    if capture.diagnostics.detected_message_count as usize != capture.messages.len() {
        return Err("Diagnostic message count does not match payload.");
    }
    let _ = (
        &capture.conversation_title,
        &capture.destination_project_id,
        &capture.destination_project_name,
        capture.diagnostics.skipped_node_count,
        &capture.diagnostics.warnings,
    );
    for message in &capture.messages {
        validate_id(&message.id)?;
        if message.text.trim().is_empty() || message.message_fingerprint.len() < 8 {
            return Err("Capture message is empty or has an invalid fingerprint.");
        }
        let _ = (
            message.order_index,
            &message.role,
            &message.html_snapshot,
            &message.source_dom_id,
            &message.created_at,
        );
    }
    Ok(())
}

fn validate_asset(asset: &AssetManifest) -> Result<(), &'static str> {
    validate_id(&asset.id)?;
    if asset.byte_size > MAX_ASSET_BYTES {
        return Err("Asset is larger than the configured limit.");
    }
    if asset.sha256.len() != 64 || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Asset SHA-256 is invalid.");
    }
    if !asset.mime_type.starts_with("image/") && !asset.mime_type.starts_with("video/") {
        return Err("Only image and video assets are accepted.");
    }
    let _ = (
        &asset.message_fingerprint,
        &asset.kind,
        &asset.role,
        &asset.original_filename,
        &asset.source_url,
        asset.width,
        asset.height,
        asset.duration_ms,
        &asset.related_shot_code,
        &asset.local_path,
        &asset.quality_source,
    );
    Ok(())
}

fn validate_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Identifier contains unsafe characters.");
    }
    Ok(())
}

fn asset_key(capture_id: &str, asset_id: &str) -> String {
    format!("{capture_id}:{asset_id}")
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => "jpg",
    }
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    {
        let mut file = File::create(&temporary)?;
        serde_json::to_writer_pretty(&mut file, value).map_err(io::Error::other)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(temporary, path)
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn default_inbox_root() -> Result<PathBuf, &'static str> {
    let local_app_data = env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is not configured.")?;
    Ok(PathBuf::from(local_app_data)
        .join("FrameSync")
        .join("inbox"))
}

fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut length_bytes = [0_u8; 4];
    match reader.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Native message length is outside allowed limits.",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn write_frame(writer: &mut impl Write, response: &NativeResponse) -> io::Result<()> {
    let payload = serde_json::to_vec(response).map_err(io::Error::other)?;
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Response is too large."))?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

#[cfg(windows)]
fn set_stdio_binary() {
    const O_BINARY: i32 = 0x8000;
    unsafe extern "C" {
        fn _setmode(file_descriptor: i32, mode: i32) -> i32;
    }
    unsafe {
        let _ = _setmode(0, O_BINARY);
        let _ = _setmode(1, O_BINARY);
    }
}

#[cfg(not(windows))]
fn set_stdio_binary() {}

fn run() -> io::Result<()> {
    set_stdio_binary();
    let inbox_root = match default_inbox_root() {
        Ok(path) => path,
        Err(message) => {
            let response = NativeResponse::error("", ResponseCode::HostNotConfigured, message);
            let mut stdout = io::stdout().lock();
            write_frame(&mut stdout, &response)?;
            return Ok(());
        }
    };
    let mut state = HostState::new(inbox_root)?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    while let Some(payload) = read_frame(&mut reader)? {
        let raw: Result<Value, _> = serde_json::from_slice(&payload);
        let response = match raw {
            Ok(value) => {
                let request_id = value
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                match serde_json::from_value::<NativeRequest>(value) {
                    Ok(request) => state.handle(request),
                    Err(error) => {
                        eprintln!("framesync-native-host: invalid request: {error}");
                        NativeResponse::error(
                            request_id,
                            ResponseCode::InvalidPayload,
                            "Native request did not match the FrameSync contract.",
                        )
                    }
                }
            }
            Err(error) => {
                eprintln!("framesync-native-host: invalid JSON: {error}");
                NativeResponse::error(
                    "",
                    ResponseCode::InvalidPayload,
                    "Native request is not valid UTF-8 JSON.",
                )
            }
        };
        write_frame(&mut writer, &response)?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("framesync-native-host: fatal I/O error: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn unsafe_identifiers_are_rejected() {
        assert!(validate_id("capture-01").is_ok());
        assert!(validate_id("../capture").is_err());
        assert!(validate_id("C:\\capture").is_err());
    }

    #[test]
    fn response_uses_native_messaging_frame() {
        let response = NativeResponse::ok("request-1", "pong");
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &response).expect("response frame");

        let mut cursor = Cursor::new(bytes);
        let payload = read_frame(&mut cursor)
            .expect("read response")
            .expect("payload");
        let parsed: Value = serde_json::from_slice(&payload).expect("json response");
        assert_eq!(parsed["requestId"], "request-1");
        assert_eq!(parsed["code"], "OK");
    }

    #[test]
    fn host_accepts_ping() {
        let temp = tempfile::tempdir().expect("temporary inbox");
        let mut host = HostState::new(temp.path().to_owned()).expect("host state");
        let response = host.handle(NativeRequest::Ping {
            protocol_version: 1,
            request_id: "ping-1".to_owned(),
        });
        assert!(response.ok);
    }
}
