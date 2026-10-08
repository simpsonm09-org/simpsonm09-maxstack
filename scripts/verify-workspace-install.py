#!/usr/bin/env python3
"""Verify the workspace-scoped PStack bundle and that no global install remains."""

import argparse
import hashlib
import json
import os
import pathlib
import re
import sys

REQUIRED_SKILLS = (
    "poteto-mode",
    "pstack-opencode",
    "setup-pstack-opencode",
    "principle-laziness-protocol",
)
REQUIRED_AGENTS = ("pstack-agent.md", "pstack-reviewer.md", "pstack-comment-sicko.md")
OBSOLETE_CLAUDE_FILES = (
    ".claude-plugin/marketplace.json",
    ".claude/workspace-settings.json",
)


def default_workspace() -> str:
    wsl = pathlib.Path("/mnt/d/dev/simpsonm09")
    if os.name != "nt" and wsl.is_dir():
        return str(wsl)
    return "D:/dev/simpsonm09"


def is_link(path: pathlib.Path) -> bool:
    """A junction on Windows, or a symlink elsewhere."""
    if hasattr(os.path, "isjunction") and os.path.isjunction(path):
        return True
    return path.is_symlink()


def frontmatter(text: str) -> str:
    """The frontmatter block of a profile, or nothing when it has none."""
    match = re.match(r"---\r?\n.*?\r?\n---\r?\n", text, re.DOTALL)
    return match.group(0) if match else ""


def tree_sha256(root: pathlib.Path) -> str:
    """Mirror Get-TreeSha256 in Install-Workspace.ps1: one line per file, relative path and
    SHA-256, sorted, leaving out a top-level node_modules; then the SHA-256 of that text."""
    lines = []
    for dirpath, dirnames, filenames in os.walk(root):
        if pathlib.Path(dirpath) == root:
            dirnames[:] = [name for name in dirnames if name != "node_modules"]
        for name in filenames:
            full = pathlib.Path(dirpath) / name
            digest = hashlib.sha256(full.read_bytes()).hexdigest().upper()
            lines.append(f"{full.relative_to(root).as_posix()}\t{digest}")
    text = "\n".join(sorted(lines)) + "\n"
    return hashlib.sha256(text.encode("utf-8")).hexdigest().upper()


def check_claude(workspace: pathlib.Path, failures: list[str]) -> None:
    """Check the Claude plugin tree against the claude records in stack.lock.json."""
    lock_path = workspace / "stack.lock.json"
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        failures.append(f"cannot read {lock_path}: {error}")
        return
    layers = lock.get("layers", [])
    if not layers or any("claude" not in layer for layer in layers):
        failures.append(
            f"{lock_path} predates the Claude plugin tree; rerun Install-Workspace.ps1 -Apply"
        )
        return

    for obsolete in OBSOLETE_CLAUDE_FILES:
        if (workspace / obsolete).exists():
            failures.append(
                f"obsolete generated file from the marketplace design: {workspace / obsolete}"
            )

    recorded = {}
    for layer in layers:
        claude = layer["claude"]
        if claude.get("enabled"):
            recorded[claude["plugin"]] = claude

    plugins_dir = workspace / ".claude" / "plugins"
    if plugins_dir.is_dir():
        for entry in sorted(plugins_dir.iterdir()):
            if entry.name not in recorded:
                failures.append(
                    f"stale Claude plugin folder not in stack.lock.json: {entry}"
                )

    for name, claude in recorded.items():
        child = workspace / claude["child"]
        if not child.exists():
            failures.append(f"missing Claude plugin '{name}': {child}")
            continue
        if claude["kind"] == "junction":
            target = workspace / claude["target"]
            if not is_link(child) or os.path.normcase(
                os.path.realpath(child)
            ) != os.path.normcase(os.path.realpath(target)):
                failures.append(f"Claude plugin '{name}' is not a link to {target}")
        elif is_link(child):
            failures.append(
                f"Claude plugin '{name}' should be a copy of the pinned folder, not a link"
            )
        manifest = child / ".claude-plugin" / "plugin.json"
        if not manifest.is_file():
            failures.append(f"Claude plugin '{name}' has no manifest at {manifest}")
        elif json.loads(manifest.read_text(encoding="utf-8")).get("name") != name:
            failures.append(
                f"Claude plugin '{name}' does not match the name in {manifest}"
            )
        if tree_sha256(child) != str(claude.get("treeSha256", "")).upper():
            failures.append(
                f"Claude plugin '{name}' differs from the tree recorded in stack.lock.json"
            )

    print(f"claude: {len(recorded)} plugin folder(s) recorded in {plugins_dir}")


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
        for needle in (
            '"default_agent"',
            '"permissions"',
            "external_directory",
        ):
            if needle not in text:
                failures.append(f"{config} is missing {needle}")
        for needle in ('"model"', '"small_model"'):
            if needle in text:
                failures.append(
                    f"{config} sets {needle}; maxstack sets no model. Rerun Install-Workspace.ps1 -Apply"
                )

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
        profile = agents / name
        if not profile.is_file():
            failures.append(f"missing agent profile: {profile}")
        elif re.search(
            r"(?m)^model:", frontmatter(profile.read_text(encoding="utf-8"))
        ):
            failures.append(
                f"agent profile {profile} sets a model; Install-Workspace.ps1 -Apply removes it"
            )

    check_claude(workspace, failures)

    global_skills = home / ".agents" / "skills"
    # Other tools own this folder too (the Cursor CLI installs its skills here), so
    # only a PStack skill counts as a leftover global install.
    if (global_skills / "poteto-mode").exists() or any(
        global_skills.glob("principle-*")
    ):
        failures.append(f"global PStack skills are still present under {global_skills}")

    if (home / ".config" / "opencode" / "AGENTS.md").exists():
        failures.append("global AGENTS.md is still present")

    global_agents = home / ".config" / "opencode" / "agents"
    if global_agents.is_dir():
        left = sorted(
            entry.name
            for entry in global_agents.iterdir()
            if entry.name.startswith("pstack-")
        )
        if left:
            failures.append(
                f"global pstack agent profiles are still present: {', '.join(left)}"
            )

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1

    print("PASS: workspace bundle present and no global PStack install found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
