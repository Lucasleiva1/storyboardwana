CREATE TABLE IF NOT EXISTS multimedia_inbox (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  original_path TEXT NOT NULL,
  staged_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  shot_id TEXT,
  detected_shot_code TEXT,
  role TEXT CHECK (role IN ('storyboard', 'first_frame', 'video_final')),
  status TEXT NOT NULL CHECK (status IN ('ready', 'needs_review', 'error')),
  detection_note TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(project_id, sha256),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (shot_id) REFERENCES shots(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_multimedia_inbox_project_status
  ON multimedia_inbox(project_id, status, created_at);
