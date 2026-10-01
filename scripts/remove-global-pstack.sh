#!/usr/bin/env bash
set -euo pipefail

APPLY=0
case "${1:-}" in
  "") ;;
  --apply) APPLY=1 ;;
  *) printf 'Usage: %s [--apply]\n' "$0" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
clone_skills="$data_home/maxstack/pstack-claude/plugins/pstack/skills"
adapter_skills="$root/opencode/skills"
adapter_agents="$root/opencode/agents"
skills_home="$HOME/.agents/skills"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
agents_home="$config_home/agents"
config="$config_home/opencode.jsonc"

removals=()
conflicts=()

same_text() {
  [[ "$(tr -d '\r' < "$1")" == "$(tr -d '\r' < "$2")" ]]
}

if [[ -d "$skills_home" ]]; then
  for link in "$skills_home"/*; do
    [[ -L "$link" ]] || continue
    target="$(readlink -f "$link" 2>/dev/null || true)"
    case "$target" in
      "$clone_skills"/*|"$adapter_skills"/*) removals+=("$link") ;;
    esac
  done
fi

dest_agents_md="$config_home/AGENTS.md"
source_agents_md="$root/opencode/AGENTS.md"
if [[ -L "$dest_agents_md" ]]; then
  [[ "$(readlink -f "$dest_agents_md")" == "$(readlink -f "$source_agents_md")" ]] && removals+=("$dest_agents_md") || conflicts+=("$dest_agents_md")
elif [[ -e "$dest_agents_md" ]]; then
  same_text "$source_agents_md" "$dest_agents_md" && removals+=("$dest_agents_md") || conflicts+=("$dest_agents_md")
fi

for profile in "$adapter_agents"/*.md; do
  name="$(basename "$profile")"
  dest="$agents_home/$name"
  if [[ -L "$dest" ]]; then
    [[ "$(readlink -f "$dest")" == "$(readlink -f "$profile")" ]] && removals+=("$dest") || conflicts+=("$dest")
  elif [[ -e "$dest" ]]; then
    same_text "$profile" "$dest" && removals+=("$dest") || conflicts+=("$dest")
  fi
done

rewrite_config=0
if [[ -f "$config" ]]; then
  normalized="$(tr -d '[:space:]' < "$config")"
  expected='{"$schema":"https://opencode.ai/config.json","model":"opencode-go/gpt-6-luna","default_agent":"build"}'
  if [[ "$normalized" == "$expected" ]]; then
    rewrite_config=1
  else
    conflicts+=("$config (remove the model and default_agent lines manually)")
  fi
fi

if [[ ${#removals[@]} -gt 0 ]]; then
  printf 'Will remove:\n'
  printf '  %s\n' "${removals[@]}"
fi
[[ "$rewrite_config" -eq 1 ]] && printf 'Will reset %s to the schema only\n' "$config"
if [[ ${#conflicts[@]} -gt 0 ]]; then
  printf 'Left for manual review:\n'
  printf '  %s\n' "${conflicts[@]}"
fi

if [[ "$APPLY" -eq 0 ]]; then
  printf 'Audit only. No global files changed. Pass --apply after reviewing.\n'
  exit 0
fi

for path in "${removals[@]}"; do
  rm -f -- "$path"
  printf 'Removed %s\n' "$path"
done
if [[ "$rewrite_config" -eq 1 ]]; then
  printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$config"
  printf 'Reset %s\n' "$config"
fi
printf 'Global PStack install removed for the Ubuntu WSL OpenCode runtime.\n'
