import { readFileSync } from 'node:fs';
import { connect, type Db, type Input as SQLInputValue, type Row } from './connection.ts';
export { type Db, type Row } from './connection.ts';
export async function openDb(
  path = process.env.DATABASE_URL || process.env.DATABASE_PATH || './data/tempo.sqlite',
): Promise<Db> {
  const db = connect(path);
  try {
    if (db.dialect === 'sqlite')
      await db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    await db.exec(
      readFileSync(
        new URL(db.dialect === 'mysql' ? './schema.mysql.sql' : './schema.sql', import.meta.url),
        'utf8',
      ),
    );
    await db
      .prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)')
      .run('team_code', '13-036');
    for (const [code, name] of Object.entries({
      FREE: 'Vrije slag',
      BACK: 'Rugslag',
      BREAST: 'Schoolslag',
      FLY: 'Vlinderslag',
      MEDLEY: 'Wisselslag',
      IMRELAY: 'Wisselslag per zwemmer',
    })) {
      await db.prepare('INSERT OR IGNORE INTO strokes(code,name) VALUES (?,?)').run(code, name);
    }
    for (let age = 8; age <= 16; age++)
      await category(db, `AGE_${age}`, `${age} jaar`, 'age', age, age, age);
    await category(db, 'SENIOR', 'Senioren (17+)', 'senior', 17, null, 20);
    await category(db, 'ALL', 'Alle leeftijden', 'all', null, null, 0);
    for (let age = 30; age <= 80; age += 5)
      await category(
        db,
        `MASTERS_${age}`,
        `Masters ${age}+`,
        'masters',
        age,
        age === 80 ? null : age + 4,
        30 + age,
      );
    await db
      .prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)')
      .run('data_revision', '0');
    // Upgrade existing archives once, without changing original uploaded bytes or eligibility.
    if (!(await one(db, "SELECT 1 FROM settings WHERE key='course_records_v1'")))
      await db.transaction(async () => {
        if (await one(db, "SELECT 1 FROM settings WHERE key='course_records_v1'")) return;
        await db.prepare("UPDATE results SET course='SCM' WHERE source_kind='seed'").run();
        await db
          .prepare("UPDATE uploads SET warnings=REPLACE(warnings,?,?) WHERE kind='excel'")
          .run(
            'Het Excel-bestand vermeldt geen badlengte. Startrecords behouden badlengte onbekend; clubrecords worden over badlengtes heen vergeleken.',
            'Alle startrecords uit Excel worden als korte baan (25m, SCM) ingedeeld.',
          );
        const { rebuildRecords } = await import('./domain.ts');
        await rebuildRecords(db);
        await db
          .prepare('INSERT INTO settings(key,value) VALUES (?,?)')
          .run('course_records_v1', '1');
      });
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
async function category(db: Db, ...values: SQLInputValue[]) {
  await db
    .prepare(
      'INSERT OR IGNORE INTO categories(code,name,kind,min_age,max_age,sort_order) VALUES (?,?,?,?,?,?)',
    )
    .run(...values);
}
export async function all(db: Db, sql: string, ...args: SQLInputValue[]): Promise<Row[]> {
  return db.prepare(sql).all(...args);
}
export async function one(db: Db, sql: string, ...args: SQLInputValue[]): Promise<Row | undefined> {
  return db.prepare(sql).get(...args);
}
export async function insert(db: Db, sql: string, ...args: SQLInputValue[]): Promise<number> {
  return (await db.prepare(sql).run(...args)).lastInsertRowid;
}
export async function transaction<T>(db: Db, action: () => T | Promise<T>): Promise<T> {
  return db.transaction(action);
}
/** Caller owns the transaction so a failed replacement seed restores the entire old archive. */
export async function clearSportData(db: Db): Promise<void> {
  for (const table of [
    'record_progress',
    'result_categories',
    'seed_row_results',
    'seed_rows',
    'relay_members',
    'splits',
  ])
    await db.exec(`DELETE FROM ${table}`);
  await db.exec(
    'DELETE FROM results WHERE parent_result_id IS NOT NULL; DELETE FROM results; DELETE FROM meet_versions; DELETE FROM uploads; DELETE FROM meets; DELETE FROM swimmer_identifiers; DELETE FROM swimmers; DELETE FROM record_slots; DELETE FROM disciplines; DELETE FROM distances;',
  );
}
export const normalize = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
export async function discipline(
  db: Db,
  stroke: string,
  meters: number,
  count = 1,
  variant = '',
): Promise<number> {
  const s = await one(db, 'SELECT id FROM strokes WHERE code=?', stroke);
  if (!s) throw new Error(`Onbekende zwemslag: ${stroke}`);
  await db.prepare('INSERT OR IGNORE INTO distances(meters) VALUES (?)').run(meters);
  const d = (await one(db, 'SELECT id FROM distances WHERE meters=?', meters))!;
  await db
    .prepare(
      'INSERT OR IGNORE INTO disciplines(stroke_id,distance_id,relay_count,variant) VALUES (?,?,?,?)',
    )
    .run(s.id, d.id, count, variant);
  return (await one(
    db,
    'SELECT id FROM disciplines WHERE stroke_id=? AND distance_id=? AND relay_count=? AND variant=?',
    s.id,
    d.id,
    count,
    variant,
  ))!.id;
}
export async function slot(
  db: Db,
  disciplineId: number,
  categoryCode: string,
  gender: string,
): Promise<number> {
  const c = await one(db, 'SELECT id FROM categories WHERE code=?', categoryCode);
  if (!c) throw new Error(`Onbekende categorie: ${categoryCode}`);
  await db
    .prepare('INSERT OR IGNORE INTO record_slots(discipline_id,category_id,gender) VALUES (?,?,?)')
    .run(disciplineId, c.id, gender);
  return (await one(
    db,
    'SELECT id FROM record_slots WHERE discipline_id=? AND category_id=? AND gender=?',
    disciplineId,
    c.id,
    gender,
  ))!.id;
}
export async function swimmer(
  db: Db,
  name: string,
  gender: string,
  birthDate?: string,
  license?: string,
  swrid?: string,
  warnings: string[] = [],
): Promise<number> {
  // License and Swimrankings IDs are stable across files; athleteid is only local to one file.
  let found: Row | undefined;
  for (const [scheme, value] of [
    ['license', license],
    ['swrid', swrid],
  ] as const) {
    if (!value) continue;
    const existing = await one(
      db,
      'SELECT s.* FROM swimmers s JOIN swimmer_identifiers i ON i.swimmer_id=s.id WHERE i.scheme=? AND i.value=?',
      scheme,
      value,
    );
    if (found && existing && existing.id !== found.id)
      throw new Error(`Tegenstrijdige identificatie voor ${name}`);
    found ||= existing;
  }
  const key = normalize(name);
  if (!found) {
    const matches = await all(
      db,
      'SELECT * FROM swimmers WHERE normalized_name=? AND gender=? AND (birth_date IS NULL OR birth_date=?)',
      key,
      gender,
      birthDate || null,
    );
    const safe: Row[] = [];
    for (const match of matches) {
      if (
        !license ||
        !(await one(
          db,
          "SELECT 1 FROM swimmer_identifiers WHERE swimmer_id=? AND scheme='license' AND value<>?",
          match.id,
          license,
        ))
      )
        safe.push(match);
    }
    if (safe.length === 1) found = safe[0];
    else if (safe.length > 1)
      warnings.push(`Naam niet automatisch gekoppeld: ${name} (meerdere zwemmers).`);
  }
  const id =
    found?.id ??
    (await insert(
      db,
      'INSERT INTO swimmers(name,normalized_name,gender,birth_date,birth_year) VALUES (?,?,?,?,?)',
      name.trim(),
      key,
      gender,
      birthDate || null,
      birthDate ? Number(birthDate.slice(0, 4)) : null,
    ));
  if (found && birthDate) {
    if (found.birth_date && found.birth_date !== birthDate)
      throw new Error(`Afwijkende geboortedatum voor ${name}`);
    if (found.gender !== gender) throw new Error(`Afwijkend geslacht voor ${name}`);
    await db
      .prepare('UPDATE swimmers SET birth_date=?,birth_year=? WHERE id=?')
      .run(birthDate, Number(birthDate.slice(0, 4)), id);
  }
  for (const [scheme, value] of [
    ['license', license],
    ['swrid', swrid],
  ] as const)
    if (value)
      await db
        .prepare('INSERT OR IGNORE INTO swimmer_identifiers VALUES (?,?,?)')
        .run(scheme, value, id);
  return id;
}
