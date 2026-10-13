#!/usr/bin/env bash
# Makes an LXC container on a Proxmox VE host and installs My Audiobook
# Collection into it. Run this **on the Proxmox host**.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/install/proxmox-create-lxc.sh)"
#
# It asks, the way the community scripts do: a menu, then either the defaults or
# every setting one at a time. The questions are whiptail, which Proxmox has;
# with no terminal to ask at — piped into bash, or run from cron — it takes the
# defaults and whatever flags it was given and says so.
#
# It does not source anything over the network to do that. The community scripts
# pull a shared `build.func` from another repository and run it as root on your
# hypervisor, which is a fine trade for a framework covering four hundred apps
# and a poor one for a single script you ought to be able to read in full. What
# is here is all of it.
#
# Every setting is also a flag, so this can be run without being asked anything:
#   --id --hostname --storage --template --bridge --cores --memory --disk
#   --books <host path>   mounted at /audiobooks
#   --import <host path>  mounted at /import
#   --unprivileged        read what it prints about shifted ids
#   --yes                 take the defaults, ask nothing
set -euo pipefail

RAW=https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main
TITLE="My Audiobook Collection"

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

# Asking needs both a terminal to ask at and something to ask with. `bash -c
# "$(curl …)"` keeps the terminal — the script arrives as an argument, not on
# stdin — but `curl … | bash` does not, and then whiptail would read the rest of
# the script as answers.
ask=0
if [ "$assume_yes" -eq 0 ] && [ -t 0 ] && command -v whiptail >/dev/null; then ask=1; fi

# --- what this host can offer --------------------------------------------
# Worked out before anything is asked, so the menus offer what exists rather
# than taking a name and failing on it later.
free_id=$(pvesh get /cluster/nextid 2>/dev/null || true)
[ -n "$ctid" ] || ctid=$free_id
[ -n "$ctid" ] || die "Could not ask the cluster for a free id. Pass one with --id."

# A storage that can hold a container root. ISO and backup storages cannot, and
# choosing one of those fails late and confusingly.
mapfile -t storages < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}')
[ "${#storages[@]}" -gt 0 ] || die "No storage on this host can hold a container. Pass one with --storage."

# The Debian templates already downloaded, newest last. Fetching one silently
# would be rude, and a host that keeps templates has the one it wants.
mapfile -t templates < <(pveam list local 2>/dev/null | awk '/debian-1[0-9]/ {print $1}' | sort -V)
if [ "${#templates[@]}" -eq 0 ] && [ -z "$template" ]; then
  say "No Debian template on this host"
  cat <<NOTEMPLATE
  Fetch one, then run this again:

    pveam update
    pveam available --section system | grep debian
    pveam download local debian-13-standard_13.0-1_amd64.tar.zst

NOTEMPLATE
  exit 1
fi
[ -n "$template" ] || template=${templates[-1]}

# --- asking ---------------------------------------------------------------
box() { whiptail --backtitle "$TITLE" --title "$1" "${@:2}" 3>&1 1>&2 2>&3; }

# Which storage the container's disk goes on.
#
# Asked whenever there is more than one, in the quick path as well as the slow
# one: a host with several pools has them for a reason, and silently taking the
# first active one puts the container on whichever disk `pvesm` happened to list
# first. That is what it used to do, and there was no way to say otherwise
# without the Advanced path.
#
# A radiolist with the free space beside each, because "local-lvm or tank?" is
# not a question anybody can answer from the names alone.
pick_storage() {
  local tag type total used free display info width=0
  local -a menu=()
  declare -gA storage_of=()
  while read -r tag type _ total used free _; do
    [ -n "$tag" ] && [ -n "$type" ] || continue
    display="$tag ($type)"
    if command -v numfmt >/dev/null; then
      info="Free: $(numfmt --to=iec --from-unit=1024 --format %.1f <<<"$free")B  Used: $(numfmt --to=iec --from-unit=1024 --format %.1f <<<"$used")B"
    else
      info="Free: ${free}K  Used: ${used}K"
    fi
    storage_of["$display"]=$tag
    menu+=("$display" "$info" "OFF")
    [ "${#display}" -gt "$width" ] && width=${#display}
  done < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active"')

  # One pool is not a choice, and a box with a single answer in it is a box
  # somebody has to dismiss for no reason.
  if [ "$((${#menu[@]} / 3))" -eq 1 ]; then
    storage=${storage_of[${menu[0]}]}
    return 0
  fi

  local chosen
  while true; do
    chosen=$(box "Storage Pools" --radiolist \
      "Which storage pool for the container?\n(Spacebar to select)" \
      16 "$((width + 42))" 6 "${menu[@]}") || die "Nothing was created."
    chosen=${chosen%"${chosen##*[![:space:]]}"}
    if [ -n "$chosen" ] && [ -n "${storage_of[$chosen]+set}" ]; then
      storage=${storage_of[$chosen]}
      return 0
    fi
    box "Storage Pools" --msgbox "Nothing was selected. Spacebar picks one, Enter confirms." 8 58
  done
}

if [ "$ask" -eq 1 ]; then
  choice=$(box "$TITLE" --menu "\nAn LXC container on this host, with the app installed in it.\n" 16 68 3 \
    "default"  "Use the defaults, and just ask where the books are" \
    "advanced" "Choose every setting" \
    "exit"     "Change nothing" || echo exit)

  case "$choice" in
    exit|"") die "Nothing was created." ;;

    # The one question worth asking even in the quick path. A container with no
    # collection mounted starts perfectly well and then has nothing to offer
    # under Library folders, which reads as the app being broken — it is the
    # most common way this ends badly, and it costs one box to prevent.
    default)
      [ -n "$storage" ] || pick_storage
      books=$(box "Where are your audiobooks?" --inputbox \
        "\nA path on this host. It is mounted in the container at /audiobooks.\n\nLeave it empty to add one later.\n" 13 68 "$books" || echo "")
      ;;

    advanced)
      ctid=$(box "Container ID" --inputbox "\nA free id on this host.\n" 10 60 "$ctid" || echo "")
      [ -n "$ctid" ] || die "Nothing was created."
      hostname=$(box "Hostname" --inputbox "\nWhat the container is called.\n" 10 60 "$hostname" || echo "")
      [ -n "$hostname" ] || die "Nothing was created."

      [ -n "$storage" ] || pick_storage

      menu=()
      for t in "${templates[@]}"; do menu+=("$t" "" "OFF"); done
      template=$(box "Template" --radiolist \
        "Which operating system for the container?\n(Spacebar to select)" \
        16 76 6 "${menu[@]}") || die "Nothing was created."
      [ -n "$template" ] || die "Nothing was created."

      disk=$(box "Disk" --inputbox "\nGB for the container itself. The database is small; your audiobooks are not in here.\n" 11 68 "$disk" || echo "")
      cores=$(box "Cores" --inputbox "\nOne is enough unless you convert books, which is ffmpeg.\n" 11 68 "$cores" || echo "")
      memory=$(box "Memory" --inputbox "\nMB.\n" 10 60 "$memory" || echo "")
      bridge=$(box "Network" --inputbox "\nThe bridge to put it on. It takes its address by DHCP.\n" 11 68 "$bridge" || echo "")
      for v in disk cores memory bridge; do [ -n "${!v}" ] || die "Nothing was created."; done

      books=$(box "Audiobooks" --inputbox \
        "\nA path on this host, mounted in the container at /audiobooks.\n\nLeave it empty to add one later.\n" 13 68 "$books" || echo "")
      importdir=$(box "Import folder" --inputbox \
        "\nWhere new audiobooks arrive, mounted at /import. Optional.\n" 12 68 "$importdir" || echo "")

      if box "Privileged?" --yesno \
        "\nPrivileged is the usual answer for a container that writes to a media share.\n\nUnprivileged shifts every id by 100000, so the app's PUID=99 is uid 100099 on this host — which owns nothing, and it is then refused permission to write in a collection whose permissions look perfectly right from here. It can be mapped through afterwards, but it is a thing to know first.\n\nMake it privileged?" 20 72; then
        unprivileged=0
      else
        unprivileged=1
      fi
      ;;
  esac
fi

# Nobody to ask and nothing said: take the first that can hold a container, and
# say which — a container that quietly landed on the wrong disk is a thing you
# find out about when that disk fills up.
if [ -z "$storage" ]; then
  storage=${storages[0]}
  if [ "${#storages[@]}" -gt 1 ]; then
    printf '\nNo --storage given and nothing to ask with, so: %s. The others here are %s.\n' \
      "$storage" "$(printf '%s ' "${storages[@]:1}")"
  fi
fi

pct status "$ctid" >/dev/null 2>&1 && die "$ctid is already a container. Pass a free one with --id."

if [ "$unprivileged" -eq 1 ]; then
  say "Unprivileged — read this before the bind mount surprises you"
  cat <<SHIFTED
  Every id inside the container is shifted by 100000, so PUID=99 in the app's
  settings is uid 100099 on this host. That uid owns nothing, so the app will be
  refused permission to write in your collection even though its permissions
  look perfectly right from here.

  Either map the owning group through in /etc/pve/lxc/$ctid.conf afterwards, or
  make it privileged, which is the usual answer for a container that writes to a
  media share.
SHIFTED
fi

mounts=()
[ -n "$books" ] && mounts+=("-mp0" "$books,mp=/audiobooks")
[ -n "$importdir" ] && mounts+=("-mp1" "$importdir,mp=/import")

plan() {
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
}

if [ "$ask" -eq 1 ]; then
  box "About to create" --yesno "\n$(plan)\n\nGo ahead?" 24 76 || die "Nothing was created."
else
  say "About to create"
  plan
  if [ "$assume_yes" -eq 0 ]; then
    printf '\nType yes to go ahead: '
    read -r answer
    [ "$answer" = "yes" ] || die "Nothing was created."
  fi
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
DONE
if [ -z "$books" ]; then
  cat <<NOBOOKS

  No collection is mounted yet, so Settings → Library folders has nothing to
  offer. Add one on this host and restart the container:

    pct set $ctid -mp0 /host/path/to/Audiobooks,mp=/audiobooks
    pct reboot $ctid
NOBOOKS
else
  printf '\n  Point it at /audiobooks in Settings → Library folders.\n'
fi
