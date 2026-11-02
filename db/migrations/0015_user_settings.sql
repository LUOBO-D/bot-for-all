-- Per-user settings that must be consistent across devices. Today this holds
-- the notification preference: `all` pushes every message, `mention` only
-- mentions/DMs. A missing row means "never changed anything", so readers insert
-- the default row lazily instead of backfilling every existing user.
-- Idempotent by design: CREATE TABLE IF NOT EXISTS also covers a rerun after a
-- crash between the DDL and recording the version in schema_migrations.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id BIGINT UNSIGNED NOT NULL,
  notify_mode ENUM('all', 'mention') NOT NULL DEFAULT 'all',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
