"""The settings document reader: the rules of scripts/Install-Settings.ps1 (Read-MaxstackSettings), in Python.

A file the installer accepts is accepted here and the reverse. scripts/verify_settings.py runs the schema and seed checks
and the `--document` command that the differential test uses.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

MAX_BYTES = 65536
MAX_DEPTH = 32
SOURCE_MAX_UNITS = 2048
TOP_KEYS = ("$schema", "version", "os", "runtimes", "layers", "t3")
RUNTIME_IDS = ("claude", "copilot", "opencode", "pi")
CLI_MODES = ("detect", "install")
OS_MODES = ("auto", "windows", "macos", "linux")
T3_DEFAULTS = ("leave-alone", "apply-defaults")
BOM = b"\xef\xbb\xbf"

SOURCE_FORBIDDEN = re.compile(
    r"[\x00-\x1f\x7f-\x9f\xa0\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]"
)
SOURCE_SHAPE = re.compile(
    r"^(?:[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+|https://[^/@\s]+/[^@\s]+)@[^@\s]+$",
    re.IGNORECASE,
)
OWNER_REPO = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+")
HTTPS_LOCATION = re.compile(r"https://[^/\\?#@]+/[^\\?#@]+")


class SettingsRefusal(Exception):
    """A document the installer's reader refuses. The message gives the reason and no path."""


def _refuse_constant(name: str) -> object:
    raise SettingsRefusal(
        "is not strict JSON. Comments and trailing commas are not allowed."
    )


def _object_without_duplicates(pairs: list) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            raise SettingsRefusal(f"duplicate key '{key}'")
        result[key] = value
    return result


def _exceeds_depth(value: object, limit: int) -> bool:
    pending = [(value, 1)]
    while pending:
        node, depth = pending.pop()
        if isinstance(node, (dict, list)):
            if depth > limit:
                return True
            children = node.values() if isinstance(node, dict) else node
            pending.extend((child, depth + 1) for child in children)
    return False


def strict_json(data: bytes) -> object:
    """Parses bytes as the installer's reader does: one BOM is skipped, and only UTF-8, strict JSON, and nesting up to MAX_DEPTH pass."""
    data = data.removeprefix(BOM)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise SettingsRefusal("is not valid UTF-8") from None
    try:
        value = json.loads(
            text,
            object_pairs_hook=_object_without_duplicates,
            parse_constant=_refuse_constant,
        )
    except RecursionError:
        raise SettingsRefusal(f"is nested deeper than {MAX_DEPTH}") from None
    except ValueError:
        raise SettingsRefusal(
            "is not strict JSON. Comments and trailing commas are not allowed."
        ) from None
    if _exceeds_depth(value, MAX_DEPTH):
        raise SettingsRefusal(f"is nested deeper than {MAX_DEPTH}")
    return value


def _keys_only(value: object, allowed: tuple, where: str) -> None:
    if not isinstance(value, dict):
        raise SettingsRefusal(f"{where} must be an object.")
    for key in value:
        if key not in allowed:
            raise SettingsRefusal(
                f"unknown key '{key}' in {where}. Valid keys: {', '.join(allowed)}."
            )


def _enum_value(value: object, allowed: tuple) -> bool:
    return isinstance(value, str) and value in allowed


def _safe_ref(ref: str) -> bool:
    if not ref or ref.startswith("-") or re.search(r"[\x00-\x20\x7f~^:?*\[\\]", ref):
        return False
    if (
        ".." in ref
        or "@{" in ref
        or "//" in ref
        or ref.startswith("/")
        or ref.endswith(("/", "."))
    ):
        return False
    return not any(
        part.startswith(".") or part.endswith(".lock") for part in ref.split("/")
    )


def _spec_ok(value: str) -> bool:
    if re.search(r"[\s\x00-\x1f\x7f]", value) or value.startswith("-") or ".." in value:
        return False
    at = value.rfind("@")
    location, ref = value[:at], value[at + 1 :]
    valid_location = OWNER_REPO.fullmatch(location) or HTTPS_LOCATION.fullmatch(
        location
    )
    return bool(valid_location) and _safe_ref(ref)


def _check_source(name: str, value: object) -> None:
    too_long = (
        isinstance(value, str)
        and len(value.encode("utf-16-le", "surrogatepass")) // 2 > SOURCE_MAX_UNITS
    )
    if (
        not isinstance(value, str)
        or not value.strip()
        or too_long
        or SOURCE_FORBIDDEN.search(value)
    ):
        raise SettingsRefusal(
            f"layers.{name}.source must be a non-empty source string of at most {SOURCE_MAX_UNITS} characters."
        )
    if value == "default":
        return
    if value.startswith("local:"):
        local = value[len("local:") :]
        if not local.strip() or re.search(r"(^|[\\/])\.\.([\\/]|$)", local):
            raise SettingsRefusal(f"layers.{name}.source has an unsafe local path.")
        return
    if not SOURCE_SHAPE.search(value) or not _spec_ok(value):
        raise SettingsRefusal(f"layers.{name}.source is not a supported source.")


def _check_runtimes(runtimes: object) -> None:
    _keys_only(runtimes, RUNTIME_IDS, "runtimes")
    if not runtimes:
        raise SettingsRefusal("runtimes names no runtime.")
    for name, entry in runtimes.items():
        _keys_only(entry, ("cli",), f"runtimes.{name}")
        if "cli" in entry and not _enum_value(entry["cli"], CLI_MODES):
            raise SettingsRefusal(f"runtimes.{name}.cli must be detect or install.")


def _check_layers(layers: object, names: tuple) -> None:
    _keys_only(layers, names, "layers")
    if not layers:
        raise SettingsRefusal("layers names no layer.")
    for name, entry in layers.items():
        _keys_only(entry, ("source",), f"layers.{name}")
        if "source" in entry:
            _check_source(name, entry["source"])


def _check_t3(t3: object) -> None:
    _keys_only(t3, ("cli", "snapshot", "defaults"), "t3")
    if "cli" in t3 and not _enum_value(t3["cli"], CLI_MODES):
        raise SettingsRefusal("t3.cli must be detect or install.")
    if "snapshot" in t3 and type(t3["snapshot"]) is not bool:
        raise SettingsRefusal("t3.snapshot must be true or false.")
    if "defaults" in t3 and not _enum_value(t3["defaults"], T3_DEFAULTS):
        raise SettingsRefusal("t3.defaults must be leave-alone or apply-defaults.")


def validate_settings(value: object, names: tuple) -> None:
    """Applies the field rules of Read-MaxstackSettings to a parsed object. Raises SettingsRefusal on the first failure."""
    _keys_only(value, TOP_KEYS, "the top level")
    if "$schema" in value and not isinstance(value["$schema"], str):
        raise SettingsRefusal("$schema must be a string.")
    if (
        "version" not in value
        or type(value["version"]) is not int
        or value["version"] != 1
    ):
        raise SettingsRefusal('needs "version": 1.')
    if "os" in value and not _enum_value(value["os"], OS_MODES):
        raise SettingsRefusal("os has an unsupported value.")
    if "runtimes" in value:
        _check_runtimes(value["runtimes"])
    if "layers" in value:
        _check_layers(value["layers"], names)
    if "t3" in value:
        _check_t3(value["t3"])


def read_settings_document(data: bytes, names: tuple) -> None:
    """Refuses what the installer's reader refuses, and returns when it would accept the file."""
    if len(data) > MAX_BYTES:
        raise SettingsRefusal(f"is larger than the {MAX_BYTES} byte limit.")
    value = strict_json(data)
    if not isinstance(value, dict):
        raise SettingsRefusal("must hold one JSON object.")
    validate_settings(value, names)


def layer_names(root: Path) -> tuple:
    try:
        manifest = json.loads((root / "layers.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ()
    layers = manifest.get("layers") if isinstance(manifest, dict) else None
    if not isinstance(layers, list):
        return ()
    return tuple(
        layer["name"]
        for layer in layers
        if isinstance(layer, dict) and isinstance(layer.get("name"), str)
    )
