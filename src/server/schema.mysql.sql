-- MySQL 8.0.23+ (enforced checks, expression defaults, invisible generated columns).
CREATE TABLE IF NOT EXISTS settings (`key` VARCHAR(255) PRIMARY KEY, value VARCHAR(255) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS strokes (id INT PRIMARY KEY AUTO_INCREMENT, code VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS distances (id INT PRIMARY KEY AUTO_INCREMENT, meters INT NOT NULL UNIQUE CHECK(meters > 0)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS disciplines (
  id INT PRIMARY KEY AUTO_INCREMENT, stroke_id INT NOT NULL, FOREIGN KEY (stroke_id) REFERENCES strokes(id),
  distance_id INT NOT NULL, FOREIGN KEY (distance_id) REFERENCES distances(id), relay_count INT NOT NULL DEFAULT 1 CHECK(relay_count > 0),
  variant VARCHAR(255) NOT NULL DEFAULT '', UNIQUE(stroke_id,distance_id,relay_count,variant)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS categories (
  id INT PRIMARY KEY AUTO_INCREMENT, code VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL,
  kind VARCHAR(255) NOT NULL CHECK(kind IN ('age','senior','all','masters')),
  min_age INT, max_age INT, sort_order INT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS record_slots (
  id INT PRIMARY KEY AUTO_INCREMENT, discipline_id INT NOT NULL, FOREIGN KEY (discipline_id) REFERENCES disciplines(id),
  category_id INT NOT NULL, FOREIGN KEY (category_id) REFERENCES categories(id), gender VARCHAR(255) NOT NULL CHECK(gender IN ('M','F','X')),
  UNIQUE(discipline_id,category_id,gender)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS swimmers (
  id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255) NOT NULL, normalized_name VARCHAR(255) NOT NULL,
  gender VARCHAR(255) NOT NULL CHECK(gender IN ('M','F','X')), birth_date VARCHAR(255), birth_year INT, INDEX swimmers_name(normalized_name,gender)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS swimmer_identifiers (
  scheme VARCHAR(255) NOT NULL, value VARCHAR(255) NOT NULL, swimmer_id INT NOT NULL, FOREIGN KEY (swimmer_id) REFERENCES swimmers(id),
  PRIMARY KEY(scheme,value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS meets (
  id INT PRIMARY KEY AUTO_INCREMENT, meet_key VARCHAR(512) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL,
  city VARCHAR(255) NOT NULL, start_date VARCHAR(255) NOT NULL, end_date VARCHAR(255) NOT NULL, course VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS uploads (
  id INT PRIMARY KEY AUTO_INCREMENT, kind VARCHAR(255) NOT NULL CHECK(kind IN ('excel','lenex')),
  filename VARCHAR(255) NOT NULL, sha256 VARCHAR(255) NOT NULL, content LONGBLOB NOT NULL, team_code VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  result_count INT NOT NULL DEFAULT 0, record_count INT NOT NULL DEFAULT 0,
  warnings LONGTEXT NOT NULL DEFAULT ('[]')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS meet_versions (
  id INT PRIMARY KEY AUTO_INCREMENT, meet_id INT NOT NULL, FOREIGN KEY (meet_id) REFERENCES meets(id),
  upload_id INT NOT NULL, FOREIGN KEY (upload_id) REFERENCES uploads(id), revision INT NOT NULL,
  active INT NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  active_meet_id INT GENERATED ALWAYS AS (CASE WHEN active=1 THEN meet_id ELSE NULL END) STORED INVISIBLE,
  UNIQUE(active_meet_id), UNIQUE(meet_id,revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS results (
  id INT PRIMARY KEY AUTO_INCREMENT, upload_id INT NOT NULL, FOREIGN KEY (upload_id) REFERENCES uploads(id),
  meet_version_id INT, FOREIGN KEY (meet_version_id) REFERENCES meet_versions(id), discipline_id INT NOT NULL, FOREIGN KEY (discipline_id) REFERENCES disciplines(id),
  swimmer_id INT, FOREIGN KEY (swimmer_id) REFERENCES swimmers(id), gender VARCHAR(255) NOT NULL CHECK(gender IN ('M','F','X')),
  race_date VARCHAR(255), date_label LONGTEXT, race_time VARCHAR(255), course VARCHAR(255) NOT NULL,
  time_cs INT CHECK(time_cs > 0), status VARCHAR(255) NOT NULL,
  event_key VARCHAR(255) NOT NULL, external_id VARCHAR(255), `round` VARCHAR(255), heat VARCHAR(255), lane VARCHAR(255),
  points INT, comment LONGTEXT, source_kind VARCHAR(255) NOT NULL CHECK(source_kind IN ('race','seed','split','lead_off')),
  parent_result_id INT, FOREIGN KEY (parent_result_id) REFERENCES results(id), raw_json LONGTEXT NOT NULL DEFAULT ('{}'), INDEX results_version(meet_version_id), INDEX results_swimmer(swimmer_id,race_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;


CREATE TABLE IF NOT EXISTS relay_members (
  result_id INT NOT NULL, FOREIGN KEY (result_id) REFERENCES results(id) ON DELETE CASCADE,
  position INT NOT NULL, swimmer_id INT NOT NULL, FOREIGN KEY (swimmer_id) REFERENCES swimmers(id),
  PRIMARY KEY(result_id,position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS splits (
  result_id INT NOT NULL, FOREIGN KEY (result_id) REFERENCES results(id) ON DELETE CASCADE,
  distance INT NOT NULL, time_cs INT NOT NULL CHECK(time_cs>0),
  PRIMARY KEY(result_id,distance)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;


CREATE TABLE IF NOT EXISTS result_categories (
  result_id INT NOT NULL, FOREIGN KEY (result_id) REFERENCES results(id) ON DELETE CASCADE,
  slot_id INT NOT NULL, FOREIGN KEY (slot_id) REFERENCES record_slots(id), source_cell VARCHAR(255),
  PRIMARY KEY(result_id,slot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS seed_rows (
  id INT PRIMARY KEY AUTO_INCREMENT, upload_id INT NOT NULL, FOREIGN KEY (upload_id) REFERENCES uploads(id),
  sheet VARCHAR(255) NOT NULL, cell VARCHAR(255) NOT NULL, raw_json LONGTEXT NOT NULL,
  UNIQUE(upload_id,sheet,cell)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS seed_row_results (
  seed_row_id INT NOT NULL, FOREIGN KEY (seed_row_id) REFERENCES seed_rows(id) ON DELETE CASCADE,
  result_id INT NOT NULL, FOREIGN KEY (result_id) REFERENCES results(id), PRIMARY KEY(seed_row_id,result_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS record_progress (
  id INT PRIMARY KEY AUTO_INCREMENT, slot_id INT NOT NULL, FOREIGN KEY (slot_id) REFERENCES record_slots(id),
  result_id INT NOT NULL, FOREIGN KEY (result_id) REFERENCES results(id), previous_time_cs INT,
  change_type VARCHAR(255) NOT NULL CHECK(change_type IN ('baseline','first','broken','equal')),
  is_current INT NOT NULL CHECK(is_current IN (0,1)), UNIQUE(slot_id,result_id), INDEX records_current(is_current,slot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS admin_credentials (id INT PRIMARY KEY CHECK(id=1), password_hash VARCHAR(255) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS sessions (token_hash VARCHAR(255) PRIMARY KEY, expires_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
