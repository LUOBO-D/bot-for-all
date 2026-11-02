-- Notification do-not-disturb ("免打扰时段"): a local wall-clock window during
-- which the browser suppresses message toasts. The window is a schedule, not a
-- moment, so the columns are plain TIME values with no timezone: every device
-- evaluates the same HH:MM pair against its own clock.
-- A NULL pair means "DND off"; the API always writes both columns together.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail.
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'user_settings' AND COLUMN_NAME = 'dnd_start'),
  'SELECT 1',
  'ALTER TABLE user_settings ADD COLUMN dnd_start TIME NULL AFTER notify_mode'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'user_settings' AND COLUMN_NAME = 'dnd_end'),
  'SELECT 1',
  'ALTER TABLE user_settings ADD COLUMN dnd_end TIME NULL AFTER dnd_start'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Mentions are the one thing worth interrupting DND for; the default keeps the
-- pre-DND behaviour of never suppressing an @mention.
SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'user_settings' AND COLUMN_NAME = 'dnd_allow_mentions'),
  'SELECT 1',
  'ALTER TABLE user_settings ADD COLUMN dnd_allow_mentions TINYINT(1) NOT NULL DEFAULT 1 AFTER dnd_end'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
