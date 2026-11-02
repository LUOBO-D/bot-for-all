-- Per-room slow mode: 0 disables it, otherwise the minimum gap (in seconds)
-- between two messages from the same member. Enforced in the socket layer, so
-- the column only carries the configured window.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'rooms' AND COLUMN_NAME = 'slow_mode_seconds'),
  'SELECT 1',
  'ALTER TABLE rooms ADD COLUMN slow_mode_seconds INT UNSIGNED NOT NULL DEFAULT 0 AFTER announcement'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
