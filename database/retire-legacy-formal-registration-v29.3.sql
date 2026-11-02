-- TCZK v29.3: retire legacy hardcoded Spring Formal registration storage
-- The current Forms Builder registration system uses form_responses, form_answers,
-- and form_registration_payments. This legacy table is no longer used.

DROP TABLE IF EXISTS event_registrations;
