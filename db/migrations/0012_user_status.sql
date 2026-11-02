-- Custom user status: a short emoji plus a short line of text, both optional.
-- Cleared by writing NULL, so the columns stay nullable rather than defaulted.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'status_emoji'),
  'SELECT 1',
  'ALTER TABLE users ADD COLUMN status_emoji VARCHAR(16) NULL AFTER avatar'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'status_text'),
  'SELECT 1',
  'ALTER TABLE users ADD COLUMN status_text VARCHAR(64) NULL AFTER status_emoji'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
