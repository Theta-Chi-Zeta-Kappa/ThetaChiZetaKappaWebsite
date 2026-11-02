-- TCZK Forms Builder v25 - Phase 3 dynamic registration, conditional logic, payment tracking
-- Run once after v23 and v24 migrations.
PRAGMA foreign_keys = ON;

ALTER TABLE registration_square_settings ADD COLUMN allow_check INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registration_square_settings ADD COLUMN check_instructions TEXT NOT NULL DEFAULT '';

ALTER TABLE registration_square_variations ADD COLUMN trigger_question_key TEXT NOT NULL DEFAULT '';
ALTER TABLE registration_square_variations ADD COLUMN trigger_value TEXT NOT NULL DEFAULT '';
ALTER TABLE registration_square_variations ADD COLUMN active_from TEXT;
ALTER TABLE registration_square_variations ADD COLUMN active_until TEXT;

ALTER TABLE registration_square_modifiers ADD COLUMN trigger_question_key TEXT NOT NULL DEFAULT '';
ALTER TABLE registration_square_modifiers ADD COLUMN trigger_value TEXT NOT NULL DEFAULT '';
ALTER TABLE registration_square_modifiers ADD COLUMN active_from TEXT;
ALTER TABLE registration_square_modifiers ADD COLUMN active_until TEXT;

CREATE TABLE IF NOT EXISTS form_registration_payments (
  response_id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'square' CHECK(payment_method IN ('square','check')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending','check_pending','paid','cancelled')),
  amount_due_cents INTEGER NOT NULL DEFAULT 0,
  selected_variation_id TEXT,
  selected_modifiers_json TEXT NOT NULL DEFAULT '[]',
  square_order_id TEXT,
  square_payment_link_id TEXT,
  square_checkout_url TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (response_id) REFERENCES form_responses(id) ON DELETE CASCADE,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
  FOREIGN KEY (selected_variation_id) REFERENCES registration_square_variations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_form_registration_payments_form ON form_registration_payments(form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_registration_payments_status ON form_registration_payments(form_id, payment_status);
