-- Link previews (Open Graph metadata of the first URL in a message).
-- Nullable: a message without a resolvable preview keeps all four columns NULL,
-- and the API maps that to `preview: null`.
--
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'preview_url'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN preview_url VARCHAR(512) NULL AFTER forwarded_from_sender_name'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'preview_title'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN preview_title VARCHAR(255) NULL AFTER preview_url'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'preview_description'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN preview_description VARCHAR(500) NULL AFTER preview_title'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'preview_site'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN preview_site VARCHAR(128) NULL AFTER preview_description'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
