-- TCZK v29.2 - retire legacy pre-Forms-Builder survey system
-- DESTRUCTIVE: permanently removes the old interest-survey tables and their responses.
-- The current Forms Builder tables (forms/form_questions/form_responses/form_answers) are NOT affected.

DROP TABLE IF EXISTS survey_answers;
DROP TABLE IF EXISTS survey_responses;
DROP TABLE IF EXISTS survey_questions;
DROP TABLE IF EXISTS surveys;
