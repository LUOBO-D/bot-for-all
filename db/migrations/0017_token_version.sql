-- Revocation counter for every token a user holds. JWTs are stateless, so a
-- password change or "log out everywhere" increments this value and the auth middleware
-- rejects any token whose `ver` claim is behind it. Tokens signed before this
-- column existed carry no claim and are read as version 0, which is what the
-- DEFAULT gives every existing row, so nobody is logged out by the upgrade.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version'),
  'SELECT 1',
  'ALTER TABLE users ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0 AFTER last_seen_at'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
