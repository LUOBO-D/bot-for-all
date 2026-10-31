-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'edited_at'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN edited_at DATETIME(3) NULL AFTER created_at'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'deleted_at'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN deleted_at DATETIME(3) NULL AFTER edited_at'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'pinned_at'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN pinned_at DATETIME(3) NULL AFTER deleted_at'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'pinned_by'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN pinned_by BIGINT UNSIGNED NULL AFTER pinned_at'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND INDEX_NAME = 'idx_messages_pinned'),
  'SELECT 1',
  'ALTER TABLE messages ADD KEY idx_messages_pinned (room_id, pinned_at)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'messages'
           AND CONSTRAINT_NAME = 'fk_messages_pinned_by'),
  'SELECT 1',
  'ALTER TABLE messages ADD CONSTRAINT fk_messages_pinned_by FOREIGN KEY (pinned_by) REFERENCES users(id)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  emoji VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (message_id, user_id, emoji),
  KEY idx_reactions_message (message_id),
  CONSTRAINT fk_reactions_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_reactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
