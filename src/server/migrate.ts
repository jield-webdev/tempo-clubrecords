import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { one, transaction, type Db } from './db.ts';

// Parent tables precede their children; result parents precede splits/lead-offs by ID.
const tables = [
  'settings',
  'strokes',
  'distances',
  'disciplines',
  'categories',
  'record_slots',
  'swimmers',
  'swimmer_identifiers',
  'meets',
  'uploads',
  'meet_versions',
  'results',
  'relay_members',
  'splits',
  'result_categories',
  'seed_rows',
  'seed_row_results',
  'record_progress',
  'admin_credentials',
] as const;

/** Copies a read-only snapshot. The target must contain only bootstrap lookup rows.
 * Sessions are deliberately expired. A failure rolls back all copied data. */
export async function migrateSqlite(target: Db, sourcePath: string) {
  if (target.dialect !== 'mysql') throw new Error('Migration requires DATABASE_URL=mysql://...');
  const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
  try {
    source.exec('BEGIN');
    const counts: Record<string, number> = {};
    await transaction(target, async () => {
      for (const table of [
        'uploads',
        'results',
        'swimmers',
        'meets',
        'disciplines',
        'record_slots',
        'distances',
        'admin_credentials',
        'sessions',
      ]) {
        if ((await one(target, `SELECT COUNT(*) n FROM ${table}`))!.n)
          throw new Error(`Target is not empty (${table}). Use a new database.`);
      }
      // IDs of initialized lookup tables must match the source exactly.
      for (const table of ['categories', 'strokes', 'settings'])
        await target.exec(`DELETE FROM ${table}`);
      for (const table of tables) {
        const rows = source
          .prepare(`SELECT * FROM ${table}${table === 'results' ? ' ORDER BY id' : ''}`)
          .all() as Record<string, any>[];
        for (const row of rows) {
          const columns = Object.keys(row);
          // Quote only known source schema names; the adapter handles reserved key/round.
          const values = columns.map((c) =>
            table === 'uploads' && c === 'created_at'
              ? new Date(row[c]).toISOString().replace('T', ' ').replace('Z', '')
              : row[c],
          );
          await target
            .prepare(
              `INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            )
            .run(...values);
        }
        counts[table] = rows.length;
        if ((await one(target, `SELECT COUNT(*) n FROM ${table}`))!.n !== rows.length)
          throw new Error(`Row count mismatch for ${table}`);
      }
      await target
        .prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)')
        .run('data_revision', '0');
      await target.prepare("UPDATE results SET course='SCM' WHERE source_kind='seed'").run();
      const { rebuildRecords } = await import('./domain.ts');
      await rebuildRecords(target);
      await target
        .prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)')
        .run('course_records_v1', '1');
    });
    source.exec('ROLLBACK');
    return counts;
  } finally {
    source.close();
  }
}
