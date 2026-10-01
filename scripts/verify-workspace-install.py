#!/usr/bin/env python3
"""Verify the workspace-scoped PStack bundle and that no global install remains."""

import argparse
import os
import pathlib
import sys

REQUIRED_SKILLS = ("poteto-mode", "pstack-opencode", "setup-pstack-opencode", "principle-laziness-protocol")
REQUIRED_AGENTS = ("pstack-agent.md", "pstack-reviewer.md", "pstack-comment-sicko.md")


def default_workspace() -> str:
    wsl = pathlib.Path("/mnt/d/dev/simpsonm09")
    if os.name != "nt" and wsl.is_dir():
        return str(wsl)
    return "D:/dev/simpsonm09"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=default_workspace())
    parser.add_argument("--home", default=os.path.expanduser("~"))
    args = parser.parse_args()

    workspace = pathlib.Path(args.workspace)
    home = pathlib.Path(args.home)
    failures: list[str] = []

    config = workspace / "opencode.jsonc"
    if not config.is_file():
        failures.append(f"missing workspace config: {config}")
    else:
        text = config.read_text(encoding="utf-8")
        for needle in ('"model"', '"default_agent"', '"permissions"', "external_directory"):
            if needle not in text:
                failures.append(f"{config} is missing {needle}")

    plugin = workspace / ".opencode" / "plugins" / "pstack-opencode"
    if not (plugin / "index.ts").is_file():
        failures.append(f"missing plugin entrypoint: {plugin / 'index.ts'}")
    if not (plugin / "node_modules" / "@opencode" / "plugin").exists():
        failures.append(f"missing plugin SDK dependency under {plugin}")

    skills = plugin / "skills"
    if not skills.is_dir():
        failures.append(f"missing vendored skills: {skills}")
    else:
        ids = sorted(entry.name for entry in skills.iterdir() if entry.is_dir())
        for required in REQUIRED_SKILLS:
            if required not in ids:
                failures.append(f"missing skill: {required}")
        print(f"skills: {len(ids)}")

    agents = workspace / ".opencode" / "agents"
    for name in REQUIRED_AGENTS:
        if not (agents / name).is_file():
            failures.append(f"missing agent profile: {agents / name}")

    global_skills = home / ".agents" / "skills"
    if global_skills.is_dir() and any(global_skills.iterdir()):
        failures.append(f"global skills are still present under {global_skills}")

    if (home / ".config" / "opencode" / "AGENTS.md").exists():
        failures.append("global AGENTS.md is still present")

    global_agents = home / ".config" / "opencode" / "agents"
    if global_agents.is_dir():
        left = sorted(entry.name for entry in global_agents.iterdir() if entry.name.startswith("pstack-"))
        if left:
            failures.append(f"global pstack agent profiles are still present: {', '.join(left)}")

    global_config = home / ".config" / "opencode" / "opencode.jsonc"
    if global_config.is_file() and '"model"' in global_config.read_text(encoding="utf-8"):
        failures.append("global opencode.jsonc still sets a model")

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1

    print("PASS: workspace bundle present and no global PStack install found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
