-- Message edit history: one row per replaced revision. Rows are written in the
-- same transaction as the messages UPDATE, so the history can never disagree
-- with the live content. Cascades keep the log in step with room/message/user
-- deletion; `(message_id, edited_at)` serves the chronological history read.
-- Idempotent by design: CREATE TABLE IF NOT EXISTS also covers a rerun after a
-- crash between the DDL and recording the version in schema_migrations.
CREATE TABLE IF NOT EXISTS message_edits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NOT NULL,
  room_id BIGINT UNSIGNED NOT NULL,
  old_content TEXT NOT NULL,
  edited_by BIGINT UNSIGNED NOT NULL,
  edited_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_message_edits_message (message_id, edited_at),
  CONSTRAINT fk_message_edits_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_edits_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_edits_user FOREIGN KEY (edited_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
