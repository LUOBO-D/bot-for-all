import { hashPassword } from '../auth/password';
import { pool, withTransaction, type ResultSetHeader, type RowDataPacket } from '../db';

const USER_COUNT = 200;
const PASSWORD = 'load12345';

async function main(): Promise<void> {
  const [adminRows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1",
  );
  const admin = adminRows[0];
  if (!admin) {
    throw new Error('No admin user found. Run `pnpm seed:admin` first.');
  }
  const adminId = Number(admin.id);

  let [roomRows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM rooms WHERE name = 'load-test' ORDER BY id LIMIT 1",
  );
  let roomId: number;
  if (roomRows[0]) {
    roomId = Number(roomRows[0].id);
  } else {
    roomId = await withTransaction(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        "INSERT INTO rooms (name, topic, owner_id, is_public) VALUES ('load-test', 'load test room', ?, 1)",
        [adminId],
      );
      await conn.execute(
        "INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'owner')",
        [result.insertId, adminId],
      );
      return result.insertId;
    });
  }

  const passwordHash = await hashPassword(PASSWORD);
  const userIds: number[] = [];

  await withTransaction(async (conn) => {
    for (let index = 0; index < USER_COUNT; index += 1) {
      const username = `load_${index}`;
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT INTO users (username, password_hash, display_name, type, role, status)
         VALUES (?, ?, ?, 'human', 'user', 'active')
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [username, passwordHash, username],
      );
      const userId = result.insertId;
      userIds.push(userId);
      await conn.execute(
        'INSERT IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
        [roomId, userId, 'member'],
      );
    }
  });

  console.log(JSON.stringify({ roomId, userIds }));
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
