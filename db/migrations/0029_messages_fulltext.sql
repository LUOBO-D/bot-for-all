-- Full-text index over message bodies, shared by room search and global
-- search. Those endpoints answer a two-or-more character word/CJK query with
-- MATCH ... AGAINST in BOOLEAN MODE and only fall back to `content LIKE ?
-- ESCAPE '\'` for one-character or metacharacter queries, so the index is what
-- keeps ordinary searches off a full scan.
--
-- The ngram parser is what makes CJK usable at all: the default parser splits
-- on whitespace, which turns a whole Chinese sentence into a single token.
-- With ngram_token_size = 2 (the server default) the index holds bigrams, so
-- the shortest query it can answer is two characters -- exactly the threshold
-- the service uses before switching to LIKE.
--
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate key name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = @db
           AND TABLE_NAME = 'messages'
           AND INDEX_NAME = 'ft_messages_content'),
  'SELECT 1',
  'ALTER TABLE messages ADD FULLTEXT KEY ft_messages_content (content) WITH PARSER ngram'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
