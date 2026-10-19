#!/usr/bin/env bash
# Takes My Audiobook Collection off a machine the installer put it on.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/install/uninstall.sh)"
#
# By default it removes the service and the app and **keeps your database and
# your settings**, because those are the two things that cannot be got back:
# the database holds every listening position, account and heart, and the
# settings file holds your password. Add --purge to remove those as well.
#
#   --purge        the database and the settings file too. Says what, and asks.
#   --yes          do not ask. For a container you are about to delete anyway.
#   --nodesource   also remove the apt repository the installer added for node.
#                  Node itself is left alone: something else may want it.
#
# It touches nothing in your audiobook collection, ever. Not one path here is
# inside it.
set -euo pipefail

APP_DIR=/opt/my-audiobook-collection
ENV_FILE=/etc/my-audiobook-collection.env
UNIT=my-audiobook-collection.service
# The updater: a path unit watching for the app's "please update" file, the
# oneshot it starts, and the script that does the work.
UPDATE_PATH=my-audiobook-collection-update.path
UPDATE_UNIT=my-audiobook-collection-update.service
UPDATE_BIN=/usr/local/bin/my-audiobook-collection-update
NODESOURCE_LIST=/etc/apt/sources.list.d/nodesource.list
NODESOURCE_KEY=/usr/share/keyrings/nodesource.gpg

purge=0
assume_yes=0
drop_nodesource=0
for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    --yes|-y) assume_yes=1 ;;
    --nodesource) drop_nodesource=1 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root: it removes a systemd service and files under /opt and /etc."

# Where the database is, read from the settings file while it is still there.
data_dir=""
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  data_dir=$( set -a; . "$ENV_FILE"; printf '%s' "${DATA_DIR:-/var/lib/my-audiobook-collection}" )
fi

# What is actually here, rather than what the installer would have left: this
# has to be safe to run on a machine where it half-installed, or never did.
present=()
[ -f "/etc/systemd/system/$UNIT" ] && present+=("the service   /etc/systemd/system/$UNIT")
[ -f "/etc/systemd/system/$UPDATE_PATH" ] && present+=("the updater   /etc/systemd/system/$UPDATE_PATH")
[ -d "$APP_DIR" ] && present+=("the app       $APP_DIR")
if [ "$purge" -eq 1 ]; then
  [ -f "$ENV_FILE" ] && present+=("the settings  $ENV_FILE   (your password and tokens)")
  [ -n "$data_dir" ] && [ -d "$data_dir" ] && present+=("the database  $data_dir   (positions, accounts, hearts, backups)")
fi
if [ "$drop_nodesource" -eq 1 ]; then
  [ -f "$NODESOURCE_LIST" ] && present+=("node's apt repository  $NODESOURCE_LIST")
fi

if [ "${#present[@]}" -eq 0 ]; then
  say "Nothing of it here"
  if [ "$purge" -eq 0 ] && { [ -f "$ENV_FILE" ] || { [ -n "$data_dir" ] && [ -d "$data_dir" ]; }; }; then
    printf 'The settings and database are still here. --purge removes those too.\n'
  fi
  exit 0
fi

say "About to remove"
printf '  %s\n' "${present[@]}"
if [ "$purge" -eq 0 ]; then
  printf '\nKeeping the database and the settings. --purge removes those as well.\n'
fi

if [ "$assume_yes" -eq 0 ]; then
  printf '\nType yes to go ahead: '
  read -r answer
  [ "$answer" = "yes" ] || die "Nothing was removed."
fi

say "The service"
# `|| true` on each: a half-installed machine has some of these and not others,
# and stopping something that is not running is not a failure worth exiting on.
#
# The updater goes first. Left behind with the app removed, its path unit would
# still be watching a folder — and if --purge is not given that folder stays.
systemctl stop "$UPDATE_PATH" 2>/dev/null || true
systemctl disable "$UPDATE_PATH" 2>/dev/null || true
rm -f "/etc/systemd/system/$UPDATE_PATH" "/etc/systemd/system/$UPDATE_UNIT" "$UPDATE_BIN"
systemctl stop "$UNIT" 2>/dev/null || true
systemctl disable "$UNIT" 2>/dev/null || true
rm -f "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true

say "The app"
rm -rf "$APP_DIR"

if [ "$purge" -eq 1 ]; then
  say "The settings and the database"
  rm -f "$ENV_FILE"
  [ -n "$data_dir" ] && rm -rf "$data_dir"
fi

if [ "$drop_nodesource" -eq 1 ]; then
  say "Node's apt repository"
  # The key only goes with the list that uses it, and only when that list is
  # the one the installer wrote: somebody else's nodesource setup is theirs.
  if grep -q 'deb.nodesource.com' "$NODESOURCE_LIST" 2>/dev/null; then
    rm -f "$NODESOURCE_LIST" "$NODESOURCE_KEY"
    apt-get update -qq || true
  fi
  printf 'node itself is left installed: something else on this machine may want it.\n'
fi

say "Gone"
if [ "$purge" -eq 0 ]; then
  cat <<KEPT
  Kept, so nothing of yours was lost:
    $ENV_FILE
    ${data_dir:-the database folder named in it}

  Install again and it picks both up where they are. Run this with --purge to
  remove them.
KEPT
fi
printf '\nYour audiobooks were never touched: nothing this removes is inside them.\n'
