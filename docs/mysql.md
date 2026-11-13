# Remote MySQL

SQLite remains the default. Set `DATABASE_URL` in `.env` to use **MySQL 8.0.23 or later** (tested with MySQL 8.4).
The server and CLI use the same configuration. Use a dedicated, empty database; the app creates its tables and lookup
rows on startup.

```dotenv
DATABASE_URL=mysql://tempo:URL_ENCODED_PASSWORD@db.example.com:3306/tempo
DATABASE_SSL_CA=/etc/tempo/mysql-ca.pem
COOKIE_SECURE=true
```

URL-encode reserved characters in credentials, including `@`, `:`, `#`, `%` and `/`. TLS with certificate and hostname
verification with TLS 1.2 or newer is enabled by default. Omit `DATABASE_SSL_CA` if the provider uses a publicly trusted
certificate.
`DATABASE_SSL=false` disables TLS for local development or a trusted tunnel. Do not put database credentials in `VITE_`
variables.
Connection options use
the [MySQL2 promise pool and SSL support](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-pool).

## Azure Database for MySQL

For Azure public-cloud MySQL, set the fully qualified server name from the Azure portal:

```dotenv
DATABASE_URL=mysql://tempo:URL_ENCODED_PASSWORD@your-server.mysql.database.azure.com:3306/tempo
COOKIE_SECURE=true
```

The server and CLI automatically load `src/server/certs/azure-mysql-ca.pem` for hostnames ending in
`.mysql.database.azure.com`. The bundle contains **DigiCert Global Root G2** and **Microsoft RSA Root Certificate
Authority 2017**, the roots listed
in [Microsoft's Azure MySQL TLS guidance](https://learn.microsoft.com/en-us/azure/mysql/flexible-server/security-tls).
No certificate download is required at startup. Keep the certificate directory in the deployment alongside the server
source.
Use the Azure hostname to allow hostname verification to succeed.

To use a certificate supplied by your administrator, override the bundled trust roots:

```dotenv
DATABASE_SSL_CA=/etc/tempo/azure-mysql-ca.pem
```

`DATABASE_SSL_CA` accepts a PEM bundle containing multiple CA certificates, or one DER-encoded `.crt` CA certificate.
Relative paths resolve from the process working directory. The service user must be able to read the file.
For Azure App Service, you can instead set **`DATABASE_SSL_CA_PEM`** to the PEM certificate contents in the application
settings. Both actual newlines and literal `\n` separators work. Set only one of these two variables.
A custom certificate replaces the default trust roots; include every root your server may use in the PEM bundle.

Missing, unreadable or malformed certificate files fail at startup with a configuration error. Certificate and hostname
verification remain enabled with custom CAs. Disabling TLS for an Azure hostname, or while configuring a CA, is
rejected.
Changes to certificates or settings require restarting the app. Other Azure cloud endpoints and custom DNS names can
use `DATABASE_SSL_CA` or `DATABASE_SSL_CA_PEM` explicitly.

See the [bundled certificate notes](../src/server/certs/README.md) for source links, fingerprints and root-rotation
maintenance.
The CA bundle contains public trust certificates. It does not contain a client private key; Azure's server-certificate
verification uses these public roots. Keep the database firewall or private network configured to allow the application
host.

Create the database through your hosting provider, or as a database administrator:

```sql
CREATE
DATABASE tempo CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE
USER 'tempo'@'APP_SERVER_IP' IDENTIFIED BY 'CHOOSE_A_STRONG_PASSWORD';
GRANT
SELECT,
INSERT
,
UPDATE,
DELETE, CREATE, REFERENCES, INDEX
ON tempo.* TO 'tempo'@'APP_SERVER_IP';
```

Allow the application host through the database firewall. The Node server connects directly to MySQL; browsers use the
existing API. Configure the host's `max_allowed_packet` to at least **32 MiB**, since uploads retain original bytes and
may be up to 10 MiB. Keep the database account and CA readable by the service user. Deploy all server source files,
including both SQL schemas. The supplied systemd unit allows outbound database connections.

## Move an existing SQLite archive

1. Stop the existing app and all CLI writers for the final copy. Back up SQLite with its online backup tool as described
   in [deployment.md](deployment.md). Keep the source archive for rollback.
2. Set `DATABASE_URL` and the TLS options in `.env` to point at a new MySQL database.
3. Run from the application directory:

   ```sh
   npm run cli -- db:migrate-sqlite /absolute/path/to/tempo.sqlite
   npm run cli -- stats
   npm run build
   npm start
   ```

The migration opens SQLite read-only, reads a consistent snapshot, preserves IDs, original upload bytes, versions,
record history, club settings and the admin password hash, and prints per-table row counts. It refuses a populated
MySQL target. Copying is one transaction: an error rolls back the data copy. Schema creation happens before copying;
MySQL DDL is not transactional. Existing sessions expire and administrators must log in again. Never seed or reset as a
migration step.

For a new archive, use `npm run cli -- seed /path/to/workbook.xlsx`, then set the administrator password.
All existing CLI commands work with the selected database. Imports and settings changes update a shared revision counter
so other app instances detect committed changes. Import writers serialize using a database-scoped MySQL advisory lock.
Use a direct connection to the same MySQL writer endpoint for all instances (a proxy must preserve session affinity).

## Backups and verification

Use your provider's backups or `mysqldump --single-transaction --hex-blob` and store encrypted copies off-host.
A SQLite file backup no longer backs up the active archive after switching to MySQL. For rollback, stop writers and
restore the appropriate backup before changing database configuration; writes made after cutover are not copied back to
SQLite.

`npm test` runs SQLite tests. To run the same integration tests on disposable MySQL databases:

```sh
TEST_MYSQL_URL=mysql://root:password@127.0.0.1:3306/test DATABASE_SSL=false npm test
```

The test account needs permission to create/drop databases. Tests create uniquely named `tempo_test_*` databases and
remove them afterward. They cover imports, corrections, rollback, concurrent duplicates, relays, authentication,
API responses, Excel reset and SQLite migration. The historical workbook/LXF reconciliation test runs only when all
three original fixture files are present in the repository root.
