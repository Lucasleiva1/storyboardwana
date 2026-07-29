PRAGMA foreign_keys = ON;

ALTER TABLE projects ADD COLUMN project_number INTEGER;

WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY created_at, id) AS project_number
  FROM projects
)
UPDATE projects
SET project_number = (
  SELECT numbered.project_number
  FROM numbered
  WHERE numbered.id = projects.id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_number
  ON projects(project_number)
  WHERE project_number IS NOT NULL;
