-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'room_members' AND COLUMN_NAME = 'favorite'),
  'SELECT 1',
  'ALTER TABLE room_members ADD COLUMN favorite TINYINT(1) NOT NULL DEFAULT 0 AFTER muted'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
