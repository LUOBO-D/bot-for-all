#!/bin/bash
# Provisions the non-root MySQL business account used by the backend
# DATABASE_URL (mysql://chat_app:...@mysql:3306/chat). Root stays confined to
# container initialization; the app never runs as root.
#
# The mysql official image runs this once, on first initialization of the data
# volume, after MYSQL_DATABASE has been created — so `chat` exists by the time
# the GRANT runs. Re-entrancy: CREATE USER IF NOT EXISTS + ALTER USER mean a
# re-run against an existing volume converges to the configured password
# instead of failing (relevant when rotating MYSQL_APP_PASSWORD, see README).
# The .sql files in this directory also run in the dev stack, which does not
# set MYSQL_APP_PASSWORD — the script is a quiet no-op there.

set -euo pipefail

if [ -z "${MYSQL_APP_PASSWORD:-}" ]; then
  echo "MYSQL_APP_PASSWORD not set; skipping chat_app user creation"
  exit 0
fi

# Hex-only by convention (see .env.production.example): Compose interpolates
# the value into DATABASE_URL, and hex excludes the quoting/URL metacharacters
# that would break this heredoc or the connection string.
mysql --user=root --password="$MYSQL_ROOT_PASSWORD" <<SQL
CREATE USER IF NOT EXISTS 'chat_app'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
ALTER USER 'chat_app'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
GRANT ALL PRIVILEGES ON chat.* TO 'chat_app'@'%';
FLUSH PRIVILEGES;
SQL

echo "chat_app@% ready: ALL PRIVILEGES ON chat.*"
