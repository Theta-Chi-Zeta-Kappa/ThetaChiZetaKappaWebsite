-- TCZK Forms Builder v24 - Phase 2 lifecycle + generic survey responses
-- Safe additive migration. Existing survey/formal tables remain untouched.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS form_responses (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  respondent_email TEXT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_form_responses_form ON form_responses(form_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_responses_email ON form_responses(form_id, respondent_email);

CREATE TABLE IF NOT EXISTS form_answers (
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer_text TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (response_id) REFERENCES form_responses(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES form_questions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_form_answers_response ON form_answers(response_id);
