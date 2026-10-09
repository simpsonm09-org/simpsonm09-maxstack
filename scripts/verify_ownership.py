"""The ownership record in stack.lock.json, and the shape check both verifiers share.

Install-Workspace.ps1 writes the record. verify-manifests.py --lock and
verify-workspace-install.py refuse a record that is malformed with these checks. The module
reads files and never writes.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

OWNED_SCHEMA = 2
OWNED_KINDS = ("file", "dir", "link", "json-entries")
OWNED_PI_KEYS = ("packages", "skills")
SHA256_UPPER = re.compile(r"^[0-9A-F]{64}$")
# A backup of a replaced file: X.bak, the original, or X.bak.N, a numbered copy. Only these may name a role.
BACKUP_PATH = re.compile(r"\.bak(\.\d+)?$")
BACKUP_ROLES = ("original", "edited")


def is_nonempty_str(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def is_owned_path(value: object) -> bool:
    """A workspace-relative path with forward slashes, which never names the lock itself."""
    text = str(value) if isinstance(value, str) else ""
    return (
        is_nonempty_str(value)
        and "\\" not in text
        and ":" not in text
        and not text.startswith("/")
        and ".." not in text.split("/")
        and text != "stack.lock.json"
    )


def check_owned_record(record: object, where: str, failures: list[str]) -> str | None:
    """Check one owned record's fields; return its sort key when the record is well formed."""
    if not isinstance(record, dict):
        failures.append(f"{where} must be an object")
        return None
    kind = record.get("kind")
    if kind not in OWNED_KINDS:
        failures.append(f"{where} kind must be one of {list(OWNED_KINDS)}")
        return None
    if not is_owned_path(record.get("path")):
        failures.append(
            f"{where} path must be a workspace-relative path with forward slashes, and not stack.lock.json"
        )
        return None
    if kind in ("file", "dir"):
        expected = {"path", "kind", "sha256"}
        if not isinstance(record.get("sha256"), str) or not SHA256_UPPER.match(
            record["sha256"]
        ):
            failures.append(f"{where} sha256 must be 64 upper-case hex digits")
    elif kind == "link":
        expected = {"path", "kind", "target"}
        if not is_owned_path(record.get("target")):
            failures.append(f"{where} target must be a workspace-relative path")
    else:
        expected = {"path", "kind", "key", "entries"}
        if record.get("key") not in OWNED_PI_KEYS:
            failures.append(f"{where} key must be one of {list(OWNED_PI_KEYS)}")
        entries = record.get("entries")
        if not isinstance(entries, list) or not entries:
            failures.append(f"{where} entries must be a non-empty list")
        if "createdKey" in record:
            expected = expected | {"createdKey"}
            if record["createdKey"] is not True:
                failures.append(f"{where} createdKey, when present, must be true")
    expected = expected | {"runtime", "layers"}
    if BACKUP_PATH.search(str(record.get("path", ""))) and "role" in record:
        expected = expected | {"role"}
        if record["role"] not in BACKUP_ROLES:
            failures.append(f"{where} role must be one of {list(BACKUP_ROLES)}")
    check_attribution(record, where, failures)
    if set(record) != expected:
        failures.append(
            f"{where} must hold exactly {sorted(expected)}, found {sorted(record)}"
        )
    return f"{record['path']}\t{kind}\t{record.get('key') or ''}"


def check_attribution(record: dict, where: str, failures: list[str]) -> None:
    """The runtime a record belongs to, null for the claude cache, and the layers it was installed for.
    The runtime must be the one the record's path names, so a record cannot claim another runtime's file."""
    runtime = record.get("runtime")
    if runtime is not None and runtime not in SELECTION_RUNTIMES:
        failures.append(
            f"{where} runtime must be null or one of {list(SELECTION_RUNTIMES)}"
        )
    elif runtime != owned_runtime(record["path"]):
        failures.append(
            f"{where} runtime is {runtime}, but its path belongs to {owned_runtime(record['path'])}"
        )
    layers = record.get("layers")
    if not isinstance(layers, list) or not all(
        is_nonempty_str(layer) for layer in layers
    ):
        failures.append(f"{where} layers must be a list of layer names")
    elif len(set(layers)) != len(layers) or layers != sorted(layers, key=utf8_order):
        failures.append(f"{where} layers must be sorted by UTF-8 bytes, once each")


def check_created(lock: dict, field: str, failures: list[str]) -> None:
    """createdDirs and createdFiles, when present, list workspace paths once each, in UTF-8 order."""
    if field not in lock:
        return
    paths = lock[field]
    if not isinstance(paths, list) or not all(is_owned_path(path) for path in paths):
        failures.append(
            f"stack.lock.json {field} must be a list of workspace-relative paths"
        )
        return
    if len(set(paths)) != len(paths):
        failures.append(f"stack.lock.json {field} names a path twice")
    elif paths != sorted(paths, key=utf8_order):
        failures.append(f"stack.lock.json {field} is not sorted by UTF-8 bytes")


def utf8_order(text: str) -> bytes:
    """The order every list is sorted in: UTF-8 bytes, which is code point order."""
    return text.encode("utf-8")


SELECTION_RUNTIMES = ("claude", "opencode", "copilot", "pi")
# Each runtime whose wrapper or settings name the Claude plugin folders, which only claude writes.
NEEDS_CLAUDE = ("copilot", "pi")


def owned_runtime(path: str) -> str | None:
    """The runtime an owned path belongs to. The claude cache is read by every runtime, so it has none."""
    if path.startswith(("opencode.jsonc", ".opencode/")):
        return "opencode"
    if path.startswith(".claude/plugins/"):
        return "claude"
    if path in (".maxstack/bin/copilot.cmd", ".maxstack/bin/copilot.sh"):
        return "copilot"
    if path.startswith((".maxstack/bin/pi.", ".pi/")):
        return "pi"
    return None


def layer_names(lock: dict) -> list[str]:
    return [layer.get("name") for layer in lock.get("layers", [])]


def selected(lock: dict) -> tuple[set[str], set[str]]:
    """The runtimes and layers the lock selects. A lock with no selection reads as all of them, and so
    does a malformed one, because check_selection reports the malformation."""
    selection = lock.get("selection")
    if "selection" not in lock or not _well_formed_selection(selection):
        return set(SELECTION_RUNTIMES), set(layer_names(lock))
    return set(selection["runtimes"]), set(selection["layers"])


def _well_formed_selection(selection: object) -> bool:
    return (
        isinstance(selection, dict)
        and sorted(selection) == ["layers", "runtimes"]
        and isinstance(selection["runtimes"], list)
        and isinstance(selection["layers"], list)
        and all(
            isinstance(name, str)
            for name in selection["runtimes"] + selection["layers"]
        )
    )


def check_name_list(where: str, values: list, valid, failures: list[str]) -> None:
    """A selection list is non-empty, names only valid values once each, and is sorted by UTF-8 bytes."""
    if not values:
        failures.append(f"stack.lock.json selection {where} names no value")
        return
    unknown = [value for value in values if value not in valid]
    if unknown:
        failures.append(
            f"stack.lock.json selection {where} names unknown {unknown}; valid names are {list(valid)}"
        )
    if len(set(values)) != len(values):
        failures.append(f"stack.lock.json selection {where} names one value twice")
    elif values != sorted(values, key=utf8_order):
        failures.append(
            f"stack.lock.json selection {where} is not sorted by UTF-8 bytes"
        )


def check_selection(lock: dict, failures: list[str]) -> None:
    """The recorded selection: well formed, naming known values, with pi and copilot only beside claude.
    Every enabled runtime record and every owned path must belong to a selected runtime and layer."""
    if "selection" not in lock:
        return
    if not _well_formed_selection(lock["selection"]):
        failures.append(
            "stack.lock.json selection must hold exactly a runtimes list and a layers list"
        )
        return
    runtimes, layers = selected(lock)
    check_name_list(
        "runtimes", lock["selection"]["runtimes"], SELECTION_RUNTIMES, failures
    )
    check_name_list("layers", lock["selection"]["layers"], layer_names(lock), failures)
    for dependent in NEEDS_CLAUDE:
        if dependent in runtimes and "claude" not in runtimes:
            failures.append(
                f"stack.lock.json selects {dependent} without claude, which its wrapper or settings need"
            )
    for layer in lock.get("layers", []):
        for runtime in SELECTION_RUNTIMES:
            enabled = (layer.get(runtime) or {}).get("enabled") is True
            if enabled and (runtime not in runtimes or layer.get("name") not in layers):
                failures.append(
                    f"stack.lock.json records {runtime} enabled for layer '{layer.get('name')}', which the selection does not select"
                )
    for runtime in ("copilot", "pi"):
        block = lock.get(runtime)
        if (
            isinstance(block, dict)
            and block.get("enabled") is True
            and runtime not in runtimes
        ):
            failures.append(
                f"stack.lock.json records {runtime} enabled, which the selection does not select"
            )
    for index, record in enumerate(lock.get("owned", []) or []):
        path = record.get("path") if isinstance(record, dict) else None
        runtime = owned_runtime(path) if isinstance(path, str) else None
        if runtime is not None and runtime not in runtimes:
            failures.append(
                f"stack.lock.json owned[{index}] is {path}, which belongs to {runtime}, and {runtime} is not selected"
            )


def check_owned(lock: dict, failures: list[str]) -> None:
    """The ownership record in stack.lock.json: a schema version, and one sorted list of records."""
    check_selection(lock, failures)
    if lock.get("ownedSchema") != OWNED_SCHEMA or isinstance(
        lock.get("ownedSchema"), bool
    ):
        failures.append(
            f"stack.lock.json: ownedSchema must be {OWNED_SCHEMA}; run Install-Workspace.ps1 -Apply once to write it"
        )
    owned = lock.get("owned")
    if not isinstance(owned, list):
        failures.append(
            "stack.lock.json has no owned list; rerun Install-Workspace.ps1 -Apply"
        )
        return
    keys: list[str] = []
    for index, record in enumerate(owned):
        key = check_owned_record(record, f"stack.lock.json owned[{index}]", failures)
        if key is not None:
            keys.append(key)
    if len(set(keys)) != len(keys):
        failures.append("stack.lock.json owned names one path, kind, and key twice")
    elif keys != sorted(keys, key=utf8_order):
        failures.append("stack.lock.json owned is not sorted by path, kind, and key")
    check_created(lock, "createdDirs", failures)
    check_created(lock, "createdFiles", failures)


def check_lock_file(path: Path, failures: list[str]) -> None:
    try:
        lock = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        failures.append(f"cannot read {path}: {error}")
        return
    if not isinstance(lock, dict):
        failures.append(f"{path} is not a JSON object")
        return
    check_owned(lock, failures)
