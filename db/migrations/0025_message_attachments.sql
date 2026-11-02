-- Room attachments: a file uploaded to a room, optionally bound to one
-- message. `stored_name` is the random on-disk name and the UNIQUE key; the
-- original `filename` is display-only and never touches the filesystem.
-- `message_id` stays NULL between upload and send, which is exactly the
-- "unused" state the message transaction matches on.
CREATE TABLE IF NOT EXISTS message_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_id BIGINT UNSIGNED NOT NULL,
  uploader_id BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NULL,
  filename VARCHAR(255) NOT NULL,
  stored_name VARCHAR(128) NOT NULL,
  mime VARCHAR(127) NOT NULL,
  size BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_message_attachments_stored (stored_name),
  KEY idx_message_attachments_message (message_id),
  -- Upload listing / "my unbound files" lookups stay covered by the prefix.
  KEY idx_message_attachments_room_uploader (room_id, uploader_id, message_id),
  CONSTRAINT fk_message_attachments_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_attachments_uploader FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_attachments_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
