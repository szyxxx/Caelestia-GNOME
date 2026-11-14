#!/usr/bin/env bash
# Caelestia for GNOME: one-run installer.
#
#   wget -qO- https://raw.githubusercontent.com/szyxxx/Caelestia-GNOME/main/install.sh | bash
#
# or, from a copy of the repository:  ./install.sh [options]
#
#   -y, --yes            ask nothing: keep this computer's own apps and take every default
#   --pick-apps          choose browser, files, terminal, editor, music and dock from menus
#   --browser APP        make APP the default for that role (a desktop id or part of the app's name);
#   --files APP          the same for --terminal, --editor and --music. Roles you leave out keep
#   --terminal APP       using what this computer already uses.
#   --editor APP
#   --music APP
#   --dock VALUE         keep (default), auto, or a comma list of apps to pin
#   --no-dock-icons      leave the dock icons as they are (default: same rounded tile for every app)
#   --city NAME          place for the dashboard weather (default: the city of your time zone)
#   --no-wallpaper       keep your wallpaper; the colours are then taken from it
#   --no-fonts           do not download the three fonts (only if you already have them)
#   --force              try even when this is not GNOME 50
#   --uninstall          put everything back and delete the files
#   -h, --help           show this text
#
# Everything is installed inside your home folder. sudo is asked for only if a needed Ubuntu package
# is missing. Your settings are backed up first; undo with:  caelestia-restore
set -euo pipefail

REPO_TARBALL=https://github.com/szyxxx/Caelestia-GNOME/archive/refs/heads/main.tar.gz
UUID=caelestia-gnome@szyx
EXT_DIR=$HOME/.local/share/gnome-shell/extensions
DATA=$HOME/.local/share/caelestia-rice
BIN=$HOME/.local/bin
FONTS=$HOME/.local/share/fonts/caelestia
WALL=$HOME/.local/share/backgrounds/caelestia-blackhole.png
CONFIG=$HOME/.config/caelestia-gnome

# Pinned downloads: url, sha256, file name. Pinned so every install gets the same files.
FONT_FILES=(
"https://raw.githubusercontent.com/google/material-design-icons/10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7/variablefont/MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf 7e74e36533ccee12c2b81e75bfcf3ccf123d3bb7e7e46d65d94445f23db0c97c MaterialSymbolsRounded.ttf"
"https://raw.githubusercontent.com/caelestia-dots/shell/bb6cd2eebb41a609fade6b3c11ef6aa4d8aa486c/assets/google-sans-flex/GoogleSansFlex-VariableFont_GRAD%2CROND%2Copsz%2Cslnt%2Cwdth%2Cwght.ttf 2510a8b7a24beb1fe8163e9a49813ccfe96b5453444b9443d42665ca4fa320c9 GoogleSansFlex.ttf"
"https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/CascadiaCode/CaskaydiaCoveNerdFont-Regular.ttf 701d7ec08f58f07251c1758361c5d1ab57ba0a867dd378cbb0fa52e1d2beccad CaskaydiaCoveNerdFont-Regular.ttf"
"https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/CascadiaCode/CaskaydiaCoveNerdFont-Bold.ttf d38b2e9461f52c70ef9f18c5c79f869d8b084432416ea6e850855c5222fbdc38 CaskaydiaCoveNerdFont-Bold.ttf"
)
WALL_URL=https://raw.githubusercontent.com/caelestia-dots/shell/7fb9f3d88d8bc1366b3f78145f2e40d90de31adb/assets/wallpaper.webp
WALL_SHA=1b87f61b667d6a5fe4bc80b3ce761ba51a3ec0451e6705561a3632a5e9e7220c
USER_THEME=user-theme@gnome-shell-extensions.gcampax.github.com

YES=0 PICK=0 FORCE=0 UNINSTALL=0 WALLPAPER=1 GET_FONTS=1 CITY="" DOCK="" DOCK_ICONS=""
declare -A ROLE=()
ARGS=("$@")

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; WARNINGS+=("$*"); }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
WARNINGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1;;
    --pick-apps) PICK=1;;
    --browser|--files|--terminal|--editor|--music) [ $# -ge 2 ] || die "$1 needs an app"; ROLE[${1#--}]=$2; shift;;
    --dock) [ $# -ge 2 ] || die "--dock needs a value"; DOCK=$2; shift;;
    --no-dock-icons) DOCK_ICONS=off;;
    --city) [ $# -ge 2 ] || die "--city needs a name"; CITY=$2; shift;;
    --no-wallpaper) WALLPAPER=0;;
    --no-fonts) GET_FONTS=0;;
    --force) FORCE=1;;
    --uninstall) UNINSTALL=1;;
    -h|--help) if [ -f "$0" ]; then sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
               else echo "Options are listed at https://github.com/szyxxx/Caelestia-GNOME#options"; fi; exit 0;;
    *) die "unknown option $1 (see --help)";;
  esac
  shift
done

# Questions are read from the terminal itself, so they also work through `wget ... | bash`.
TTY=""
if [ $YES = 0 ] && { true < /dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi
ask() {  # ask "question" default -> answer in $REPLY
  REPLY=$2
  [ -n "$TTY" ] || return 0
  printf '%s ' "$1" > "$TTY"
  IFS= read -r REPLY < "$TTY" || REPLY=""
  [ -n "$REPLY" ] || REPLY=$2
}

fetch() {  # fetch URL FILE
  if command -v curl >/dev/null; then curl -fL --retry 2 --connect-timeout 20 -sS -o "$2" "$1"
  elif command -v wget >/dev/null; then wget -q --tries=3 --timeout=30 -O "$2" "$1"
  else python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$1" "$2"
  fi
}
fetch_checked() {  # fetch_checked URL SHA256 FILE: only leaves FILE behind when it is the expected file
  local tmp="$3.part"
  if fetch "$1" "$tmp" && [ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$2" ]; then mv "$tmp" "$3"; return 0; fi
  rm -f "$tmp"; return 1
}

[ "$(id -u)" != 0 ] || die "run this as your own user, not with sudo"

if [ $UNINSTALL = 1 ]; then
  [ -x "$BIN/caelestia-restore" ] || die "Caelestia is not installed here (no $BIN/caelestia-restore)"
  exec "$BIN/caelestia-restore" --remove
fi

# ---- 1. is this a computer it can run on? -------------------------------------------------------
command -v gnome-shell >/dev/null || die "GNOME Shell is not installed. This is a look for the GNOME desktop (Ubuntu's default)."
command -v python3 >/dev/null || die "python3 is missing"
SHELL_VER=$(gnome-shell --version | grep -oE '[0-9]+' | head -n 1)
if [ "$SHELL_VER" != 50 ]; then
  [ $FORCE = 1 ] || die "this needs GNOME 50 (Ubuntu 26.04); you have GNOME $SHELL_VER. It has only been built and tested on 50. --force tries anyway."
  warn "GNOME $SHELL_VER is untested; the extension may not load"
fi
case "${XDG_CURRENT_DESKTOP:-}" in *GNOME*) ;; *) warn "this session is not GNOME (${XDG_CURRENT_DESKTOP:-unknown}); the look only shows in a GNOME session";; esac

# ---- 2. get the files ---------------------------------------------------------------------------
SRC=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/extension/metadata.json" ]; then
  SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
else
  say "Downloading Caelestia for GNOME"
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  fetch "$REPO_TARBALL" "$TMP/src.tar.gz" || die "could not download $REPO_TARBALL"
  mkdir "$TMP/src" && tar -xzf "$TMP/src.tar.gz" -C "$TMP/src" --strip-components=1
  SRC=$TMP/src
  [ -f "$SRC/extension/metadata.json" ] || die "the download is not the Caelestia repository"
fi

# ---- 3. Ubuntu packages ---------------------------------------------------------------------------
NEED=()
python3 -c 'import PIL' 2>/dev/null || NEED+=(python3-pil)
python3 -c 'import gi; gi.require_version("Gtk", "4.0"); from gi.repository import Gtk' 2>/dev/null || NEED+=(python3-gi gir1.2-gtk-4.0)
python3 -c 'import gi; gi.require_version("Rsvg", "2.0"); from gi.repository import Rsvg' 2>/dev/null || NEED+=(gir1.2-rsvg-2.0)
command -v dconf >/dev/null || NEED+=(dconf-cli)
command -v glib-compile-schemas >/dev/null || NEED+=(libglib2.0-bin)
command -v fc-cache >/dev/null || NEED+=(fontconfig)
if [ ${#NEED[@]} -gt 0 ]; then
  command -v apt-get >/dev/null || die "missing: ${NEED[*]} (Ubuntu package names). Install their equivalents, then run this again."
  say "Installing Ubuntu packages (asks for your password): ${NEED[*]}"
  if [ -n "$TTY" ]; then sudo apt-get install -y "${NEED[@]}" < "$TTY"; else sudo apt-get install -y "${NEED[@]}"; fi \
    || die "could not install ${NEED[*]}. Run: sudo apt install ${NEED[*]}   then run this again."
fi

# ---- 4. extension and commands ------------------------------------------------------------------
say "Installing the shell extension and commands"
mkdir -p "$EXT_DIR" "$BIN" "$DATA/setup" "$CONFIG"
if [ -d "$EXT_DIR/$UUID" ]; then   # an earlier install: keep one copy to go back to
  rm -rf "$DATA/backup/ext-previous"; mkdir -p "$DATA/backup"; mv "$EXT_DIR/$UUID" "$DATA/backup/ext-previous"
fi
cp -r "$SRC/extension" "$EXT_DIR/$UUID"
glib-compile-schemas "$EXT_DIR/$UUID/schemas"
for f in "$SRC"/bin/*; do install -m 755 "$f" "$BIN/"; done
install -m 644 "$SRC"/setup/* "$DATA/setup/"

if [ ! -d "$EXT_DIR/$USER_THEME" ] && [ ! -d "/usr/share/gnome-shell/extensions/$USER_THEME" ]; then
  # GNOME's own User Themes extension (styles the lock screen). The copy in this repository is for GNOME 50.
  if [ "$SHELL_VER" = 50 ] && [ -d "$SRC/third_party/$USER_THEME" ]; then
    cp -r "$SRC/third_party/$USER_THEME" "$EXT_DIR/$USER_THEME"
  else
    say "Downloading the User Themes extension (from extensions.gnome.org)"
    Z=$(mktemp)
    fetch "https://extensions.gnome.org/download-extension/$USER_THEME.shell-extension.zip?shell_version=$SHELL_VER" "$Z" &&
      python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$Z" "$EXT_DIR/$USER_THEME" 2>/dev/null || {
        rm -rf "${EXT_DIR:?}/$USER_THEME"
        warn "User Themes could not be downloaded: the lock screen keeps the stock look. Later: sudo apt install gnome-shell-extension-user-theme"
      }
    rm -f "$Z"
  fi
  [ ! -d "$EXT_DIR/$USER_THEME/schemas" ] || glib-compile-schemas "$EXT_DIR/$USER_THEME/schemas" 2>/dev/null || true
fi

# ---- 5. fonts and wallpaper ---------------------------------------------------------------------
if [ $GET_FONTS = 1 ]; then
  mkdir -p "$FONTS"
  MISSING=0
  for line in "${FONT_FILES[@]}"; do
    read -r url sha name <<< "$line"
    [ -f "$FONTS/$name" ] && continue
    [ $MISSING = 1 ] || say "Downloading fonts (about 25 MB)"
    MISSING=1
    fetch_checked "$url" "$sha" "$FONTS/$name" || warn "font $name could not be downloaded; run the installer again later"
  done
  fc-cache -f "$FONTS" >/dev/null 2>&1 || true
fi
fc-list : family | grep -qiF 'Material Symbols Rounded' || warn "the icon font (Material Symbols Rounded) is missing: icons will show as words until it is installed"

if [ $WALLPAPER = 1 ] && [ ! -f "$WALL" ]; then
  say "Downloading the wallpaper"
  mkdir -p "$(dirname "$WALL")"
  W=$(mktemp)
  # GNOME may not read WebP, so it is saved as PNG.
  if fetch_checked "$WALL_URL" "$WALL_SHA" "$W" && python3 -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], "PNG")' "$W" "$WALL"; then :
  else rm -f "$WALL"; warn "the wallpaper could not be downloaded; keeping yours"; fi
  rm -f "$W" "$W.part"
fi

# ---- 6. weather place ---------------------------------------------------------------------------
if [ -n "$CITY" ]; then
  "$BIN/caelestia-weather" "$CITY" || warn "weather place not set; later: caelestia-weather CITY"
elif ! grep -q '"place"' "$CONFIG/config.json" 2>/dev/null; then
  GUESS=$(python3 -c 'import os; z=os.path.realpath("/etc/localtime").split("zoneinfo/")[-1]; print(z.split("/")[-1].replace("_", " ") if "/" in z else "")' 2>/dev/null || true)
  ask "City for the dashboard weather [${GUESS:-skip}]:" "$GUESS"
  if [ -n "$REPLY" ]; then "$BIN/caelestia-weather" "$REPLY" || warn "weather place not set; later: caelestia-weather CITY"
  else warn "no weather place set; later: caelestia-weather CITY"; fi
fi

# ---- 7. apply the look (backs up your settings first) ------------------------------------------
say "Applying the look"
"$BIN/caelestia-apply" > /dev/null || warn "caelestia-apply reported a problem; run it again to see"

# ---- 8. apps (after the backup) ----------------------------------------------------------------
say "Setting up apps"
for r in "${!ROLE[@]}"; do "$BIN/caelestia-apps" set "$r" "${ROLE[$r]}" >/dev/null || warn "--$r ${ROLE[$r]}: not set (see: caelestia-apps list $r)"; done
[ -z "$DOCK" ] || "$BIN/caelestia-apps" dock "$DOCK" >/dev/null || warn "--dock $DOCK: not set"
[ -f "$CONFIG/apps.conf" ] || "$BIN/caelestia-apps" apply --quiet || true
[ -z "$DOCK_ICONS" ] || sed -i "s/^dock_icons *=.*/dock_icons = $DOCK_ICONS/" "$CONFIG/apps.conf"
if [ $PICK = 0 ] && [ -n "$TTY" ] && [ ${#ROLE[@]} = 0 ]; then
  "$BIN/caelestia-apps" show | sed '$d' | sed '$d'
  ask "These are the apps it will use. Change any of them now? [y/N]" n
  case "$REPLY" in y|Y|yes) PICK=1;; esac
fi
if [ $PICK = 1 ] && [ -n "$TTY" ]; then "$BIN/caelestia-apps" pick < "$TTY" || true
else "$BIN/caelestia-apps" apply --quiet || true; fi

echo
say "Caelestia for GNOME is installed."
"$BIN/caelestia-apps" show | sed '$d' | sed '$d'
cat <<EOF

Log out and back in to see it.

  Super            launcher (apps, wallpapers, themes, clipboard)
  Super+D          dashboard        Super+N   sidebar        Super+X   power menu
  caelestia-apps   change the browser, files, terminal, editor, music app and dock
  caelestia-scheme change colours, motion and shape (also in the dashboard's Themes tab)
  caelestia-weather CITY
  caelestia-restore            put your desktop back as it was (--remove also deletes the files)
EOF
case ":$PATH:" in *":$BIN:"*) ;; *) echo; echo "Note: $BIN is not on your PATH yet. Ubuntu adds it at your next login.";; esac
if [ ${#WARNINGS[@]} -gt 0 ]; then
  echo; echo "Finished with ${#WARNINGS[@]} warning(s):"; printf '  - %s\n' "${WARNINGS[@]}"
fi
