# Tempo clubrecords

A local web application for Zwemvereniging Tempo Valkenswaard. TypeScript throughout, with a React interface, a Fastify
server and a normalized SQLite or MySQL database. Excel is a one-time baseline; the application subsequently reads and writes the
database.

## Start locally

Requires **Node.js 22.13 or newer** (tested with Node 26.13). SQLite is included in Node; no separate database server is
needed.

```sh
npm ci
npm run db:seed
npm run cli -- import '2026_ITT_Results_Total.lxf' 'results (2).lxf'
npm run cli -- admin:set-password
npm run dev
```

Open **http://127.0.0.1:3000**. The public recordbook needs no login. Use **Beheeromgeving** to sign in and upload
results. There is deliberately no default admin password. The password command prompts without echoing characters and
requires at least 12 characters.

**The supplied workbook and both example exports have already been imported into `data/tempo.sqlite` in this
workspace.** You can start with `npm run dev`; run the seed command only against an empty database, or use the explicit
reset command below.

For a production build on your own machine:

```sh
npm run build
NODE_ENV=production npm start
```

The application binds to loopback by default. `.env.example` lists optional configuration; copy it to `.env` to override
the port, host or database location. A reverse proxy with HTTPS needs `COOKIE_SECURE=true`.

## Use remote MySQL

Set `DATABASE_URL=mysql://tempo:password@db.example.com:3306/tempo` in `.env`. MySQL 8.0.23+ is supported with
verified TLS enabled by default. Azure hosts ending in `.mysql.database.azure.com` automatically use the bundled Azure
root certificates. `DATABASE_SSL_CA` (a certificate file) or `DATABASE_SSL_CA_PEM` (certificate contents, including Azure
App Service settings) can supply custom trust roots. `DATABASE_URL` takes
precedence over `DATABASE_PATH`. See the [MySQL setup and migration guide](docs/mysql.md) for account setup,
backups and copying the existing SQLite archive with `npm run cli -- db:migrate-sqlite /path/to/tempo.sqlite`.

## Deploy on a Linux server

See the [Linux and Nginx deployment guide](docs/deployment.md) for server setup, building, migrating the existing SQLite
archive, HTTPS with Certbot, backups and updates. Ready-to-use examples are included for
[Nginx](deploy/nginx.conf) and [systemd](deploy/tempo-clubrecords.service). Nginx proxies to the Node server on loopback;
the Node process serves both the built frontend and the API. The site has not been deployed to an external host.

For automatic updates from GitHub, follow the [GitHub Actions setup](docs/github-actions.md). The included workflow
tests each change and deploys pushes to `main` over SSH, with a health check and rollback to the previous code release.

## What is included

- A responsive Dutch recordbook with filters for stroke, individual/relay, gender, age/Masters category and distance,
  plus name search and CSV export.
- Current recordholders, including shared records, and a timeline of known improvements with links back to source
  uploads.
- Swimmer pages and all current imported race results, including disqualifications, meet/date/course details, relay
  members and cumulative splits.
- An authenticated admin panel for LXF/LEF/XML uploads, import summaries, warnings, version status, original-file
  downloads and the global club code.
- Real-time updates via server-sent events. Web uploads notify immediately; committed CLI/database changes are detected
  within approximately two seconds.
- Atomic imports, retained original files and old revisions, idempotent duplicate handling, and chronological record
  recalculation after corrections.

## CLI

```sh
# Load the Excel baseline into an empty database.
npm run db:seed
npm run cli -- seed '/path/to/another-copy.xlsx'

# Delete sports data AND reload the workbook. Keeps admin password and team setting.
# Parsing/import failure rolls the transaction back, restoring the previous archive.
npm run db:reset -- --yes
npm run db:reset -- --yes '/path/to/another-copy.xlsx'

# Import one or more zipped or plain LENEX files.
npm run cli -- import 'results (2).lxf'
npm run cli -- import '/path/to/results.lef' '/path/to/another.xml'

# Diagnostics and rebuilding the derived record history.
npm run cli -- stats
npm run cli -- records:rebuild

# Exact club-code matching for FUTURE imports. Default: 13-036.
npm run cli -- settings:team 13-036

# Set/change the admin password and invalidate all existing sessions.
npm run cli -- admin:set-password

# Use a separate database, e.g. for rehearsing a reset/import.
DATABASE_PATH=/tmp/tempo-trial.sqlite npm run db:seed
```

The password command also accepts stdin or `TEMPO_ADMIN_PASSWORD` for automation. Avoid placing a password in shell
command arguments or committing `.env`.

## Workbook findings and policy choices

The workbook has **16 sheets**: `Leeftijden`, six individual stroke/distance sheets, three relay sheets, and six Masters
sheets. There are **795 populated record rows**, representing **682 distinct performances** after consolidating repeated
senior/all-age entries and separating two tied holders in one cell. There are 1,101 empty category slots, which are
retained in the model.

The `Leeftijden` matrix maps birth years 2000–2030 against competition years 2022–2030. All **279 data cells** match
`competition year − birth year`: ages 1–16 are numeric, 17+ is `heren/Dames`, and zero/negative ages are `-`. Birthdays
and the month of the meet do not affect classification. Individual record categories start at age 8.

Important preservation decisions:

- **Pool length:** Excel does not identify a pool course. Seed performances therefore retain `UNKNOWN`. The club
  recordbook combines meter courses, matching the workbook's single register. LENEX results retain SCM/LCM separately,
  and the results page can filter them. Yards/unknown-course imports are stored but excluded from automatic meter-record
  eligibility. Separate short-/long-course recordbooks would require a club policy decision and classification of the
  legacy records.
- **Birth dates:** absent in Excel, so they are not invented. Each baseline belongs only to its stated category. LENEX
  birth dates and stable license/Swimrankings identifiers populate swimmers on subsequent imports.
- **Ties:** `Vrij 25-200!K9` has Elvira den Hertog and Yanna van der Heijden with separate dates. Both are separate
  normalized swimmers and coholders, linked to the same source row.
- **Typographical time errors:** `Vlinder!K50` (`2.42.04.`) and `School!C45` (`4.01..33`) are normalized unambiguously;
  original values remain in the source-row audit.
- **Historical seasons:** `seiz. 76/77` and `Seiz. 74/75` stay textual, with a null exact race date. No arbitrary day is
  assigned.
- **Special mixed relays:** the two 8×50 freestyle formats with prescribed age compositions are separate discipline
  variants. Ordinary LENEX relay results cannot overwrite them.
- **Baseline inconsistencies:** three all-age claims are slower than age/senior performances elsewhere in the workbook
  (men's 100m freestyle, men's 600m freestyle, women's 100m medley). The supplied claims remain unchanged and are
  reported for review.
- **Spelling:** only normalized exact names (accents, spaces and punctuation ignored) are matched. Different spellings,
  e.g. `Jellle` versus `Jelle`, are not silently guessed to be one person.

See [workbook analysis](docs/workbook-analysis.md) for the full column layout and reconciliation,
and [model and import rules](docs/model-and-imports.md) for the schema and replay algorithm.

## Validation

```sh
npm test
npm run build
```

The integration suite uses disposable SQLite databases, or disposable MySQL schemas when `TEST_MYSQL_URL` is set.
Generated fixtures cover Excel/LENEX imports and rollback. The historical workbook/LXF reconciliation test runs when the three original files are present. It also
exercises age boundaries, exact time arithmetic, shared records, out-of-order imports, content-based duplicates, slower
corrections, DSQs, removed results, rollback during reset, relay members, invalid XML, club-code filtering,
original-file downloads, authentication and request protection. Tests do not alter your local archive.

Expected real-file reconciliation:

| Source                                  |                          Saved race results |   New current record allocations |
| --------------------------------------- | ------------------------------------------: | -------------------------------: |
| Excel seed                              | 682 baseline performances / 795 source rows | 795 occupied slots (796 holders) |
| Arena International Talent Trophy 2026  |                        25 (including 1 DSQ) |                                0 |
| Open NK short course / Dutch Qualifiers |                                           3 |                                1 |

The new record is **Senn van Tongeren, men's 50m backstroke, age 16, 29.04, 24 October 2026 (SCM)**. It improves Luuk
Smits's 29.17 baseline. The database stores all 28 imported race results, not only the new record. Eligible cumulative
freestyle splits are additional derived performances, linked to their parent race.

## Source map

| File                            | Responsibility                                           |
| ------------------------------- | -------------------------------------------------------- |
| `src/server/schema.sql`         | Normalized tables, keys, constraints and indexes         |
| `src/server/db.ts`              | Database lifecycle, transactions and identity matching   |
| `src/server/domain.ts`          | Times, ages, eligibility and chronological record replay |
| `src/server/importers/excel.ts` | Workbook interpretation, normalization and audit         |
| `src/server/importers/lenex.ts` | Bounded ZIP/XML parsing and versioned meet imports       |
| `src/server/queries.ts`         | Public read models without birthdays or license numbers  |
| `src/server/app.ts`             | Fastify API, upload boundary, SSE and frontend serving   |
| `src/server/auth.ts`            | Scrypt password hashes and expiring server-side sessions |
| `src/client/main.tsx`           | Dutch recordbook, results, swimmers and admin interface  |
| `scripts/cli.ts`                | Seed, reset, import, settings and admin commands         |

Frameworks/packages reduce boilerplate: [Fastify](https://fastify.dev/docs/latest/) for routing and
plugins, [React](https://react.dev/) and [Vite](https://vite.dev/) for the
interface/build, [ExcelJS](https://github.com/exceljs/exceljs) for workbook
reading, [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)
and [fflate](https://github.com/101arrowz/fflate) for LENEX. The ExcelJS UUID dependency is overridden to the patched,
CommonJS-compatible v11 series. No ORM or native SQLite compilation is required.

## Backups and remaining domain limits

For MySQL, use provider backups or `mysqldump` as described in the [MySQL guide](docs/mysql.md).
For SQLite, keep `data/tempo.sqlite` on persistent local storage. Stop the server before copying the SQLite file, or use SQLite's
online backup facilities; copying only the main file while WAL writes are active can omit recent transactions. Original
Excel/LENEX bytes and superseded results are part of this database, so backup size grows with imports.

Every LENEX file must be a **complete snapshot of Tempo's results for each included meet**. Uploading a partial export
of an existing meet removes omitted performances from that meet's active version. Old versions remain archived. Meet
identity is nation + meet number + first session date, falling back to normalized name/city/date when no number exists.
If a correction changes that identity itself, it is treated as a different meet and needs explicit data reconciliation.

Relay year categories use the oldest swimmer's year-age; senior relay eligibility requires every swimmer to be at least 17. This is an explicit implementation assumption because `Leeftijden` does not explain relay team composition.
Missing/incomplete teams are saved without automatic record eligibility. Special mixed-age compositions are preserved
from Excel but are not inferred from generic LENEX relays. Automatic individual lead-off records, time trials with
federation-specific ratification requirements, handicap record classes, and summed-age Masters relays need additional
club rules. Relay flying starts are never promoted into individual records.

The app replays known performances, not an invented complete history: the workbook provides only current baseline
claims. SQLite or remote MySQL and a single administrator are supported; federated admin accounts and separate course
policies are outside this implementation. See the [deployment guide](docs/deployment.md) to host this version behind Nginx.
