-- Additive project-page fields. Existing project rows are preserved and the
-- new columns remain nullable until they are populated from the admin panel.
ALTER TABLE projects ADD COLUMN banner_url TEXT;
ALTER TABLE projects ADD COLUMN download_url TEXT;
ALTER TABLE projects ADD COLUMN long_description TEXT;
ALTER TABLE projects ADD COLUMN technologies TEXT;

CREATE TABLE IF NOT EXISTS project_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image', 'video', 'youtube')),
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  title TEXT,
  caption TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_media_project_id
  ON project_media(project_id);
CREATE INDEX IF NOT EXISTS idx_project_media_project_sort
  ON project_media(project_id, sort_order, created_at, id);
