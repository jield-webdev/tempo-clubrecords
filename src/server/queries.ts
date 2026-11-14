import { all, one, type Db, type Row } from './db.ts';
import { formatTime, getTeamCode } from './domain.ts';

const resultSelect = `r.id,r.swimmer_id,r.race_date,r.date_label,r.course,r.time_cs,r.status,r.source_kind,
  r.comment,r.round,r.upload_id,s.name swimmer_name,di.meters,d.relay_count,d.variant,st.code stroke,st.name stroke_name,
  m.name meet_name,m.city,u.filename`;
const resultJoins = `JOIN disciplines d ON d.id=r.discipline_id JOIN distances di ON di.id=d.distance_id
  JOIN strokes st ON st.id=d.stroke_id LEFT JOIN swimmers s ON s.id=r.swimmer_id
  LEFT JOIN meet_versions v ON v.id=r.meet_version_id LEFT JOIN meets m ON m.id=v.meet_id JOIN uploads u ON u.id=r.upload_id`;

export async function decorate(db: Db, row: Row): Promise<Row> {
  return {
    ...row,
    time: formatTime(row.time_cs),
    event: `${row.relay_count > 1 ? `${row.relay_count} × ` : ''}${row.meters}m ${row.stroke_name}`,
    swimmer_name: row.swimmer_name || 'Tempo estafette',
    members:
      row.relay_count > 1
        ? await all(
            db,
            'SELECT s.id,s.name,rm.position FROM relay_members rm JOIN swimmers s ON s.id=rm.swimmer_id WHERE result_id=? ORDER BY position',
            row.id,
          )
        : [],
  };
}

export async function meta(db: Db) {
  return {
    teamCode: await getTeamCode(db),
    clubName: 'Tempo Valkenswaard',
    categories: await all(db, 'SELECT code,name,kind FROM categories ORDER BY sort_order'),
    strokes: await all(db, 'SELECT code,name FROM strokes'),
    distances: await all(db, 'SELECT meters FROM distances ORDER BY meters'),
    stats: {
      records: (await one(
        db,
        'SELECT COUNT(*) n FROM (SELECT p.slot_id,r.course FROM record_progress p JOIN results r ON r.id=p.result_id WHERE p.is_current=1 GROUP BY p.slot_id,r.course) current_slots',
      ))!.n,
      swimmers: (await one(db, 'SELECT COUNT(*) n FROM swimmers'))!.n,
      results: (await one(
        db,
        `SELECT COUNT(*) n
                 FROM results r
                          LEFT JOIN meet_versions v ON v.id = r.meet_version_id
                 WHERE r.source_kind = 'race'
                   AND v.active = 1`,
      ))!.n,
      meets: (await one(db, 'SELECT COUNT(*) n FROM meets'))!.n,
      lastImport:
        (await one(db, 'SELECT created_at FROM uploads ORDER BY id DESC LIMIT 1'))?.created_at ??
        null,
    },
    policy: {
      age: 'Wedstrijdjaar − geboortejaar, ongeacht verjaardag.',
      courses:
        'Clubrecords worden afzonderlijk bijgehouden voor 25m (SCM) en 50m (LCM). Alle startrecords uit Excel zijn 25m.',
    },
  };
}

function filters(params: Record<string, string>, alias: string, records: boolean) {
  const where: string[] = [],
    args: any[] = [];
  for (const [key, column] of [
    ['stroke', 'st.code'],
    ['gender', records ? 'rs.gender' : 'r.gender'],
    ['distance', 'di.meters'],
  ] as const) {
    if (params[key]) {
      where.push(`${column}=?`);
      args.push(params[key]);
    }
  }
  if (params.type === 'relay') where.push('d.relay_count>1');
  else if (params.type === 'individual') where.push('d.relay_count=1');
  if (records && params.category) {
    where.push('c.code=?');
    args.push(params.category);
  }
  if (params.q) {
    where.push(
      `(s.name LIKE ? OR s.normalized_name LIKE ? OR m.name LIKE ? OR EXISTS(SELECT 1 FROM relay_members rm JOIN swimmers sm ON sm.id=rm.swimmer_id WHERE rm.result_id=r.id AND sm.name LIKE ?))`,
    );
    args.push(
      `%${params.q}%`,
      `%${params.q
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')}%`,
      `%${params.q}%`,
      `%${params.q}%`,
    );
  }
  if (!records && params.swimmer) {
    where.push(
      '(r.swimmer_id=? OR EXISTS(SELECT 1 FROM relay_members rm WHERE rm.result_id=r.id AND rm.swimmer_id=?))',
    );
    args.push(Number(params.swimmer), Number(params.swimmer));
  }
  if (params.course) {
    where.push('r.course=?');
    args.push(params.course);
  }
  return { sql: where.length ? ` AND ${where.join(' AND ')}` : '', args };
}

export async function records(db: Db, params: Record<string, string>) {
  const f = filters(params, 'r', true);
  const from = `FROM record_progress p JOIN results r ON r.id=p.result_id ${resultJoins}
    JOIN record_slots rs ON rs.id=p.slot_id JOIN categories c ON c.id=rs.category_id WHERE p.is_current=1 ${f.sql}`;
  const total = (await one(db, `SELECT COUNT(*) n ${from}`, ...f.args))!.n;
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 25));
  const page = Math.max(1, Number(params.page) || 1);
  const rows = await all(
    db,
    `SELECT ${resultSelect},p.slot_id,p.change_type,rs.gender,c.name category,c.code category_code ${from}
    ORDER BY st.id,di.meters,d.relay_count,c.sort_order,rs.gender,r.race_date LIMIT ? OFFSET ?`,
    ...f.args,
    limit,
    (page - 1) * limit,
  );
  return { rows: await Promise.all(rows.map((r) => decorate(db, r))), total, page, limit };
}

export async function results(db: Db, params: Record<string, string>) {
  const f = filters(params, 'r', false);
  const from = `FROM results r ${resultJoins} WHERE (v.id IS NULL OR v.active=1) AND r.source_kind IN ('race','seed') ${f.sql}`;
  const total = (await one(db, `SELECT COUNT(*) n ${from}`, ...f.args))!.n;
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 25));
  const page = Math.max(1, Number(params.page) || 1);
  return {
    rows: await Promise.all(
      (
        await all(
          db,
          `SELECT ${resultSelect},
                    r.gender,
                    EXISTS(SELECT 1 FROM record_progress WHERE result_id = r.id AND is_current = 1) is_record ${from}
             ORDER BY r.race_date DESC, r.id DESC
             LIMIT ? OFFSET ?`,
          ...f.args,
          limit,
          (page - 1) * limit,
        )
      ).map((r) => decorate(db, r)),
    ),
    total,
    page,
    limit,
  };
}

export async function history(db: Db, slotId?: number, course?: string) {
  const rows = await all(
    db,
    `SELECT ${resultSelect}, p.slot_id, p.previous_time_cs, p.change_type, p.is_current, c.name category, rs.gender
         FROM record_progress p
                  JOIN results r ON r.id = p.result_id ${resultJoins}
    JOIN record_slots rs
         ON rs.id=p.slot_id JOIN categories c ON c.id=rs.category_id
             ${slotId ? 'WHERE p.slot_id=?' : "WHERE r.source_kind<>'seed' AND p.is_current=1"} ${course ? 'AND r.course=?' : ''}
         ORDER BY r.race_date DESC, r.race_time DESC, r.id DESC ${slotId ? '' : 'LIMIT 12'}`,
    ...(slotId ? [slotId] : []),
    ...(course ? [course] : []),
  );
  return Promise.all(rows.map((r) => decorate(db, r)));
}

export async function swimmers(db: Db, q = '') {
  return await all(
    db,
    `SELECT s.id,
                s.name,
                s.gender,
                COUNT(DISTINCT CASE WHEN p.is_current = 1 THEN ${db.dialect === 'mysql' ? "CONCAT(p.slot_id,'|',r.course)" : "p.slot_id||'|'||r.course"} END)                   record_count,
                COUNT(DISTINCT CASE WHEN r.source_kind = 'race' AND v.active = 1 THEN r.id END) result_count
         FROM swimmers s
                  LEFT JOIN results r ON r.swimmer_id = s.id
                  LEFT JOIN meet_versions v ON v.id = r.meet_version_id
                  LEFT JOIN record_progress p ON p.result_id = r.id
         WHERE s.name LIKE ?
         GROUP BY s.id
         ORDER BY record_count DESC, s.name`,
    `%${q}%`,
  );
}

export async function uploads(db: Db) {
  return (
    await all(
      db,
      `SELECT u.id,
                u.filename,
                u.kind,
                u.created_at,
                u.result_count,
                u.record_count,
                u.warnings,
                u.team_code,
                (SELECT COUNT(*) FROM meet_versions WHERE upload_id = u.id AND active = 1) active_meets,
                (SELECT COUNT(*) FROM meet_versions WHERE upload_id = u.id)                total_meets,
                (SELECT ${db.dialect === 'mysql' ? "GROUP_CONCAT(m.name SEPARATOR ' · ')" : "group_concat(m.name, ' · ')"}
                 FROM meet_versions v
                          JOIN meets m ON m.id = v.meet_id
                 WHERE v.upload_id = u.id)                                                 meet_names
         FROM uploads u
         ORDER BY u.id DESC`,
    )
  ).map((u) => ({ ...u, warnings: JSON.parse(u.warnings) }));
}
