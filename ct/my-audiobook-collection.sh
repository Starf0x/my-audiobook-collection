#!/usr/bin/env bash
# My Audiobook Collection, as a Proxmox VE Helper Script.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/ct/my-audiobook-collection.sh)"
#
# This is the community-scripts entry point, and it behaves exactly like theirs
# because it *is* theirs: the engine is loaded from community-scripts/core, and
# everything you see — the banner, Default and Advanced settings, the storage
# radiolist, the spinners, the line at the end with the address — comes from it.
#
# The one line that makes this work for an app outside their repository is the
# export below. The engine resolves two roots separately: the engine's own files
# from `COMMUNITY_SCRIPTS_CORE_URL`, and `ct/` and `install/` from
# `COMMUNITY_SCRIPTS_URL`. Left unset, the second defaults to their script
# repository and the install step would be fetched from there — and 404. Pointed
# here, the engine fetches this repository's installer instead.
export COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main}"

_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# Copyright (c) 2021-2026 community-scripts ORG
# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE
# Source: https://github.com/Starf0x/my-audiobook-collection

APP="My Audiobook Collection"
var_tags="${var_tags:-media;audiobooks}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-8}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-0}"
# Privileged, where their scripts default to unprivileged — and it is a
# deliberate difference. This app writes to your audiobooks over a bind mount,
# and an unprivileged container shifts every id by 100000: PUID=99 inside is
# 100099 on the host, which owns nothing, so it is refused permission to write
# in a collection whose permissions look perfectly right from the host. Set
# var_unprivileged=1 if you would rather map the owning group through yourself.

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/my-audiobook-collection ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  msg_info "Updating ${APP}"
  cd /opt/my-audiobook-collection || exit
  # The newest released tag, not main: main is where work in progress lands and
  # a tag is a thing that passed its checks and was published.
  $STD git fetch --tags --force
  newest=$(git tag --sort=-v:refname | head -n 1)
  if [[ -z "$newest" ]]; then
    msg_error "No released version found in the repository"
    exit
  fi
  if [[ "$(git describe --tags --exact-match 2>/dev/null)" == "$newest" ]]; then
    msg_ok "Already on ${newest}"
    exit
  fi
  systemctl stop my-audiobook-collection
  $STD git checkout "$newest"
  $STD npm ci --omit=dev --no-audit --no-fund
  systemctl start my-audiobook-collection
  msg_ok "Updated to ${newest}"
  exit
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}:8523${CL}"
echo -e "${INFO}${YW}The page that changes things:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}:8523/admin${CL}"
echo -e "${INFO}${YW}Settings (edit (Admin/password), then restart the service):${CL}"
echo -e "${TAB}${GATEWAY}${BGN}/etc/my-audiobook-collection.env${CL}"
# The two folders, here, because this is the moment somebody needs them: the app
# is up and has nothing to show. They are the host's to mount and the container
# has to be rebooted to see them, which is two commands and no explaining.
echo -e "${INFO}${YW}Your folders — on the HOST, then reboot the container:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}pct set ${CTID} -mp0 /host/path/Audiobooks,mp=/audiobooks${CL}"
echo -e "${TAB}${GATEWAY}${BGN}pct set ${CTID} -mp1 /host/path/Import,mp=/import${CL}"
echo -e "${TAB}${GATEWAY}${BGN}pct reboot ${CTID}${CL}"
echo -e "${INFO}${YW}Then add /audiobooks under Settings → Library folders.${CL}"
