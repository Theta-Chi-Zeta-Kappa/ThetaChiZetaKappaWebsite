-- TCZK Chapter History Submissions
-- Run against the same D1 database used by the admin/family-tree Worker.

CREATE TABLE IF NOT EXISTS chapter_history_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  submitter_name TEXT NOT NULL,
  submitter_email TEXT NOT NULL,
  category TEXT NOT NULL,
  historical_date TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','reviewing','acted_upon','rejected')),
  review_notes TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  acted_upon_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chapter_history_submission_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (submission_id) REFERENCES chapter_history_submissions(id) ON DELETE CASCADE
);

-- Minimal non-content audit trail. No submitter email, description, or uploaded material is retained here.
CREATE TABLE IF NOT EXISTS chapter_history_deletion_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_public_id TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  deletion_reason TEXT NOT NULL,
  prior_status TEXT,
  deleted_file_count INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_history_submissions_status
  ON chapter_history_submissions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_files_submission
  ON chapter_history_submission_files(submission_id);
CREATE INDEX IF NOT EXISTS idx_history_deletion_audit_public_id
  ON chapter_history_deletion_audit(submission_public_id);
