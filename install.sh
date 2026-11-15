#!/bin/sh
# Claude Code Stats installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/AIInnovator/claude-stats/main/install.sh | sh
#
# 1. Installs the current Node.js LTS when Node 22 or newer is missing (Homebrew on macOS when present,
#    otherwise nvm in your home folder; never sudo).
# 2. Downloads the latest release into ~/.claude-stats (re-run to update; it replaces only that folder).
# 3. Starts the dashboard on http://127.0.0.1:7420 (Ctrl+C stops it).
#
# Options (environment variables): CLAUDE_STATS_DIR=<folder> installs elsewhere,
# CLAUDE_STATS_NO_START=1 installs without starting.
set -eu

REPO="AIInnovator/claude-stats"
DIR="${CLAUDE_STATS_DIR:-$HOME/.claude-stats}"
NEED=22
NVM_VERSION="v0.40.3"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'claude-stats install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
fetch() {
  if have curl; then curl -fsSL --retry 3 "$1"
  elif have wget; then wget -qO- "$1"
  else die "curl or wget is needed"; fi
}
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) die "on Windows, run in PowerShell: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
esac
have tar || die "tar is needed"

# 1. Node.js
if ! have node || [ "$(node_major)" -lt "$NEED" ]; then
  say "Node.js $NEED or newer is needed: installing the current LTS"
  if [ "$(uname -s)" = Darwin ] && have brew; then
    if brew list node >/dev/null 2>&1; then brew upgrade node; else brew install node; fi
  else
    have bash || die "bash is needed to install nvm; or install Node.js $NEED+ from https://nodejs.org and run this again"
    NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    export NVM_DIR
    [ -s "$NVM_DIR/nvm.sh" ] || fetch "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
    # nvm reads unset variables, which set -u would stop on
    set +u
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install --lts
    set -u
  fi
  if ! have node || [ "$(node_major)" -lt "$NEED" ]; then
    die "Node.js $NEED+ is still not available; open a new terminal and run this again"
  fi
fi
say "Node.js $(node --version)"

# 2. The latest release (the main branch if there is none yet)
TAG=$(fetch "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1) || TAG=""
if [ -n "$TAG" ]; then REF="tags/$TAG"; NAME="$TAG"; else REF="heads/main"; NAME="main"; fi
say "Downloading claude-stats $NAME"
TMP="$DIR.download.$$"
rm -rf "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$TMP"
fetch "https://github.com/$REPO/archive/refs/$REF.tar.gz" | tar -xzf - -C "$TMP"
SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)
if [ -z "$SRC" ] || [ ! -f "$SRC/server.mjs" ]; then die "the download does not look like claude-stats"; fi

# replace an earlier install, never a folder that is something else
if [ -e "$DIR" ]; then
  grep -q '"name": "claude-stats"' "$DIR/package.json" 2>/dev/null || die "$DIR exists and is not a claude-stats install; set CLAUDE_STATS_DIR to another folder"
  rm -rf "$DIR"
fi
mv "$SRC" "$DIR"
rm -rf "$TMP"
trap - EXIT INT TERM
say "Installed in $DIR"

# 3. Start
if [ "${CLAUDE_STATS_NO_START:-}" = 1 ]; then
  say "Start it with: node \"$DIR/server.mjs\""
  exit 0
fi
say "Starting: open http://127.0.0.1:7420 once it prints its address (Ctrl+C stops it; start again with: node \"$DIR/server.mjs\")"
exec node "$DIR/server.mjs"
