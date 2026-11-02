-- Scheduled messages: a member writes a message now that the worker delivers
-- later. `pending` waits for `send_at`; the worker flips it to `sending` with a
-- conditional UPDATE to claim the row (so two workers never deliver it twice),
-- then to `sent` (with the created message id) or `failed`. `sending` rows are
-- reset to `pending` on startup, so a crash mid-delivery is retried instead of
-- being lost forever.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful CREATE must not make a rerun fail with "table already exists".
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  content VARCHAR(4000) NOT NULL,
  send_at DATETIME(3) NOT NULL,
  status ENUM('pending','sending','sent','cancelled','failed') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_message_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  -- The worker's queue scan: due rows in one ordered index range.
  KEY idx_scheduled_due (status, send_at, id),
  -- Per-user listing, pending cap and cancel lookup.
  KEY idx_scheduled_sender (room_id, sender_id, status, send_at),
  CONSTRAINT fk_scheduled_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_scheduled_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  -- Keeping the history of a deleted message is still useful; the link is not.
  CONSTRAINT fk_scheduled_message FOREIGN KEY (sent_message_id) REFERENCES messages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
