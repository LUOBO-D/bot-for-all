CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(32) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  avatar VARCHAR(255) NULL,
  type ENUM('human','bot') NOT NULL DEFAULT 'human',
  role ENUM('admin','user') NOT NULL DEFAULT 'user',
  status ENUM('active','banned') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS rooms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  topic VARCHAR(255) NOT NULL DEFAULT '',
  owner_id BIGINT UNSIGNED NOT NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 1,
  invite_code CHAR(8) NULL,
  max_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_rooms_invite_code (invite_code),
  KEY idx_rooms_owner (owner_id),
  CONSTRAINT fk_rooms_owner FOREIGN KEY (owner_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS room_members (
  room_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('owner','admin','member','bot') NOT NULL DEFAULT 'member',
  last_read_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
  joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (room_id, user_id),
  KEY idx_members_user (user_id),
  KEY idx_members_room_role (room_id, role),
  CONSTRAINT fk_members_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_id BIGINT UNSIGNED NOT NULL,
  seq BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  sender_type ENUM('user','bot','system') NOT NULL,
  content MEDIUMTEXT NOT NULL,
  status ENUM('done','streaming','error') NOT NULL DEFAULT 'done',
  reply_to_id BIGINT UNSIGNED NULL,
  client_msg_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_messages_room_seq (room_id, seq),
  UNIQUE KEY uk_messages_client (room_id, sender_id, client_msg_id),
  KEY idx_messages_room_id (room_id, id),
  CONSTRAINT fk_messages_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS bots (
  user_id BIGINT UNSIGNED NOT NULL,
  base_url VARCHAR(512) NOT NULL,
  api_key_encrypted VARCHAR(512) NOT NULL,
  model VARCHAR(128) NOT NULL,
  system_prompt TEXT NOT NULL,
  trigger_mode ENUM('mention','all') NOT NULL DEFAULT 'mention',
  owner_user_id BIGINT UNSIGNED NOT NULL,
  scope ENUM('global','room') NOT NULL,
  room_id BIGINT UNSIGNED NULL,
  temperature DECIMAL(3,2) NOT NULL DEFAULT 0.70,
  max_tokens INT NOT NULL DEFAULT 1024,
  extra_body TEXT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  KEY idx_bots_owner (owner_user_id),
  CONSTRAINT fk_bots_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_bots_owner FOREIGN KEY (owner_user_id) REFERENCES users(id),
  CONSTRAINT fk_bots_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT chk_bots_scope CHECK ((scope = 'room' AND room_id IS NOT NULL) OR (scope = 'global' AND room_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
