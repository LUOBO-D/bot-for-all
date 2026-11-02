-- Room polls ("投票"): a poll is a message of kind 'poll' plus one polls row.
-- Poll options are fixed at creation; votes are a replace-all set per member,
-- so re-voting deletes the member's previous rows and inserts the new ones.
-- `closed` is not stored: it derives from closes_at at read time.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER/CREATE must not make a rerun fail.
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'kind'),
  'SELECT 1',
  'ALTER TABLE messages ADD COLUMN kind ENUM(''text'',''poll'') NOT NULL DEFAULT ''text'' AFTER content'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS polls (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- One poll per message: the cascade deletes the poll with its message, and the
  -- unique key makes "does this message carry a poll?" a single index lookup.
  message_id BIGINT UNSIGNED NOT NULL,
  multiple TINYINT(1) NOT NULL DEFAULT 0,
  closes_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_polls_message (message_id),
  CONSTRAINT fk_polls_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS poll_options (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  poll_id BIGINT UNSIGNED NOT NULL,
  -- 100 characters is the API cap. The collation makes the unique key
  -- case-insensitive, matching the service-level duplicate check.
  label VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_poll_options_label (poll_id, label),
  CONSTRAINT fk_poll_options_poll FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id BIGINT UNSIGNED NOT NULL,
  option_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- A member may pick several options on a multiple-choice poll, but the same
  -- option at most once: the primary key is the vote uniqueness guard.
  PRIMARY KEY (poll_id, user_id, option_id),
  KEY idx_poll_votes_option (option_id, user_id),
  CONSTRAINT fk_poll_votes_poll FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  CONSTRAINT fk_poll_votes_option FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
  CONSTRAINT fk_poll_votes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
