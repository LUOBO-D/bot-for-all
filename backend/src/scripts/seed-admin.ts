import { hashPassword } from '../auth/password';
import { config } from '../config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../db';

async function main(): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, role FROM users WHERE username = ?',
    [config.adminUsername],
  );
  const existing = rows[0];
  if (existing) {
    if (existing.role !== 'admin') {
      await pool.execute("UPDATE users SET role = 'admin' WHERE id = ?", [existing.id]);
    }
    console.log(`admin id=${existing.id}`);
  } else {
    const passwordHash = await hashPassword(config.adminPassword);
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO users (username, password_hash, display_name, type, role, status)
       VALUES (?, ?, ?, 'human', 'admin', 'active')`,
      [config.adminUsername, passwordHash, config.adminUsername],
    );
    console.log(`admin id=${result.insertId}`);
  }
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
