-- Anonymous polls ("匿名投票"): voters are still stored per option so tallies
-- stay exact, but read APIs never expose `userIds` for an anonymous poll.
-- Each member can still read back their own selection via the my-votes route.
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate column name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'polls' AND COLUMN_NAME = 'anonymous'),
  'SELECT 1',
  'ALTER TABLE polls ADD COLUMN anonymous TINYINT(1) NOT NULL DEFAULT 0 AFTER multiple'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
