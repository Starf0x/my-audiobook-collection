#!/usr/bin/env bash
# Updates the app in place, as root. The same steps the Proxmox helper script
# takes, so there is one way this is done and not two.
#
# Run it yourself:   my-audiobook-collection-update
# Or from the app:   Settings → "A newer version" → Install it
#
# The app cannot do this itself and should not be able to. It runs as PUID, not
# root, so it can neither write in /opt nor restart a unit — and a web page that
# can run a root script is one that can run a root script for whoever reaches
# it. What it can do is leave a file in its own data folder; a path unit owned
# by root sees that file and starts this. The root side only ever does this one
# fixed thing, which is why asking for it is not an escalation.
set -euo pipefail

APP_DIR=/opt/my-audiobook-collection
ENV_FILE=/etc/my-audiobook-collection.env
UNIT=my-audiobook-collection.service

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { printf 'Run this as root.\n' >&2; exit 1; }
[ -d "$APP_DIR/.git" ] || { printf 'No git checkout at %s: this is not an LXC install.\n' "$APP_DIR" >&2; exit 1; }

# Where to leave word of what happened, so the app can say so on a page even
# though it was restarted in the middle of it.
DATA_DIR=$(set -a; . "$ENV_FILE" 2>/dev/null; printf '%s' "${DATA_DIR:-/var/lib/my-audiobook-collection}")
PUID=$(set -a; . "$ENV_FILE" 2>/dev/null; printf '%s' "${PUID:-}")
PGID=$(set -a; . "$ENV_FILE" 2>/dev/null; printf '%s' "${PGID:-}")
SAID="$DATA_DIR/update-said.json"
ASK="$DATA_DIR/update-wanted"
# Which step it is on, for the bar on the page. Written before each step, and
# once more at the end, so a page that comes back after the restart can read
# where it got to — the app is down for two of these and cannot be asked.
PROG="$DATA_DIR/update-progress.json"
STEPS=6
step() {
  printf '{"at":"%s","step":%s,"of":%s,"doing":"%s","done":false}\n' \
    "$(date -Iseconds)" "$1" "$STEPS" "$2" >"$PROG"
  [ -n "$PUID" ] && [ -n "$PGID" ] && chown "$PUID:$PGID" "$PROG" 2>/dev/null || true
  say "$2"
}

# The request is cleared first, whatever happens next. Left behind, the path
# unit would fire again the moment this exits and the container would update in
# a loop.
rm -f "$ASK"

was=$(git -C "$APP_DIR" describe --tags --exact-match 2>/dev/null || echo 'an unreleased checkout')
done_() {
  printf '{"at":"%s","from":"%s","to":"%s","ok":%s,"said":"%s"}\n' \
    "$(date -Iseconds)" "$was" "${2:-$was}" "$1" "${3:-}" >"$SAID"
  # and the bar's last word: finished, how, and on which version
  printf '{"at":"%s","step":%s,"of":%s,"doing":"%s","done":true,"ok":%s,"to":"%s","said":"%s"}\n' \
    "$(date -Iseconds)" "$STEPS" "$STEPS" "finished" "$1" "${2:-$was}" "${3:-}" >"$PROG"
  [ -n "$PUID" ] && [ -n "$PGID" ] && chown "$PUID:$PGID" "$SAID" "$PROG" 2>/dev/null || true
}
trap 'done_ false "" "it stopped part way through; the service was left as it was"' ERR

step 1 "Looking for a newer version"
git -C "$APP_DIR" fetch --tags --force --quiet
newest=$(git -C "$APP_DIR" tag --sort=-v:refname | head -n 1)
if [ -z "$newest" ]; then
  done_ false "" "no released version found in the repository"
  printf 'No released version found.\n' >&2
  exit 1
fi

if [ "$was" = "$newest" ]; then
  say "Already on $newest"
  done_ true "$newest" "already the newest"
  exit 0
fi

say "Updating $was to $newest"
# Stopped first: npm replacing node_modules under a running process is how a
# half-updated app comes to be serving.
step 2 "Stopping the app"
systemctl stop "$UNIT"
step 3 "Fetching $newest"
git -C "$APP_DIR" checkout --quiet "$newest"
# And this script, as the new version has it. What runs is the copy the
# installer put in /usr/local/bin, so without this a container keeps the updater
# it was installed with for ever — the progress bar of 2.14.96 would never have
# reached one. `install` writes a new file rather than into the one bash is
# reading from, so this run carries on undisturbed and the next run is the new.
install -m 0755 "$APP_DIR/install/update.sh" /usr/local/bin/my-audiobook-collection-update
step 4 "Installing what $newest needs"
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund )
step 5 "Starting the app"
systemctl start "$UNIT"

# Started is not running: a unit that dies on its first second leaves
# `systemctl start` perfectly happy.
step 6 "Checking it stays up"
sleep 3
if systemctl is-active --quiet "$UNIT"; then
  done_ true "$newest" ""
  say "Now on $newest"
else
  done_ false "$newest" "it updated but the service did not stay up — journalctl -u $UNIT"
  printf 'Updated to %s but the service did not stay up.\n' "$newest" >&2
  journalctl -u "$UNIT" --no-pager -n 30 >&2 || true
  exit 1
fi
