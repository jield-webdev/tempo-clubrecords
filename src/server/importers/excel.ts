import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  all,
  clearSportData,
  discipline,
  insert,
  one,
  slot,
  swimmer,
  transaction,
  type Db,
} from '../db.ts';
import { getTeamCode, parseTime, rebuildRecords } from '../domain.ts';

function text(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) return String(value.result ?? '').trim();
    if ('richText' in value)
      return value.richText
        .map((p) => p.text)
        .join('')
        .trim();
  }
  return String(value).trim();
}
function dateValue(cell: ExcelJS.Cell): { date: string | null; label: string | null } {
  if (cell.value instanceof Date)
    return { date: cell.value.toISOString().slice(0, 10), label: null };
  if (typeof cell.value === 'number')
    return {
      date: new Date(Date.UTC(1899, 11, 30) + Math.round(cell.value) * 86400000)
        .toISOString()
        .slice(0, 10),
      label: null,
    };
  return dateTextValue(text(cell));
}
function dateTextValue(value: string): { date: string | null; label: string | null } {
  const raw = value.trim();
  const dutch = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dutch)
    return {
      date: `${dutch[3]}-${dutch[2].padStart(2, '0')}-${dutch[1].padStart(2, '0')}`,
      label: null,
    };
  return { date: /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null, label: raw || null };
}
function categoryCode(value: string): string | null {
  if (/^(8|9|1[0-6])$/.test(value)) return `AGE_${value}`;
  if (/^(HR|DA|D\/H)$/i.test(value)) return 'SENIOR';
  if (value === 'AL') return 'ALL';
  if (/^\d+\+$/.test(value)) return `MASTERS_${parseInt(value)}`;
  return null;
}
function heading(value: string) {
  const m = value.match(/^(?:(\d+)\s*[xX×]\s*)?(\d+)\s*m?\s+(.*(?:slag|wissel).*)$/i);
  if (!m) return null;
  const name = m[3].toLowerCase();
  const stroke = name.includes('vrij')
    ? 'FREE'
    : name.includes('school')
      ? 'BREAST'
      : name.includes('rug')
        ? 'BACK'
        : name.includes('vlinder')
          ? 'FLY'
          : name.includes('wissel')
            ? 'MEDLEY'
            : null;
  return stroke ? { stroke, meters: Number(m[2]), count: Number(m[1] || 1) } : null;
}

/** The workbook is a record register, not a results log. Preserve row-specific category claims,
 * missing birthdays, historical seasons, special relay compositions, and split annotations.
 * Excel is used only here: subsequent imports and all UI reads use normalized SQL data.
 */
export async function importExcel(
  db: Db,
  bytes: Buffer,
  filename: string,
  options: { reset?: boolean } = {},
) {
  filename = basename(filename.replaceAll('\\', '/'));
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as any);
  const ageSheet = book.getWorksheet('Leeftijden');
  if (!ageSheet) throw new Error('Het werkblad Leeftijden ontbreekt.');
  // Verify ALL supplied matrix cells, rather than assuming birthdays or a sporting-season cutoff.
  let checked = 0;
  for (let c = 2; c <= ageSheet.columnCount; c++) {
    const year = Number(text(ageSheet.getCell(1, c)).match(/\d{4}/)?.[0]);
    if (!year) continue;
    for (let r = 2; r <= ageSheet.rowCount; r++) {
      const birth = Number(text(ageSheet.getCell(r, 1)));
      const actual = text(ageSheet.getCell(r, c));
      if (!birth || !actual) continue;
      const age = year - birth;
      const expected = age <= 0 ? '-' : age >= 17 ? 'heren/Dames' : String(age);
      if (actual.toLowerCase() !== expected.toLowerCase())
        throw new Error(
          `Afwijkende leeftijdsregel in Leeftijden!${ageSheet.getCell(r, c).address}: ${actual}, verwacht ${expected}`,
        );
      checked++;
    }
  }
  if (!checked) throw new Error('Geen leeftijdsmatrix gevonden.');
  return await transaction(db, async () => {
    if (!options.reset && (await one(db, "SELECT id FROM uploads WHERE kind='excel'")))
      throw new Error(
        'Er is al een Excel-startbestand geladen. Gebruik de CLI reset om opnieuw te beginnen.',
      );

    if (options.reset) await clearSportData(db);
    const warnings: string[] = [
      'Het Excel-bestand vermeldt geen badlengte. Startrecords behouden badlengte onbekend; clubrecords worden over badlengtes heen vergeleken.',
    ];
    const uploadId = await insert(
      db,
      'INSERT INTO uploads(kind,filename,sha256,content,team_code) VALUES (?,?,?,?,?)',
      'excel',
      filename,
      createHash('sha256').update(bytes).digest('hex'),
      bytes,
      await getTeamCode(db),
    );
    let rows = 0,
      emptySlots = 0;
    const uniqueResults = new Map<string, number>();
    const sheetCounts: Record<string, number> = {};
    for (const sheet of book.worksheets) {
      if (sheet.name === 'Leeftijden') continue;
      const relay = sheet.name.startsWith('Estafette');
      const groups = relay ? [1, 7, 13] : [1, 9];
      const active = new Map<number, { id: number; headerRow: number }>();
      sheetCounts[sheet.name] = 0;
      for (let r = 2; r <= sheet.rowCount; r++) {
        for (const c of groups) {
          const label = text(sheet.getCell(r, c));
          const h = heading(label);
          if (h) {
            // Two 8×50 mixed freestyle sections use explicitly different age compositions.
            // Give them separate discipline variants; ordinary relays must never overwrite these.
            let variant = '';
            if (
              relay &&
              sheet.name.includes('gemengd') &&
              text(sheet.getCell(r + 2, c)).includes('omschrijving')
            ) {
              variant = [3, 4, 5, 6, 7, 8]
                .map((offset) => text(sheet.getCell(r + offset, c)))
                .filter(Boolean)
                .join('; ');
              warnings.push(
                `${sheet.name}!${sheet.getCell(r, c).address}: bijzondere estafettesamenstelling bewaard als aparte discipline.`,
              );
            }
            active.set(c, {
              id: await discipline(db, h.stroke, h.meters, h.count, variant),
              headerRow: r,
            });
            continue;
          }
          // Parallel blocks can have different lengths: a new header row closes absent columns.
          if (groups.some((col) => heading(text(sheet.getCell(r, col)))) && !h) {
            active.delete(c);
            continue;
          }
          const a = active.get(c),
            code = categoryCode(label);
          if (!a || !code) continue;
          const gender = relay
            ? sheet.name.includes('gemengd')
              ? 'X'
              : sheet.name.includes('meisjes')
                ? 'F'
                : 'M'
            : c === 1
              ? 'M'
              : 'F';
          const slotId = await slot(db, a.id, code, gender);
          const timeCell = sheet.getCell(r, c + 2);
          const rawTime = text(timeCell);
          if (!rawTime) {
            emptySlots++;
            continue;
          }
          // The supplied workbook has two punctuation errors (2.42.04. and 4.01..33).
          // Only normalize unambiguous separator duplication; preserve the exact source in seed_rows.
          const cleanedTime = rawTime.replace(/\.{2,}/g, '.').replace(/\.$/, '');
          const time =
            typeof timeCell.value === 'number'
              ? Math.round(timeCell.value * 8640000)
              : parseTime(cleanedTime);
          if (!time)
            throw new Error(
              `Ongeldige recordtijd in ${sheet.name}!${timeCell.address}: ${rawTime}`,
            );
          if (rawTime !== cleanedTime)
            warnings.push(
              `${sheet.name}!${timeCell.address}: tijdnotatie genormaliseerd (${rawTime} → ${cleanedTime}).`,
            );
          const name = relay ? null : text(sheet.getCell(r, c + 4));
          if (!relay && !name)
            throw new Error(`Naam ontbreekt in ${sheet.name}!${timeCell.address}`);
          const date = dateValue(sheet.getCell(r, c + (relay ? 4 : 6)));
          const annotation = relay ? '' : text(sheet.getCell(r, c + 3));
          const raw = {
            category: label,
            time: rawTime,
            name,
            date: text(sheet.getCell(r, c + (relay ? 4 : 6))),
            annotation,
          };
          const sourceId = await insert(
            db,
            'INSERT INTO seed_rows(upload_id,sheet,cell,raw_json) VALUES (?,?,?,?)',
            uploadId,
            sheet.name,
            timeCell.address,
            JSON.stringify(raw),
          );
          // Vrij 25-200!K9 contains two equal recordholders and two dates in a single cell.
          // Split these into distinct swimmers/performances, linked back to the same source row.
          const names = name?.split(/\s*\/\s*/).map((n) => n.trim()) || [null];
          const dates = names.length > 1 ? raw.date.split(/\s*\/\s*/).map(dateTextValue) : [date];
          if (names.length !== dates.length)
            throw new Error(
              `Namen en datums komen niet overeen in ${sheet.name}!${timeCell.address}`,
            );
          if (names.length > 1)
            warnings.push(
              `${sheet.name}!${timeCell.address}: ${names.length} gedeelde recordhouders afzonderlijk opgeslagen.`,
            );
          for (let holder = 0; holder < names.length; holder++) {
            const who = names[holder] ? await swimmer(db, names[holder]!, gender) : null;
            const holderDate = dates[holder];
            if (!holderDate.date)
              warnings.push(
                `${sheet.name}!${timeCell.address}: exacte wedstrijddatum ontbreekt (${holderDate.label || 'leeg'}).`,
              );
            const key = JSON.stringify([a.id, who, gender, holderDate, time]);
            let resultId = uniqueResults.get(key);
            if (!resultId) {
              resultId = await insert(
                db,
                `INSERT INTO results(upload_id,discipline_id,swimmer_id,gender,race_date,date_label,course,time_cs,status,event_key,source_kind,comment)
                VALUES (?,?,?,?,?,?,'UNKNOWN',?,'OK',?,'seed',?)`,
                uploadId,
                a.id,
                who,
                gender,
                holderDate.date,
                holderDate.label,
                time,
                `${sheet.name}:${a.headerRow}`,
                annotation || null,
              );
              uniqueResults.set(key, resultId);
            }
            await db
              .prepare(
                'INSERT OR IGNORE INTO result_categories(result_id,slot_id,source_cell) VALUES (?,?,?)',
              )
              .run(resultId, slotId, `${sheet.name}!${timeCell.address}`);
            await db.prepare('INSERT INTO seed_row_results VALUES (?,?)').run(sourceId, resultId);
          }
          rows++;
          sheetCounts[sheet.name]++;
        }
      }
    }
    if (!rows) throw new Error('Geen clubrecords in het Excel-bestand gevonden.');
    await rebuildRecords(db);
    // Surface workbook contradictions without silently changing the association's baseline claims.
    const contradictions = await all(
      db,
      `SELECT d.id,s.name,di.meters,rs.gender,MIN(r.time_cs) fastest,
      MIN(CASE WHEN c.code='ALL' THEN r.time_cs END) all_time FROM result_categories rc
      JOIN record_slots rs ON rs.id=rc.slot_id JOIN results r ON r.id=rc.result_id JOIN categories c ON c.id=rs.category_id
      JOIN disciplines d ON d.id=rs.discipline_id JOIN strokes s ON s.id=d.stroke_id JOIN distances di ON di.id=d.distance_id
      WHERE c.kind<>'masters' GROUP BY d.id,rs.gender HAVING all_time>fastest`,
    );
    for (const issue of contradictions)
      warnings.push(
        `Broncontrole: ${issue.meters}m ${issue.name} (${issue.gender}) heeft een snellere leeftijds-/seniorentijd dan het AL-record. Bronwaarden zijn behouden.`,
      );
    warnings.push(
      'Namen en spelling uit Excel zijn behouden. Alleen gelijke namen (accenten/spaties genegeerd) worden gekoppeld; ontbrekende geboortedata blijven leeg.',
    );
    const summary = {
      uploadId,
      rows,
      results: uniqueResults.size,
      emptySlots,
      ageMatrixCells: checked,
      sheets: sheetCounts,
      warnings,
    };
    await db
      .prepare('UPDATE uploads SET result_count=?,record_count=?,warnings=? WHERE id=?')
      .run(uniqueResults.size, rows, JSON.stringify(warnings), uploadId);
    return summary;
  });
}
