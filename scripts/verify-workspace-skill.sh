#!/usr/bin/env bash
# platforms: linux
set -euo pipefail

skill_id="${1:-poteto-mode}"
workspace="${WORKSPACE:-/mnt/d/dev/simpsonm09}"
project="${PROJECT:-$workspace/projects/repos/simpsonm09-repo-template}"
opencode_bin="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
tmp_root="${PSTACK_TEST_TMPDIR:-${TMPDIR:-/tmp}}"

mkdir -p "$tmp_root"
result_file="$(mktemp "$tmp_root/workspace-skill-check.XXXXXX")"
trap 'rm -f "$result_file"' EXIT

if [[ ! -x "$opencode_bin" ]]; then
  printf 'OpenCode CLI not found at %s\n' "$opencode_bin" >&2
  exit 1
fi

prompt="Call the skill tool with id $skill_id. Then read the file playbooks/investigation.md in that skill's own directory and post WORKSPACE_PSTACK_OK=<its first heading>. Do not edit files and do not run shell commands."

(
  cd "$project"
  "$opencode_bin" run --standalone --auto --format json "$prompt"
) > "$result_file"

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
