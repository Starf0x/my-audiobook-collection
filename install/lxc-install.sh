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

# --- not on the hypervisor -------------------------------------------------
# This installs the app *into* the machine it runs on. Run on a Proxmox host it
# therefore installs the app on the Proxmox host: node, ffmpeg, a NodeSource apt
# repository and a systemd service, all on the box that runs everything else.
# Nothing about the command says so, and the obvious place to paste a one-liner
# you found is the host's shell prompt — which is exactly what happened.
#
# `proxmox-create-lxc.sh` is the one that belongs on the host: it makes the
# container and then runs this inside it. `uninstall.sh` clears up a host this
# was already run on.
if [ -d /etc/pve ] && command -v pct >/dev/null; then
  printf '\n\033[31m==> This is the Proxmox host, not a container.\033[0m\n' >&2
  cat >&2 <<WRONGPLACE

  This script installs the app onto whatever machine it runs on, so here it
  would install node, ffmpeg and a service onto your hypervisor.

  To make a container and install into it, from this same prompt:

    bash -c "\$(curl -fsSL ${RAW:-https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main}/install/proxmox-create-lxc.sh)"

  To run this script as intended, go inside the container first: pct enter <id>.

  If a previous run already installed onto this host, this takes it off again:

    bash -c "\$(curl -fsSL ${RAW:-https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main}/install/uninstall.sh)"

WRONGPLACE
  exit 1
fi
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

# --- the one thing that catches people on Proxmox -------------------------
# An unprivileged container shifts every id: container 0 is host 100000, so the
# PUID below is not the uid that will own the files on the host — it is that uid
# plus the offset. Set PUID=99 in an unprivileged container and the share sees
# 100099, which owns nothing, and the app is refused permission to write in a
# collection whose permissions look perfectly correct from the host.
#
# `/proc/self/uid_map` says which kind of container this is: `0 0 4294967295`
# is privileged, anything else is a shift. Unreadable on anything that is not a
# container, which is why this says nothing rather than guessing.
if [ -r /proc/self/uid_map ]; then
  shift_by=$(awk 'NR==1 {print $2}' /proc/self/uid_map 2>/dev/null || echo 0)
  if [ -n "${shift_by:-}" ] && [ "$shift_by" != "0" ]; then
    printf '\n\033[33m==> This is an unprivileged container (ids are shifted by %s)\033[0m\n' "$shift_by"
    cat <<MAPPED
  PUID and PGID below are ids *inside* here. On the host they become
  $((shift_by + ${puid:-0})) and $((shift_by + ${pgid:-0})), which probably own nothing — so the app
  will be refused permission to write in your collection even though its
  permissions look right from the host.

  Two ways out, on the host, with the container stopped:
    * make it privileged, which is the usual answer for a media container; or
    * map the owning group through, in /etc/pve/lxc/<id>.conf:
        lxc.idmap: u 0 100000 65536
        lxc.idmap: g 0 100000 100
        lxc.idmap: g 100 100 1
        lxc.idmap: g 101 100101 65435
      (that example maps gid 100 straight through; use the gid that owns
       your audiobooks, which \`stat -c '%g' /path\` on the host says)

  Install carries on. This is about writing to the collection, not about
  whether the app starts.
MAPPED
  fi
fi

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
