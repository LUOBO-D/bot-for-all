-- Platform announcements: one row per admin post. The newest row with
-- `active = 1` is the banner every signed-in user sees; deactivating keeps the
-- row so the admin list still shows what was published and when.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful CREATE must not make a rerun fail with "table already exists".
CREATE TABLE IF NOT EXISTS announcements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  body VARCHAR(1000) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_announcements_active (active, id),
  CONSTRAINT fk_announcements_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
