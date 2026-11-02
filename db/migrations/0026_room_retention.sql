-- Per-room message retention: 0 keeps messages forever, otherwise messages
-- older than `retention_days` are removed by the background sweep, except
-- pinned ones. The column only carries the policy; deletion happens in the
-- retention service, which also clears attachment files after commit.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'rooms' AND COLUMN_NAME = 'retention_days'),
  'SELECT 1',
  'ALTER TABLE rooms ADD COLUMN retention_days INT NOT NULL DEFAULT 0 AFTER slow_mode_seconds'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
