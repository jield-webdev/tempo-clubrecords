> This guide uses SQLite. For a remote MySQL database, follow [MySQL setup and migration](mysql.md) for database configuration, data transfer and backups; the Node/Nginx/systemd setup below still applies.

# Deploy on Linux with Nginx

These instructions target Ubuntu/Debian with systemd and a domain such as `records.example.com`. Replace that domain
and `deploy@your-server` with your own values. Run server commands as an account with sudo access. The examples host
the application at the domain root, not under a URL subdirectory.

Nginx terminates HTTPS and proxies the whole site to a single Node/Fastify process on `127.0.0.1:3001`. Fastify serves
the built React files and the API. SQLite lives in `/var/lib/tempo-clubrecords`, outside the application directory,
so replacing the code does not replace the archive. No separate database server is required.

## 1. Prepare the server

Install **Node.js 26 LTS** and npm system-wide using your preferred Node installation method. The application requires
at least Node 22.13; the distribution's default `nodejs` package may be older. Check the installed version and path:

```sh
node --version
npm --version
command -v node

sudo apt update
sudo apt install nginx certbot python3-certbot-nginx rsync sqlite3
sudo useradd --system --user-group --home-dir /var/lib/tempo-clubrecords --shell /usr/sbin/nologin tempo
sudo install -d -o tempo -g tempo -m 0755 /opt/tempo-clubrecords
sudo install -d -o tempo -g tempo -m 0700 /var/lib/tempo-clubrecords
```

The service template assumes Node is `/usr/bin/node`. If `command -v node` returns another system-wide path, change
`ExecStart` before installing the unit. A Node installation inside your personal home directory (such as nvm) will not
work with this service's `ProtectHome=true` setting. Ensure `sudo -u tempo node --version` and `sudo -u tempo npm --version`
find the intended installation too.

Point the domain's DNS A record (and AAAA record if using IPv6) to the server. Allow inbound TCP ports **80 and 443**
in the server/provider firewall, keeping your SSH access allowed. Port 3001 should remain private.

## 2. Copy and build the application

From your **local project directory**, copy the source to a staging directory in your SSH account:

```sh
rsync -av --delete \
  --exclude='.git/' --exclude='.idea/' --exclude='.agents/' --exclude='.codex/' \
  --exclude='node_modules/' --exclude='dist/' --exclude='data/' \
  --exclude='.env' --exclude='coverage/' --exclude='*.log' \
  ./ deploy@your-server:tempo-clubrecords-upload/
```

Back on the **server**, install and build it:

```sh
sudo rsync -a --delete --chown=tempo:tempo \
  --exclude='.env' --exclude='node_modules/' --exclude='dist/' \
  ~/tempo-clubrecords-upload/ /opt/tempo-clubrecords/
cd /opt/tempo-clubrecords
sudo -u tempo npm ci --include=dev
sudo -u tempo npm run build
```

Keep development dependencies installed: the current production start command uses `tsx`, which is a dev dependency.
Deploy the source including `src/server/certs`, `src/server/schema.sql`, `package.json`, `package-lock.json`, `node_modules` and `dist` together;
`dist` alone is only the frontend.

Run `sudo editor /opt/tempo-clubrecords/.env` and save this content:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
DATABASE_PATH=/var/lib/tempo-clubrecords/tempo.sqlite
COOKIE_SECURE=true
```

```sh
sudo chown tempo:tempo /opt/tempo-clubrecords/.env
sudo chmod 600 /opt/tempo-clubrecords/.env
```

The server and CLI load `.env` from the working directory. Keep commands in `/opt/tempo-clubrecords` so they use the
production database. `COOKIE_SECURE=true` is required for HTTPS admin sessions; complete the HTTPS setup before logging in.

## 3. Initialize or migrate the database

Choose one of the following paths. Do not seed or reset a database you are migrating.

### Start a new archive

On the server, from `/opt/tempo-clubrecords`:

```sh
sudo -u tempo npm run db:seed
# Optional: import the two supplied example exports.
sudo -u tempo npm run cli -- import '2026_ITT_Results_Total.lxf' 'results (2).lxf'
sudo -u tempo npm run cli -- admin:set-password
```

The password prompt requires at least 12 characters and does not echo input. The workbook and any files passed to the
import command must be present on the server.

### Preserve the existing local archive

The supplied workspace already has imported results. To preserve them and all later changes, create a consistent
SQLite backup on your **local machine** (install the `sqlite3` CLI there if needed):

```sh
tempo_backup_dir="$(mktemp -d)"
sqlite3 data/tempo.sqlite ".backup '$tempo_backup_dir/tempo.sqlite'"
scp "$tempo_backup_dir/tempo.sqlite" deploy@your-server:tempo-deploy.sqlite
rm "$tempo_backup_dir/tempo.sqlite"
rmdir "$tempo_backup_dir"
```

On the **server**, before starting the service for the first time:

```sh
sudo install -o tempo -g tempo -m 0600 ~/tempo-deploy.sqlite /var/lib/tempo-clubrecords/tempo.sqlite
rm ~/tempo-deploy.sqlite
cd /opt/tempo-clubrecords
sudo -u tempo npm run cli -- admin:set-password
```

This transfers records, uploads, settings and credentials. Setting the password again invalidates any sessions copied
from the local database. Use SQLite's backup command rather than copying a live `tempo.sqlite` file; recent writes may
still be in its WAL file. These migration commands assume a fresh target database; use the restore procedure below
when replacing an existing server archive.

## 4. Start the systemd service

Adjust the Node path in `deploy/tempo-clubrecords.service` if necessary, then:

```sh
sudo cp deploy/tempo-clubrecords.service /etc/systemd/system/tempo-clubrecords.service
sudo systemctl daemon-reload
sudo systemctl enable --now tempo-clubrecords
sudo systemctl status tempo-clubrecords --no-pager
curl --fail http://127.0.0.1:3001/api/health
```

The production examples use `PORT=3001`, matching `proxy_pass` in the supplied Nginx configuration.
Set this explicitly in the production `.env`; the application defaults to port 3000 when `PORT` is absent.
If you choose another port, update `.env`, Nginx and the manual health-check commands together.

The health endpoint should return `{"ok":true}`. The service runs without root privileges, restarts after failures,
starts on boot and can write only to its state directory and private temporary directory. Run only one application
instance against this local SQLite database.

## 5. Enable Nginx and HTTPS

From `/opt/tempo-clubrecords`, copy the provided configuration and replace the example hostname:

```sh
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tempo-clubrecords
sudo editor /etc/nginx/sites-available/tempo-clubrecords
sudo ln -s /etc/nginx/sites-available/tempo-clubrecords /etc/nginx/sites-enabled/tempo-clubrecords
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
sudo certbot --nginx -d records.example.com --redirect
sudo nginx -t
sudo certbot renew --dry-run
```

Certbot obtains the certificate and updates the site configuration to serve HTTPS and redirect HTTP. DNS must resolve
to this server and port 80 must be reachable for certificate validation. Verify the installed Certbot renewal timer
with `systemctl list-timers --all | grep certbot`; keep automated renewal enabled.

The Nginx example preserves the public `Host` header for the application's same-origin checks, permits a 10 MiB upload
plus multipart overhead, and disables buffering for server-sent events. Its 90-second read timeout accommodates the
25-second event heartbeat. No WebSocket configuration is needed in production.

Fastify currently uses `trustProxy: false`, so its login limit of eight attempts per minute is shared by clients
behind this Nginx proxy. Forwarded IP headers are supplied for future use but do not change that behavior.

Verify the public site:

```sh
curl --fail https://records.example.com/api/health
curl -N --max-time 30 https://records.example.com/api/events
```

The second command should immediately print `: connected`, followed by a `: keepalive` comment after about 25 seconds;
curl then exits on its intentional timeout. In a browser, check the recordbook, admin login, a LENEX upload and live
updates in a second tab. HTTP redirects to HTTPS; the session cookie should have the `Secure` flag.

## Updates and operations

For an update, first create a database backup as described below. Repeat the local rsync command to refresh staging,
then stop the service and run the server-side rsync, `npm ci --include=dev` and `npm run build` commands from step 2.
Start it again with `sudo systemctl start tempo-clubrecords` and check both health URLs. This causes a short outage;
keep the previous source/build available to recover from a failed build. The rsync exclusions preserve `.env`, and
the database stays in `/var/lib/tempo-clubrecords`. Never run `db:reset` as an upgrade step.

If the service template changes, reinstall it and run `sudo systemctl daemon-reload` before starting. After changing
`.env`, restart the service. Certbot edits the live Nginx configuration: edit that file for later changes instead of
overwriting it with the original HTTP-only template.

```sh
sudo journalctl -u tempo-clubrecords -n 100 --no-pager
sudo journalctl -u tempo-clubrecords -f
sudo tail -f /var/log/nginx/error.log
```

For a `502`, check the service log and loopback health endpoint. For a `413`, check both Nginx's body limit and the
application's 10 MiB file limit. If login is rejected, check the preserved Host header and HTTPS/secure-cookie setting.

### Backup and restore

On the server, SQLite's online backup works while the application is running:

```sh
sudo install -d -o root -g root -m 0700 /var/backups/tempo-clubrecords
sudo sqlite3 /var/lib/tempo-clubrecords/tempo.sqlite \
  ".backup '/var/backups/tempo-clubrecords/tempo-$(date +%Y%m%d-%H%M%S).sqlite'"
```

Schedule this command with your normal backup tooling and retain copies off the server. The database includes original
Excel/LENEX uploads, archived revisions and administrator credentials; protect backup access. Back up `.env` separately.

To restore, stop the service and any CLI imports, make a backup of the current archive, then replace the database with
your chosen backup. The following assumes it is available at `/var/backups/tempo-clubrecords/chosen-backup.sqlite`:

```sh
sudo systemctl stop tempo-clubrecords
sudo sqlite3 /var/lib/tempo-clubrecords/tempo.sqlite \
  ".backup '/var/backups/tempo-clubrecords/before-restore-$(date +%Y%m%d-%H%M%S).sqlite'"
sudo rm -f /var/lib/tempo-clubrecords/tempo.sqlite-wal /var/lib/tempo-clubrecords/tempo.sqlite-shm
sudo install -o tempo -g tempo -m 0600 \
  /var/backups/tempo-clubrecords/chosen-backup.sqlite /var/lib/tempo-clubrecords/tempo.sqlite
cd /opt/tempo-clubrecords
sudo -u tempo npm run cli -- admin:set-password
sudo systemctl start tempo-clubrecords
curl --fail http://127.0.0.1:3001/api/health
```

The old WAL/SHM files must not be reused with a restored database. Resetting the admin password invalidates sessions
from the backup. Check record counts with `sudo -u tempo npm run cli -- stats` after restoring.
