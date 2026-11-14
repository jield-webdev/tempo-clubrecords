#!/usr/bin/env bash
# Installed on the server as /usr/local/bin/tempo-deploy. Run as the deploy user.
set -Eeuo pipefail
umask 022

root=/opt/tempo-clubrecords
sha=${1:-}
[[ $# == 1 && "$sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'Usage: tempo-deploy <40-character commit SHA>' >&2
  exit 1
}

# Check the service permissions before building or changing the active release.
# -l checks policy without actually restarting/stopping the running service.
for action in restart stop; do
  if ! sudo -n -l /usr/bin/systemctl "$action" tempo-clubrecords.service >/dev/null; then
    echo "Deployment user $(id -un) cannot check sudo permission for systemctl $action tempo-clubrecords.service." >&2
    echo 'Configure passwordless service commands for this user; see docs/github-actions.md.' >&2
    exit 1
  fi
done

working_directory=$(systemctl show --property=WorkingDirectory --value tempo-clubrecords.service)
[[ "$working_directory" == "$root/current" ]] || {
  echo "Set WorkingDirectory=$root/current in tempo-clubrecords.service and run sudo systemctl daemon-reload." >&2
  exit 1
}

# Also serialize manual deployments with Actions deployments.
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
cd "$root/repository"
git fetch --no-tags origin main
git merge-base --is-ancestor "$sha" FETCH_HEAD || {
  echo 'Commit must belong to origin/main.' >&2
  exit 1
}
[[ -s "$root/.env" ]] || { echo 'Missing production .env.' >&2; exit 1; }
[[ ! -e "$root/current" || -L "$root/current" ]] || {
  echo 'current must be a symlink.' >&2
  exit 1
}
previous=
if [[ -L "$root/current" ]]; then
  [[ -d "$root/current" ]] || {
    echo 'current must point to an existing release directory. Repair the symlink before deploying.' >&2
    exit 1
  }
  previous=$(cd "$root/current" && pwd -P)
fi
release=$(mktemp -d "$root/releases/$sha.XXXXXX")
switched=false

switch_to() {
  ln -s "$1" "$root/.current-next"
  mv -Tf "$root/.current-next" "$root/current"
}
recover() {
  result=$?
  trap - EXIT
  rm -f "$root/.current-next"
  if [[ $result != 0 && "$switched" == true ]]; then
    if [[ -n "$previous" && -d "$previous" ]]; then
      echo "Deployment failed; restoring $previous" >&2
      switch_to "$previous"
      sudo -n /usr/bin/systemctl restart tempo-clubrecords.service || true
    else
      sudo -n /usr/bin/systemctl stop tempo-clubrecords.service || true
      rm -f "$root/current"
    fi
  fi
  if [[ $result != 0 ]]; then
    echo "Deployment failed. Inspect journalctl -u tempo-clubrecords; release retained at $release" >&2
  fi
  exit "$result"
}
trap recover EXIT

# Build with Linux dependencies while the previous release keeps serving traffic.
git archive "$sha" | tar -x -C "$release"
cd "$release"
npm ci --include=dev
npm run build
ln -s "$root/.env" "$release/.env"
chmod 755 "$release"
# Match the service's EnvironmentFile without executing .env as shell code.
health_url=$(node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const env = parseEnv(readFileSync('.env', 'utf8'));
const port = Number(env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid production PORT');
let host = env.HOST || '127.0.0.1';
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';
if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
console.log(new URL(`http://${host}:${port}/api/health`).href);
NODE
)
switch_to "$release"
switched=true
sudo -n /usr/bin/systemctl restart tempo-clubrecords.service
echo "Checking $health_url"
for attempt in {1..30}; do
  if response=$(curl --noproxy '*' --fail --silent --show-error --max-time 2 "$health_url") &&
    printf '%s' "$response" | node -e 'try { process.exit(JSON.parse(require("node:fs").readFileSync(0, "utf8")).ok === true ? 0 : 1); } catch { process.exit(1); }'; then
    echo "Deployed $sha"
    exit 0
  fi
  sleep 2
done
echo "Health check failed at $health_url. Check production HOST/PORT, the service log and Nginx proxy_pass." >&2
exit 1
