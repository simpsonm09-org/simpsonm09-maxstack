#!/usr/bin/env python3
"""Check that the workspace manifests the installer consumes agree.

`scripts/Install-Workspace.ps1` reads `layers.json`,
`pstack-opencode.lock.json`, `models.json`, and `workspace/opencode.jsonc`.
A drift between them installs a broken bundle, so this fails CI first. It
reads only the manifests and never clones the private plugin repository.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
HEX40 = re.compile(r"^[0-9a-f]{40}$")
GIT_URL = re.compile(r"^https://github\.com/[^/]+/[^/]+\.git$")
AGENT_ROLES = ("primary", "worker", "reviewer", "comment-sicko")
LAYER_KINDS = ("plugin", "config")


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
            failures.append(f"{where} source must be an https github.com git URL: {layer['source']}")
        if "pluginTarget" in layer and not is_nonempty_str(layer.get("pluginTarget")):
            failures.append(f"{where} pluginTarget must be a non-empty string")
        if layer.get("kind") == "plugin":
            plugins.append(layer)
    if len(plugins) != 1:
        failures.append(f"layers.json: expected exactly one plugin layer, found {len(plugins)}")
        return None
    return plugins[0]


def check_lock(lock: dict, plugin: dict | None, failures: list[str]) -> None:
    repository = lock.get("repository")
    if not is_nonempty_str(repository) or not GIT_URL.match(repository or ""):
        failures.append("pstack-opencode.lock.json: repository must be an https github.com git URL")
    commit = lock.get("commit")
    if not is_nonempty_str(commit) or not HEX40.match(commit or ""):
        failures.append("pstack-opencode.lock.json: commit must be a 40-character lowercase hex SHA")
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


def check_models(models: dict, failures: list[str]) -> str | None:
    default = models.get("default")
    if not is_nonempty_str(default):
        failures.append("models.json: default must be a non-empty string")
    roles = models.get("roles")
    if not isinstance(roles, dict):
        failures.append("models.json: roles must be an object")
        return default if is_nonempty_str(default) else None
    for role in AGENT_ROLES:
        if not is_nonempty_str(roles.get(role)):
            failures.append(f"models.json: roles.{role} must be a non-empty string")
    if is_nonempty_str(roles.get("primary")):
        return roles["primary"]
    return default if is_nonempty_str(default) else None


def check_workspace_config(config: dict, expected_model: str | None, failures: list[str]) -> None:
    if not is_nonempty_str(config.get("model")):
        failures.append("workspace/opencode.jsonc: model must be a non-empty string")
    elif expected_model and config["model"] != expected_model:
        failures.append(
            "workspace/opencode.jsonc: model does not match the models.json primary "
            f"({config['model']} != {expected_model})"
        )
    if not is_nonempty_str(config.get("default_agent")):
        failures.append("workspace/opencode.jsonc: default_agent must be a non-empty string")
    if not isinstance(config.get("permissions"), list):
        failures.append("workspace/opencode.jsonc: permissions must be a list")
    if "mcpServers" in config:
        failures.append("workspace/opencode.jsonc: use the V2 mcp.servers shape, not top-level mcpServers")
    mcp = config.get("mcp")
    if not isinstance(mcp, dict):
        failures.append("workspace/opencode.jsonc: mcp must be an object")
        return
    if "enabled" in mcp:
        failures.append("workspace/opencode.jsonc: mcp must not use the V1 enabled field; use disabled: true per server")


def check_surface(failures: list[str]) -> None:
    if not (REPO_ROOT / "scripts" / "Install-Workspace.ps1").is_file():
        failures.append("scripts/Install-Workspace.ps1 is missing")
    if not (REPO_ROOT / "docs" / "plugin-publishing.md").is_file():
        failures.append("docs/plugin-publishing.md is missing")
    surface = (REPO_ROOT / "README.md", REPO_ROOT / "docs" / "layout.md")
    if not any(
        path.is_file() and "pstack-opencode.lock.json" in path.read_text(encoding="utf-8")
        for path in surface
    ):
        failures.append("README.md or docs/layout.md must reference pstack-opencode.lock.json")


def main() -> int:
    failures: list[str] = []
    layers = load_json(REPO_ROOT / "layers.json", failures)
    lock = load_json(REPO_ROOT / "pstack-opencode.lock.json", failures)
    models = load_json(REPO_ROOT / "models.json", failures)
    config = load_jsonc(REPO_ROOT / "workspace" / "opencode.jsonc", failures)

    plugin = check_layers(layers, failures) if layers else None
    if lock:
        check_lock(lock, plugin, failures)
    primary = check_models(models, failures) if models else None
    if config:
        check_workspace_config(config, primary, failures)
    check_surface(failures)

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("PASS: workspace manifests agree with the installer and the plugin pin.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
