-- Existing priority remains constrained to 1, 2, or 3. The effective P0 tier uses a separate flag.
ALTER TABLE admin_users ADD COLUMN system_admin INTEGER NOT NULL DEFAULT 0 CHECK (system_admin IN (0, 1));

CREATE TRIGGER IF NOT EXISTS protect_last_system_admin_update
BEFORE UPDATE OF system_admin, active, role, deleted_at ON admin_users
WHEN OLD.system_admin = 1 AND OLD.active = 1 AND OLD.role = 'admin'
  AND OLD.deleted_at IS NULL
  AND (NEW.system_admin IS NOT 1 OR NEW.active IS NOT 1 OR NEW.role IS NOT 'admin' OR NEW.deleted_at IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM admin_users
    WHERE id <> OLD.id AND system_admin = 1 AND active = 1 AND role = 'admin' AND deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'Cannot remove the last active System Administrator');
END;

CREATE TRIGGER IF NOT EXISTS protect_last_system_admin_delete
BEFORE DELETE ON admin_users
WHEN OLD.system_admin = 1 AND OLD.active = 1 AND OLD.role = 'admin'
  AND OLD.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM admin_users
    WHERE id <> OLD.id AND system_admin = 1 AND active = 1 AND role = 'admin' AND deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'Cannot remove the last active System Administrator');
END;
