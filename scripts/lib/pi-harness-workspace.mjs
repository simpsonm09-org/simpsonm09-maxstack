// Reads the Pi wiring of a workspace without writing to it: the workspace discovery order of the
// installer, the Pi layer list, the Pi settings, one installed skill per Pi layer, and the Pi binary
// that the installed wrapper runs. Nothing here writes, and nothing here reads an auth file.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class SetupError extends Error {}

// Names the auth file the snapshot must never stat or read, even by metadata.
const SKIPPED_NAMES = new Set(["auth.json"]);

function readJson(path, label) {
  if (!existsSync(path)) throw new SetupError(`${label} is missing at ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SetupError(`${label} is not valid JSON at ${path}: ${error.message}`);
  }
}

function hasWorkspaceMarker(dir) {
  return existsSync(join(dir, "maxstack.settings.json")) || existsSync(join(dir, "stack.lock.json"));
}

// The nearest directory at or above start that holds a workspace marker, as the installer walks.
function findMarkerUp(start) {
  let dir = resolve(start);
  for (;;) {
    if (hasWorkspaceMarker(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A repository checked out under <workspace>/projects/repos or /projects/worktrees.
function scriptLayoutWorkspace(repoRoot) {
  if (basename(dirname(dirname(repoRoot))) !== "projects") return null;
  const candidate = dirname(dirname(dirname(repoRoot)));
  return existsSync(candidate) ? candidate : null;
}

// The workspace, in the installer's order: an explicit path, MAXSTACK_WORKSPACE, the nearest marker
// from the working directory, then the layout of this repository. An explicit value never falls through.
export function resolveWorkspace({ explicit, env, cwd, repoRoot }) {
  if (explicit) return { path: resolve(cwd, explicit), origin: "--workspace" };
  if (env.MAXSTACK_WORKSPACE) {
    return { path: resolve(cwd, env.MAXSTACK_WORKSPACE), origin: "MAXSTACK_WORKSPACE" };
  }
  const marker = findMarkerUp(cwd);
  if (marker) return { path: marker, origin: "working directory marker" };
  const layout = scriptLayoutWorkspace(repoRoot);
  if (layout) return { path: layout, origin: "repository layout" };
  throw new SetupError("no workspace found: pass --workspace or set MAXSTACK_WORKSPACE");
}

// The layers that declare a Pi runtime in layers.json, in order. Their names key the checks.
export function readPiLayerNames(repoRoot) {
  const manifest = readJson(join(repoRoot, "layers.json"), "layers.json");
  const names = (manifest.layers ?? [])
    .filter((layer) => layer.runtimes && Object.hasOwn(layer.runtimes, "pi"))
    .map((layer) => layer.name);
  if (names.length === 0) throw new SetupError("layers.json declares no layer for the pi runtime");
  return names;
}

// The Pi settings the installer wrote, with each package and skills entry made absolute against the
// agent folder, the way Pi resolves them.
export function readPiSettings(workspace) {
  const agentDir = join(workspace, ".pi", "agent");
  const settings = readJson(join(agentDir, "settings.json"), "Pi settings");
  const absolute = (entries) =>
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => typeof entry === "string")
      .map((entry) => resolve(agentDir, entry));
  return { agentDir, packages: absolute(settings.packages), skills: absolute(settings.skills) };
}

// The name in a SKILL.md frontmatter, or the folder name when the frontmatter names none.
function skillNameOf(skillFile, folderName) {
  const text = readFileSync(skillFile, "utf8");
  const frontmatter = text.startsWith("---") ? text.split(/^---\s*$/m)[1] ?? "" : "";
  const match = frontmatter.match(/^name:\s*(.+?)\s*$/m);
  return match ? match[1].replace(/^["']|["']$/g, "") : folderName;
}

const normalize = (path) => path.replaceAll("\\", "/");

// For each layer, one installed skill: the first folder, by name, that holds a SKILL.md under the
// layer's skills folder in the Pi settings. A layer with no such folder yields an error entry.
export function pickLayerSkills(layerNames, skillDirs) {
  return layerNames.map((layer) => {
    const suffix = `/plugins/${layer}/skills`;
    const folder = skillDirs.find((dir) => normalize(dir).endsWith(suffix));
    if (!folder) return { layer, error: `no skills folder for ${layer} in the Pi settings` };
    const candidates = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
    if (candidates.length === 0) return { layer, error: `no SKILL.md under ${folder}` };
    const folderName = candidates[0];
    const skillFile = join(folder, folderName, "SKILL.md");
    const layerPath = `plugins/${layer}/skills/${folderName}/SKILL.md`;
    return { layer, name: skillNameOf(skillFile, folderName), layerPath, location: normalize(skillFile) };
  });
}

// The Pi binary the installed wrapper runs, as the wrapper writes it. MAXSTACK_PI_BIN wins over the
// default, as it does in the wrapper. Windows reads pi.cmd and the POSIX wrapper reads pi.sh.
export function readWrapperPiBin({ workspace, env, platform }) {
  const name = platform === "win32" ? "pi.cmd" : "pi.sh";
  const wrapper = join(workspace, ".maxstack", "bin", name);
  if (!existsSync(wrapper)) {
    throw new SetupError(`the Pi wrapper ${wrapper} is missing; run scripts/Install-Workspace.ps1 -Apply`);
  }
  const text = readFileSync(wrapper, "utf8");
  const match = platform === "win32"
    ? text.match(/^set "PI_BIN=(.*)"\s*$/m)
    : text.match(/pi_bin="\$\{MAXSTACK_PI_BIN:-(.*?)\}"/m);
  if (!match) throw new SetupError(`the Pi wrapper ${wrapper} names no Pi binary`);
  if (env.MAXSTACK_PI_BIN) return env.MAXSTACK_PI_BIN;
  return match[1];
}

// Each entry's size and mtime under a folder, for proving the check wrote nothing. Links and the auth
// file are skipped, so no link target and no credential is read.
export function snapshotTree(root) {
  const entries = new Map();
  if (!existsSync(root)) return entries;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (lstatSync(full).isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(full);
      } else {
        const stat = statSync(full);
        entries.set(normalize(full), `${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  visit(root);
  return entries;
}

// The folders the check must leave alone: the Pi agent folder and the wrapper folder.
export function watchedFolders(workspace) {
  return [join(workspace, ".pi", "agent"), join(workspace, ".maxstack", "bin")];
}
