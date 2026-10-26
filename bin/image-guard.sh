#!/bin/sh
if ! command -v node > /dev/null 2>&1; then
  [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  [ -d "$HOME/.volta/bin" ] && export PATH="$HOME/.volta/bin:$PATH"
  [ -d "$HOME/.asdf/shims" ] && export PATH="$HOME/.asdf/shims:$PATH"
  [ -d "$HOME/.local/share/mise/shims" ] && export PATH="$HOME/.local/share/mise/shims:$PATH"
  [ -d "/opt/homebrew/bin" ] && export PATH="/opt/homebrew/bin:$PATH"
  [ -d "/usr/local/bin" ] && export PATH="/usr/local/bin:$PATH"
  [ -d "/home/linuxbrew/.linuxbrew/bin" ] && export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"
fi
if ! command -v node > /dev/null 2>&1; then
  echo "Image Guard: Node not found. Install Node.js via nvm, Volta, asdf, mise, or Homebrew." >&2
  exit 1
fi
# Follows symlinks (as from node_modules/.bin or a global bin folder) to this script’s own folder
self="$0"
while [ -L "$self" ]; do
  target="$(readlink "$self")"
  case "$target" in
    /*) self="$target" ;;
    *) self="$(dirname "$self")/$target" ;;
  esac
done
exec node "$(dirname "$self")/image-guard.js" "$@"