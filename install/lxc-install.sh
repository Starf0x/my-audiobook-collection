#!/usr/bin/env bash
# My Audiobook Collection, installed into an LXC container (or any Debian or
# Ubuntu machine with systemd). Run it again later and it updates in place.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/install/lxc-install.sh)"
#
# What the Docker image does for you, this has to do itself: install node and
# ffmpeg, put the app somewhere, write a settings file, and arrange for it to
# start at boot and come back after a crash. It does not touch your collection,
# and it never overwrites a settings file that is already there.
#
# The collection itself is a bind mount from the host, which is the host's to
# arrange — on Proxmox:
#   pct set <id> -mp0 /host/path/to/Audiobooks,mp=/audiobooks
# and the README says the rest.
set -euo pipefail

REPO=https://github.com/Starf0x/my-audiobook-collection.git
APP_DIR=/opt/my-audiobook-collection
ENV_FILE=/etc/my-audiobook-collection.env
UNIT=my-audiobook-collection.service
# The major this is built and checked on. `tests/packaging.mjs` holds it to the
# Dockerfile's, so the container and the LXC never drift on to two different
# runtimes without somebody deciding to.
NODE_MAJOR=26

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root: it installs packages and a systemd service."
command -v systemctl >/dev/null || die "No systemd here. This script is for a Debian or Ubuntu LXC; the Docker image is the other way to run the app."
command -v apt-get >/dev/null || die "No apt-get here. This script is for Debian or Ubuntu; on anything else install node ${NODE_MAJOR}, ffmpeg and the app by hand — the systemd unit beside this script is the only other piece."

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# ffmpeg brings ffprobe, which converting .m4b and .ogg books needs as well.
apt-get install -y -qq curl ca-certificates gnupg git ffmpeg

have_node=0
if command -v node >/dev/null; then
  current=$(node -p 'process.versions.node.split(".")[0]')
  [ "$current" -ge "$NODE_MAJOR" ] && have_node=1
fi

if [ "$have_node" -eq 1 ]; then
  say "Node $(node -v) is already here, and new enough"
else
  say "Node ${NODE_MAJOR}"
  # NodeSource rather than a tarball, so `apt upgrade` keeps it current and the
  # package manager knows what is installed.
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  chmod 0644 /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  node -v
fi

# The newest release, not whatever main happens to be: main is where work in
# progress lands, and a tag is a thing that passed its checks and was published.
say "The app"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" remote set-url origin "$REPO"
  git -C "$APP_DIR" fetch --tags --force --quiet
else
  rm -rf "$APP_DIR"
  git clone --quiet "$REPO" "$APP_DIR"
fi
newest=$(git -C "$APP_DIR" tag --sort=-v:refname | head -n 1)
[ -n "$newest" ] || die "No released version found in the repository."
git -C "$APP_DIR" checkout --quiet "$newest"
printf 'version %s\n' "$newest"

say "Its three dependencies"
# --omit=dev: jsdom is for the suites and has no business on a machine that is
# only running the app.
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund )

say "Settings"
if [ -f "$ENV_FILE" ]; then
  printf 'kept the one already at %s\n' "$ENV_FILE"
else
  install -m 0600 "$APP_DIR/install/my-audiobook-collection.env.example" "$ENV_FILE"
  printf 'wrote %s — it holds your password and tokens, so it is 0600\n' "$ENV_FILE"
fi

# Read out of the settings file rather than assumed, so what this prints at the
# end is what the service will actually do.
# shellcheck disable=SC1090
data_dir=$( set -a; . "$ENV_FILE"; printf '%s' "${DATA_DIR:-/var/lib/my-audiobook-collection}" )
port=$( set -a; . "$ENV_FILE"; printf '%s' "${PORT:-8523}" )
puid=$( set -a; . "$ENV_FILE"; printf '%s' "${PUID:-}" )
pgid=$( set -a; . "$ENV_FILE"; printf '%s' "${PGID:-}" )

say "Where it keeps the database"
install -d -m 0755 "$data_dir"
# Handed over before the app drops to that user, or it cannot open its own
# database on the very first start.
if [ -n "$puid" ] && [ -n "$pgid" ]; then
  chown -R "$puid:$pgid" "$data_dir"
  printf '%s, owned by %s:%s\n' "$data_dir" "$puid" "$pgid"
else
  printf '%s\n' "$data_dir"
fi

say "The service"
install -m 0644 "$APP_DIR/install/$UNIT" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable --quiet "$UNIT"
systemctl restart "$UNIT"

# A unit that fails at once leaves `systemctl start` happy and the app gone, so
# this looks again a moment later rather than reporting a success it has not
# seen.
sleep 3
if ! systemctl is-active --quiet "$UNIT"; then
  printf '\n\033[31mIt did not stay running. What it said:\033[0m\n' >&2
  journalctl -u "$UNIT" --no-pager -n 30 >&2 || true
  exit 1
fi

ip=$(hostname -I 2>/dev/null | awk '{print $1}')
say "Running"
cat <<DONE
  http://${ip:-this-container}:${port}/        the listening page
  http://${ip:-this-container}:${port}/admin   the page that changes things

  settings   $ENV_FILE    (edit, then: systemctl restart $UNIT)
  database   $data_dir
  app        $APP_DIR     ($newest)
  log        journalctl -u $UNIT -f

Point it at your collection in Settings → Library folders. The collection is a
bind mount from the host; if there is nothing to choose there yet, that mount is
what is missing.

Run this script again to update to the newest release. It keeps your settings.
DONE
