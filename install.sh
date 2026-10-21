#!/usr/bin/env bash
# Build the app and install the desktop entry, icon, user service (enabled at login),
# ~/.local/bin/town-gen-app and the SUPER+CTRL+ALT+T keybind.
# Idempotent: rerun after editing packaging/ or the code. Use --uninstall to remove.
set -euo pipefail
root="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
apps="$HOME/.local/share/applications"
icons="$HOME/.local/share/icons/hicolor/scalable/apps"
units="$HOME/.config/systemd/user"
binds="$HOME/.config/hypr/bindings.lua"

strip_bind() { [ -f "$binds" ] && sed -i '/^-- town-gen: start$/,/^-- town-gen: end$/d' "$binds" || true; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now town-gen.service 2>/dev/null || true
  rm -f "$apps/town-gen.desktop" "$icons/town-gen.svg" "$units/town-gen.service" "$HOME/.local/bin/town-gen-app"
  strip_bind
  systemctl --user daemon-reload
  update-desktop-database "$apps" 2>/dev/null || true
  echo "removed"; exit 0
fi

(cd "$root" && npm run build)
mkdir -p "$apps" "$icons" "$units" "$HOME/.local/bin"
sed "s|@APP@|$root/town-gen-app|" "$root/packaging/town-gen.desktop.in" > "$apps/town-gen.desktop"
cp "$root/packaging/town-gen.svg" "$icons/town-gen.svg"
sed "s|@ROOT@|$root|" "$root/packaging/town-gen.service.in" > "$units/town-gen.service"
ln -sf "$root/town-gen-app" "$HOME/.local/bin/town-gen-app"
if [ -f "$binds" ]; then
  strip_bind
  printf '%s\n' '-- town-gen: start' \
    "o.bind(\"SUPER + CTRL + ALT + T\", \"Town Generator\", home .. \"${root#$HOME}/town-gen-app\")" \
    '-- town-gen: end' >> "$binds"
fi
systemctl --user daemon-reload
systemctl --user enable --now town-gen.service
systemctl --user restart town-gen.service
update-desktop-database "$apps" 2>/dev/null || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "installed: launcher 'Town Generator', command 'town-gen-app', SUPER+CTRL+ALT+T, http://127.0.0.1:31741/"
