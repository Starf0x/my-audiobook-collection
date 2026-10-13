#!/usr/bin/env bash
# Makes an LXC container on a Proxmox VE host and installs My Audiobook
# Collection into it. Run this **on the Proxmox host**.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/install/proxmox-create-lxc.sh)"
#
# It asks nothing it can work out, says everything it is about to do, and stops
# before doing any of it if you say no.
#
#   --id <n>            container id (default: the first free one from 120)
#   --hostname <name>   default: audiobooks
#   --storage <name>    where the container's disk goes (default: guessed)
#   --template <vol>    the OS template (default: the newest Debian you have)
#   --bridge <name>     default: vmbr0
#   --cores <n>         default: 2
#   --memory <MB>       default: 1024
#   --disk <GB>         default: 8
#   --books <path>      host path to your audiobooks, mounted at /audiobooks
#   --import <path>     host path for new arrivals, mounted at /import
#   --unprivileged      make it unprivileged. Read the note it prints first.
#   --yes               do not ask
set -euo pipefail

RAW=https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main

ctid=""
hostname=audiobooks
storage=""
template=""
bridge=vmbr0
cores=2
memory=1024
disk=8
books=""
importdir=""
unprivileged=0
assume_yes=0

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --id) ctid=$2; shift 2 ;;
    --hostname) hostname=$2; shift 2 ;;
    --storage) storage=$2; shift 2 ;;
    --template) template=$2; shift 2 ;;
    --bridge) bridge=$2; shift 2 ;;
    --cores) cores=$2; shift 2 ;;
    --memory) memory=$2; shift 2 ;;
    --disk) disk=$2; shift 2 ;;
    --books) books=$2; shift 2 ;;
    --import) importdir=$2; shift 2 ;;
    --unprivileged) unprivileged=1; shift ;;
    --yes|-y) assume_yes=1; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done

command -v pct >/dev/null || die "No pct here. Run this on the Proxmox VE host; inside a container, lxc-install.sh is the one you want."
[ "$(id -u)" -eq 0 ] || die "Run this as root."

# --- the id ----------------------------------------------------------------
if [ -z "$ctid" ]; then
  ctid=$(pvesh get /cluster/nextid 2>/dev/null || true)
  [ -n "$ctid" ] || die "Could not ask the cluster for a free id. Pass one with --id."
fi
pct status "$ctid" >/dev/null 2>&1 && die "$ctid is already a container. Pass a free one with --id."

# --- the template ----------------------------------------------------------
# The newest Debian already downloaded, rather than fetching one: a host that
# keeps templates has the one it wants, and downloading silently is rude.
if [ -z "$template" ]; then
  template=$(pveam list local 2>/dev/null | awk '/debian-1[0-9]/ {print $1}' | sort -V | tail -n 1 || true)
fi
if [ -z "$template" ]; then
  say "No Debian template on this host"
  cat <<NOTEMPLATE
  Fetch one, then run this again:

    pveam update
    pveam available --section system | grep debian
    pveam download local debian-13-standard_13.0-1_amd64.tar.zst

NOTEMPLATE
  exit 1
fi

# --- where the disk goes ---------------------------------------------------
# A storage that can actually hold a container root, not just any storage: ISOs
# and backups cannot, and picking one of those fails late and confusingly.
if [ -z "$storage" ]; then
  storage=$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}' || true)
  [ -n "$storage" ] || die "No storage here can hold a container. Pass one with --storage."
fi

# --- privileged, and why ---------------------------------------------------
if [ "$unprivileged" -eq 1 ]; then
  say "Unprivileged, as asked — read this before the bind mount surprises you"
  cat <<SHIFTED
  Every id inside the container is shifted by 100000, so PUID=99 in the app's
  settings is uid 100099 on this host. That uid owns nothing, so the app will be
  refused permission to write in your collection even though its permissions
  look perfectly right from here.

  Either map the owning group through in /etc/pve/lxc/$ctid.conf afterwards, or
  leave off --unprivileged and let it be privileged, which is the usual answer
  for a container that writes to a media share.
SHIFTED
fi

mounts=()
[ -n "$books" ] && mounts+=("-mp0" "$books,mp=/audiobooks")
[ -n "$importdir" ] && mounts+=("-mp1" "$importdir,mp=/import")

say "About to create"
cat <<PLAN
  id          $ctid
  hostname    $hostname
  template    $template
  storage     $storage ($disk GB)
  cores       $cores
  memory      $memory MB
  network     $bridge, DHCP
  privileged  $([ "$unprivileged" -eq 1 ] && echo 'no — ids shifted by 100000' || echo 'yes')
  audiobooks  ${books:-none yet — add one later with: pct set $ctid -mp0 /path,mp=/audiobooks}
  import      ${importdir:-none}

  Then, inside it: node, ffmpeg, the app at its newest release, and a service.
PLAN

if [ "$assume_yes" -eq 0 ]; then
  printf '\nType yes to go ahead: '
  read -r answer
  [ "$answer" = "yes" ] || die "Nothing was created."
fi

say "Creating $ctid"
pct create "$ctid" "$template" \
  --hostname "$hostname" \
  --cores "$cores" --memory "$memory" \
  --rootfs "$storage:$disk" \
  --net0 "name=eth0,bridge=$bridge,ip=dhcp" \
  --unprivileged "$unprivileged" \
  --features nesting=1 \
  --onboot 1 \
  "${mounts[@]+"${mounts[@]}"}"

say "Starting it"
pct start "$ctid"

# A container is "running" before it has an address, and the installer's very
# first act is an apt update. Waiting for DNS to answer is waiting for the thing
# that actually has to work.
say "Waiting for it to reach the network"
for _ in $(seq 1 30); do
  pct exec "$ctid" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
pct exec "$ctid" -- getent hosts deb.debian.org >/dev/null 2>&1 \
  || die "It started but has no network yet. Look at: pct enter $ctid"

say "Installing the app inside it"
pct exec "$ctid" -- bash -c "apt-get update -qq && apt-get install -y -qq curl ca-certificates"
pct exec "$ctid" -- bash -c "bash -c \"\$(curl -fsSL $RAW/install/lxc-install.sh)\""

ip=$(pct exec "$ctid" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
say "Done"
cat <<DONE
  http://${ip:-the container}:8523/        the listening page
  http://${ip:-the container}:8523/admin   the page that changes things

  shell      pct enter $ctid
  settings   /etc/my-audiobook-collection.env   (inside it)
  remove     pct stop $ctid && pct destroy $ctid

Point it at your collection in Settings → Library folders.
DONE
