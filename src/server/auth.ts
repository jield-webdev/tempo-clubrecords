import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { one, type Db } from './db.ts';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function setPassword(db: Db, password: string) {
  if (password.length < 12) throw new Error('Gebruik een wachtwoord van minimaal 12 tekens.');
  const salt = randomBytes(16).toString('hex');
  const hash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  await db
    .prepare(
      db.dialect === 'mysql'
        ? 'INSERT INTO admin_credentials VALUES (1,?) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash)'
        : 'INSERT INTO admin_credentials VALUES (1,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash',
    )
    .run(hash);
  await db.exec('DELETE FROM sessions');
}
export async function verifyPassword(db: Db, password: string) {
  const row = await one(db, 'SELECT password_hash FROM admin_credentials WHERE id=1');
  // Pay the hashing cost even when no account is configured.
  const [salt, stored] = (row?.password_hash || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(stored, 'hex')) && !!row;
}
export async function createSession(db: Db) {
  await db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  const token = randomBytes(32).toString('hex');
  await db
    .prepare('INSERT INTO sessions VALUES (?,?)')
    .run(tokenHash(token), Date.now() + 8 * 60 * 60 * 1000);
  return token;
}
export async function isAuthenticated(db: Db, token?: string) {
  return (
    !!token &&
    !!(await one(
      db,
      'SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?',
      tokenHash(token),
      Date.now(),
    ))
  );
}
