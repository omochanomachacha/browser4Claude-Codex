#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER_SRC="${SCRIPT_DIR}/human-browser-wrapper.sh"
TARGET_PATH="${1:-${HOME}/.local/bin/human-browser}"

if [[ ! -f "${WRAPPER_SRC}" ]]; then
  echo "wrapper script not found: ${WRAPPER_SRC}" >&2
  exit 1
fi

mkdir -p "$(dirname "${TARGET_PATH}")"

if [[ -e "${TARGET_PATH}" && ! -L "${TARGET_PATH}" ]]; then
  backup_path="${TARGET_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "${TARGET_PATH}" "${backup_path}"
  echo "Backed up existing wrapper to: ${backup_path}"
fi

cp "${WRAPPER_SRC}" "${TARGET_PATH}"
chmod +x "${TARGET_PATH}"

echo "Installed wrapper to: ${TARGET_PATH}"
echo "Run: human-browser --json status"
