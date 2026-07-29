PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_sources (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('chatgpt', 'gemini', 'generic')),
  source_url TEXT NOT NULL,
  conversation_title TEXT,
  captured_at TEXT NOT NULL,
  capture_mode TEXT NOT NULL CHECK (capture_mode IN ('full', 'loaded', 'selection', 'session')),
  status TEXT NOT NULL CHECK (status IN ('received', 'analyzed', 'reviewed', 'imported', 'failed')),
  fingerprint TEXT NOT NULL UNIQUE,
  raw_text TEXT NOT NULL,
  original_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_capture_sources_project
  ON capture_sources(project_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS capture_messages (
  id TEXT PRIMARY KEY NOT NULL,
  capture_source_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'unknown')),
  text TEXT NOT NULL,
  html_snapshot TEXT,
  message_fingerprint TEXT NOT NULL,
  source_dom_id TEXT,
  created_at TEXT,
  UNIQUE(capture_source_id, message_fingerprint),
  FOREIGN KEY (capture_source_id) REFERENCES capture_sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY NOT NULL,
  capture_source_id TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  summary TEXT,
  proposal_json TEXT,
  FOREIGN KEY (capture_source_id) REFERENCES capture_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_capture
  ON analysis_runs(capture_source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS detected_items (
  id TEXT PRIMARY KEY NOT NULL,
  analysis_run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  payload_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('explicit', 'rule', 'inferred', 'manual')),
  source_message_ids_json TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'approved', 'rejected', 'needs_review')),
  FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  canonical_version_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS script_versions (
  id TEXT PRIMARY KEY NOT NULL,
  script_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  source_capture_id TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(script_id, version_number),
  FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE,
  FOREIGN KEY (source_capture_id) REFERENCES capture_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisional', 'approved')),
  canonical_version_id TEXT,
  source_capture_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, canonical_name),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_capture_id) REFERENCES capture_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS character_versions (
  id TEXT PRIMARY KEY NOT NULL,
  character_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  aliases_json TEXT NOT NULL,
  narrative_function TEXT,
  physical_description TEXT,
  wardrobe TEXT,
  accessories TEXT,
  attitude TEXT,
  master_prompt TEXT,
  source_capture_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(character_id, version_number),
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
  FOREIGN KEY (source_capture_id) REFERENCES capture_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisional', 'approved')),
  canonical_version_id TEXT,
  source_capture_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, canonical_name),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_capture_id) REFERENCES capture_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS location_versions (
  id TEXT PRIMARY KEY NOT NULL,
  location_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  description TEXT,
  atmosphere TEXT,
  lighting TEXT,
  permanent_elements_json TEXT NOT NULL,
  time_of_day TEXT,
  weather TEXT,
  master_prompt TEXT,
  source_capture_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(location_id, version_number),
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (source_capture_id) REFERENCES capture_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  source_capture_id TEXT,
  number INTEGER,
  code TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  script_fragment TEXT,
  location_id TEXT,
  order_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, code),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_capture_id) REFERENCES capture_sources(id) ON DELETE SET NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY NOT NULL,
  scene_id TEXT NOT NULL,
  source_capture_id TEXT,
  code TEXT,
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  visual_description TEXT,
  action TEXT,
  framing TEXT,
  angle TEXT,
  movement TEXT,
  estimated_duration_ms INTEGER,
  dialogue TEXT,
  image_prompt TEXT,
  video_prompt TEXT,
  status TEXT NOT NULL CHECK (status IN ('empty', 'structured', 'storyboard', 'first_frame', 'video', 'approved', 'conflict', 'incomplete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scene_id, code),
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
  FOREIGN KEY (source_capture_id) REFERENCES capture_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT,
  capture_source_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document')),
  role TEXT NOT NULL,
  original_filename TEXT,
  stored_path TEXT NOT NULL,
  source_url TEXT,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  sha256 TEXT NOT NULL UNIQUE,
  quality_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (capture_source_id) REFERENCES capture_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS shot_assets (
  shot_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  role TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  PRIMARY KEY (shot_id, asset_id, role),
  FOREIGN KEY (shot_id) REFERENCES shots(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

