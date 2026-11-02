-- Per-user, per-room message drafts ("草稿"). One row per (user, room), so a
-- half-written message follows the account across devices while staying
-- invisible to every other member. Saving '' deletes the row; `updated_at` is
-- returned to the client so a late GET can be reconciled with local input.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful CREATE must not make a rerun fail with "table already exists".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'user_drafts'),
  'SELECT 1',
  'CREATE TABLE user_drafts (
     user_id BIGINT UNSIGNED NOT NULL,
     room_id BIGINT UNSIGNED NOT NULL,
     content TEXT NOT NULL,
     updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
     PRIMARY KEY (user_id, room_id),
     CONSTRAINT fk_user_drafts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
     CONSTRAINT fk_user_drafts_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
