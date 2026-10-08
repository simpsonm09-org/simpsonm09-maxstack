#!/usr/bin/env bash
# platforms: linux
set -euo pipefail

# Usage: verify-workspace-skill.sh [skill_id] <provider/model> [call_timeout_seconds]
skill_id="${1:-poteto-mode}"
model="${2:-}"
call_timeout_seconds="${3:-180}"
workspace="${WORKSPACE:-/mnt/d/dev/simpsonm09}"
project="${PROJECT:-$workspace/projects/repos/simpsonm09-repo-template}"
opencode_bin="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
tmp_root="${PSTACK_TEST_TMPDIR:-${TMPDIR:-/tmp}}"

if [[ -z "$model" ]]; then
  printf 'FAIL: pass the model as the second argument, provider/model. The workspace sets no model, so this check names the model its bounded run uses.\n' >&2
  exit 1
fi
if [[ "$model" != */* ]]; then
  printf 'FAIL: the model must be provider/model, got %s\n' "$model" >&2
  exit 1
fi
if [[ ! "$call_timeout_seconds" =~ ^[0-9]+$ ]]; then
  printf 'FAIL: the call timeout must be a whole number of seconds, got %s\n' "$call_timeout_seconds" >&2
  exit 1
fi

mkdir -p "$tmp_root"
result_file="$(mktemp "$tmp_root/workspace-skill-check.XXXXXX")"
trap 'rm -f "$result_file"' EXIT

if [[ ! -x "$opencode_bin" ]]; then
  printf 'OpenCode CLI not found at %s\n' "$opencode_bin" >&2
  exit 1
fi
if ! command -v timeout >/dev/null 2>&1; then
  printf 'FAIL: the timeout command is needed to bound the OpenCode run.\n' >&2
  exit 1
fi

prompt="Call the skill tool with id $skill_id. Then read the file playbooks/investigation.md in that skill's own directory and post WORKSPACE_PSTACK_OK=<its first heading>. Do not edit files and do not run shell commands."

# The same limit as verify-workspace-skill.ps1. timeout stops the OpenCode process
# (exit 124, or 137 when it had to kill it), so the check fails and names the command.
set +e
(
  cd "$project"
  timeout --kill-after=10 "$call_timeout_seconds" "$opencode_bin" run --standalone --auto --format json --model "$model" "$prompt"
) > "$result_file"
run_status=$?
set -e
if [[ $run_status -eq 124 || $run_status -eq 137 ]]; then
  printf 'FAIL: OpenCode run did not finish within %s seconds in %s. Run it there by hand to see where it stops.\n' "$call_timeout_seconds" "$project" >&2
  exit 1
fi
if [[ $run_status -ne 0 ]]; then
  printf 'FAIL: OpenCode run exited with %s.\n' "$run_status" >&2
  exit 1
fi

python3 - "$result_file" "$skill_id" <<'PY'
import json
import sys

path, expected_skill = sys.argv[1:]
loaded = False
heading = None
unsafe = []

with open(path, encoding="utf-8") as source:
    for line in source:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        part = event.get("part", {})
        if event.get("type") == "text":
            text = part.get("text", "")
            marker = "WORKSPACE_PSTACK_OK="
            index = text.find(marker)
            if index != -1:
                rest = text[index + len(marker):].splitlines()[0].strip()
                rest = rest.lstrip("#*<> ").strip()
                heading = rest.split()[0].strip("<>*") if rest else ""
        if event.get("type") != "tool_use" or part.get("type") != "tool":
            continue
        tool = part.get("tool")
        inputs = part.get("state", {}).get("input", {})
        if tool == "skill" and inputs.get("id") == expected_skill:
            loaded = True
        if tool in {"shell", "edit", "write", "patch", "subagent", "execute"}:
            unsafe.append(tool)

if not loaded:
    raise SystemExit(f"FAIL: no skill tool call loaded {expected_skill!r}.")
if heading != "Investigation":
    raise SystemExit("FAIL: the agent did not read the skill's sibling playbook.")
if unsafe:
    raise SystemExit(f"FAIL: bounded run used restricted tools: {', '.join(unsafe)}")

print(f"PASS: workspace skill {expected_skill!r} loaded and its sibling file was read.")
PY
