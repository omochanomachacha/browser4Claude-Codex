#!/usr/bin/env bash
set -euo pipefail

HB_HOME="${HUMAN_BROWSER_HOME:-${HOME}/.human-browser}"
HB_CLI="${HB_HOME}/src/cli/human-browser.ts"
HB_ROUTER="${HUMAN_BROWSER_PROFILE_ROUTER:-${HB_HOME}/scripts/profile_router.py}"
HB_PROFILES="${HUMAN_BROWSER_PROFILES:-${HB_HOME}/profiles.json}"
HB_PROFILE_STATE="${HUMAN_BROWSER_PROFILE_STATE:-${HB_HOME}/profile-state.json}"
HB_REPO_URL="${HUMAN_BROWSER_REPO_URL:-https://github.com/<owner>/browser4Claude-Codex}"
HB_PYTHON="${HUMAN_BROWSER_PYTHON:-}"

DEFAULT_CONFIG="${HB_HOME}/config.json"
DEFAULT_LABEL="com.teramotodaiki.human-browser"
DEFAULT_PLIST="${HOME}/Library/LaunchAgents/${DEFAULT_LABEL}.plist"

resolve_python() {
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  if [[ -x /usr/bin/python3 ]]; then
    echo /usr/bin/python3
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    command -v python
    return 0
  fi
  return 1
}

if [[ -z "${HB_PYTHON}" ]]; then
  if ! HB_PYTHON="$(resolve_python)"; then
    cat >&2 <<'HELP'
human-browser wrapper requires Python 3.
Install python3 and retry, or set HUMAN_BROWSER_PYTHON to a valid interpreter path.
HELP
    exit 127
  fi
fi

# Manual overrides (environment) are respected when present.
HB_CONFIG="${HUMAN_BROWSER_CONFIG:-}"
LAUNCHD_LABEL="${HUMAN_BROWSER_LAUNCHD_LABEL:-}"
LAUNCHD_PLIST="${HUMAN_BROWSER_LAUNCHD_PLIST:-}"

manual_target_override=0
if [[ -n "${HUMAN_BROWSER_CONFIG:-}" || -n "${HUMAN_BROWSER_LAUNCHD_LABEL:-}" || -n "${HUMAN_BROWSER_LAUNCHD_PLIST:-}" ]]; then
  manual_target_override=1
fi

requested_profile=""
retry_profiles_override=""
expect_text=""
expect_selector=""
filtered_args=()
while (($# > 0)); do
  case "$1" in
    --profile|--browser)
      if (($# < 2)); then
        echo "human-browser: $1 requires a value" >&2
        exit 2
      fi
      requested_profile="$2"
      shift 2
      ;;
    --profile=*|--browser=*)
      requested_profile="${1#*=}"
      shift
      ;;
    --retry-profiles)
      retry_profiles_override="on"
      shift
      ;;
    --no-retry-profiles)
      retry_profiles_override="off"
      shift
      ;;
    --expect-text)
      if (($# < 2)); then
        echo "human-browser: --expect-text requires a value" >&2
        exit 2
      fi
      expect_text="$2"
      shift 2
      ;;
    --expect-text=*)
      expect_text="${1#*=}"
      shift
      ;;
    --expect-selector)
      if (($# < 2)); then
        echo "human-browser: --expect-selector requires a value" >&2
        exit 2
      fi
      expect_selector="$2"
      shift 2
      ;;
    --expect-selector=*)
      expect_selector="${1#*=}"
      shift
      ;;
    *)
      filtered_args+=("$1")
      shift
      ;;
  esac
done
set -- "${filtered_args[@]-}"

DETECTED_COMMAND=""
DETECTED_INDEX=0

detect_command() {
  local argv=("$@")
  local i=0
  while ((i < ${#argv[@]})); do
    local token="${argv[$i]}"
    case "${token}" in
      --json)
        ((i += 1))
        ;;
      --config|--timeout|--queue-mode)
        ((i += 2))
        ;;
      --config=*|--timeout=*|--queue-mode=*)
        ((i += 1))
        ;;
      --*)
        # Unknown option: stop here and treat it as the command token.
        break
        ;;
      *)
        break
        ;;
    esac
  done
  DETECTED_COMMAND="${argv[$i]:-}"
  DETECTED_INDEX=$i
}

detect_command "$@"
cmd="${DETECTED_COMMAND}"
command_url=""
if [[ "${cmd}" == "open" || "${cmd}" == "goto" || "${cmd}" == "navigate" ]]; then
  url_index=$((DETECTED_INDEX + 1))
  if ((${#filtered_args[@]} > url_index)); then
    command_url="${filtered_args[$url_index]}"
  fi
fi

profile_router_available() {
  [[ -f "${HB_ROUTER}" ]]
}

run_profile_router() {
  "${HB_PYTHON}" "${HB_ROUTER}" \
    --home "${HB_HOME}" \
    --profiles "${HB_PROFILES}" \
    --state "${HB_PROFILE_STATE}" \
    "$@"
}

handle_profile_command() {
  if ! profile_router_available; then
    echo "human-browser: profile router not found (${HB_ROUTER})" >&2
    exit 127
  fi

  local fmt="text"
  local args=()
  for token in "$@"; do
    if [[ "$token" == "--json" ]]; then
      fmt="json"
      continue
    fi
    args+=("$token")
  done

  if ((${#args[@]} == 0)); then
    args=("current")
  fi

  run_profile_router --format "${fmt}" "${args[@]}"
  exit $?
}

if [[ "${cmd}" == "profile" ]]; then
  # Wrapper-only command:
  #   human-browser profile list|current|use|resolve
  profile_args=()
  for i in "${!filtered_args[@]}"; do
    if ((i == DETECTED_INDEX)); then
      continue
    fi
    profile_args+=("${filtered_args[$i]}")
  done
  handle_profile_command "${profile_args[@]}"
fi

resolve_profile() {
  local explicit_profile="$1"
  local command="$2"
  local url="$3"
  local hint="$4"
  local persist="${5:-1}"

  if ! profile_router_available; then
    return 1
  fi

  local -a router_args=(
    --format env
    resolve
    --explicit="${explicit_profile}"
    --command="${command}"
    --url="${url}"
    --hint="${hint}"
    --cwd "${PWD}"
    --auto "${HUMAN_BROWSER_PROFILE_AUTO:-1}"
  )
  if [[ "${persist}" == "1" ]]; then
    router_args+=(--persist)
  fi

  run_profile_router \
    "${router_args[@]}"
}

infer_project_routing_hint() {
  "${HB_PYTHON}" - <<'PY' "${PWD}" "${HB_PROFILES}"
import json
import subprocess
import sys
from pathlib import Path


def read_text(path: Path, limit: int = 40000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")[:limit]
    except Exception:
        return ""


cwd = Path(sys.argv[1])
profiles_path = Path(sys.argv[2])

token_candidates: list[str] = []

if profiles_path.exists():
    try:
        data = json.loads(read_text(profiles_path, 200000))
    except Exception:
        data = {}
    profiles = data.get("profiles", {}) if isinstance(data, dict) else {}
    if isinstance(profiles, dict):
        for profile_name, profile_data in profiles.items():
            if isinstance(profile_name, str):
                token_candidates.append(profile_name.lower())
            if not isinstance(profile_data, dict):
                continue
            for key in ("aliases", "keywords", "url_hosts"):
                values = profile_data.get(key, [])
                if isinstance(values, str):
                    values = [values]
                if isinstance(values, list):
                    for value in values:
                        if isinstance(value, str):
                            token_candidates.append(value.lower())
            match = profile_data.get("match", {})
            if isinstance(match, dict):
                for key in ("aliases", "keywords", "url_hosts"):
                    values = match.get(key, [])
                    if isinstance(values, str):
                        values = [values]
                    if isinstance(values, list):
                        for value in values:
                            if isinstance(value, str):
                                token_candidates.append(value.lower())

if not token_candidates:
    token_candidates = []

blocked_tokens = {"default", "profile", "profiles", "browser", "browsers", "config", "launchd", "human-browser"}

normalized_tokens: list[str] = []
seen = set()
for token in token_candidates:
    token = token.strip().lower()
    if not token or token in seen:
        continue
    if len(token) < 3:
        continue
    if token in blocked_tokens:
        continue
    seen.add(token)
    normalized_tokens.append(token)

parts: list[str] = []
parts.append(str(cwd).lower())
parts.extend(p.lower() for p in cwd.parts if p)

try:
    entries = []
    for item in cwd.iterdir():
        entries.append(item.name)
        if len(entries) >= 80:
            break
    if entries:
        parts.append(" ".join(entries).lower())
except Exception:
    pass

for filename in ("AGENTS.md", "README.md", "package.json", "pyproject.toml", ".env", ".env.local", ".env.development", ".env.production"):
    file_path = cwd / filename
    if file_path.exists() and file_path.is_file():
        parts.append(read_text(file_path).lower())

try:
    remotes = subprocess.check_output(
        ["git", "-C", str(cwd), "remote", "-v"],
        stderr=subprocess.DEVNULL,
        text=True,
    )
except Exception:
    remotes = ""
if remotes:
    parts.append(remotes.lower())

haystack = "\n".join(parts)
hits: list[str] = []
for token in sorted(normalized_tokens, key=len, reverse=True):
    if token in haystack:
        hits.append(token)

deduped_hits: list[str] = []
seen_hits = set()
for token in hits:
    if token in seen_hits:
        continue
    seen_hits.add(token)
    deduped_hits.append(token)
    if len(deduped_hits) >= 10:
        break

print(" ".join(deduped_hits))
PY
}

routing_hint="${HUMAN_BROWSER_CONTEXT_HINT:-}"
if [[ -z "${routing_hint}" && "${HUMAN_BROWSER_AUTO_CONTEXT:-1}" == "1" ]]; then
  routing_hint="$(infer_project_routing_hint)"
fi

apply_resolved_profile_env() {
  local env_payload="$1"
  # shellcheck disable=SC1090
  eval "${env_payload}"
  HB_SELECTED_PROFILE="${profile:-${HB_SELECTED_PROFILE:-}}"
  HB_PROFILE_REASON="${reason:-${HB_PROFILE_REASON:-}}"
  HB_CONFIG="${config:-${HB_CONFIG:-}}"
  LAUNCHD_LABEL="${launchd_label:-${LAUNCHD_LABEL:-}}"
  LAUNCHD_PLIST="${launchd_plist:-${LAUNCHD_PLIST:-}}"
  HB_CANDIDATE_PROFILES="${candidate_profiles:-${HB_CANDIDATE_PROFILES:-[]}}"
  HB_SCORED_CANDIDATES="${scored_candidates:-${HB_SCORED_CANDIDATES:-[]}}"
  unset profile reason config launchd_label launchd_plist known_profiles matched_rules score auto_selected host candidate_profiles scored_candidates
}

if [[ -n "${requested_profile}" || "${manual_target_override}" -eq 0 ]]; then
  routing_env=""

  if routing_env="$(resolve_profile "${requested_profile}" "${cmd}" "${command_url}" "${routing_hint}" 1)"; then
    apply_resolved_profile_env "${routing_env}"

    if [[ "${HUMAN_BROWSER_PROFILE_DEBUG:-0}" == "1" ]]; then
      echo "[human-browser] profile=${HB_SELECTED_PROFILE} reason=${HB_PROFILE_REASON}" >&2
      if [[ -n "${routing_hint}" ]]; then
        echo "[human-browser] routing_hint=${routing_hint}" >&2
      fi
    fi
  elif [[ -n "${requested_profile}" ]]; then
    echo "human-browser: failed to resolve requested profile '${requested_profile}'" >&2
    exit 2
  fi
fi

if [[ -z "${HB_CONFIG}" ]]; then
  HB_CONFIG="${DEFAULT_CONFIG}"
fi
if [[ -z "${LAUNCHD_LABEL}" ]]; then
  LAUNCHD_LABEL="${DEFAULT_LABEL}"
fi
if [[ -z "${LAUNCHD_PLIST}" ]]; then
  LAUNCHD_PLIST="${DEFAULT_PLIST}"
fi

get_port() {
      if [[ -f "${HB_CONFIG}" ]]; then
    "${HB_PYTHON}" - <<'PY' "${HB_CONFIG}" 2>/dev/null || true
import json, sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
  cfg = json.load(f)
port = (cfg.get('daemon') or {}).get('port')
try:
  port = int(port)
except Exception:
  port = None
print(port or 18765)
PY
    return 0
  fi

  echo 18765
}

daemon_healthy() {
  local port
  port="$(get_port)"
  curl -fsS --max-time 0.2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1
}

ensure_daemon() {
  # Allow opting out when needed (e.g. debugging connection failures).
  if [[ "${HUMAN_BROWSER_AUTOSTART:-1}" == "0" ]]; then
    return 0
  fi

  if daemon_healthy; then
    return 0
  fi

  if [[ ! -f "${LAUNCHD_PLIST}" ]]; then
    # No launchd config: do not try to background-spawn here.
    return 0
  fi

  local domain
  domain="gui/$(id -u)"

  # If not loaded yet (e.g. first run), bootstrap it.
  launchctl print "${domain}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || \
    launchctl bootstrap "${domain}" "${LAUNCHD_PLIST}" >/dev/null 2>&1 || true

  launchctl kickstart -k "${domain}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true

  # Wait briefly for the HTTP server to come up.
  local i
  for i in {1..20}; do
    if daemon_healthy; then
      return 0
    fi
    sleep 0.1
  done
}

if [[ ! -f "${HB_CLI}" ]]; then
  cat >&2 <<HELP
human-browser は未インストールです。
Codex 内で使えるようにするには、次を1回実行してください。

git clone ${HB_REPO_URL} "$HOME/.human-browser"
cd "$HOME/.human-browser"
npm install
npm link
human-browser init
human-browser daemon

Chrome 側は ${HB_REPO_URL} の手順で extension を読み込んでください。
HELP
  exit 127
fi

if [[ -z "${cmd}" ]]; then
  exec node "$HB_CLI"
fi

has_config_flag() {
  local prev=""
  for token in "$@"; do
    if [[ "${prev}" == "--config" ]]; then
      return 0
    fi
    if [[ "${token}" == --config=* ]]; then
      return 0
    fi
    prev="${token}"
  done
  return 1
}

has_port_flag() {
  local prev=""
  for token in "$@"; do
    if [[ "${prev}" == "--port" ]]; then
      return 0
    fi
    if [[ "${token}" == --port=* ]]; then
      return 0
    fi
    prev="${token}"
  done
  return 1
}

json_array_to_lines() {
  local raw="${1:-[]}"
  "${HB_PYTHON}" - <<'PY' "${raw}"
import json
import sys

raw = sys.argv[1] if len(sys.argv) > 1 else "[]"
try:
    data = json.loads(raw)
except Exception:
    data = []

if not isinstance(data, list):
    data = []

for item in data:
    if isinstance(item, str) and item.strip():
        print(item.strip())
PY
}

run_command_current_profile() {
  local -a args=("$@")
  if ! has_config_flag "${args[@]}"; then
    args=(--config "${HB_CONFIG}" "${args[@]}")
  fi
  node "$HB_CLI" "${args[@]}"
}

command_needs_access_probe() {
  case "${cmd}" in
    open|goto|navigate)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

profile_access_looks_valid() {
  local target_tab="${1:-}"
  local block_markers
  local min_content_chars
  local load_wait_ms
  local probe_json
  local selector_ok="true"
  local -a tab_args=()

  if [[ -n "${target_tab}" ]]; then
    tab_args=(--tab "${target_tab}")
  fi

  block_markers="${HUMAN_BROWSER_BLOCK_MARKERS:-sign in|ログイン|サインイン|access denied|unauthorized|verify account|2-step verification|permission denied|not authorized}"
  min_content_chars="${HUMAN_BROWSER_MIN_CONTENT_CHARS:-40}"
  load_wait_ms="${HUMAN_BROWSER_FAILOVER_WAIT_MS:-5000}"

  node "$HB_CLI" --config "${HB_CONFIG}" wait --load domcontentloaded --timeout "${load_wait_ms}" "${tab_args[@]}" >/dev/null 2>&1 || true

  probe_json="$(node "$HB_CLI" --json --config "${HB_CONFIG}" eval '(() => ({url: String(location.href || ""), title: String(document.title || ""), text: String((document.body && document.body.innerText) || "").slice(0, 20000)}))()' "${tab_args[@]}" 2>/dev/null || true)"
  if [[ -z "${probe_json}" ]]; then
    return 1
  fi

  if [[ -n "${expect_selector}" ]]; then
    local selector_literal selector_probe_json
    selector_literal="$("${HB_PYTHON}" - <<'PY' "${expect_selector}"
import json
import sys
print(json.dumps(sys.argv[1]))
PY
)"
    selector_probe_json="$(node "$HB_CLI" --json --config "${HB_CONFIG}" eval "Boolean(document.querySelector(${selector_literal}))" "${tab_args[@]}" 2>/dev/null || true)"
    selector_ok="$("${HB_PYTHON}" - <<'PY' "${selector_probe_json}"
import json
import sys

raw = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    data = json.loads(raw)
except Exception:
    print("false")
    raise SystemExit(0)

value = None
if isinstance(data, bool):
    value = data
elif isinstance(data, dict):
    if isinstance(data.get("result"), bool):
        value = data.get("result")
    elif isinstance(data.get("result"), dict):
        inner = data.get("result")
        if isinstance(inner.get("result"), bool):
            value = inner.get("result")

print("true" if value is True else "false")
PY
)"
    if [[ "${selector_ok}" != "true" ]]; then
      selector_ok="false"
    fi
  fi

  "${HB_PYTHON}" - <<'PY' "${probe_json}" "${block_markers}" "${expect_text}" "${selector_ok}" "${min_content_chars}" "${HUMAN_BROWSER_PROFILE_DEBUG:-0}"
import json
import sys

probe_raw = sys.argv[1]
markers_raw = sys.argv[2]
expect_text = sys.argv[3]
selector_ok = sys.argv[4].lower() == "true"
min_chars = int(sys.argv[5]) if sys.argv[5].isdigit() else 40
debug = sys.argv[6] == "1"

try:
    probe = json.loads(probe_raw)
except Exception:
    if debug:
        print("[human-browser] failover-probe: invalid probe JSON", file=sys.stderr)
    raise SystemExit(1)

if not isinstance(probe, dict):
    if debug:
        print("[human-browser] failover-probe: unexpected probe payload", file=sys.stderr)
    raise SystemExit(1)

if isinstance(probe.get("result"), dict):
    inner = probe.get("result")
    if isinstance(inner.get("result"), dict):
        probe = inner.get("result")
    else:
        probe = inner

url = str(probe.get("url") or "")
title = str(probe.get("title") or "")
text = str(probe.get("text") or "")
haystack = "\n".join([url, title, text]).lower()

markers = [m.strip().lower() for m in markers_raw.split("|") if m.strip()]
blocked_marker = next((m for m in markers if m in haystack), "")
expected_text_ok = (not expect_text) or (expect_text.lower() in haystack)
content_ok = len(text.strip()) >= min_chars
selector_match_ok = selector_ok

valid = (not blocked_marker) and expected_text_ok and selector_match_ok and (content_ok or expected_text_ok or selector_match_ok)
if valid:
    raise SystemExit(0)

if debug:
    reasons = []
    if blocked_marker:
        reasons.append(f"blocked_marker:{blocked_marker}")
    if not expected_text_ok:
        reasons.append("expected_text_missing")
    if not selector_match_ok:
        reasons.append("expected_selector_missing")
    if not content_ok:
        reasons.append(f"content_too_short<{min_chars}")
    reason_text = ",".join(reasons) if reasons else "unknown"
    print(f"[human-browser] failover-probe: invalid({reason_text})", file=sys.stderr)

raise SystemExit(1)
PY
}

resolve_and_apply_profile() {
  local profile_name="$1"
  local resolved_env=""
  if ! resolved_env="$(resolve_profile "${profile_name}" "${cmd}" "${command_url}" "${routing_hint}" 0)"; then
    return 1
  fi
  apply_resolved_profile_env "${resolved_env}"
  return 0
}

extract_probe_tab_id() {
  local payload="$1"
  "${HB_PYTHON}" - <<'PY' "${payload}"
import json
import sys

raw = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    data = json.loads(raw)
except Exception:
    raise SystemExit(0)

candidate = None
if isinstance(data, dict):
    if isinstance(data.get("tab_id"), int):
        candidate = data.get("tab_id")
    elif isinstance(data.get("tab_id"), str) and data.get("tab_id").isdigit():
        candidate = int(data.get("tab_id"))
    result = data.get("result")
    if candidate is None and isinstance(result, dict):
        if isinstance(result.get("tab_id"), int):
            candidate = result.get("tab_id")
        elif isinstance(result.get("tab_id"), str) and result.get("tab_id").isdigit():
            candidate = int(result.get("tab_id"))

if isinstance(candidate, int):
    print(candidate)
PY
}

base_args=("$@")
user_supplied_config=0
if has_config_flag "${base_args[@]}"; then
  user_supplied_config=1
fi

failover_enabled=0
case "${cmd}" in
  open|goto|navigate)
    if [[ "${HUMAN_BROWSER_PROFILE_FAILOVER:-1}" == "1" ]]; then
      failover_enabled=1
    fi
    ;;
  *)
    failover_enabled=0
    ;;
esac

if [[ "${retry_profiles_override}" == "on" ]]; then
  failover_enabled=1
fi
if [[ "${retry_profiles_override}" == "off" ]]; then
  failover_enabled=0
fi
if [[ -n "${requested_profile}" && "${retry_profiles_override}" != "on" ]]; then
  failover_enabled=0
fi
if ((user_supplied_config == 1)) && [[ "${retry_profiles_override}" != "on" ]]; then
  failover_enabled=0
fi

# Autostart daemon for Codex / Claude Code workflows.
# - Uses launchd if configured (recommended).
# - Does not hide failures: commands will still error if the daemon can't start.
if ((failover_enabled == 0)); then
  case "$cmd" in
    daemon|init|ws|rotate-token)
      ;;
    *)
      ensure_daemon
      ;;
  esac
fi

node_args=("$@")
if ! has_config_flag "${node_args[@]}"; then
  node_args=(--config "${HB_CONFIG}" "${node_args[@]}")
fi
if [[ "${cmd}" == "init" ]] && ! has_port_flag "${node_args[@]}"; then
  node_args=(--port "$(get_port)" "${node_args[@]}")
fi

if ((failover_enabled == 0)); then
  exec node "$HB_CLI" "${node_args[@]}"
fi

candidate_json="${HB_CANDIDATE_PROFILES:-[]}"
candidates=()
while IFS= read -r line; do
  if [[ -n "${line}" ]]; then
    candidates+=("${line}")
  fi
done < <(json_array_to_lines "${candidate_json}")

if ((${#candidates[@]} == 0)); then
  if [[ -n "${HB_SELECTED_PROFILE:-}" ]]; then
    candidates=("${HB_SELECTED_PROFILE}")
  else
    candidates=("default")
  fi
fi

if [[ "${HUMAN_BROWSER_PROFILE_DEBUG:-0}" == "1" ]]; then
  echo "[human-browser] failover candidates: ${candidates[*]}" >&2
fi

last_output=""
last_status=1
last_profile="${HB_SELECTED_PROFILE:-}"
for candidate in "${candidates[@]}"; do
  if [[ -z "${candidate}" ]]; then
    continue
  fi

  if [[ "${candidate}" != "${HB_SELECTED_PROFILE:-}" ]]; then
    if ! resolve_and_apply_profile "${candidate}"; then
      if [[ "${HUMAN_BROWSER_PROFILE_DEBUG:-0}" == "1" ]]; then
        echo "[human-browser] failover: profile resolve failed (${candidate})" >&2
      fi
      continue
    fi
  fi

  case "$cmd" in
    daemon|init|ws|rotate-token)
      ;;
    *)
      ensure_daemon
      ;;
  esac

  last_profile="${HB_SELECTED_PROFILE:-${candidate}}"
  if [[ "${HUMAN_BROWSER_PROFILE_DEBUG:-0}" == "1" ]]; then
    echo "[human-browser] failover attempt: profile=${last_profile}" >&2
  fi

  set +e
  last_output="$(run_command_current_profile "${base_args[@]}" 2>&1)"
  attempt_status=$?
  set -e

  if ((attempt_status == 0)); then
    if command_needs_access_probe; then
      probe_tab_id="$(extract_probe_tab_id "${last_output}")"
      if ! profile_access_looks_valid "${probe_tab_id}"; then
        last_status=1
        continue
      fi
    fi
    if [[ -n "${last_output}" ]]; then
      printf '%s\n' "${last_output}"
    fi
    run_profile_router --format text use "${HB_SELECTED_PROFILE:-${candidate}}" >/dev/null 2>&1 || true
    exit 0
  fi

  last_status=${attempt_status}
  if [[ "${HUMAN_BROWSER_PROFILE_DEBUG:-0}" == "1" ]]; then
    echo "[human-browser] failover attempt failed: profile=${last_profile} status=${last_status}" >&2
  fi
done

if [[ -n "${last_output}" ]]; then
  printf '%s\n' "${last_output}" >&2
fi
if [[ "${HUMAN_BROWSER_PROFILE_DEBUG:-0}" == "1" ]]; then
  echo "[human-browser] failover exhausted (last_profile=${last_profile})" >&2
fi
exit "${last_status}"
