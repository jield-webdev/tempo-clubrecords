import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSqlite } from '../src/server/migrate.ts';
import { createSession, verifyPassword } from '../src/server/auth.ts';
import mysql, { type Connection } from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { zipSync, strToU8 } from 'fflate';
import { all, one, openDb, type Db } from '../src/server/db.ts';
import { eligibleCategories, ageOnRaceYear, parseTime } from '../src/server/domain.ts';
import { importExcel } from '../src/server/importers/excel.ts';
import { decodeLenex, importLenex } from '../src/server/importers/lenex.ts';
import { records } from '../src/server/queries.ts';
import { setPassword } from '../src/server/auth.ts';
import { createApp } from '../src/server/app.ts';

const opened: Db[] = [];
const schemas: { connection: Connection; name: string }[] = [];

const db = async () => {
  let location = ':memory:';
  if (process.env.TEST_MYSQL_URL) {
    const url = new URL(process.env.TEST_MYSQL_URL);
    const name = `tempo_test_${process.pid}_${schemas.length}`;
    const connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await connection.query(`CREATE DATABASE ${name}`);
    schemas.push({ connection, name });
    url.pathname = `/${name}`;
    location = url.toString();
  }
  const value = await openDb(location);
  opened.push(value);
  return value;
};
afterEach(async () => {
  for (const value of opened.splice(0)) await value.close();
  for (const { connection, name } of schemas.splice(0)) {
    await connection.query(`DROP DATABASE ${name}`);
    await connection.end();
  }
});
function fixture({
  number = '1',
  date = '2026-01-10',
  time = '00:00:40.00',
  name = 'Test',
  license = '201001111',
  club = '13-036',
  status = '',
  stroke = 'FREE',
  split = '',
  empty = false,
} = {}) {
  return Buffer.from(
    `<?xml version="1.0"?><LENEX version="3.0"><MEETS><MEET name="Testwedstrijd" number="${number}" nation="NED" city="Valkenswaard" course="SCM"><SESSIONS><SESSION date="${date}" number="1"><EVENTS><EVENT eventid="1" number="1" round="TIM" gender="M" daytime="10:00"><SWIMSTYLE distance="50" relaycount="1" stroke="${stroke}"/></EVENT></EVENTS></SESSION></SESSIONS><CLUBS><CLUB code="${club}" name="Tempo"><ATHLETES><ATHLETE athleteid="1" firstname="${name}" lastname="Zwemmer" gender="M" birthdate="2010-12-06" license="${license}"><RESULTS>${empty ? '' : `<RESULT resultid="1" eventid="1" swimtime="${time}" ${status ? `status="${status}"` : ''}>${split ? `<SPLITS><SPLIT distance="25" swimtime="${split}"/></SPLITS>` : ''}</RESULT>`}</RESULTS></ATHLETE></ATHLETES></CLUB></CLUBS></MEET></MEETS></LENEX>`,
  );
}
const activeTimes = async (d: Db) =>
  (
    await all(
      d,
      'SELECT r.time_cs FROM record_progress p JOIN results r ON r.id=p.result_id WHERE p.is_current=1',
    )
  ).map((r) => r.time_cs);
describe('Swimming rules', () => {
  it('uses race year, including before a December birthday and senior/Masters boundaries', () => {
    expect(ageOnRaceYear(2010, '2026-01-01')).toBe(16);
    expect(eligibleCategories(16)).toEqual(['ALL', 'AGE_16']);
    expect(eligibleCategories(17)).toEqual(['ALL', 'SENIOR']);
    expect(eligibleCategories(29)).toEqual(['ALL', 'SENIOR']);
    expect(eligibleCategories(30)).toEqual(['ALL', 'SENIOR', 'MASTERS_30']);
    expect(eligibleCategories(34)).toContain('MASTERS_30');
    expect(eligibleCategories(35)).toContain('MASTERS_35');
    expect(eligibleCategories(7)).toEqual(['ALL']);
    expect(eligibleCategories(0)).toEqual([]);
  });
  it('compares exact hundredths and rejects invalid/zero times', () => {
    expect(parseTime('0.25.84')).toBe(2584);
    expect(parseTime('00:01:04.16')).toBe(6416);
    expect(parseTime('18.25.03')).toBe(110503);
    expect(parseTime('1:60.00')).toBeNull();
    expect(parseTime('00:61:00.00')).toBeNull();
    expect(parseTime('00:00:00.00')).toBeNull();
  });
});
describe('Supplied workbook and LENEX exports', () => {
  it('rolls back a failed reset and preserves the previous archive and credentials', async () => {
    const d = await db();
    await setPassword(d, 'keep-this-password');
    await importLenex(d, fixture(), 'existing.lef');
    await d.exec(
      d.dialect === 'mysql'
        ? "CREATE TRIGGER fail_seed BEFORE INSERT ON seed_rows FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='simulated import failure'"
        : "CREATE TEMP TRIGGER fail_seed BEFORE INSERT ON seed_rows BEGIN SELECT RAISE(ABORT,'simulated import failure'); END;",
    );
    await expect(
      importExcel(d, await workbook(), 'replacement.xlsx', {
        reset: true,
      }),
    ).rejects.toThrow('simulated import failure');
    expect(await activeTimes(d)).toEqual([4000, 4000]);
    expect((await one(d, 'SELECT filename FROM uploads'))!.filename).toBe('existing.lef');
    expect((await one(d, 'SELECT COUNT(*) n FROM admin_credentials'))!.n).toBe(1);
  });
  it.skipIf(
    !['Tempo clubrecords 2026.xlsx', '2026_ITT_Results_Total.lxf', 'results (2).lxf'].every(
      existsSync,
    ),
  )('reconciles every seed row, shared holders, seasons, and special relay variants', async () => {
    const d = await db();
    const summary = await importExcel(d, readFileSync('Tempo clubrecords 2026.xlsx'), 'seed.xlsx');
    expect(summary.rows).toBe(795);
    expect(summary.results).toBe(682);
    expect(summary.ageMatrixCells).toBe(279);
    expect(Object.keys(summary.sheets)).toHaveLength(15);
    expect((await one(d, 'SELECT COUNT(*) n FROM seed_rows'))!.n).toBe(795);
    expect((await one(d, 'SELECT COUNT(*) n FROM result_categories'))!.n).toBe(796);
    expect(
      (await one(d, 'SELECT COUNT(DISTINCT slot_id) n FROM record_progress WHERE is_current=1'))!.n,
    ).toBe(795);
    expect((await one(d, "SELECT COUNT(*) n FROM disciplines WHERE variant<>''"))!.n).toBe(2);
    expect((await one(d, "SELECT COUNT(*) n FROM swimmers WHERE name LIKE '%/%'"))!.n).toBe(0);
    expect(
      (await one(d, "SELECT COUNT(*) n FROM results WHERE date_label LIKE '%76/77%'"))!.n,
    ).toBeGreaterThan(0);
    expect((await one(d, 'SELECT COUNT(*) n FROM swimmers WHERE birth_date IS NOT NULL'))!.n).toBe(
      0,
    );
    const tied = await all(
      d,
      `SELECT s.name,r.race_date FROM seed_rows sr JOIN seed_row_results srr ON srr.seed_row_id=sr.id JOIN results r ON r.id=srr.result_id JOIN swimmers s ON s.id=r.swimmer_id WHERE sr.sheet='Vrij 25-200' AND sr.cell='K9' ORDER BY r.race_date`,
    );
    expect(tied.map((r) => r.race_date)).toEqual(['2011-11-19', '2016-07-03']);
    const a = await importLenex(d, readFileSync('2026_ITT_Results_Total.lxf'), 'march.lxf');
    expect(a.results).toBe(25);
    expect(a.newRecords).toBe(0);
    const b = await importLenex(d, readFileSync('results (2).lxf'), 'october.lxf');
    expect(b.results).toBe(3);
    expect(b.newRecords).toBe(1);
    expect((await one(d, "SELECT COUNT(*) n FROM results WHERE source_kind='race'"))!.n).toBe(28);
    expect((await one(d, "SELECT COUNT(*) n FROM results WHERE status='DSQ'"))!.n).toBe(1);
    expect(
      (await one(
        d,
        "SELECT COUNT(*) n FROM record_progress p JOIN results r ON r.id=p.result_id WHERE r.status<>'OK'",
      ))!.n,
    ).toBe(0);
    expect(
      (await one(d, 'SELECT COUNT(*) n FROM distances WHERE meters IN (150,250,350)'))!.n,
    ).toBe(0);
    const senn = (
      await records(d, {
        type: 'individual',
        category: 'AGE_16',
        stroke: 'BACK',
        distance: '50',
        gender: 'M',
      })
    ).rows;
    expect(senn).toHaveLength(1);
    expect(senn[0].time).toBe('0:29.04');
    expect(senn[0].swimmer_name).toBe('Senn van Tongeren');
    if (d.dialect === 'sqlite') {
      expect(await all(d, 'PRAGMA foreign_key_check')).toHaveLength(0);
      expect((await one(d, 'PRAGMA integrity_check'))!.integrity_check).toBe('ok');
    }
  });
});
describe('Versioned imports', () => {
  it('is idempotent by content, even under a different filename', async () => {
    const d = await db(),
      file = fixture();
    await importLenex(d, file, 'one.lef');
    expect((await importLenex(d, file, 'renamed.xml')).duplicate).toBe(true);
    expect((await one(d, 'SELECT COUNT(*) n FROM uploads'))!.n).toBe(1);
    expect(await activeTimes(d)).toEqual([4000, 4000]);
  });
  it('restores earlier records after a slower correction, DSQ, and removed race', async () => {
    const d = await db();
    await importLenex(d, fixture(), 'january.lef');
    await importLenex(
      d,
      fixture({ number: '2', date: '2026-02-10', time: '00:00:35.00' }),
      'february.lef',
    );
    expect(await activeTimes(d)).toEqual([3500, 3500]);
    const correction = await importLenex(
      d,
      fixture({ number: '2', date: '2026-02-10', time: '00:00:45.00' }),
      'corrected.lef',
    );
    expect(correction.replacedMeets).toBe(1);
    expect(correction.newRecords).toBe(0);
    expect(await activeTimes(d)).toEqual([4000, 4000]);
    await importLenex(
      d,
      fixture({ number: '2', date: '2026-02-10', time: '00:00:00.00', status: 'DSQ' }),
      'dsq.lef',
    );
    expect(await activeTimes(d)).toEqual([4000, 4000]);
    await importLenex(d, fixture({ number: '2', date: '2026-02-10', empty: true }), 'removed.lef');
    expect(await activeTimes(d)).toEqual([4000, 4000]);
    expect((await one(d, 'SELECT COUNT(*) n FROM meet_versions'))!.n).toBe(5);
    expect((await one(d, 'SELECT COUNT(*) n FROM meet_versions WHERE active=1'))!.n).toBe(2);
    expect((await one(d, "SELECT COUNT(*) n FROM results WHERE status='DSQ'"))!.n).toBe(1);
  });
  it('replays dates rather than upload order and preserves equal holders', async () => {
    const d = await db();
    await importLenex(
      d,
      fixture({ number: '2', date: '2026-02-10', time: '00:00:35.00' }),
      'later.lef',
    );
    await importLenex(d, fixture(), 'earlier.lef');
    expect(await activeTimes(d)).toEqual([3500, 3500]);
    await importLenex(
      d,
      fixture({
        number: '3',
        date: '2026-03-10',
        name: 'Andere',
        license: '201002222',
        time: '00:00:35.00',
      }),
      'equal.lef',
    );
    expect(await activeTimes(d)).toEqual([3500, 3500, 3500, 3500]);
    expect(
      (await one(d, "SELECT COUNT(*) n FROM record_progress WHERE change_type='equal'"))!.n,
    ).toBe(2);
  });
  it('rolls back completely when club, event, identity or XML validation fails', async () => {
    const d = await db();
    await expect(importLenex(d, fixture({ club: '99-999' }), 'wrong.lef')).rejects.toThrow(
      '13-036',
    );
    expect((await one(d, 'SELECT COUNT(*) n FROM uploads'))!.n).toBe(0);
    await importLenex(d, fixture(), 'good.lef');
    const invalid = Buffer.from(fixture({ time: 'invalid' }));
    await expect(importLenex(d, invalid, 'bad.lef')).rejects.toThrow('tijd');
    expect((await one(d, 'SELECT COUNT(*) n FROM uploads'))!.n).toBe(1);
    expect(await activeTimes(d)).toEqual([4000, 4000]);
    expect(() => decodeLenex(Buffer.from('<LENEX>'))).toThrow('XML');
    expect(() => decodeLenex(Buffer.from('<!DOCTYPE LENEX><LENEX/>'))).toThrow('DTD');
    expect(() =>
      decodeLenex(Buffer.from(zipSync({ 'a.lef': fixture(), 'b.lef': fixture() }))),
    ).toThrow('één');
  });
  it('keeps freestyle splits but never promotes medley transitions or DSQ splits', async () => {
    const d = await db();
    await importLenex(d, fixture({ split: '00:00:15.01' }), 'free.lef');
    expect((await one(d, "SELECT COUNT(*) n FROM results WHERE source_kind='split'"))!.n).toBe(1);
    expect((await one(d, 'SELECT COUNT(*) n FROM splits'))!.n).toBe(1);
    await importLenex(
      d,
      fixture({ number: '2', stroke: 'MEDLEY', split: '00:00:15.00' }),
      'medley.lef',
    );
    await importLenex(d, fixture({ number: '3', split: '00:00:15.00', status: 'DSQ' }), 'dsq.lef');
    expect((await one(d, "SELECT COUNT(*) n FROM results WHERE source_kind='split'"))!.n).toBe(1);
  });
  it('respects the configurable exact club code and stable swimmer licenses', async () => {
    const d = await db();
    await d.prepare("UPDATE settings SET value='99-999' WHERE key='team_code'").run();
    await importLenex(d, fixture({ club: '99-999', name: 'Tést' }), 'custom.lef');
    await importLenex(d, fixture({ club: '99-999', name: 'Test', number: '2' }), 'other.lef');
    expect((await one(d, 'SELECT COUNT(*) n FROM swimmers'))!.n).toBe(1);
    expect((await one(d, 'SELECT team_code FROM uploads LIMIT 1'))!.team_code).toBe('99-999');
  });
});
describe('Relays', () => {
  function relayFile(incomplete = false) {
    const members = Array.from(
      { length: 4 },
      (_, i) =>
        `<ATHLETE athleteid="${i + 1}" firstname="Team${i}" lastname="Tempo" gender="${i < 2 ? 'M' : 'F'}" birthdate="${2010 + (i % 2)}-01-01"/>`,
    ).join('');
    const positions = Array.from(
      { length: incomplete ? 3 : 4 },
      (_, i) => `<RELAYPOSITION order="${i + 1}" athleteid="${i + 1}"/>`,
    ).join('');
    return Buffer.from(
      `<LENEX version="3.0"><MEETS><MEET number="77" name="Relay" nation="NED" city="Valkenswaard" course="LCM"><SESSIONS><SESSION date="2026-10-10" number="1"><EVENTS><EVENT eventid="1" number="1" gender="X"><SWIMSTYLE distance="50" relaycount="4" stroke="FREE"/></EVENT></EVENTS></SESSION></SESSIONS><CLUBS><CLUB code="13-036"><ATHLETES>${members}</ATHLETES><RELAYS><RELAY number="1" gender="X"><RESULTS><RESULT eventid="1" resultid="55" swimtime="00:02:00.00"><RELAYPOSITIONS>${positions}</RELAYPOSITIONS></RESULT></RESULTS></RELAY></RELAYS></CLUB></CLUBS></MEET></MEETS></LENEX>`,
    );
  }
  it('uses leg distance, keeps all members, and classifies by the oldest youth swimmer', async () => {
    const d = await db();
    await importLenex(d, relayFile(), 'relay.xml');
    const rows = (await records(d, { type: 'relay' })).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].event).toBe('4 × 50m Vrije slag');
    expect(rows[0].members).toHaveLength(4);
    expect(rows.map((r) => r.category_code)).toContain('AGE_16');
    expect(rows[0].gender).toBe('X');
  });
  it('stores incomplete teams without guessing record eligibility', async () => {
    const d = await db();
    const summary = await importLenex(d, relayFile(true), 'incomplete.xml');
    expect(summary.results).toBe(1);
    expect(summary.warnings).toHaveLength(1);
    expect(await activeTimes(d)).toEqual([]);
  });
});
describe('HTTP admin boundary', () => {
  it('requires authentication and CSRF header, hides birthdays, and permits authenticated settings', async () => {
    const d = await db();
    await setPassword(d, 'a-long-test-password');
    const app = await createApp(d);
    try {
      expect((await app.inject('/api/admin/uploads')).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { password: 'a-long-test-password' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            headers: { 'x-tempo-request': '1' },
            payload: { password: 'wrong' },
          })
        ).statusCode,
      ).toBe(401);
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { 'x-tempo-request': '1' },
        payload: { password: 'a-long-test-password' },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies[0];
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe('Strict');
      const auth = {
        headers: { 'x-tempo-request': '1' },
        cookies: { tempo_session: cookie.value },
      };
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/admin/settings',
            ...auth,
            payload: { teamCode: '99-999' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/admin/settings',
            ...auth,
            payload: { teamCode: 'bad' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/admin/settings',
            ...auth,
            headers: { ...auth.headers, origin: 'https://evil.example' },
            payload: { teamCode: '99-999' },
          })
        ).statusCode,
      ).toBe(403);
      expect((await app.inject('/api/meta')).json().teamCode).toBe('99-999');
      expect((await app.inject('/api/swimmers')).body).not.toContain('birth_date');
      const boundary = 'tempo-test-boundary';
      const file = fixture({ club: '99-999' });
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="meet.lef"\r\nContent-Type: application/xml\r\n\r\n`,
        ),
        file,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const upload = await app.inject({
        method: 'POST',
        url: '/api/admin/uploads',
        cookies: auth.cookies,
        headers: { ...auth.headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(upload.statusCode).toBe(200);
      expect(upload.json().results).toBe(1);
      const original = await app.inject({
        url: `/api/admin/uploads/${upload.json().uploadId}/download`,
        cookies: auth.cookies,
      });
      expect(original.statusCode).toBe(200);
      expect(original.rawPayload.equals(file)).toBe(true);
      expect((await app.inject('/api/results')).body).not.toContain('2010-12-06');
      await app.inject({ method: 'POST', url: '/api/logout', ...auth });
      expect(
        (await app.inject({ url: '/api/admin/uploads', cookies: auth.cookies })).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});

async function workbook() {
  const book = new ExcelJS.Workbook();
  const ages = book.addWorksheet('Leeftijden');
  ages.getCell('B1').value = '2026';
  ages.getCell('A2').value = 2010;
  ages.getCell('B2').value = '16';
  const sheet = book.addWorksheet('Vrij');
  sheet.getCell('A2').value = '50 m vrije slag';
  sheet.getCell('A3').value = '16';
  sheet.getCell('C3').value = '0.40.00';
  sheet.getCell('E3').value = 'Test Zwemmer';
  sheet.getCell('G3').value = '2026-01-10';
  return Buffer.from(await book.xlsx.writeBuffer());
}

it('imports a generated Excel baseline, rejects duplicates, and atomically resets it', async () => {
  const d = await db();
  const bytes = await workbook();
  expect((await importExcel(d, bytes, 'seed.xlsx')).results).toBe(1);
  await expect(importExcel(d, bytes, 'duplicate.xlsx')).rejects.toThrow('al een Excel');
  expect((await importExcel(d, bytes, 'replacement.xlsx', { reset: true })).results).toBe(1);
  expect((await records(d, {})).rows[0].time).toBe('0:40.00');
  expect((await one(d, 'SELECT COUNT(*) n FROM uploads'))!.n).toBe(1);
});

it('serializes concurrent identical imports and rolls back failed transactions', async () => {
  const d = await db();
  const summaries = await Promise.all([
    importLenex(d, fixture(), 'a.lef'),
    importLenex(d, fixture(), 'b.lef'),
  ]);
  expect(summaries.filter((s) => s.duplicate)).toHaveLength(1);
  expect((await one(d, 'SELECT COUNT(*) n FROM uploads'))!.n).toBe(1);
});

it.skipIf(!process.env.TEST_MYSQL_URL)(
  'migrates an archive with original bytes and credentials, and refuses a populated target',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tempo-migration-'));
    const path = join(dir, 'source.sqlite');
    const source = await openDb(path);
    try {
      const bytes = fixture({ split: '00:00:15.00' });
      await setPassword(source, 'migration-test-password');
      await createSession(source);
      await importLenex(source, bytes, 'original.lef');
      const target = await db();
      const counts = await migrateSqlite(target, path);
      expect(counts.results).toBe(2);
      expect(Buffer.from((await one(target, 'SELECT content FROM uploads'))!.content)).toEqual(
        bytes,
      );
      expect(await records(target, {})).toEqual(await records(source, {}));
      expect(await verifyPassword(target, 'migration-test-password')).toBe(true);
      expect((await one(target, 'SELECT COUNT(*) n FROM sessions'))!.n).toBe(0);
      await expect(migrateSqlite(target, path)).rejects.toThrow('not empty');
    } finally {
      await source.close();
      rmSync(dir, { recursive: true });
    }
  },
);
