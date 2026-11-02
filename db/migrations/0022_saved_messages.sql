-- Saved messages ("收藏"): a private bookmark on one message for one user.
-- The (user_id, message_id) primary key is the idempotency guard, so saving
-- twice is a no-op and unsaving is a plain DELETE. `room_id` is denormalised
-- from the message so the list can join rooms without touching messages twice.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful CREATE must not make a rerun fail with "table already exists".
CREATE TABLE IF NOT EXISTS saved_messages (
  user_id BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  room_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, message_id),
  -- The saved list is "my rows, newest first": one index serves both halves.
  KEY idx_saved_user_created (user_id, created_at),
  CONSTRAINT fk_saved_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
