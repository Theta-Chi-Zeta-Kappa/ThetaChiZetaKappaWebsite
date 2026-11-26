-- The audit insert shares the promotion statement's transaction.
CREATE TRIGGER IF NOT EXISTS audit_initial_system_admin
AFTER UPDATE OF system_admin ON admin_users
WHEN OLD.system_admin = 0 AND NEW.system_admin = 1
  AND lower(NEW.email) = 'jackkinn13@gmail.com'
BEGIN
  INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
  VALUES (NEW.id, 'initial_system_admin_promoted', 'admin_user', CAST(NEW.id AS TEXT),
    json_object('source', '0002-bootstrap-system-administrator', 'previousPriority', OLD.priority, 'priority', 0));
END;

UPDATE admin_users SET system_admin = 1, updated_at = CURRENT_TIMESTAMP
WHERE lower(email) = 'jackkinn13@gmail.com'
  AND active = 1 AND role = 'admin' AND deleted_at IS NULL AND priority IN (1, 2)
  AND password_hash IS NOT NULL AND length(password_hash) > 0
  AND (SELECT COUNT(*) FROM admin_users WHERE lower(email) = 'jackkinn13@gmail.com') = 1
  AND NOT EXISTS (SELECT 1 FROM admin_users WHERE system_admin = 1 AND active = 1 AND role = 'admin' AND deleted_at IS NULL);

DROP TRIGGER audit_initial_system_admin;
