CREATE TABLE IF NOT EXISTS detached_shot_assets (
  shot_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('storyboard', 'first_frame', 'video_final')),
  detached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (shot_id, asset_id, role),
  FOREIGN KEY (shot_id) REFERENCES shots(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_detached_shot_assets_lookup
  ON detached_shot_assets (shot_id, role, asset_id);
