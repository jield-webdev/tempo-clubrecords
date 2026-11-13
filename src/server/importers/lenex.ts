import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import { all, discipline, insert, normalize, one, swimmer, transaction, type Db } from '../db.ts';
import {
  ageOnRaceYear,
  assignCategories,
  currentRecordKeys,
  eligibleCategories,
  getTeamCode,
  parseTime,
  rebuildRecords,
} from '../domain.ts';

type Xml = Record<string, any>;
const list = (v: any): Xml[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_XML_BYTES = 40 * 1024 * 1024;
const RECORD_SPLIT_DISTANCES = new Set([25, 50, 100, 200, 300, 400, 600, 800, 1500, 2000]);

function validDate(v: string | undefined): v is string {
  return (
    !!v &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v
  );
}

export function decodeLenex(bytes: Buffer): Xml {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('Bestand is groter dan 10 MB.');
  let xmlBytes: Uint8Array = bytes;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // Check ZIP's declared uncompressed size BEFORE allocation, then verify actual length as well.
    // fflate filter runs on central-directory metadata and prevents ZIP bombs/irrelevant entries.
    let total = 0,
      entries = 0;
    const files = unzipSync(bytes, {
      filter: (entry) => {
        if (!/\.(lef|xml)$/i.test(entry.name)) return false;
        total += entry.originalSize;
        entries++;
        if (total > MAX_XML_BYTES || entries > 1)
          throw new Error('Upload één LENEX-document per bestand (maximaal 40 MB uitgepakt).');
        return true;
      },
    });
    const values = Object.values(files);
    if (values.length !== 1)
      throw new Error('Het LXF-bestand moet precies één .lef- of .xml-document bevatten.');
    xmlBytes = values[0];
  }
  if (xmlBytes.length > MAX_XML_BYTES) throw new Error('XML is te groot.');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(xmlBytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('DTD en XML-entiteiten worden niet ondersteund.');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`Ongeldige XML: ${valid.err.msg}`);
  const doc = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    removeNSPrefix: true,
  }).parse(xml);
  if (!doc.LENEX || !list(doc.LENEX.MEETS?.MEET).length)
    throw new Error('Geen LENEX-wedstrijden gevonden.');
  return doc.LENEX;
}

/** A file is a complete snapshot of each included meet for the configured team.
 * Replace active meet versions atomically; retain original bytes and every old result.
 * Identical active bytes are idempotent, independent of filenames. Different bytes create revisions.
 */
export async function importLenex(db: Db, bytes: Buffer, filename: string) {
  filename = basename(filename.replaceAll('\\', '/'));
  const doc = decodeLenex(bytes);
  return transaction(db, async () => {
    const teamCode = await getTeamCode(db);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const previous = await one(
      db,
      `SELECT u.id
         FROM uploads u
         WHERE u.kind = 'lenex'
           AND u.sha256 = ?
           AND u.team_code = ?
           AND EXISTS(SELECT 1 FROM meet_versions WHERE upload_id = u.id)
           AND NOT EXISTS(SELECT 1 FROM meet_versions WHERE upload_id = u.id AND active = 0)
         ORDER BY u.id DESC LIMIT 1`,
      sha,
      teamCode,
    );
    if (previous)
      return {
        uploadId: previous.id,
        duplicate: true,
        results: 0,
        newRecords: 0,
        replacedMeets: 0,
        warnings: [] as string[],
      };
    const before = await currentRecordKeys(db),
      warnings: string[] = [];
    const uploadId = await insert(
      db,
      'INSERT INTO uploads(kind,filename,sha256,content,team_code) VALUES (?,?,?,?,?)',
      'lenex',
      filename,
      sha,
      bytes,
      teamCode,
    );
    let count = 0,
      replacedMeets = 0,
      matchedClubs = 0;
    const seenMeets = new Set<string>();
    for (const meet of list(doc.MEETS.MEET)) {
      const sessions = list(meet.SESSIONS?.SESSION);
      const dates = sessions
        .map((s) => s.date)
        .filter(validDate)
        .sort();
      if (!dates.length || dates.length !== sessions.length)
        throw new Error(`Ongeldige sessiedata in ${meet.name || 'wedstrijd'}`);
      const meetKey = meet.number
        ? `${meet.nation || ''}|${meet.number}|${dates[0]}`
        : `${normalize(meet.name || '')}|${normalize(meet.city || '')}|${dates[0]}`;
      if (seenMeets.has(meetKey))
        throw new Error('Dezelfde wedstrijd komt tweemaal in het document voor.');
      seenMeets.add(meetKey);
      const clubs = list(meet.CLUBS?.CLUB).filter((c) => c.code === teamCode);
      // A missing club is not silently interpreted as deletion. Reject the file below if none match.
      if (!clubs.length) {
        warnings.push(`${meet.name}: geen club ${teamCode}; deze wedstrijd is overgeslagen.`);
        continue;
      }
      matchedClubs += clubs.length;
      const course = meet.course || 'UNKNOWN';
      let existing = await one(db, 'SELECT * FROM meets WHERE meet_key=?', meetKey);
      const meetId =
        existing?.id ??
        (await insert(
          db,
          'INSERT INTO meets(meet_key,name,city,start_date,end_date,course) VALUES (?,?,?,?,?,?)',
          meetKey,
          meet.name || 'Wedstrijd',
          meet.city || '',
          dates[0],
          dates.at(-1)!,
          course,
        ));
      await db
        .prepare('UPDATE meets SET name=?,city=?,end_date=?,course=? WHERE id=?')
        .run(meet.name || 'Wedstrijd', meet.city || '', dates.at(-1)!, course, meetId);
      const version =
        (await one(db, 'SELECT MAX(revision) revision FROM meet_versions WHERE meet_id=?', meetId))
          ?.revision || 0;
      if (version) replacedMeets++;
      await db.prepare('UPDATE meet_versions SET active=0 WHERE meet_id=?').run(meetId);
      const versionId = await insert(
        db,
        'INSERT INTO meet_versions(meet_id,upload_id,revision) VALUES (?,?,?)',
        meetId,
        uploadId,
        version + 1,
      );
      const events = new Map<string, Xml>();
      for (const session of sessions)
        for (const event of list(session.EVENTS?.EVENT)) {
          if (!event.eventid || events.has(event.eventid))
            throw new Error('Ontbrekend of dubbel eventid.');
          events.set(event.eventid, {
            ...event,
            date: session.date,
            session: session.number,
            course: session.course || course,
          });
        }
      // Relay references may point at athletes in another club container. Resolve within the meet.
      const athletes = new Map<string, Xml>();
      for (const club of list(meet.CLUBS?.CLUB))
        for (const a of list(club.ATHLETES?.ATHLETE)) {
          if (athletes.has(a.athleteid)) throw new Error(`Dubbel athleteid: ${a.athleteid}`);
          athletes.set(a.athleteid, a);
        }

      async function who(a: Xml): Promise<number> {
        const name = [a.firstname, a.nameprefix, a.lastname].filter(Boolean).join(' ');
        if (!name || !['M', 'F'].includes(a.gender) || !validDate(a.birthdate))
          throw new Error(`Onvolledige zwemmergegevens: ${name || a.athleteid}`);
        return await swimmer(db, name, a.gender, a.birthdate, a.license, a.swrid, warnings);
      }

      const resultIds = new Set<string>();
      for (const club of clubs) {
        // Include even athletes with no results, as supplied by the export.
        for (const a of list(club.ATHLETES?.ATHLETE)) {
          const swimmerId = await who(a);
          for (const result of list(a.RESULTS?.RESULT))
            await saveResult(result, a, swimmerId, null);
        }
        for (const relay of list(club.RELAYS?.RELAY))
          for (const result of list(relay.RESULTS?.RESULT))
            await saveResult(result, null, null, relay);
      }

      async function saveResult(
        raw: Xml,
        a: Xml | null,
        swimmerId: number | null,
        relay: Xml | null,
      ) {
        const event = events.get(raw.eventid);
        if (!event) throw new Error(`Resultaat verwijst naar onbekende proef ${raw.eventid}.`);
        const st = event.SWIMSTYLE;
        if (!st) throw new Error(`Zwemslag ontbreekt voor proef ${raw.eventid}.`);
        const distance = Number(st.distance),
          relayCount = Number(st.relaycount || 1);
        if (
          !Number.isInteger(distance) ||
          distance <= 0 ||
          !Number.isInteger(relayCount) ||
          relayCount < 1
        )
          throw new Error('Ongeldige afstand of estafettegrootte.');
        if (!!relay !== relayCount > 1)
          throw new Error('Individueel/estafetteresultaat komt niet overeen met proef.');
        const gender = relay ? (['M', 'F'].includes(event.gender) ? event.gender : 'X') : a!.gender;
        const d = await discipline(db, st.stroke, distance, relayCount);
        const status = raw.status || 'OK';
        const time = parseTime(raw.swimtime || '');
        if (status === 'OK' && !time)
          throw new Error(`Geldige tijd ontbreekt voor resultaat ${raw.resultid || raw.eventid}.`);
        if (raw.resultid && resultIds.has(raw.resultid))
          throw new Error(`Dubbel resultid: ${raw.resultid}`);
        if (raw.resultid) resultIds.add(raw.resultid);
        const key = `${event.session}|${event.number}|${event.round}|${d}|${gender}`;
        const id = await insert(
          db,
          `INSERT INTO results(upload_id, meet_version_id, discipline_id, swimmer_id, gender, race_date,
                                         race_time, course, time_cs, status, event_key, external_id, round, heat, lane,
                                         points, comment, source_kind, raw_json)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'race', ?)`,
          uploadId,
          versionId,
          d,
          swimmerId,
          gender,
          event.date,
          event.daytime || null,
          event.course,
          time,
          status,
          key,
          raw.resultid || null,
          event.round || null,
          raw.heatid || null,
          raw.lane || null,
          raw.points ? Number(raw.points) : null,
          raw.comment || null,
          JSON.stringify(raw),
        );
        count++;
        let codes: string[] = [];
        if (a)
          codes = eligibleCategories(ageOnRaceYear(Number(a.birthdate.slice(0, 4)), event.date));
        else {
          // LENEX RELAYPOSITIONS belongs to RESULT; accept legacy relay-level placements too.
          const members = list(
            raw.RELAYPOSITIONS?.RELAYPOSITION ?? relay!.RELAYPOSITIONS?.RELAYPOSITION,
          );
          const ages: number[] = [];
          const used = new Set<number>();
          for (const member of members) {
            const memberAthlete = athletes.get(member.athleteid);
            if (!memberAthlete) throw new Error(`Onbekende estafettezwemmer ${member.athleteid}`);
            const memberId = await who(memberAthlete),
              pos = Number(member.order);
            if (!Number.isInteger(pos) || pos < 1 || pos > relayCount || used.has(pos))
              throw new Error('Ongeldige of dubbele estafettepositie.');
            used.add(pos);
            ages.push(ageOnRaceYear(Number(memberAthlete.birthdate.slice(0, 4)), event.date));
            await db.prepare('INSERT INTO relay_members VALUES (?,?,?)').run(id, pos, memberId);
          }
          if (ages.length === relayCount) {
            // The workbook uses individual year labels for relays, not summed Masters ages.
            // Youngest/senior mixed compositions have their own seed variants and are not inferred.
            const oldest = Math.max(...ages);
            codes = ['ALL'];
            if (oldest >= 8 && oldest <= 16) codes.push(`AGE_${oldest}`);
            if (ages.every((age) => age >= 17)) codes.push('SENIOR');
          } else
            warnings.push(
              `Estafette ${raw.resultid || event.number}: onvolledige ploeg; bewaard zonder automatische recordtoekenning.`,
            );
        }
        if (event.course === 'SCY' || !['SCM', 'LCM'].includes(event.course)) {
          codes = [];
          warnings.push(
            `Resultaat ${raw.resultid || event.number}: badlengte ${event.course} telt niet mee voor meterrecords.`,
          );
        }
        await assignCategories(db, id, d, gender, codes);
        for (const split of list(raw.SPLITS?.SPLIT)) {
          const meters = Number(split.distance),
            splitTime = parseTime(split.swimtime || '');
          if (
            !Number.isInteger(meters) ||
            meters <= 0 ||
            meters >= distance * relayCount ||
            !splitTime
          )
            throw new Error(`Ongeldige tussentijd voor ${raw.resultid}`);
          await db.prepare('INSERT INTO splits VALUES (?,?,?)').run(id, meters, splitTime);
          // Preserve all cumulative splits. A valid freestyle split can set a shorter-distance
          // record (the seed contains these). Do not turn medley transitions or flying starts
          // into individual stroke records. Relay lead-offs need separate official ratification.
          if (
            a &&
            st.stroke === 'FREE' &&
            status === 'OK' &&
            splitTime < time! &&
            RECORD_SPLIT_DISTANCES.has(meters)
          ) {
            const splitD = await discipline(db, 'FREE', meters);
            const splitId = await insert(
              db,
              `INSERT INTO results(upload_id, meet_version_id, discipline_id, swimmer_id, gender,
                                                 race_date, race_time, course, time_cs, status, event_key, source_kind,
                                                 parent_result_id)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OK', ?, 'split', ?)`,
              uploadId,
              versionId,
              splitD,
              swimmerId,
              gender,
              event.date,
              event.daytime || null,
              event.course,
              splitTime,
              `${key}:split:${meters}`,
              id,
            );
            await assignCategories(db, splitId, splitD, gender, codes);
          }
        }
      }
    }
    if (!matchedClubs)
      throw new Error(`Geen club met code ${teamCode} gevonden. Er is niets geïmporteerd.`);
    await rebuildRecords(db);
    const after = await currentRecordKeys(db);
    const newRecords = [...(await currentRecordKeys(db, uploadId))].filter(
      (key) => !before.has(key),
    ).length;
    const changedRecords = new Set(
      [...after]
        .filter((key) => !before.has(key))
        .concat([...before].filter((key) => !after.has(key)))
        .map((key) => key.split('|')[0]),
    ).size;
    await db
      .prepare('UPDATE uploads SET result_count=?,record_count=?,warnings=? WHERE id=?')
      .run(count, newRecords, JSON.stringify(warnings), uploadId);
    return {
      uploadId,
      duplicate: false,
      results: count,
      newRecords,
      changedRecords,
      replacedMeets,
      warnings,
    };
  });
}
