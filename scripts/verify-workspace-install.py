#!/usr/bin/env python3
"""Verify the installed workspace bundle against stack.lock.json, and that no global install remains.

Each runtime the lock records is checked against the files on disk: the Claude plugin
folders, the OpenCode plugin folders and their agent profiles, the nested OpenCode
entries the config names, and the Copilot wrappers.
"""

import argparse
import hashlib
import json
import os
import pathlib
import re
import sys

REQUIRED_SKILLS = (
    "poteto-mode",
    "setup-pstack",
    "principle-laziness-protocol",
)
PSTACK = "pstack"
OBSOLETE_CLAUDE_FILES = (
    ".claude-plugin/marketplace.json",
    ".claude/workspace-settings.json",
)
RETIRED_OPENCODE_FOLDERS = ("pstack-opencode",)
COPILOT_WRAPPERS = ("copilot.cmd", "copilot.sh")
COPILOT_ASK_LINE = 'set "AGENT_ACCESS_COPILOT_ASK=allow"'
RUNTIMES = ("claude", "opencode", "copilot")


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


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def tree_sha256(root: pathlib.Path) -> str:
    """Mirror Get-TreeSha256 in Install-Workspace.ps1: one line per file, relative path and
    SHA-256, sorted, leaving out a top-level node_modules; then the SHA-256 of that text."""
    lines = []
    for dirpath, dirnames, filenames in os.walk(root):
        if pathlib.Path(dirpath) == root:
            dirnames[:] = [name for name in dirnames if name != "node_modules"]
        for name in filenames:
            full = pathlib.Path(dirpath) / name
            lines.append(f"{full.relative_to(root).as_posix()}\t{sha256_hex(full.read_bytes())}")
    text = "\n".join(sorted(lines)) + "\n"
    return sha256_hex(text.encode("utf-8"))


def load_lock(workspace: pathlib.Path, failures: list[str]) -> dict | None:
    lock_path = workspace / "stack.lock.json"
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        failures.append(f"cannot read {lock_path}: {error}")
        return None
    layers = lock.get("layers", [])
    if not layers or any(
        any(runtime not in layer for runtime in RUNTIMES) for layer in layers
    ):
        failures.append(
            f"{lock_path} predates the runtime records; rerun Install-Workspace.ps1 -Apply"
        )
        return None
    return lock


def check_claude(lock: dict, workspace: pathlib.Path, failures: list[str]) -> None:
    """Check the Claude plugin tree against the claude records in stack.lock.json."""
    for obsolete in OBSOLETE_CLAUDE_FILES:
        if (workspace / obsolete).exists():
            failures.append(
                f"obsolete generated file from the marketplace design: {workspace / obsolete}"
            )

    recorded = {}
    for layer in lock["layers"]:
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


def check_opencode(lock: dict, workspace: pathlib.Path, failures: list[str]) -> None:
    """Check each OpenCode folder, its entry, its config reference, and its agent profiles."""
    config_path = workspace / "opencode.jsonc"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        failures.append(f"cannot read {config_path}: {error}")
        config = {}
    configured = config.get("plugin", [])
    for key in ("model", "small_model"):
        if key in config:
            failures.append(f"{config_path} sets {key}; maxstack sets no model. Rerun Install-Workspace.ps1 -Apply")

    recorded = set()
    planned_plugins = []
    for layer in lock["layers"]:
        opencode = layer["opencode"]
        if not opencode.get("enabled"):
            continue
        folder = workspace / opencode["folder"]
        recorded.add(folder.name)
        entry = folder / opencode["entry"]
        if not entry.is_file():
            failures.append(f"missing OpenCode entry for '{layer['name']}': {entry}")
        plugin = opencode.get("plugin")
        if opencode.get("loader") == "config":
            planned_plugins.append(plugin)
            if plugin not in configured:
                failures.append(f"{config_path} does not name the OpenCode entry {plugin} for '{layer['name']}'")
            if not (workspace / plugin.removeprefix("./")).is_dir():
                failures.append(f"the OpenCode plugin path {plugin} for '{layer['name']}' is not a folder")
        for agent in opencode.get("agents", []):
            profile = workspace / ".opencode" / "agents" / agent
            if not profile.is_file():
                failures.append(f"missing agent profile: {profile}")
            elif re.search(r"(?m)^model:", frontmatter(profile.read_text(encoding="utf-8"))):
                failures.append(
                    f"agent profile {profile} sets a model; Install-Workspace.ps1 -Apply removes it"
                )

    if sorted(configured) != sorted(planned_plugins):
        failures.append(
            f"{config_path} lists plugin entries {configured}, but stack.lock.json records {planned_plugins}"
        )

    plugins_dir = workspace / ".opencode" / "plugins"
    if plugins_dir.is_dir():
        for entry in sorted(plugins_dir.iterdir()):
            if entry.name in RETIRED_OPENCODE_FOLDERS:
                failures.append(f"retired OpenCode plugin folder is still present: {entry}")
            elif entry.name not in recorded:
                failures.append(f"stale OpenCode plugin folder not in stack.lock.json: {entry}")

    skills = workspace / ".opencode" / "plugins" / PSTACK / "skills"
    if not skills.is_dir():
        failures.append(f"missing vendored skills: {skills}")
    else:
        ids = sorted(entry.name for entry in skills.iterdir() if entry.is_dir())
        for required in REQUIRED_SKILLS:
            if required not in ids:
                failures.append(f"missing skill: {required}")
        print(f"skills: {len(ids)}")


def check_copilot(lock: dict, workspace: pathlib.Path, failures: list[str]) -> None:
    """Check the Copilot wrappers against their recorded hashes, switch, folders, and executable."""
    bin_dir = workspace / ".maxstack" / "bin"
    copilot = lock.get("copilot") or {}
    if not copilot.get("enabled"):
        for name in COPILOT_WRAPPERS:
            if (bin_dir / name).exists():
                failures.append(
                    f"Copilot wrapper {bin_dir / name} is present, but stack.lock.json records copilot disabled"
                )
        return

    for name, key in (("copilot.cmd", "cmdSha256"), ("copilot.sh", "shSha256")):
        path = bin_dir / name
        if not path.is_file():
            failures.append(f"missing Copilot wrapper: {path}")
        elif sha256_hex(path.read_bytes()) != str(copilot.get(key, "")).upper():
            failures.append(f"Copilot wrapper {path} differs from the text recorded in stack.lock.json")

    cmd = bin_dir / "copilot.cmd"
    if cmd.is_file():
        text = cmd.read_text(encoding="utf-8")
        if COPILOT_ASK_LINE not in text:
            failures.append(f"{cmd} does not set the ask switch: {COPILOT_ASK_LINE}")
        # The wrapper runs its executable on one line, which also names the plugin folders.
        run_lines = [line.strip() for line in text.splitlines() if "--plugin-dir" in line]
        if len(run_lines) != 1:
            failures.append(f"{cmd} must run the executable on one line, found {len(run_lines)}")
            return
        executable = re.match(r'^(?:call )?"([^"]+)"', run_lines[0])
        if executable is None or not pathlib.Path(executable.group(1)).is_file():
            failures.append(f"{cmd} does not run an executable that exists")
        found = [pathlib.Path(folder) for folder in re.findall(r'--plugin-dir "([^"]+)"', run_lines[0])]
        expected = [
            workspace / layer["copilot"]["pluginDir"]
            for layer in lock["layers"]
            if layer["copilot"].get("enabled")
        ]
        if found != expected:
            failures.append(f"{cmd} names plugin folders {found}, but stack.lock.json records {expected}")


def check_global(home: pathlib.Path, failures: list[str]) -> None:
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=default_workspace())
    parser.add_argument("--home", default=os.path.expanduser("~"))
    args = parser.parse_args()

    workspace = pathlib.Path(args.workspace)
    home = pathlib.Path(args.home)
    failures: list[str] = []

    if not (workspace / "opencode.jsonc").is_file():
        failures.append(f"missing workspace config: {workspace / 'opencode.jsonc'}")
    lock = load_lock(workspace, failures)
    if lock is not None:
        check_claude(lock, workspace, failures)
        check_opencode(lock, workspace, failures)
        check_copilot(lock, workspace, failures)

    check_global(home, failures)

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1

    print("PASS: workspace bundle present and no global PStack install found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
