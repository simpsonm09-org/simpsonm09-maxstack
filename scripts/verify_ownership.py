"""The ownership record in stack.lock.json, and the shape check both verifiers share.

Install-Workspace.ps1 writes the record. verify-manifests.py --lock and
verify-workspace-install.py refuse a record that is malformed with these checks. The module
reads files and never writes.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

OWNED_SCHEMA = 1
OWNED_KINDS = ("file", "dir", "link", "json-entries")
OWNED_PI_KEYS = ("packages", "skills")
SHA256_UPPER = re.compile(r"^[0-9A-F]{64}$")


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
    if set(record) != expected:
        failures.append(
            f"{where} must hold exactly {sorted(expected)}, found {sorted(record)}"
        )
    return f"{record['path']}\t{kind}\t{record.get('key') or ''}"


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


def check_owned(lock: dict, failures: list[str]) -> None:
    """The ownership record in stack.lock.json: a schema version, and one sorted list of records."""
    if lock.get("ownedSchema") != OWNED_SCHEMA or isinstance(
        lock.get("ownedSchema"), bool
    ):
        failures.append(f"stack.lock.json: ownedSchema must be {OWNED_SCHEMA}")
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
