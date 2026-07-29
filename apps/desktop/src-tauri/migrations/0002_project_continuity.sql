PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  source_capture_id TEXT,
  number INTEGER NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  order_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, number),
  UNIQUE(project_id, code),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_capture_id) REFERENCES capture_sources(id) ON DELETE SET NULL
);

ALTER TABLE scenes ADD COLUMN episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL;

ALTER TABLE shots ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE shots ADD COLUMN global_number INTEGER;
ALTER TABLE shots ADD COLUMN shot_type TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE shots ADD COLUMN special_code TEXT;
ALTER TABLE shots ADD COLUMN variant_of_shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL;
ALTER TABLE shots ADD COLUMN content_fingerprint TEXT;

WITH ranked AS (
  SELECT
    shot.id AS shot_id,
    scene.project_id AS project_id,
    ROW_NUMBER() OVER (
      PARTITION BY scene.project_id
      ORDER BY scene.order_index, shot.order_index, shot.created_at, shot.id
    ) AS global_number
  FROM shots shot
  JOIN scenes scene ON scene.id = shot.scene_id
)
UPDATE shots
SET
  project_id = (SELECT ranked.project_id FROM ranked WHERE ranked.shot_id = shots.id),
  global_number = (
    SELECT ranked.global_number FROM ranked WHERE ranked.shot_id = shots.id
  ),
  code = 'P' || printf(
    '%03d',
    (SELECT ranked.global_number FROM ranked WHERE ranked.shot_id = shots.id)
  ),
  shot_type = 'normal'
WHERE id IN (SELECT shot_id FROM ranked);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shots_project_global_number
  ON shots(project_id, global_number)
  WHERE shot_type = 'normal' AND global_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shots_project_special_code
  ON shots(project_id, special_code)
  WHERE special_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shots_project_order
  ON shots(project_id, global_number, order_index);

ALTER TABLE assets ADD COLUMN related_shot_code TEXT;
ALTER TABLE assets ADD COLUMN local_path TEXT;

CREATE TABLE IF NOT EXISTS shot_import_events (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  capture_source_id TEXT NOT NULL,
  detected_item_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('created', 'repeated', 'updated', 'conflict', 'special_created', 'variant_created')
  ),
  global_number INTEGER,
  shot_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (capture_source_id) REFERENCES capture_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (shot_id) REFERENCES shots(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_shot_import_events_capture
  ON shot_import_events(capture_source_id, created_at);
