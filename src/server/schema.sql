-- Measurements are integers in hundredths of a second. Never compare floating-point times.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS strokes (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS distances (id INTEGER PRIMARY KEY, meters INTEGER NOT NULL UNIQUE CHECK(meters > 0));
-- distance is per swimmer, as specified by LENEX SWIMSTYLE; a relay is count × distance.
CREATE TABLE IF NOT EXISTS disciplines (
  id INTEGER PRIMARY KEY, stroke_id INTEGER NOT NULL REFERENCES strokes,
  distance_id INTEGER NOT NULL REFERENCES distances, relay_count INTEGER NOT NULL DEFAULT 1 CHECK(relay_count > 0),
  variant TEXT NOT NULL DEFAULT '', UNIQUE(stroke_id,distance_id,relay_count,variant)
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('age','senior','all','masters')),
  min_age INTEGER, max_age INTEGER, sort_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS record_slots (
  id INTEGER PRIMARY KEY, discipline_id INTEGER NOT NULL REFERENCES disciplines,
  category_id INTEGER NOT NULL REFERENCES categories, gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
  UNIQUE(discipline_id,category_id,gender)
);
CREATE TABLE IF NOT EXISTS swimmers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  gender TEXT NOT NULL CHECK(gender IN ('M','F','X')), birth_date TEXT, birth_year INTEGER
);
CREATE INDEX IF NOT EXISTS swimmers_name ON swimmers(normalized_name,gender);
CREATE TABLE IF NOT EXISTS swimmer_identifiers (
  scheme TEXT NOT NULL, value TEXT NOT NULL, swimmer_id INTEGER NOT NULL REFERENCES swimmers,
  PRIMARY KEY(scheme,value)
);
CREATE TABLE IF NOT EXISTS meets (
  id INTEGER PRIMARY KEY, meet_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  city TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, course TEXT NOT NULL
);
-- Original bytes stay in the database. Old revisions remain available for audit/download.
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('excel','lenex')),
  filename TEXT NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL, team_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  result_count INTEGER NOT NULL DEFAULT 0, record_count INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS meet_versions (
  id INTEGER PRIMARY KEY, meet_id INTEGER NOT NULL REFERENCES meets,
  upload_id INTEGER NOT NULL REFERENCES uploads, revision INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), UNIQUE(meet_id,revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_version ON meet_versions(meet_id) WHERE active=1;
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY, upload_id INTEGER NOT NULL REFERENCES uploads,
  meet_version_id INTEGER REFERENCES meet_versions, discipline_id INTEGER NOT NULL REFERENCES disciplines,
  swimmer_id INTEGER REFERENCES swimmers, gender TEXT NOT NULL CHECK(gender IN ('M','F','X')),
  race_date TEXT, date_label TEXT, race_time TEXT, course TEXT NOT NULL,
  time_cs INTEGER CHECK(time_cs > 0), status TEXT NOT NULL,
  event_key TEXT NOT NULL, external_id TEXT, round TEXT, heat TEXT, lane TEXT,
  points INTEGER, comment TEXT, source_kind TEXT NOT NULL CHECK(source_kind IN ('race','seed','split','lead_off')),
  parent_result_id INTEGER REFERENCES results, raw_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS results_version ON results(meet_version_id);
CREATE INDEX IF NOT EXISTS results_swimmer ON results(swimmer_id,race_date);
CREATE TABLE IF NOT EXISTS relay_members (
  result_id INTEGER NOT NULL REFERENCES results ON DELETE CASCADE,
  position INTEGER NOT NULL, swimmer_id INTEGER NOT NULL REFERENCES swimmers,
  PRIMARY KEY(result_id,position)
);
CREATE TABLE IF NOT EXISTS splits (
  result_id INTEGER NOT NULL REFERENCES results ON DELETE CASCADE,
  distance INTEGER NOT NULL, time_cs INTEGER NOT NULL CHECK(time_cs>0),
  PRIMARY KEY(result_id,distance)
);
-- Eligibility is many-to-many: a race can set an age record AND an all-age record.
-- Seed eligibility is explicit because Excel has no reliable birth dates.
CREATE TABLE IF NOT EXISTS result_categories (
  result_id INTEGER NOT NULL REFERENCES results ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES record_slots, source_cell TEXT,
  PRIMARY KEY(result_id,slot_id)
);
CREATE TABLE IF NOT EXISTS seed_rows (
  id INTEGER PRIMARY KEY, upload_id INTEGER NOT NULL REFERENCES uploads,
  sheet TEXT NOT NULL, cell TEXT NOT NULL, raw_json TEXT NOT NULL,
  UNIQUE(upload_id,sheet,cell)
);
CREATE TABLE IF NOT EXISTS seed_row_results (
  seed_row_id INTEGER NOT NULL REFERENCES seed_rows ON DELETE CASCADE,
  result_id INTEGER NOT NULL REFERENCES results, PRIMARY KEY(seed_row_id,result_id)
);
-- Derived in a single transaction after every import. Inactive revisions never contribute.
CREATE TABLE IF NOT EXISTS record_progress (
  id INTEGER PRIMARY KEY, slot_id INTEGER NOT NULL REFERENCES record_slots,
  result_id INTEGER NOT NULL REFERENCES results, previous_time_cs INTEGER,
  change_type TEXT NOT NULL CHECK(change_type IN ('baseline','first','broken','equal')),
  is_current INTEGER NOT NULL CHECK(is_current IN (0,1)), UNIQUE(slot_id,result_id)
);
CREATE INDEX IF NOT EXISTS records_current ON record_progress(is_current,slot_id);
CREATE TABLE IF NOT EXISTS admin_credentials (id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
PRAGMA user_version=1;
