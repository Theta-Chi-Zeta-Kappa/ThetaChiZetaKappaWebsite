-- TCZK Forms Builder v23 - draft configuration layer
-- Safe additive migration: existing survey and formal registration tables are untouched.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  form_type TEXT NOT NULL CHECK(form_type IN ('survey','registration')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed','archived')),
  opens_at TEXT,
  closes_at TEXT,
  allow_multiple INTEGER NOT NULL DEFAULT 0,
  event_date TEXT,
  public_path TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES admin_users(id)
);

CREATE TABLE IF NOT EXISTS form_questions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  question_key TEXT NOT NULL,
  label TEXT NOT NULL,
  help_text TEXT NOT NULL DEFAULT '',
  question_type TEXT NOT NULL CHECK(question_type IN ('text','email','phone','number','date','textarea','select','radio','checkbox','multi_select','yes_no','section','info')),
  options_json TEXT,
  conditional_json TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
  UNIQUE(form_id, question_key)
);
CREATE INDEX IF NOT EXISTS idx_form_questions_order ON form_questions(form_id, display_order, id);

CREATE TABLE IF NOT EXISTS registration_square_settings (
  form_id TEXT PRIMARY KEY,
  item_name TEXT NOT NULL DEFAULT '',
  item_id TEXT,
  validation_status TEXT NOT NULL DEFAULT 'not_validated' CHECK(validation_status IN ('not_validated','valid','invalid','partial')),
  validation_message TEXT NOT NULL DEFAULT '',
  last_validated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS registration_square_variations (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  internal_label TEXT NOT NULL,
  square_name TEXT NOT NULL,
  square_variation_id TEXT,
  expected_price_cents INTEGER,
  pricing_phase TEXT NOT NULL DEFAULT 'standard',
  display_order INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'not_validated' CHECK(validation_status IN ('not_validated','valid','missing','price_mismatch')),
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_registration_square_variations ON registration_square_variations(form_id, display_order, id);

CREATE TABLE IF NOT EXISTS registration_square_modifier_sets (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  internal_purpose TEXT NOT NULL,
  square_name TEXT NOT NULL,
  square_modifier_set_id TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'not_validated' CHECK(validation_status IN ('not_validated','valid','missing')),
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_registration_square_modifier_sets ON registration_square_modifier_sets(form_id, display_order, id);

CREATE TABLE IF NOT EXISTS registration_square_modifiers (
  id TEXT PRIMARY KEY,
  modifier_set_id TEXT NOT NULL,
  internal_label TEXT NOT NULL,
  square_name TEXT NOT NULL,
  square_modifier_id TEXT,
  expected_price_cents INTEGER,
  display_order INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'not_validated' CHECK(validation_status IN ('not_validated','valid','missing','price_mismatch')),
  FOREIGN KEY (modifier_set_id) REFERENCES registration_square_modifier_sets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_registration_square_modifiers ON registration_square_modifiers(modifier_set_id, display_order, id);
