> For remote MySQL, use [the MySQL guide](mysql.md) for persistent storage, migration and backups. The deployment process preserves `.env`, including the remote database configuration.

# Automatic deployment from GitHub

The workflow in `.github/workflows/deploy.yml` tests pull requests and pushes to `main`. After successful tests and a
build, pushes to `main` deploy the exact tested commit over SSH. You can also run it manually from the Actions tab on
`main`. Change `main` in both the workflow and `deploy/git-deploy.sh` if your production branch has another name.
GitHub supports these triggers, environment secrets and serialized deployments; see its
[deployment documentation](https://docs.github.com/en/actions/get-started/continuous-deployment).

The server fetches source using Git and builds each release separately. The running app stays available during the
build. A symlink switch and systemd restart activate the release, causing a short interruption. A failed health check
restores the previous code and restarts it. SQLite stays in `/var/lib/tempo-clubrecords`; deployment never seeds or resets
it. Code rollback does not undo database schema or data changes. Keep database backups using the deployment guide.

## Prepare the repository

Push this project to a GitHub repository. This workspace currently has no `.git` directory. Keep `.env`, `node_modules`,
`dist` and the live SQLite database out of Git (the supplied `.gitignore` already excludes them).

The existing integration tests require these files in the repository root:

- `Tempo clubrecords 2026.xlsx`
- `2026_ITT_Results_Total.lxf`
- `results (2).lxf`

They are currently absent from this workspace. Supply them through an appropriate private repository or secure CI fixture
download before enabling deployment. Tests deliberately block deployment if fixtures are missing; don't publish private
swimmer data in a public repository.

## Prepare the Linux server once

Follow the [Linux guide](deployment.md) for Node 26, Nginx, HTTPS, the `tempo` service account, the production `.env` and
database migration. This automation uses a release layout instead of the guide's direct source copy. In the commands
below, `tempo` is a separate SSH login account; create it if needed. Install `git`, `curl` and `util-linux` as well.

For an existing direct installation, stop the service and move `/opt/tempo-clubrecords` to
`/opt/tempo-clubrecords-before-actions` first. Preserve its `.env`; the database remains in `/var/lib/tempo-clubrecords`.

```sh
sudo install -d -o tempo -g tempo -m 0755 /opt/tempo-clubrecords
sudo install -d -o tempo -g tempo -m 0755 /opt/tempo-clubrecords/releases
sudo -u tempo git clone git@github.com:jield-webdev/tempo-clubrecords.git /opt/tempo-clubrecords/repository

# For an existing installation; otherwise create .env using the Linux guide.
sudo install -o tempo -g tempo -m 0600 /opt/tempo-clubrecords-before-actions/.env /opt/tempo-clubrecords/.env
sudo install -o root -g root -m 0755 /opt/tempo-clubrecords/repository/deploy/git-deploy.sh /usr/local/bin/tempo-deploy
```

For a private repository, configure a dedicated **read-only GitHub deploy key** in the server's `tempo` account so
`git fetch` works without a prompt. Verify GitHub's SSH host key against GitHub's published fingerprints. This key is
separate from the Actions-to-server SSH key below.

Install the provided systemd service from the repository, and change its `WorkingDirectory` to:

```ini
WorkingDirectory=/opt/tempo-clubrecords/current
```

Keep `EnvironmentFile=/opt/tempo-clubrecords/.env`, the absolute Node path, and the remaining settings from the template.
Run `sudo systemctl daemon-reload` after saving. Do not start it until the first release is built. CLI commands should
now run from `/opt/tempo-clubrecords/current`; each release links to the shared `.env`.

Use `sudo visudo -f /etc/sudoers.d/tempo-deploy` to allow only these service commands without a password:

```sudoers
tempo ALL=(root) NOPASSWD: /usr/bin/systemctl restart tempo-clubrecords.service, /usr/bin/systemctl stop tempo-clubrecords.service
```

Check that `command -v systemctl` returns `/usr/bin/systemctl`; adjust both the script and sudoers if necessary.
The username must match the SSH account in `DEPLOY_USER`. These examples use `tempo`; if you use a separate `deploy`
account, substitute it consistently in the sudoers rule, repository/release ownership, SSH setup and commands below.
The deploy account can execute application code as `tempo` through deployment, so treat its SSH access as privileged.

To build the first release, take the full commit SHA from GitHub and run:

```sh
sudo -u tempo /usr/local/bin/tempo-deploy FULL_40_CHARACTER_COMMIT_SHA
sudo systemctl enable tempo-clubrecords.service
curl --fail https://records.example.com/api/health
```

The script reads `HOST` and `PORT` from the shared production `.env` and checks `/api/health`, requiring
`{"ok":true}`. The production examples and Nginx configuration use `HOST=127.0.0.1` and `PORT=3001`;
set these in `/opt/tempo-clubrecords/.env` and keep Nginx `proxy_pass` on the same port.
The application defaults to port 3000 if `PORT` is absent. Wildcard listen addresses are checked via loopback.

## Configure GitHub once

Create a dedicated SSH key for Actions to log into the server's `tempo` account. Add its public key to that account's
`~/.ssh/authorized_keys`. The server must accept SSH connections from the GitHub runner.

In **Settings → Environments**, create `production`, restrict deployment branches to `main`, and add these secrets:

| Secret               | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| `DEPLOY_HOST`        | Server hostname or IP, without a URL scheme                        |
| `DEPLOY_USER`        | `tempo` (or your chosen deployment SSH account)                    |
| `DEPLOY_PORT`        | Optional SSH port; defaults to `22`                                |
| `DEPLOY_SSH_KEY`     | Complete private SSH key, without a passphrase                     |
| `DEPLOY_KNOWN_HOSTS` | Verified server SSH host-key entries in OpenSSH known_hosts format |

Obtain the host key through a trusted server console or verify an `ssh-keyscan` result against a trusted fingerprint
before saving it. For a custom SSH port, known_hosts uses `[hostname]:port`. The workflow enforces host-key verification.

Push to `main` and inspect **Actions → Test and deploy**. Pull requests run validation without server secrets. Deployment
jobs run one at a time, and active deployments are not cancelled by a later push. GitHub may replace a pending run with
a newer push, so the server converges on the latest version rather than deploying every intermediate commit.

## Operations

### Fix health-check 404s

A successful build followed by HTTP 404 means an HTTP server answered the check, but did not serve the expected route.
Confirm the production `.env` contains `HOST=127.0.0.1` and `PORT=3001` (or your chosen port), and that Nginx uses the
same port. The npm install-script warning alone does not explain this failure when the build succeeds.

Check the installed service and listener on the server:

```sh
systemctl show --property=WorkingDirectory --property=EnvironmentFiles tempo-clubrecords.service
sudo journalctl -u tempo-clubrecords -n 100 --no-pager
sudo ss -ltnp '( sport = :3000 or sport = :3001 )'
curl --fail http://127.0.0.1:3001/api/health
readlink -f /opt/tempo-clubrecords/current
```

The working directory must be `/opt/tempo-clubrecords/current` and the environment file must be
`/opt/tempo-clubrecords/.env`. Apply unit edits with `sudo systemctl daemon-reload`.
`current` must be a symlink to an existing release directory, never to itself. If it is broken, inspect
`/opt/tempo-clubrecords/releases` and point it to a known working release before retrying. On a first installation
with no working release, remove only the broken symlink so deployment can create the first one.

Reinstall the updated deployment script; a GitHub push alone does not update the server's installed copy:

```sh
sudo -u tempo git -C /opt/tempo-clubrecords/repository pull --ff-only origin main
sudo install -o root -g root -m 0755 /opt/tempo-clubrecords/repository/deploy/git-deploy.sh /usr/local/bin/tempo-deploy
```

Then rerun deployment for the tested commit.

### Fix `sudo: a password is required`

The script uses `sudo -n` so unattended deployments fail instead of prompting for a password. This error on restart
means the SSH user lacks an effective `NOPASSWD` rule for the exact service command. The subsequent "restoring" message
is the rollback attempt; it needs the same permission.

On the server, use an administrator account to edit `sudo visudo -f /etc/sudoers.d/tempo-deploy` and install the rule
above for the actual `DEPLOY_USER`. Check the configuration with `sudo visudo -c`. Review `sudo -l -U tempo` (substitute
your deployment user) for conflicting rules; a later matching password-required rule can override `NOPASSWD`.

As the deployment SSH user, verify without a cached sudo credential:

```sh
sudo -k
sudo -n -l /usr/bin/systemctl restart tempo-clubrecords.service
sudo -n -l /usr/bin/systemctl stop tempo-clubrecords.service
```

These commands inspect permission without changing the service. Policy listing can succeed even when execution still
requires authentication, so confirm the effective listing includes `NOPASSWD` for both commands. The script runs these
policy checks before building. Custom `listpw` settings can also require authentication for policy listing.

Reinstall the updated script as described above, then rerun the deployment. Updating the repository alone does not
replace `/usr/local/bin/tempo-deploy` on the server.

Old release directories are retained for recovery. Remove unused releases periodically, keeping the active release and
at least one known working previous release. Release directories include `node_modules`, so monitor disk space.
Failed builds leave the running release untouched. A failed first deployment has no previous release to restore and
stops the service. Inspect `sudo journalctl -u tempo-clubrecords -n 100 --no-pager` for startup errors.

Changes to the systemd unit, Nginx configuration or the installed `/usr/local/bin/tempo-deploy` script need a separate
server update. Application deployments do not overwrite these files. Keep the script root-owned and reinstall it from
reviewed source when changing the deployment process.
