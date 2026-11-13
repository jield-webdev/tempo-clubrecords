import { all, one, slot, type Db } from './db.ts';

export function parseTime(value: string): number | null {
  // Excel uses m.ss.hh; LENEX uses hh:mm:ss.hh. Strip a known trailing full stop only.
  const s = value.trim().replace(/\.$/, '');
  let h = 0,
    m = 0,
    sec = 0,
    cs = 0;
  let hourFormat = false;
  let parts: RegExpMatchArray | null;
  if ((parts = s.match(/^(\d+):(\d{2}):(\d{2})[.,](\d{2})$/))) {
    [, h, m, sec, cs] = parts.map(Number);
    hourFormat = true;
  } else if ((parts = s.match(/^(\d+)[.:](\d{2})[.,](\d{2})$/))) [, m, sec, cs] = parts.map(Number);
  else return null;
  if (sec >= 60 || (hourFormat && m >= 60)) return null;
  const time = ((h * 60 + m) * 60 + sec) * 100 + cs;
  return time > 0 ? time : null;
}
export function formatTime(time: number | null): string {
  if (time == null) return '—';
  return `${Math.floor(time / 6000)}:${String(Math.floor(time / 100) % 60).padStart(2, '0')}.${String(time % 100).padStart(2, '0')}`;
}
export function ageOnRaceYear(birthYear: number, raceDate: string): number {
  return Number(raceDate.slice(0, 4)) - birthYear;
}
export function eligibleCategories(age: number): string[] {
  if (!Number.isInteger(age) || age < 1 || age > 120) return [];
  const codes = ['ALL'];
  if (age >= 8 && age <= 16) codes.push(`AGE_${age}`);
  if (age >= 17) codes.push('SENIOR');
  if (age >= 30) codes.push(`MASTERS_${Math.min(80, Math.floor(age / 5) * 5)}`);
  return codes;
}
export async function assignCategories(
  db: Db,
  resultId: number,
  disciplineId: number,
  gender: string,
  codes: string[],
) {
  for (const code of codes)
    await db
      .prepare('INSERT OR IGNORE INTO result_categories(result_id,slot_id) VALUES (?,?)')
      .run(resultId, await slot(db, disciplineId, code, gender));
}

/** Replay all active results in race-date order, not upload order. Rebuilding is intentional:
 * a corrected file can slow down, disqualify, or remove a former record and must restore its predecessor.
 * Workbook rows are baselines for ONLY their stated category. No birth dates are inferred from them.
 * The legacy workbook combines courses; preserve that policy while retaining SCM/LCM on every race.
 */
export async function rebuildRecords(db: Db): Promise<void> {
  await db.exec('DELETE FROM record_progress');
  const candidates = await all(
    db,
    `SELECT rc.slot_id,r.*,s.normalized_name,
    ${relayIdentity(db)} relay_identity
    FROM result_categories rc
    JOIN results r ON r.id=rc.result_id LEFT JOIN meet_versions v ON v.id=r.meet_version_id
    LEFT JOIN swimmers s ON s.id=r.swimmer_id
    WHERE r.status='OK' AND r.time_cs>0 AND (v.id IS NULL OR v.active=1)
    ORDER BY rc.slot_id,COALESCE(r.race_date,'0000-00-00'),COALESCE(r.race_time,'23:59:59'),
      CASE WHEN r.source_kind='seed' THEN 1 ELSE 0 END,r.id`,
  );
  let currentSlot = -1,
    best = Infinity;
  const seen = new Set<string>();
  for (const r of candidates) {
    if (r.slot_id !== currentSlot) {
      currentSlot = r.slot_id;
      best = Infinity;
      seen.clear();
    }
    const identity = `${r.swimmer_id || `relay:${r.relay_identity || 'unknown'}`}|${r.race_date || r.date_label}|${r.time_cs}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (r.time_cs <= best) {
      const type =
        r.time_cs === best
          ? 'equal'
          : Number.isFinite(best)
            ? 'broken'
            : r.source_kind === 'seed'
              ? 'baseline'
              : 'first';
      await db
        .prepare(
          'INSERT INTO record_progress(slot_id,result_id,previous_time_cs,change_type,is_current) VALUES (?,?,?,?,0)',
        )
        .run(r.slot_id, r.id, Number.isFinite(best) ? best : null, type);
      best = r.time_cs;
    }
  }
  const bestTimes = await all(
    db,
    'SELECT p.slot_id,MIN(r.time_cs) best FROM record_progress p JOIN results r ON r.id=p.result_id GROUP BY p.slot_id',
  );
  for (const row of bestTimes)
    await db
      .prepare(
        'UPDATE record_progress SET is_current=1 WHERE slot_id=? AND result_id IN (SELECT id FROM results WHERE time_cs=?)',
      )
      .run(row.slot_id, row.best);
}
export async function currentRecordKeys(db: Db, uploadId?: number): Promise<Set<string>> {
  return new Set(
    (
      await all(
        db,
        `SELECT p.slot_id,r.time_cs,
    ${db.dialect === 'mysql' ? `COALESCE(CAST(r.swimmer_id AS CHAR),CONCAT('relay:',COALESCE(${relayIdentity(db)},'unknown')))` : `COALESCE(CAST(r.swimmer_id AS TEXT),'relay:'||COALESCE(${relayIdentity(db)},'unknown'))`} identity,
    COALESCE(r.race_date,r.date_label) date
    FROM record_progress p JOIN results r ON r.id=p.result_id LEFT JOIN swimmers s ON s.id=r.swimmer_id WHERE is_current=1 ${uploadId ? 'AND r.upload_id=?' : ''}`,
        ...(uploadId ? [uploadId] : []),
      )
    ).map((r) => `${r.slot_id}|${r.time_cs}|${r.identity}|${r.date}`),
  );
}
export const getTeamCode = async (db: Db): Promise<string> =>
  (await one(db, "SELECT value FROM settings WHERE key='team_code'"))!.value;

function relayIdentity(db: Db): string {
  return db.dialect === 'mysql'
    ? "(SELECT GROUP_CONCAT(swimmer_id ORDER BY position SEPARATOR ',') FROM relay_members WHERE result_id=r.id)"
    : "(SELECT group_concat(swimmer_id,',') FROM (SELECT swimmer_id FROM relay_members WHERE result_id=r.id ORDER BY position))";
}
