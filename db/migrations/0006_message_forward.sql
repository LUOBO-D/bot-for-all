-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
--
-- Forward snapshots are stored on the new message row (no FK to rooms): the
-- source room may be deleted later, but the forwarded message must keep
-- rendering its origin label.
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'forwarded_from_room_id'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN forwarded_from_room_id BIGINT UNSIGNED NULL AFTER pinned_by'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'forwarded_from_room_name'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN forwarded_from_room_name VARCHAR(64) NULL AFTER forwarded_from_room_id'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'forwarded_from_sender_name'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN forwarded_from_sender_name VARCHAR(64) NULL AFTER forwarded_from_room_name'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
