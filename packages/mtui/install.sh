#!/usr/bin/env bash
# MTUI one-line installer for macOS / Linux
# Usage: curl -fsSL https://.../install.sh | bash

set -euo pipefail

VERSION="0.1.0"
REPO="AionUi/MTUI"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac
case "$OS" in
  linux) TARGET="${ARCH}-unknown-linux-gnu" ;;
  darwin) TARGET="${ARCH}-apple-darwin" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

INSTALL_DIR="${HOME}/.local/bin"
BINARY="mtui"
SOURCE_PATH="$(cd "$(dirname "$0")" && pwd)/target/release/${BINARY}"
DEBUG_SOURCE_PATH="$(cd "$(dirname "$0")" && pwd)/target/debug/${BINARY}"

mkdir -p "${INSTALL_DIR}"

if [ -f "${SOURCE_PATH}" ]; then
  cp "${SOURCE_PATH}" "${INSTALL_DIR}/${BINARY}"
  chmod +x "${INSTALL_DIR}/${BINARY}"
  echo "Installed MTUI from local build"
elif command -v cargo >/dev/null 2>&1; then
  echo "Building release binary from source..."
  (cd "$(dirname "$0")" && cargo build --release)
  cp "${SOURCE_PATH}" "${INSTALL_DIR}/${BINARY}"
  chmod +x "${INSTALL_DIR}/${BINARY}"
  echo "Installed MTUI from newly built release"
elif [ -f "${DEBUG_SOURCE_PATH}" ]; then
  cp "${DEBUG_SOURCE_PATH}" "${INSTALL_DIR}/${BINARY}"
  chmod +x "${INSTALL_DIR}/${BINARY}"
  echo "Installed MTUI from existing debug build"
else
  # Uncomment when releases are published:
  # URL="https://github.com/${REPO}/releases/download/v${VERSION}/mtui-${TARGET}.tar.gz"
  # curl -fsSL "${URL}" | tar xz -C "${INSTALL_DIR}"
  echo "(Download support will be available with first GitHub release)"
  echo "Build from source: cd packages/mtui && cargo build --release"
  exit 1
fi

if ! echo ":${PATH}:" | grep -q ":${INSTALL_DIR}:"; then
  SHELL_NAME="$(basename "${SHELL:-}")"
  case "${SHELL_NAME}" in
    zsh) PROFILE="${HOME}/.zshrc" ;;
    fish) PROFILE="${HOME}/.config/fish/config.fish" ;;
    *) PROFILE="${HOME}/.bashrc" ;;
  esac

  mkdir -p "$(dirname "${PROFILE}")"
  if [ "${SHELL_NAME}" = "fish" ]; then
    PATH_LINE="fish_add_path ${INSTALL_DIR}"
  else
    PATH_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi

  if [ ! -f "${PROFILE}" ] || ! grep -Fq "${INSTALL_DIR}" "${PROFILE}"; then
    printf '\n# MTUI\n%s\n' "${PATH_LINE}" >> "${PROFILE}"
    echo "Added ${INSTALL_DIR} to PATH in ${PROFILE}"
  fi
fi

echo "MTUI installed to ${INSTALL_DIR}/${BINARY}"
echo "Run 'mtui --help' to get started."
