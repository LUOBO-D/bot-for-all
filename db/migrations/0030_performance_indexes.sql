-- Composite indexes for the hot read paths that were still scanning:
--
--   messages (room_id, created_at)             per-room retention sweep and
--                                              date-window searches
--   messages (room_id, sender_id, created_at)  sender + date search, in date
--                                              order so no filesort is needed
--   admin_audit_log (actor_id, id)             "actions by operator" listing,
--                                              newest first (id DESC)
--   message_attachments (uploader_id)          upload quota COUNT/SUM, which
--                                              the (room_id, uploader_id, ...)
--                                              index cannot serve
--   message_attachments (room_id, id)          media library pagination,
--                                              newest attachment first
--   rooms (is_public, id)                      public room discovery, newest
--                                              room first
--
-- Index-only migration: no column, constraint or query semantics change.
--
-- Idempotent by design: MySQL DDL is not transactional, so a crash after a
-- successful ALTER must not make a rerun fail with "Duplicate key name".
SET @db = DATABASE();

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = @db
           AND TABLE_NAME = 'messages'
           AND INDEX_NAME = 'idx_messages_room_created'),
  'SELECT 1',
  'ALTER TABLE messages ADD KEY idx_messages_room_created (room_id, created_at)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = @db
           AND TABLE_NAME = 'messages'
           AND INDEX_NAME = 'idx_messages_room_sender_created'),
  'SELECT 1',
  'ALTER TABLE messages ADD KEY idx_messages_room_sender_created (room_id, sender_id, created_at)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = @db
           AND TABLE_NAME = 'admin_audit_log'
           AND INDEX_NAME = 'idx_audit_actor'),
  'SELECT 1',
  'ALTER TABLE admin_audit_log ADD KEY idx_audit_actor (actor_id, id)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = @db
           AND TABLE_NAME = 'message_attachments'
           AND INDEX_NAME = 'idx_message_attachments_uploader'),
  'SELECT 1',
  'ALTER TABLE message_attachments ADD KEY idx_message_attachments_uploader (uploader_id)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = @db
           AND TABLE_NAME = 'message_attachments'
           AND INDEX_NAME = 'idx_message_attachments_room_id'),
  'SELECT 1',
  'ALTER TABLE message_attachments ADD KEY idx_message_attachments_room_id (room_id, id)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = @db
           AND TABLE_NAME = 'rooms'
           AND INDEX_NAME = 'idx_rooms_public_id'),
  'SELECT 1',
  'ALTER TABLE rooms ADD KEY idx_rooms_public_id (is_public, id)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
