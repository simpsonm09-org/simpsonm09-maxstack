#!/usr/bin/env python3
"""Check that the workspace manifests the installer consumes agree.

`scripts/Install-Workspace.ps1` reads `layers.json`,
`pstack-opencode.lock.json`, `pstack-claude.lock.json`, and
`workspace/opencode.jsonc`. A drift between them installs a broken bundle, so
this fails CI first. By default it reads only the manifests and never clones the
private plugin repository. With `--online` it also asks GitHub whether the Claude
tag still resolves to the locked commit and whether the OpenCode port's pin
names the same upstream commit.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
HEX40 = re.compile(r"^[0-9a-f]{40}$")
GIT_URL = re.compile(r"^https://github\.com/[^/]+/[^/]+\.git$")
GITHUB_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
LAYER_KINDS = ("plugin", "config")
CLAUDE_LOCK = "pstack-claude.lock.json"
MODEL_KEYS = ("model", "small_model")


def is_nonempty_str(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def strip_jsonc(text: str) -> str:
    """Strip // and /* */ comments; the standard library has no JSONC parser."""
    out: list[str] = []
    index = 0
    in_string = False
    while index < len(text):
        char = text[index]
        if in_string:
            out.append(char)
            if char == "\\" and index + 1 < len(text):
                out.append(text[index + 1])
                index += 2
                continue
            if char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        if char == "/" and index + 1 < len(text):
            next_char = text[index + 1]
            if next_char == "/":
                newline = text.find("\n", index)
                index = len(text) if newline == -1 else newline
                continue
            if next_char == "*":
                end = text.find("*/", index + 2)
                index = len(text) if end == -1 else end + 2
                continue
        out.append(char)
        index += 1
    return "".join(out)


def load_json(path: Path, failures: list[str]) -> dict | None:
    if not path.is_file():
        failures.append(f"missing file: {path.relative_to(REPO_ROOT)}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        failures.append(f"{path.relative_to(REPO_ROOT)} is not valid JSON: {error}")
        return None


def load_jsonc(path: Path, failures: list[str]) -> dict | None:
    if not path.is_file():
        failures.append(f"missing file: {path.relative_to(REPO_ROOT)}")
        return None
    try:
        return json.loads(strip_jsonc(path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as error:
        failures.append(f"{path.relative_to(REPO_ROOT)} is not valid JSONC: {error}")
        return None


def check_layers(layers: dict, failures: list[str]) -> dict | None:
    records = layers.get("layers")
    if not isinstance(records, list) or not records:
        failures.append("layers.json: layers must be a non-empty list")
        return None
    plugins: list[dict] = []
    for index, layer in enumerate(records):
        where = f"layers.json: layers[{index}]"
        if not isinstance(layer, dict):
            failures.append(f"{where} must be an object")
            continue
        for key in ("name", "kind", "path", "source"):
            if not is_nonempty_str(layer.get(key)):
                failures.append(f"{where} is missing a non-empty {key}")
        if layer.get("kind") not in LAYER_KINDS:
            failures.append(f"{where} kind must be one of {list(LAYER_KINDS)}")
        if is_nonempty_str(layer.get("source")) and not GIT_URL.match(layer["source"]):
            failures.append(
                f"{where} source must be an https github.com git URL: {layer['source']}"
            )
        if "pluginTarget" in layer and not is_nonempty_str(layer.get("pluginTarget")):
            failures.append(f"{where} pluginTarget must be a non-empty string")
        if layer.get("kind") == "plugin":
            plugins.append(layer)
    if len(plugins) != 1:
        failures.append(
            f"layers.json: expected exactly one plugin layer, found {len(plugins)}"
        )
        return None
    return plugins[0]


def check_lock(lock: dict, plugin: dict | None, failures: list[str]) -> None:
    repository = lock.get("repository")
    if not is_nonempty_str(repository) or not GIT_URL.match(repository or ""):
        failures.append(
            "pstack-opencode.lock.json: repository must be an https github.com git URL"
        )
    commit = lock.get("commit")
    if not is_nonempty_str(commit) or not HEX40.match(commit or ""):
        failures.append(
            "pstack-opencode.lock.json: commit must be a 40-character lowercase hex SHA"
        )
    if not is_nonempty_str(lock.get("path")):
        failures.append("pstack-opencode.lock.json: path must be a non-empty string")
    if plugin:
        if lock.get("path") != plugin.get("path"):
            failures.append(
                "pstack-opencode.lock.json: path does not match the plugin layer path "
                f"({lock.get('path')} != {plugin.get('path')})"
            )
        if lock.get("repository") != plugin.get("source"):
            failures.append(
                "pstack-opencode.lock.json: repository does not match the plugin layer source "
                f"({lock.get('repository')} != {plugin.get('source')})"
            )


def check_claude_layers(layers: dict, failures: list[str]) -> list[dict]:
    """Validate each optional claude block; return the git pins they declare."""
    pins: list[dict] = []
    records = layers.get("layers") if isinstance(layers, dict) else None
    if not isinstance(records, list):
        return pins
    for index, layer in enumerate(records):
        if not isinstance(layer, dict) or "claude" not in layer:
            continue
        where = f"layers.json: layers[{index}].claude"
        block = layer["claude"]
        if not isinstance(block, dict):
            failures.append(f"{where} must be an object")
            continue
        if not is_nonempty_str(block.get("plugin")):
            failures.append(f"{where}.plugin must be a non-empty string")
        if "git" not in block:
            if "pluginTarget" not in layer:
                failures.append(
                    f"{where} names a local plugin, so the layer needs a pluginTarget"
                )
            continue
        git = block["git"]
        if not isinstance(git, dict):
            failures.append(f"{where}.git must be an object")
            continue
        if not isinstance(git.get("url"), str) or not GIT_URL.match(git["url"]):
            failures.append(f"{where}.git.url must be an https github.com git URL")
        path = git.get("path")
        if not is_nonempty_str(path) or path.startswith("/") or ".." in path.split("/"):
            failures.append(
                f"{where}.git.path must be a relative path inside the repository"
            )
        if not isinstance(git.get("commit"), str) or not HEX40.match(git["commit"]):
            failures.append(
                f"{where}.git.commit must be a 40-character lowercase commit SHA"
            )
        if "tag" in git and not is_nonempty_str(git["tag"]):
            failures.append(f"{where}.git.tag must be a non-empty string when present")
        pins.append({"plugin": block.get("plugin"), **git})
    return pins


def check_claude_lock(
    claude_lock: dict | None, pins: list[dict], failures: list[str]
) -> None:
    """The Claude pin must name the same commit as layers.json and the OpenCode port's upstream commit."""
    if not pins:
        if claude_lock is not None:
            failures.append(
                f"{CLAUDE_LOCK} exists but no layer declares a git Claude pin"
            )
        return
    if claude_lock is None:
        failures.append(
            f"{CLAUDE_LOCK} is required by the git Claude pin in layers.json"
        )
        return
    for pin in pins:
        if claude_lock.get("repository") != pin["url"]:
            failures.append(
                f"{CLAUDE_LOCK}: repository does not match layers.json ({claude_lock.get('repository')} != {pin['url']})"
            )
        if claude_lock.get("path") != pin["path"]:
            failures.append(
                f"{CLAUDE_LOCK}: path does not match layers.json ({claude_lock.get('path')} != {pin['path']})"
            )
        if claude_lock.get("commit") != pin["commit"]:
            failures.append(
                f"{CLAUDE_LOCK}: commit does not match layers.json ({claude_lock.get('commit')} != {pin['commit']})"
            )
        if "tag" in pin and claude_lock.get("tag") != pin["tag"]:
            failures.append(
                f"{CLAUDE_LOCK}: tag does not match layers.json ({claude_lock.get('tag')} != {pin['tag']})"
            )
    commit = claude_lock.get("commit")
    if not is_nonempty_str(commit) or not HEX40.match(commit or ""):
        failures.append(
            f"{CLAUDE_LOCK}: commit must be a 40-character lowercase hex SHA"
        )
    upstream = claude_lock.get("opencodeUpstream")
    if not is_nonempty_str(upstream) or not HEX40.match(upstream or ""):
        failures.append(
            f"{CLAUDE_LOCK}: opencodeUpstream must be a 40-character lowercase hex SHA"
        )
    elif commit != upstream:
        failures.append(
            f"{CLAUDE_LOCK}: the Claude commit ({commit}) and the OpenCode port's upstream pin "
            f"({upstream}) name different commits"
        )


def run_command(args: list[str], failures: list[str]) -> str | None:
    """Run a read-only command; record a failure and return None when it cannot answer."""
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=120, check=False
        )
    except FileNotFoundError:
        failures.append(f"online check needs {args[0]} on PATH")
        return None
    except subprocess.TimeoutExpired:
        failures.append(f"online check timed out: {' '.join(args[:2])}")
        return None
    if result.returncode != 0:
        failures.append(
            f"online check failed: {' '.join(args[:2])}: {result.stderr.strip() or 'no output'}"
        )
        return None
    return result.stdout


def check_online(
    claude_lock: dict, plugin_lock: dict | None, failures: list[str]
) -> None:
    """Ask GitHub: does the release tag still name the pinned commit, and does the plugin pin agree?"""
    repository = claude_lock.get("repository", "")
    tag = claude_lock.get("tag")
    if tag:
        output = run_command(
            [
                "git",
                "ls-remote",
                repository,
                f"refs/tags/{tag}",
                f"refs/tags/{tag}^{{}}",
            ],
            failures,
        )
        if output is not None:
            resolved: dict[str, str] = {}
            for line in output.splitlines():
                sha, _, name = line.partition("\t")
                resolved[name] = sha
            # An annotated tag names its commit on the peeled (^{}) line.
            tag_commit = resolved.get(f"refs/tags/{tag}^{{}}") or resolved.get(
                f"refs/tags/{tag}"
            )
            if tag_commit is None:
                failures.append(f"tag {tag} is not on {repository}")
            elif tag_commit != claude_lock.get("commit"):
                failures.append(
                    f"tag {tag} resolves to {tag_commit}, not the locked {claude_lock.get('commit')}"
                )

    if plugin_lock is None:
        return
    slug = (
        plugin_lock.get("repository", "")
        .removeprefix("https://github.com/")
        .removesuffix(".git")
    )
    pin = plugin_lock.get("commit", "")
    output = run_command(
        [
            "gh",
            "api",
            f"repos/{slug}/contents/pstack.lock.json?ref={pin}",
            "--jq",
            ".content",
        ],
        failures,
    )
    if output is None:
        return
    try:
        plugin_pin = json.loads(
            base64.b64decode("".join(output.split())).decode("utf-8")
        )
    except (ValueError, UnicodeDecodeError) as error:
        failures.append(f"{slug}@{pin}: pstack.lock.json is not readable: {error}")
        return
    upstream = plugin_pin.get("commit")
    if upstream != claude_lock.get("opencodeUpstream"):
        failures.append(
            f"{slug}@{pin} pins upstream {upstream} in pstack.lock.json, "
            f"not the {claude_lock.get('opencodeUpstream')} in {CLAUDE_LOCK}"
        )


def check_workspace_config(config: dict, failures: list[str]) -> None:
    for key in MODEL_KEYS:
        if key in config:
            failures.append(
                f"workspace/opencode.jsonc must not set {key}: maxstack sets no model, "
                "the user picks it in the harness"
            )
    if not is_nonempty_str(config.get("default_agent")):
        failures.append(
            "workspace/opencode.jsonc: default_agent must be a non-empty string"
        )
    if not isinstance(config.get("permissions"), list):
        failures.append("workspace/opencode.jsonc: permissions must be a list")
    if "mcpServers" in config:
        failures.append(
            "workspace/opencode.jsonc: use the V2 mcp.servers shape, not top-level mcpServers"
        )
    mcp = config.get("mcp")
    if not isinstance(mcp, dict):
        failures.append("workspace/opencode.jsonc: mcp must be an object")
        return
    if "enabled" in mcp:
        failures.append(
            "workspace/opencode.jsonc: mcp must not use the V1 enabled field; use disabled: true per server"
        )


def check_surface(failures: list[str]) -> None:
    if not (REPO_ROOT / "scripts" / "Install-Workspace.ps1").is_file():
        failures.append("scripts/Install-Workspace.ps1 is missing")
    if not (REPO_ROOT / "docs" / "plugin-publishing.md").is_file():
        failures.append("docs/plugin-publishing.md is missing")
    surface = (REPO_ROOT / "README.md", REPO_ROOT / "docs" / "layout.md")
    for name in ("pstack-opencode.lock.json", CLAUDE_LOCK):
        if not any(
            path.is_file() and name in path.read_text(encoding="utf-8")
            for path in surface
        ):
            failures.append(f"README.md or docs/layout.md must reference {name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--online",
        action="store_true",
        help="also check the Claude tag with git ls-remote and the plugin pin with gh api",
    )
    args = parser.parse_args()

    failures: list[str] = []
    layers = load_json(REPO_ROOT / "layers.json", failures)
    lock = load_json(REPO_ROOT / "pstack-opencode.lock.json", failures)
    claude_lock = (
        load_json(REPO_ROOT / CLAUDE_LOCK, failures)
        if (REPO_ROOT / CLAUDE_LOCK).exists()
        else None
    )
    config = load_jsonc(REPO_ROOT / "workspace" / "opencode.jsonc", failures)

    plugin = check_layers(layers, failures) if layers else None
    if lock:
        check_lock(lock, plugin, failures)
    pins = check_claude_layers(layers, failures) if layers else []
    check_claude_lock(claude_lock, pins, failures)
    if config:
        check_workspace_config(config, failures)
    check_surface(failures)
    if args.online and claude_lock and pins:
        check_online(claude_lock, lock, failures)

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    mode = " (online)" if args.online else ""
    print(
        f"PASS: workspace manifests agree with the installer and the plugin pins{mode}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
