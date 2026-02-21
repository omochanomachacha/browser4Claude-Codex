#!/usr/bin/env python3
"""Profile routing for human-browser wrapper.

This helper keeps profile-selection logic out of the shell script so both
Codex and Claude Code can share deterministic browser routing.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


@dataclass(frozen=True)
class Profile:
    name: str
    config: str
    launchd_label: str
    launchd_plist: str
    aliases: tuple[str, ...]
    url_hosts: tuple[str, ...]
    url_host_regex: tuple[str, ...]
    workspace_regex: tuple[str, ...]
    keywords: tuple[str, ...]
    priority: int


def _expand_path(value: str) -> str:
    return os.path.abspath(os.path.expandvars(os.path.expanduser(value)))


def _coerce_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def _safe_read_json(path: str) -> Any | None:
    file_path = Path(path)
    if not file_path.exists():
        return None
    raw = file_path.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _extract_first_json_object(raw: str) -> dict[str, Any] | None:
    """Best-effort recovery for partially corrupted state files.

    Some environments can leave trailing garbage bytes after a valid JSON object
    (e.g. interrupted writes). We recover the first top-level JSON object and
    ignore the rest to keep profile routing stable.
    """
    if not raw:
        return None

    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
        return None
    except json.JSONDecodeError:
        pass

    start = raw.find("{")
    if start < 0:
        return None

    depth = 0
    in_string = False
    escaped = False

    for idx in range(start, len(raw)):
        ch = raw[idx]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
            continue
        if ch == "}":
            depth -= 1
            if depth == 0:
                candidate = raw[start : idx + 1]
                try:
                    parsed = json.loads(candidate)
                except json.JSONDecodeError:
                    return None
                if isinstance(parsed, dict):
                    return parsed
                return None

    return None


def _default_profiles(hb_home: str, user_home: str) -> dict[str, dict[str, Any]]:
    base_label = "com.teramotodaiki.human-browser"
    defaults_by_name = {
        "personal": ["personal", "private", "個人", "個人ブラウザ"],
        "anymind": ["anymind", "company1", "corp1", "company-1", "会社1", "会社ブラウザ1"],
        "acua": ["acua", "acua.ai", "company2", "corp2", "company-2", "会社2", "会社ブラウザ2"],
    }
    profiles: dict[str, dict[str, Any]] = {}
    for name in ("personal", "anymind", "acua"):
        label = f"{base_label}.{name}"
        aliases = defaults_by_name[name]
        config_path = os.path.join(hb_home, f"config.{name}.json")
        if name == "anymind":
            # Backward compatibility: older installs used config.json for company1.
            config_path = os.path.join(hb_home, "config.json")
        profiles[name] = {
            "config": config_path,
            "launchd_label": label,
            "launchd_plist": os.path.join(user_home, "Library", "LaunchAgents", f"{label}.plist"),
            "aliases": aliases,
            "url_hosts": [],
            "url_host_regex": [],
            "workspace_regex": [],
            "keywords": aliases,
            "priority": 0,
        }

    # Keep compatibility with the original single-profile setup.
    profiles["default"] = {
        "config": os.path.join(hb_home, "config.json"),
        "launchd_label": base_label,
        "launchd_plist": os.path.join(user_home, "Library", "LaunchAgents", f"{base_label}.plist"),
        "aliases": ["default"],
        "url_hosts": [],
        "url_host_regex": [],
        "workspace_regex": [],
        "keywords": [],
        "priority": -100,
    }
    return profiles


def _merge_profile_entry(name: str, entry: Any, base: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(entry, dict):
        return base

    merged = dict(base)
    match_section = entry.get("match")
    if not isinstance(match_section, dict):
        match_section = {}

    config_path = entry.get("config")
    launchd_label = entry.get("launchd_label")
    launchd_plist = entry.get("launchd_plist")
    priority = entry.get("priority")

    if isinstance(config_path, str) and config_path:
        merged["config"] = config_path
    if isinstance(launchd_label, str) and launchd_label:
        merged["launchd_label"] = launchd_label
    if isinstance(launchd_plist, str) and launchd_plist:
        merged["launchd_plist"] = launchd_plist
    if isinstance(priority, int):
        merged["priority"] = priority

    aliases = _coerce_string_list(entry.get("aliases")) + _coerce_string_list(match_section.get("aliases"))
    url_hosts = _coerce_string_list(entry.get("url_hosts")) + _coerce_string_list(match_section.get("url_hosts"))
    url_host_regex = _coerce_string_list(entry.get("url_host_regex")) + _coerce_string_list(
        match_section.get("url_host_regex")
    )
    workspace_regex = _coerce_string_list(entry.get("workspace_regex")) + _coerce_string_list(
        match_section.get("workspace_regex")
    )
    keywords = _coerce_string_list(entry.get("keywords")) + _coerce_string_list(match_section.get("keywords"))

    merged["aliases"] = aliases or merged.get("aliases", [])
    merged["url_hosts"] = url_hosts or merged.get("url_hosts", [])
    merged["url_host_regex"] = url_host_regex or merged.get("url_host_regex", [])
    merged["workspace_regex"] = workspace_regex or merged.get("workspace_regex", [])
    merged["keywords"] = keywords or merged.get("keywords", [])
    return merged


def load_profiles(hb_home: str, profiles_path: str) -> tuple[dict[str, Profile], str]:
    user_home = os.path.expanduser("~")
    defaults = _default_profiles(hb_home, user_home)

    custom_data = _safe_read_json(profiles_path)
    if custom_data is None:
        custom_data = {}
    if not isinstance(custom_data, dict):
        raise ValueError(f"Invalid profiles JSON (object required): {profiles_path}")

    configured_profiles = custom_data.get("profiles", {})
    if configured_profiles is None:
        configured_profiles = {}
    if not isinstance(configured_profiles, dict):
        raise ValueError(f"Invalid profiles.profiles (object required): {profiles_path}")

    merged: dict[str, dict[str, Any]] = dict(defaults)
    for name, value in configured_profiles.items():
        if not isinstance(name, str):
            continue
        base = defaults.get(name, defaults["default"])
        merged[name] = _merge_profile_entry(name, value, base)

    profile_map: dict[str, Profile] = {}
    for name, raw in merged.items():
        aliases = [name] + _coerce_string_list(raw.get("aliases"))
        profile_map[name] = Profile(
            name=name,
            config=_expand_path(str(raw["config"])),
            launchd_label=str(raw["launchd_label"]),
            launchd_plist=_expand_path(str(raw["launchd_plist"])),
            aliases=tuple(dict.fromkeys(a.strip() for a in aliases if a and isinstance(a, str))),
            url_hosts=tuple(h.strip().lower().lstrip(".") for h in _coerce_string_list(raw.get("url_hosts")) if h.strip()),
            url_host_regex=tuple(_coerce_string_list(raw.get("url_host_regex"))),
            workspace_regex=tuple(_coerce_string_list(raw.get("workspace_regex"))),
            keywords=tuple(k.strip().lower() for k in _coerce_string_list(raw.get("keywords")) if k.strip()),
            priority=int(raw.get("priority", 0)),
        )

    default_profile = custom_data.get("default_profile")
    if not isinstance(default_profile, str) or default_profile not in profile_map:
        # Backward-compatible default:
        # 1) legacy single-config profile when available
        # 2) personal profile when available
        # 3) any existing config
        # 4) deterministic profile name fallback
        if "default" in profile_map and Path(profile_map["default"].config).exists():
            default_profile = "default"
        elif "personal" in profile_map and Path(profile_map["personal"].config).exists():
            default_profile = "personal"
        else:
            existing = [name for name, profile in profile_map.items() if Path(profile.config).exists()]
            if existing:
                default_profile = sorted(existing)[0]
            else:
                default_profile = "personal" if "personal" in profile_map else sorted(profile_map.keys())[0]

    return profile_map, default_profile


def resolve_alias(name: str, profiles: dict[str, Profile]) -> str | None:
    target = name.strip().lower()
    if not target:
        return None
    for profile_name, profile in profiles.items():
        candidates = {profile_name.lower(), *(a.lower() for a in profile.aliases)}
        if target in candidates:
            return profile_name
    return None


def parse_host(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    host = parsed.hostname
    return host.lower().strip() if isinstance(host, str) else ""


def load_state(state_path: str) -> dict[str, Any]:
    path = Path(state_path)
    if not path.exists():
        return {}

    raw = path.read_text(encoding="utf-8")
    data = _extract_first_json_object(raw)
    if not isinstance(data, dict):
        return {}

    # If trailing garbage existed, rewrite sanitized JSON to prevent recurring failures.
    try:
        normalized = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        if raw != normalized:
            path.write_text(normalized, encoding="utf-8")
    except Exception:
        # Recovery should never block routing.
        pass

    return data


def save_state(state_path: str, profile: str, reason: str) -> None:
    path = Path(state_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "current_profile": profile,
        "reason": reason,
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def score_profile(profile: Profile, host: str, context_text_lower: str, cwd: str) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []

    if host:
        for candidate in profile.url_hosts:
            if host == candidate or host.endswith(f".{candidate}"):
                score += 1000
                reasons.append(f"url_host:{candidate}")
                break

        for raw_pattern in profile.url_host_regex:
            try:
                if re.search(raw_pattern, host):
                    score += 900
                    reasons.append(f"url_regex:{raw_pattern}")
                    break
            except re.error:
                continue

    if context_text_lower:
        for keyword in profile.keywords:
            if keyword and keyword in context_text_lower:
                score += 250
                reasons.append(f"keyword:{keyword}")
                break

    for raw_pattern in profile.workspace_regex:
        try:
            if re.search(raw_pattern, cwd):
                score += 200
                reasons.append(f"workspace_regex:{raw_pattern}")
                break
        except re.error:
            continue

    score += profile.priority
    if profile.priority:
        reasons.append(f"priority:{profile.priority}")

    if not Path(profile.config).exists():
        score -= 100
        reasons.append("config_missing_penalty")

    return score, reasons


def resolve_profile(
    profiles: dict[str, Profile],
    default_profile: str,
    state_path: str,
    *,
    explicit: str,
    command: str,
    url: str,
    hint: str,
    cwd: str,
    auto_enabled: bool,
) -> dict[str, Any]:
    host = parse_host(url)
    state = load_state(state_path)
    score_board: list[tuple[str, int, list[str]]] = []
    context_text = " ".join(part for part in [hint, command, url] if part).lower()

    if auto_enabled:
        for name, profile in profiles.items():
            score, reasons = score_profile(profile, host, context_text, cwd)
            score_board.append((name, score, reasons))

    if explicit:
        resolved = resolve_alias(explicit, profiles)
        if not resolved:
            raise ValueError(f"Unknown profile: {explicit}. known={','.join(sorted(profiles.keys()))}")
        selected = profiles[resolved]
        reason = "explicit"
        matched_rules = ["explicit"]
        auto_selected = False
        score = 0
    else:
        selected = None
        reason = ""
        matched_rules: list[str] = []
        auto_selected = False
        score = 0

        if auto_enabled:
            best_name: str | None = None
            best_score = -10**9
            best_reasons: list[str] = []

            for name, candidate_score, candidate_reasons in score_board:
                if candidate_score > best_score and candidate_score > 0:
                    best_name = name
                    best_score = candidate_score
                    best_reasons = candidate_reasons

            if best_name:
                selected = profiles[best_name]
                score = best_score
                matched_rules = best_reasons
                reason = "auto_rule_match"
                auto_selected = True

        if selected is None:
            current = state.get("current_profile")
            if isinstance(current, str) and current in profiles:
                selected = profiles[current]
                reason = "state_fallback"
                matched_rules = ["state:current_profile"]
            else:
                selected = profiles.get(default_profile) or profiles[sorted(profiles.keys())[0]]
                reason = "default_fallback"
                matched_rules = [f"default:{selected.name}"]

        # If auto/default resolved to a missing config, prefer an existing config
        # to avoid breaking legacy single-profile workflows.
        if selected is not None and not Path(selected.config).exists() and reason in {"state_fallback", "default_fallback"}:
            current = state.get("current_profile")
            fallback_candidates: list[str] = []
            if isinstance(current, str):
                fallback_candidates.append(current)
            fallback_candidates.extend([default_profile, "default", "personal"])
            fallback_candidates.extend(sorted(profiles.keys()))

            replacement: Profile | None = None
            for candidate in fallback_candidates:
                profile = profiles.get(candidate)
                if profile and Path(profile.config).exists():
                    replacement = profile
                    break

            if replacement is not None:
                selected = replacement
                reason = "existing_config_fallback"
                matched_rules = [*matched_rules, "fallback:existing_config"]
                auto_selected = False
                score = 0

    candidate_profiles: list[str] = [selected.name]
    ranked_scores = sorted(score_board, key=lambda item: (item[1], item[0]), reverse=True)
    for name, candidate_score, _candidate_reasons in ranked_scores:
        if name == selected.name:
            continue
        if candidate_score > 0:
            candidate_profiles.append(name)

    for name in sorted(profiles.keys()):
        if name != selected.name and name not in candidate_profiles:
            candidate_profiles.append(name)

    return {
        "profile": selected.name,
        "reason": reason,
        "auto_selected": auto_selected,
        "score": score,
        "matched_rules": matched_rules,
        "candidate_profiles": candidate_profiles,
        "scored_candidates": [
            {
                "profile": name,
                "score": candidate_score,
                "reasons": candidate_reasons,
            }
            for name, candidate_score, candidate_reasons in ranked_scores
        ],
        "host": host,
        "config": selected.config,
        "launchd_label": selected.launchd_label,
        "launchd_plist": selected.launchd_plist,
        "known_profiles": sorted(profiles.keys()),
    }


def emit_result(data: Any, fmt: str) -> None:
    if fmt == "json":
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    if fmt == "env":
        if not isinstance(data, dict):
            raise ValueError("env format is supported only for object output")
        for key, value in data.items():
            if value is None:
                continue
            env_key = str(key)
            env_value = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            print(f"{env_key}={shlex.quote(env_value)}")
        return

    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, (dict, list)):
                print(f"{key}: {json.dumps(value, ensure_ascii=False)}")
            else:
                print(f"{key}: {value}")
        return

    if isinstance(data, list):
        for entry in data:
            print(entry)
        return

    print(str(data))


def main() -> int:
    parser = argparse.ArgumentParser(description="human-browser profile router")
    parser.add_argument("--home", default=os.path.join(os.path.expanduser("~"), ".human-browser"))
    parser.add_argument("--profiles", default="")
    parser.add_argument("--state", default="")
    parser.add_argument("--format", choices=("text", "json", "env"), default="text")

    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    subparsers.add_parser("list", help="list profiles")
    subparsers.add_parser("current", help="show current profile")

    use_parser = subparsers.add_parser("use", help="set current profile")
    use_parser.add_argument("profile")

    resolve_parser = subparsers.add_parser("resolve", help="resolve profile")
    resolve_parser.add_argument("--command", default="")
    resolve_parser.add_argument("--url", default="")
    resolve_parser.add_argument("--hint", default="")
    resolve_parser.add_argument("--cwd", default=os.getcwd())
    resolve_parser.add_argument("--explicit", default="")
    resolve_parser.add_argument("--auto", choices=("0", "1"), default="1")
    resolve_parser.add_argument("--persist", action="store_true")

    args = parser.parse_args()

    hb_home = _expand_path(args.home)
    profiles_path = _expand_path(args.profiles) if args.profiles else os.path.join(hb_home, "profiles.json")
    state_path = _expand_path(args.state) if args.state else os.path.join(hb_home, "profile-state.json")

    profiles, default_profile = load_profiles(hb_home, profiles_path)

    if args.subcommand == "list":
        data = [
            {
                "profile": p.name,
                "config": p.config,
                "launchd_label": p.launchd_label,
                "launchd_plist": p.launchd_plist,
                "aliases": list(p.aliases),
                "priority": p.priority,
            }
            for _, p in sorted(profiles.items())
        ]
        emit_result(data, args.format)
        return 0

    if args.subcommand == "current":
        state = load_state(state_path)
        current = state.get("current_profile")
        if isinstance(current, str) and current in profiles:
            selected = profiles[current]
            reason = "state"
        else:
            selected = profiles.get(default_profile) or profiles[sorted(profiles.keys())[0]]
            reason = "default"
        emit_result(
            {
                "profile": selected.name,
                "reason": reason,
                "config": selected.config,
                "launchd_label": selected.launchd_label,
                "launchd_plist": selected.launchd_plist,
            },
            args.format,
        )
        return 0

    if args.subcommand == "use":
        resolved = resolve_alias(args.profile, profiles)
        if not resolved:
            raise ValueError(f"Unknown profile: {args.profile}. known={','.join(sorted(profiles.keys()))}")
        save_state(state_path, resolved, "manual_use")
        selected = profiles[resolved]
        emit_result(
            {
                "profile": selected.name,
                "reason": "manual_use",
                "config": selected.config,
                "launchd_label": selected.launchd_label,
                "launchd_plist": selected.launchd_plist,
            },
            args.format,
        )
        return 0

    if args.subcommand == "resolve":
        result = resolve_profile(
            profiles,
            default_profile,
            state_path,
            explicit=args.explicit,
            command=args.command,
            url=args.url,
            hint=args.hint,
            cwd=_expand_path(args.cwd),
            auto_enabled=args.auto == "1",
        )
        if args.persist:
            save_state(state_path, result["profile"], result["reason"])
        emit_result(result, args.format)
        return 0

    raise ValueError(f"Unsupported subcommand: {args.subcommand}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - defensive CLI boundary
        print(str(exc), file=sys.stderr)
        raise SystemExit(2)
