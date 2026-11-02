-- Last time a user was seen online. The socket layer writes it on connect and
-- on disconnect; NULL means "never connected since this column existed", which
-- clients render as a plain "offline" instead of a relative timestamp.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_seen_at'),
  'SELECT 1',
  'ALTER TABLE users ADD COLUMN last_seen_at DATETIME(3) NULL AFTER status_text'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
