#!/usr/bin/env bash
# The inside half of ct/my-audiobook-collection.sh: what runs in the container
# once the engine has made it.
#
# The filename is not a choice. The engine computes it as `${APP,,}` with the
# spaces taken out, plus `-install` — so "My Audiobook Collection" becomes
# `myaudiobookcollection-install.sh`, and it is fetched from this repository
# because `ct/my-audiobook-collection.sh` points `COMMUNITY_SCRIPTS_URL` here.
# Renaming this file means the engine fetches something that is not there.
#
# Copyright (c) 2021-2026 community-scripts ORG
# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE
# Source: https://github.com/Starf0x/my-audiobook-collection

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
# ffmpeg brings ffprobe with it, and converting .m4b and .ogg books needs both.
$STD apt install -y \
  git \
  ffmpeg
msg_ok "Installed Dependencies"

# The major the app is built and checked on. `tests/packaging.mjs` holds it to
# the Dockerfile's, so the image and this never drift on to two runtimes.
NODE_VERSION="26" setup_nodejs

msg_info "Installing My Audiobook Collection"
$STD git clone https://github.com/Starf0x/my-audiobook-collection.git /opt/my-audiobook-collection
cd /opt/my-audiobook-collection || exit
# The newest released tag rather than main: main is where work in progress
# lands, and a tag is a thing that passed its checks and was published. The
# releases API is not used because this repository publishes tags, not releases.
NEWEST=$(git tag --sort=-v:refname | head -n 1)
if [[ -z "$NEWEST" ]]; then
  msg_error "No released version found in the repository"
  exit 1
fi
$STD git checkout "$NEWEST"
# --omit=dev: jsdom is for the suites and has no business on a machine that is
# only running the app.
$STD npm ci --omit=dev --no-audit --no-fund
echo "$NEWEST" >/opt/my-audiobook-collection_version.txt
msg_ok "Installed My Audiobook Collection ${NEWEST}"

msg_info "Setting up Settings and Data"
# 0600: it holds the admin password and the Music Assistant and Home Assistant
# tokens. Never overwritten on a later run.
if [[ ! -f /etc/my-audiobook-collection.env ]]; then
  install -m 0600 /opt/my-audiobook-collection/install/my-audiobook-collection.env.example \
    /etc/my-audiobook-collection.env
fi
# The database, the covers and backups/ go here, on the container's own disk and
# not on the share: it is the one thing the audio files cannot rebuild. Handed
# to PUID:PGID before the app drops to that user, or it cannot open its own
# database on the very first start.
DATA_DIR=$(set -a; . /etc/my-audiobook-collection.env; printf '%s' "${DATA_DIR:-/var/lib/my-audiobook-collection}")
PUID=$(set -a; . /etc/my-audiobook-collection.env; printf '%s' "${PUID:-}")
PGID=$(set -a; . /etc/my-audiobook-collection.env; printf '%s' "${PGID:-}")
mkdir -p "$DATA_DIR"
if [[ -n "$PUID" && -n "$PGID" ]]; then
  chown -R "$PUID:$PGID" "$DATA_DIR"
fi
msg_ok "Set up Settings and Data"

msg_info "Creating Service"
install -m 0644 /opt/my-audiobook-collection/install/my-audiobook-collection.service \
  /etc/systemd/system/my-audiobook-collection.service
systemctl enable -q --now my-audiobook-collection
msg_ok "Created Service"

motd_ssh
customize

msg_info "Cleaning up"
$STD apt -y autoremove
$STD apt -y autoclean
$STD apt -y clean
msg_ok "Cleaned"
