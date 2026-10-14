// Installer tests for the layer sources (-Source, -Update, local checkouts, pinned git) and for the guarded git
// that reads them: filters, git config, refs, and the child environment. Helpers come from ./lib/installer-test-kit.mjs.

import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, existsSync, mkdirSync, readFileSync, rmSync, renameSync, cpSync, mkdtempSync, appendFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, parse as parsePath } from 'node:path';
import { test } from 'node:test';
import { NPM, ORG_FOLDER, ORG_SOURCE, RLO, SHORTHAND_URL, SKILL_FEAT_TWO, SKILL_PATH, USER_CONFIG, USER_SETTINGS, ZWJ, ZWSP, assertOk, escapedChar, gitRun, githubEnv, independentSha, installedSkill, installer, layerNamed, layerSourcesFile, lockPath, moveFeat, mustApply, ownedRecord, plainOutput, problemRows, python, readJson, remoteUrl, removal, repoRoot, resolveShorthand, runInstaller, runStatus, runWorkspaceDiscovery, seedUserFiles, serveRepo, servedFeature, setLock, settingsPath, shell, skip, snapshotTree, sourceBlockIn, sourceBlockOf, sourceOf, testEnvironment, withWorkspace, withWorkspaceNeeding, writeFile, writeLayerStub, writeLayers, writeWorkspaceSettings } from './lib/installer-test-kit.mjs';

withWorkspace('the pure git ref syntax check covers forbidden characters and path components', (ctx) => {
  const cases = [
    { ref: '', safe: false },
    { ref: '-leading', safe: false },
    { ref: 'has space', safe: false },
    { ref: 'release.LOCK', safe: true },
    { ref: 'release.Lock/topic', safe: true },
    { ref: 'has~tilde', safe: false },
    { ref: 'has^caret', safe: false },
    { ref: 'has:colon', safe: false },
    { ref: 'has?mark', safe: false },
    { ref: 'has*star', safe: false },
    { ref: 'has[bracket', safe: false },
    { ref: 'has\\backslash', safe: false },
    { ref: 'double..dot', safe: false },
    { ref: 'has@{open', safe: false },
    { ref: 'double//slash', safe: false },
    { ref: '/leading', safe: false },
    { ref: 'trailing/', safe: false },
    { ref: 'trailing.', safe: false },
    { ref: '.hidden', safe: false },
    { ref: 'folder/.hidden', safe: false },
    { ref: 'folder/name.lock', safe: false },
    { ref: 'valid-ref', safe: true },
    { ref: 'feature/neutral-layer', safe: true },
    { ref: '18791b4b8c983443033ceeacd5a21edd29145a29', safe: true },
  ];
  const encoded = Buffer.from(JSON.stringify(cases)).toString('base64');
  const layerSources = join(repoRoot, 'scripts', 'Install-LayerSources.ps1').replaceAll("'", "''");
  const script = join(ctx.base, 'ref-syntax.ps1');
  writeFileSync(script, `$ErrorActionPreference = 'Stop'\n. '${layerSources}'\n$cases = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json\nforeach ($case in $cases) { if ((Test-SafeRefNameSyntax $case.ref) -ne $case.safe) { throw "unexpected ref result for '$($case.ref)'" } }\n`);
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
}, {});

test('local source grammar accepts POSIX absolute paths under the injected macOS rules', { skip: !shell }, () => {
  const ordinal = join(repoRoot, 'scripts', 'Install-Ordinal.ps1').replaceAll("'", "''");
  const sources = join(repoRoot, 'scripts', 'Install-LayerSources.ps1').replaceAll("'", "''");
  const script = `. '${ordinal}'; . '${sources}'; $result = Read-LocalGrammar -Path '/Users/name/dev/plugin' -Platform 'macOS'; if (-not $result.absolute -or $result.path -cne '/Users/name/dev/plugin') { throw 'POSIX source path was not preserved as absolute' }; $fault = Get-LocalPathTextFault -Path 'C:\\Repo\\Plugin' -Platform 'Windows'; if ($fault) { throw $fault }; $fault = Get-LocalPathTextFault -Path '\\\\server\\share\\plugin' -Platform 'Windows'; if (-not $fault -or -not $fault.Contains('UNC')) { throw 'Windows UNC source rule was not retained' }`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

withWorkspace('a layer source with a DEL, a C1 control, a bidi control, or NBSP is refused, and other text is not', (ctx) => {
  const refused = ['sample/repo@main\u007f', 'local:projects\u0085x', 'local:a\u00a0b', 'local:x\u202ey', 'local:x\u200fy', 'local:x\u2066y'];
  for (const source of refused) {
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source } } });
    const run = runInstaller(shell, ctx, [], { apply: false });
    assert.notEqual(run.status, 0, JSON.stringify(source));
    assert.match(plainOutput(run), /layers\.pstack\.source .*holds (?:the character \\u[0-9A-F]{4}|a non-breaking space)/, JSON.stringify(source));
  }
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:caf\u00e9' } } });
  assertOk(runInstaller(shell, ctx, [], { apply: false }));
}, {});

withWorkspace('nesting deeper than 32 is named as nesting, not as comments or trailing commas', (ctx) => {
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), `{"version":1,"deep":${'['.repeat(40)}0${']'.repeat(40)}}`);
  const run = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(run.status, 0);
  assert.match(plainOutput(run), /nested deeper than 32/);
  assert.doesNotMatch(plainOutput(run), /Comments and trailing commas/);
}, {});

withWorkspace('date-like strings stay strings, as the Python reader keeps them', (ctx) => {
  // ConvertFrom-Json turns an ISO date into a DateTime unless asked for strings. Both values here are strings in JSON.
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), '{"version":1,"$schema":"2020-12-01T00:00:00Z"}');
  assertOk(runInstaller(shell, ctx, [], { apply: false }));

  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: '2020-12-01' } } });
  const dateSource = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(dateSource.status, 0);
  assert.match(plainOutput(dateSource), /layers\.pstack\.source is not a supported source/);
  assert.doesNotMatch(plainOutput(dateSource), /must be a non-empty source string/);
}, {});

const verifySettingsScript = join(repoRoot, 'scripts', 'verify_settings.py');

const psFile = (name) => join(repoRoot, 'scripts', name).replaceAll("'", "''");

// Finding 1: a runtime key with a zero width joiner is refused by its escaped name, and a fresh workspace stays empty.
withWorkspace('finding 1: a runtime key with a zero width joiner is refused by its escaped name, and nothing is written', (ctx) => {
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {}, [`pi${ZWJ}`]: {} } });
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /runtimes key 'pi\\u200D' holds the character \\u200D/);
  assert.doesNotMatch(plainOutput(run), new RegExp(ZWJ));
  assert.equal(existsSync(lockPath(ctx)), false, 'a refused settings file wrote a lock');
  assert.equal(existsSync(join(ctx.workspace, '.maxstack')), false, 'a refused settings file wrote the wrappers');
}, {});

// Finding 1: a layer key with a zero width space is refused with and without a source.
withWorkspace('finding 1: a layer key with a zero width space is refused with and without a source, and nothing is written', (ctx) => {
  const layer = `pstack${ZWSP}`;
  for (const entry of [{}, { source: 'local:ext-b-in-ws' }]) {
    writeWorkspaceSettings(ctx, { version: 1, layers: { [layer]: entry } });
    const run = runInstaller(shell, ctx);
    assert.notEqual(run.status, 0, plainOutput(run));
    assert.match(plainOutput(run), /layers key 'pstack\\u200B' holds the character \\u200B/);
  }
  assert.equal(existsSync(lockPath(ctx)), false, 'a refused layer key wrote a lock');
}, {});

// Finding 5: the refusal comes before any lookup. A lookup replaced by a probe would print its marker, so the refusal must be
// the first thing a UNC or device path meets.
withWorkspace('finding 5: a UNC or device path is refused by text before the local path lookup runs', (ctx) => {
  const script = String.raw`$ErrorActionPreference = 'Stop'
. '${psFile('Install-WorkspaceDiscovery.ps1')}'
. '${psFile('Install-Ordinal.ps1')}'
. '${psFile('Install-LayerSources.ps1')}'
. '${psFile('Install-Settings.ps1')}'
$Workspace = '${ctx.workspace.replaceAll("'", "''")}'
function Get-LocalPathFault { 'LOOKUP-REACHED' }
foreach ($spec in @('local:\\server\share\x', 'local:\\\\?\\C:\x')) {
  try { $null = Read-SourceSpec pstack $spec; "NO-REFUSAL $spec" } catch { "REFUSED=$($_.Exception.Message)" }
}
try { $null = Read-SourceSpecs -Specs @() -LayerSpecs @('pstack=\\server\share\x') -LayerNames @('pstack'); 'NO-REFUSAL layer' } catch { "LAYER=$($_.Exception.Message)" }
`;
  const file = join(ctx.base, 'unc-order.ps1');
  writeFileSync(file, script);
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', file], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /LOOKUP-REACHED|NO-REFUSAL/, run.stdout);
  assert.match(run.stdout, /REFUSED=.*UNC or device path/);
  assert.match(run.stdout, /LAYER=.*UNC or device path/);
}, {});

// Finding 2: a read-only audit, a -Status, and -Update -Check contact no remote for a declared git source, while an apply does.
withWorkspace('finding 2: an audit, a -Status, and an -Update -Check start no ls-remote for a declared git source', (ctx) => {
  mustApply(ctx);
  const seam = join(ctx.base, 'seam');
  const bare = join(seam, 'example', 'fixture.git');
  mkdirSync(bare, { recursive: true });
  gitRun(bare, ['init', '-q', '--bare']);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'example/fixture@main' } } });
  const trace = join(ctx.base, 'remote-trace.txt');
  const env = { ...testEnvironment(), MAXSTACK_TEST_GITHUB_ROOT: seam, GIT_TRACE: trace };
  for (const args of [[], ['-Status'], ['-Update', '-Check']]) {
    const run = runInstaller(shell, ctx, args, { apply: false, env });
    assert.ok(run.status === 0 || run.status === 1, `${args.join(' ') || 'audit'}: ${plainOutput(run)}`);
    const traced = existsSync(trace) ? readFileSync(trace, 'utf8') : '';
    // The declared remote is the one under the seam. -Update -Check still reads the layers.json pin for its hint, which is a
    // pin and not a declared source, so only the declared remote is asserted for it.
    assert.doesNotMatch(traced, /ls-remote[^\n]*example[\\/]fixture\.git/, `${args.join(' ') || 'audit'} contacted the declared remote`);
    rmSync(trace, { force: true });
  }
  const apply = runInstaller(shell, ctx, [], { apply: true, env });
  assert.match(readFileSync(trace, 'utf8'), /ls-remote[^\n]*example[\\/]fixture\.git/, `the spy did not see the apply: ${plainOutput(apply)}`);
}, {});

// Finding 13: every printed name escapes a control, a bidi, and a zero width character, in each position a run can reach.
withWorkspace('finding 13: a name with a control, bidi, or zero width character is printed escaped in every position', (ctx) => {
  mustApply(ctx);
  const positions = [
    ['top-level key', (char) => ({ version: 1, [`x${char}`]: 1 })],
    ['runtimes key', (char) => ({ version: 1, runtimes: { [`claude${char}`]: {} } })],
    ['layers key', (char) => ({ version: 1, layers: { [`pstack${char}`]: {} } })],
    ['t3 key', (char) => ({ version: 1, t3: { [`cli${char}`]: 'detect' } })],
    ['runtime cli value', (char) => ({ version: 1, runtimes: { claude: { cli: `detect${char}` } } })],
    ['os value', (char) => ({ version: 1, os: `auto${char}` })],
    ['layer source value', (char) => ({ version: 1, layers: { pstack: { source: `default${char}` } } })],
  ];
  for (const char of [ZWSP, RLO, '\u0007']) {
    for (const [label, build] of positions) {
      writeWorkspaceSettings(ctx, build(char));
      const run = runInstaller(shell, ctx, [], { apply: false });
      const text = `${run.stdout}${run.stderr}`;
      assert.notEqual(run.status, 0, `${label} ${escapedChar(char)}: ${plainOutput(run)}`);
      assert.ok(!text.includes(char), `${label} ${escapedChar(char)} printed the raw character`);
      assert.ok(text.includes(escapedChar(char)), `${label} ${escapedChar(char)} printed no escape: ${plainOutput(run)}`);
    }
    for (const [flag, value] of [['-Source', `pstack${char}=default`], ['-LayerSource', `pstack${char}=${join(ctx.base, 'missing-layer')}`]]) {
      rmSync(join(ctx.workspace, 'maxstack.settings.json'), { force: true });
      const run = runInstaller(shell, ctx, [flag, value], { apply: false });
      const text = `${run.stdout}${run.stderr}`;
      assert.notEqual(run.status, 0, `${flag} ${escapedChar(char)}: ${plainOutput(run)}`);
      assert.ok(!text.includes(char), `${flag} ${escapedChar(char)} printed the raw character`);
      assert.ok(text.includes(escapedChar(char)), `${flag} ${escapedChar(char)} printed no escape: ${plainOutput(run)}`);
    }
  }
}, {});

// Finding 15: an 8.3 short name and a trailing dot or space in a source folder are refused, the way -Workspace refuses an 8.3 name.
withWorkspace('finding 15: an 8.3 short name, and a trailing dot or space in a source folder, are refused', (ctx) => {
  mustApply(ctx);
  for (const source of ['local:SAMPLE~1', 'local:tools/checkout.', 'local:tools/checkout ']) {
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source } } });
    const run = runInstaller(shell, ctx, [], { apply: true });
    assert.notEqual(run.status, 0, `${source}: ${plainOutput(run)}`);
    assert.match(plainOutput(run), source === 'local:SAMPLE~1' ? /layers\.pstack\.source local path has an 8\.3 short name/ : /layers\.pstack\.source has a folder name with a trailing dot or space/, `${source}: ${plainOutput(run)}`);
  }
  for (const folder of ['tools\\checkout.', 'SAMPLE~1']) {
    writeWorkspaceSettings(ctx, { version: 1 });
    const flag = runInstaller(shell, ctx, ['-Source', `pstack=local:${join(ctx.workspace, folder)}`], { apply: false });
    assert.notEqual(flag.status, 0, `-Source ${folder}: ${plainOutput(flag)}`);
    assert.match(plainOutput(flag), folder === 'SAMPLE~1' ? /-Source pstack=local:.* has an 8\.3 short name/ : /has a folder name with a trailing dot or space/, `-Source ${folder}`);
  }
}, {});

// Finding 17: the verifier prints a zero width name on a cp1252 console as an escape, with no traceback.
withWorkspaceNeeding('python', python, 'finding 17: the reader prints a zero width name on a cp1252 console as an escape, with no traceback', (ctx) => {
  const file = join(ctx.base, 'zero-width.json');
  writeFileSync(file, JSON.stringify({ version: 1, [`runtimes${ZWSP}`]: {} }));
  const run = spawnSync(python, [verifySettingsScript, '--document', file], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'cp1252', PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /Traceback|UnicodeEncodeError/);
  assert.match(run.stdout, /\\u200B/);
}, {});

withWorkspace('a git pin the repository cannot supply stops the run before anything is written', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'pstack').source.commit = 'f'.repeat(40);
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.notEqual(run.status, 0, 'the installer accepted an unreachable pin');
  assert.match(plainOutput(run), /Could not fetch the pinned commit f{40}/);
  assert.ok(!existsSync(join(ctx.workspace, 'opencode.jsonc')), 'the config was written before the pin check');
  assert.ok(!existsSync(join(ctx.workspace, '.claude', 'plugins', 'pstack')), 'a pstack folder was written');
  assert.ok(!existsSync(join(ctx.workspace, '.opencode', 'plugins', 'pstack')), 'an OpenCode folder was written');
}, {});

withWorkspace('an offline re-apply reuses the cached commit', (ctx) => {
  mustApply(ctx);
  const moved = `${ctx.fixture.dir}-moved`;
  renameSync(ctx.fixture.dir, moved);
  try {
    const run = runInstaller(shell, ctx);
    assert.equal(run.status, 0, `offline re-apply failed\n${run.stdout}\n${run.stderr}`);
    const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
    const pstack = lock.layers.find((record) => record.name === 'pstack');
    assert.equal(pstack.claude.commit, ctx.fixture.commit);
  } finally {
    renameSync(moved, ctx.fixture.dir);
  }
}, {});

withWorkspace('the cache follows the layer url, even when it was cloned from another remote', (ctx) => {
  mustApply(ctx);
  const cache = join(ctx.workspace, '.claude', 'cache', 'pstack');
  const drifted = spawnSync('git', ['-C', cache, 'remote', 'set-url', 'origin', 'file:///nonexistent/other-remote'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(drifted.status, 0, drifted.stderr);

  mustApply(ctx);
  const origin = spawnSync('git', ['-C', cache, 'remote', 'get-url', 'origin'], { windowsHide: true, encoding: 'utf8' }).stdout.trim();
  assert.equal(origin, ctx.fixture.url, 'the cache origin was not reset to the layer url');
}, {});

withWorkspace('LayerSource overrides a local checkout, and now also a git-pinned layer', (ctx) => {
  const alternate = join(ctx.base, 'alternate-org');
  writeLayerStub(alternate, { claudePlugin: 'simpsonm09-org-ai-plugin', extra: { 'from-override.txt': 'override\n' } });
  mustApply(ctx, ['-LayerSource', `simpsonm09-org-ai-plugin=${alternate}`]);
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'from-override.txt')));

  // -LayerSource is the local alias of -Source, so it reads pstack from a checkout of the fork as well.
  const pstackCheckout = join(ctx.base, 'pstack-checkout');
  cpSync(join(ctx.fixture.dir), pstackCheckout, { recursive: true });
  mustApply(ctx, ['-LayerSource', `pstack=${pstackCheckout}`]);
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'pstack', 'opencode', 'index.ts')), 'pstack was not installed from the checkout');
}, {});

withWorkspace('audit with the real layers.json needs no network and writes no runtime files', (ctx) => {
  // The real manifest points pstack at GitHub; audit must not fetch it.
  const args = [
    '-LayerSource',
    `simpsonm09-org-ai-plugin=${join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin')},` +
      `simpsonm09-personal-ai-plugin=${join(ctx.workspace, 'projects/repos/simpsonm09-personal-ai-plugin')}`,
  ];
  const run = runInstaller(shell, ctx, args, { apply: false, layersFile: null });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /plugins\\pstack: missing/);
  // The pinned cache is not synced in audit, so the Pi settings cannot be checked yet.
  assert.match(run.stdout, /\.pi\\agent\\settings\.json: unknown until -Apply/);
  assert.ok(!existsSync(join(ctx.workspace, '.claude')), 'audit wrote under .claude');
  assert.ok(!existsSync(join(ctx.workspace, '.opencode')), 'audit wrote under .opencode');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack')), 'audit wrote under .maxstack');
  assert.ok(!existsSync(join(ctx.workspace, '.pi')), 'audit wrote under .pi');
}, {});

withWorkspace('an entry the user already lists is not written twice', (ctx) => {
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({ packages: ['../../.claude/cache/pstack'] }));
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath).packages, ['../../.claude/cache/pstack']);
}, {});

withWorkspace('a round trip through an npm install leaves the tree byte-identical to the start', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, NPM);

withWorkspace('names sort by code point, and the tree hash keeps case, emoji, and fullwidth names exact', (ctx) => {
  // Node_Modules is an item, not npm's folder, so it is hashed. An emoji name sorts after a fullwidth
  // one by code point, and before it by UTF-16, so a sort in the wrong order changes the hash.
  const org = join(ctx.workspace, ...ORG_SOURCE.split('/'));
  writeFile(org, 'Node_Modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  writeFile(org, 'Package-Lock.json', '{"lockfileVersion": 3}\n');
  writeFile(org, '\u{1F642}-emoji/a.txt', 'emoji\n');
  writeFile(org, 'Ａ-fullwidth/b.txt', 'fullwidth\n');
  writeFile(org, 'layer.json', JSON.stringify({
    files: ['index.ts', 'Node_Modules', 'Package-Lock.json', '\u{1F642}-emoji', 'Ａ-fullwidth', 'package.json', 'skills', '.claude-plugin'],
  }));
  mustApply(ctx);
  const folder = join(ctx.workspace, ...ORG_FOLDER.split('/'));
  assert.ok(existsSync(join(folder, 'Node_Modules', '@opencode', 'plugin', 'index.js')));
  assert.ok(existsSync(join(folder, 'Package-Lock.json')), 'the item named Package-Lock.json was not kept');
  assert.ok(existsSync(join(folder, '\u{1F642}-emoji', 'a.txt')));
  assert.ok(existsSync(join(folder, 'Ａ-fullwidth', 'b.txt')));
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, ORG_FOLDER, 'dir').sha256, independentSha(folder, 'owned'));
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('an unsynced pinned cache reports only the entries it cannot know, each once', (ctx) => {
  mustApply(ctx);
  // The pin moves to a commit the cache has not fetched: pstack's folders and entries are unknown.
  writeFileSync(join(ctx.fixture.dir, 'bump.txt'), 'bump\n');
  const commit = (args) => {
    const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-C', ctx.fixture.dir, ...args], { windowsHide: true, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  commit(['add', '-A']);
  commit(['commit', '-q', '-m', 'bump']);
  const moved = commit(['rev-parse', 'HEAD']);
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'pstack').source.commit = moved;
  });

  const run = runInstaller(shell, ctx, ['-Status'], { apply: false, layersFile: layers });
  assert.equal(run.status, 0, run.stderr);
  const problems = problemRows(run);
  assert.ok(problems.length > 0, run.stdout);
  assert.ok(problems.every((row) => row.state === 'drifted'), run.stdout);
  assert.ok(problems.every((row) => row.label.includes('pstack')), `a local layer is reported: ${run.stdout}`);
  const labels = problems.map((row) => row.label);
  assert.equal(new Set(labels).size, labels.length, `a path is reported twice: ${run.stdout}`);
  const localSkills = problems.filter((row) => /simpsonm09-(org|personal)-ai-plugin\/skills/.test(row.label));
  assert.deepEqual(localSkills, [], `a local layer's entry was reported: ${run.stdout}`);
}, {});

withWorkspace('a selected layer that declares none of the selected runtimes is reported and installs nothing', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-personal-ai-plugin').runtimes = { opencode: {} };
  });
  const run = mustApply(ctx, ['-Runtimes', 'claude'], { layersFile: layers });
  assert.match(plainOutput(run), /Layer 'simpsonm09-personal-ai-plugin' declares none of the selected runtimes, so it installs nothing\./);
  assert.ok(!existsSync(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-personal-ai-plugin')), 'the personal layer installed');
  const personal = readJson(lockPath(ctx)).layers.find((layer) => layer.name === 'simpsonm09-personal-ai-plugin');
  assert.equal(personal.claude.enabled, false);
  assert.equal(personal.opencode.enabled, false);
}, {});

withWorkspace('a round trip: installing every runtime and then uninstalling leaves the tree byte-identical to the start', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  assert.notDeepEqual(snapshotTree(ctx.workspace), before, 'the install wrote nothing');

  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock files remain after a full uninstall');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), USER_CONFIG, 'the user config was not restored');
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS, 'the user Pi settings were not restored');
}, {});

withWorkspace('removing pi leaves the tree and the lock that a fresh install of claude and copilot writes', (ctx) => {
  seedUserFiles(ctx);
  mustApply(ctx, ['-Runtimes', 'claude,copilot,pi']);
  assertOk(removal(ctx, ['-Remove', '-Runtimes', 'pi']));
  const removed = snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true });

  assertOk(removal(ctx, ['-Uninstall']));
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  assert.deepEqual(snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true }), removed);
}, {});

const REFUSED_SOURCES = [
  ['pstack=http://github.com/simpsonm09/pstack-max.git@feat', 'only https'],
  ['pstack=ssh://git@github.com/simpsonm09/pstack-max.git@feat', 'only https'],
  ['pstack=file:///tmp/pstack.git@feat', 'only https'],
  ['pstack=https://user@github.com/simpsonm09/pstack-max.git@feat', 'only https'],
  ['pstack=simpsonm09/pstack-max@feat..x', 'holds [.][.]'],
  ['pstack=simpsonm09/pstack-max@-feat', 'not a safe git ref name'],
  ['pstack=simpsonm09/pstack-max@feat~1', 'not a safe git ref name'],
  ['pstack=simpsonm09/pstack-max@feat.lock', 'not a safe git ref name'],
  ['pstack=simpsonm09/pstack-max@feat x', 'space or a control character'],
  ['pstack=simpsonm09/pstack claude@feat', 'space or a control character'],
  ['pstack=-simpsonm09/pstack-max@feat', 'starts with a dash'],
  ['pstack=simpsonm09/pstack-max', 'needs @ref'],
  ['pstack=simpsonm09/..x@feat', 'holds \\.\\.'],
  ['pstack=local:relative/checkout', 'needs an absolute path'],
  ['nosuchlayer=simpsonm09/pstack-max@feat', 'names an unknown layer'],
];

withWorkspace('malformed -Source specs and unknown layers are refused before anything is written', (ctx) => {
  for (const [spec, reason] of REFUSED_SOURCES) {
    const run = runInstaller(shell, ctx, ['-Source', spec]);
    assert.notEqual(run.status, 0, `the installer accepted -Source ${spec}`);
    assert.match(plainOutput(run), new RegExp(reason), `${spec}: ${run.stdout}\n${run.stderr}`);
    assert.equal(existsSync(lockPath(ctx)), false, `${spec} wrote a lock`);
    assert.equal(existsSync(join(ctx.workspace, '.claude')), false, `${spec} wrote under .claude`);
  }
}, {});

withWorkspace('a local source is refused for the workspace itself and for each folder the installer writes', (ctx) => {
  for (const folder of [ctx.workspace, join(ctx.workspace, '.claude'), join(ctx.workspace, '.claude', 'cache')]) {
    mkdirSync(folder, { recursive: true });
    const run = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${folder}`]);
    assert.notEqual(run.status, 0, `the installer accepted ${folder}`);
    assert.match(plainOutput(run), /cannot be a layer source/, run.stdout);
  }
  assert.equal(existsSync(lockPath(ctx)), false, 'a refused local source wrote a lock');
}, {});

withWorkspace('an https source that cannot be reached fails with the reason, and leaves the install untouched', (ctx) => {
  mustApply(ctx);
  const before = snapshotTree(ctx.workspace);
  const run = runInstaller(shell, ctx, ['-Source', 'pstack=https://127.0.0.1:1/simpsonm09/pstack-max.git@feat'], { env: githubEnv(ctx) });
  assert.notEqual(run.status, 0, 'an unreachable source was accepted');
  assert.match(plainOutput(run), /could not read the refs of https:\/\/127\.0\.0\.1:1/, run.stdout);
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'a failed source changed the install');
}, {});

withWorkspace('-Status, -Remove, and -Uninstall refuse -Source, which only an apply or an audit takes', (ctx) => {
  for (const args of [['-Status'], ['-Remove', '-Layers', 'pstack'], ['-Uninstall']]) {
    const run = runInstaller(shell, ctx, [...args, '-Source', 'pstack=simpsonm09/pstack-max@feat'], { apply: false });
    assert.notEqual(run.status, 0, `${args.join(' ')} accepted -Source`);
    assert.match(plainOutput(run), /-Source sets a layer source for an apply or an audit/, run.stdout);
  }
}, {});

withWorkspace('an audit names the source it would install, and writes nothing', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx);
  const before = snapshotTree(ctx.workspace);
  const audit = runInstaller(shell, ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { apply: false, env: githubEnv(ctx) });
  assertOk(audit);
  const block = sourceBlockOf(audit.stdout);
  assert.ok(block, audit.stdout);
  assert.match(block.lines.join('\n'), new RegExp(`pstack: override, git \\S+ ref feat at ${featCommit}`));
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'an audit changed the workspace');
}, {});

withWorkspace('-Update moves a branch override to its current commit and records it, and a dry run changes nothing', (ctx) => {
  const { bare, featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  const lockBefore = readFileSync(lockPath(ctx), 'utf8');
  const featTwo = moveFeat(ctx, bare);

  const dry = runInstaller(shell, ctx, ['-Update'], { apply: false, env: githubEnv(ctx) });
  assertOk(dry);
  assert.match(dry.stdout, new RegExp(`feat ${featCommit} -> ${featTwo}`), dry.stdout);
  assert.equal(readFileSync(lockPath(ctx), 'utf8'), lockBefore, 'a dry -Update changed the lock');

  mustApply(ctx, ['-Update'], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').commit, featTwo, 'the branch override did not move');
  assert.equal(sourceOf(ctx, 'pstack').source.override, true);
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body two/, 'the moved content was not installed');
}, {});

withWorkspace('-Update does not move a commit pin, even when its branch has moved', (ctx) => {
  const { bare, featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', `pstack=simpsonm09/pstack-max@${featCommit}`], { env: githubEnv(ctx) });
  moveFeat(ctx, bare);
  mustApply(ctx, ['-Update'], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').commit, featCommit, 'a commit pin moved');
  assert.equal(sourceOf(ctx, 'pstack').source.ref, featCommit);
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body/);
  assert.doesNotMatch(readFileSync(installedSkill(ctx), 'utf8'), /feat body two/);
}, {});

withWorkspace('-Update -Check -Strict exits 0 when nothing would change', (ctx) => {
  servedFeature(ctx);
  mustApply(ctx);
  const strict = runInstaller(shell, ctx, ['-Update', '-Check', '-Strict'], { apply: false, env: githubEnv(ctx) });
  assert.equal(strict.status, 0, `${strict.stdout}\n${strict.stderr}`);
  assert.match(strict.stdout, /Nothing would change/, strict.stdout);
}, {});

withWorkspace('-Update re-reads a local source, and an apply then installs what the checkout holds', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  writeFile(checkout, 'index.ts', 'export default { edit: 1 };\n');
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);

  writeFile(checkout, 'index.ts', 'export default { edit: 2 };\n');
  const installed = join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'index.ts');
  const check = runInstaller(shell, ctx, ['-Update', '-Check', '-Strict'], { apply: false });
  assert.equal(check.status, 1, `the edited checkout was not reported:\n${check.stdout}`);
  assert.match(readFileSync(installed, 'utf8'), /edit: 1/, 'the check changed the install');

  mustApply(ctx, ['-Update']);
  assert.match(readFileSync(installed, 'utf8'), /edit: 2/, '-Update did not re-read the checkout');
  assert.equal(sourceOf(ctx, 'simpsonm09-org-ai-plugin').source.dirty, true);
}, {});

withWorkspace('a -Update whose branch cannot be resolved fails with the reason, and leaves the install untouched', (ctx) => {
  const { bare } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  gitRun(bare, ['update-ref', '-d', 'refs/heads/feat']);
  const before = snapshotTree(ctx.workspace);
  const run = runInstaller(shell, ctx, ['-Update'], { env: githubEnv(ctx) });
  assert.notEqual(run.status, 0, '-Update resolved a branch that is gone');
  assert.match(plainOutput(run), /has no branch or tag named feat/, run.stdout);
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'a failed -Update changed the install');
}, {});

withWorkspace('-Update prints the pin hint when layers.json\'s branch has moved, and moves no pin', (ctx) => {
  mustApply(ctx);
  const lockBefore = readFileSync(lockPath(ctx), 'utf8');
  gitRun(ctx.fixture.dir, ['checkout', '-q', '-b', 'test']);
  writeFile(ctx.fixture.dir, SKILL_PATH, '---\nname: poteto-mode\ndescription: fixture\n---\nnewer\n');
  gitRun(ctx.fixture.dir, ['add', '-A']);
  gitRun(ctx.fixture.dir, ['commit', '-q', '-m', 'newer']);
  const newer = gitRun(ctx.fixture.dir, ['rev-parse', 'HEAD']);

  const run = runInstaller(shell, ctx, ['-Update'], { apply: false });
  assertOk(run);
  assert.match(run.stdout, new RegExp(`layers\\.json pins ${ctx.fixture.commit}, and test is at ${newer}`), run.stdout);
  assert.match(run.stdout, /-Update never moves a pin/, run.stdout);
  assert.equal(readFileSync(lockPath(ctx), 'utf8'), lockBefore, 'the hint changed the lock');
}, {});

withWorkspace('-Source owner/repo@tag resolves an annotated tag to the commit it points at', (ctx) => {
  const { bare, featCommit } = servedFeature(ctx);
  gitRun(bare, ['tag', '-a', 'v1', '-m', 'release', featCommit]);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@v1'], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').commit, featCommit, 'the annotated tag resolved to its tag object, not its commit');
  assert.deepEqual(sourceOf(ctx, 'pstack').source, { kind: 'git', url: remoteUrl(ctx, 'simpsonm09', 'pstack-max'), ref: 'v1', commit: featCommit, override: true });
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body/, 'the tagged content was not installed');
}, {});

// ---- Hardening of the layer sources: each test names one review finding, and each fails before its fix. ----

// A config layer served from a local bare repository, pinned to its commit, for a git override of that layer.
function servedConfigLayer(ctx) {
  const source = join(ctx.base, 'cfg-src');
  writeLayerStub(source, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  gitRun(source, ['init', '-q']);
  gitRun(source, ['add', '-A']);
  gitRun(source, ['commit', '-q', '-m', 'config layer']);
  const commit = gitRun(source, ['rev-parse', 'HEAD']);
  serveRepo(ctx, 'simpsonm09', 'org-ai-plugin', source);
  return commit;
}

// Finding 1: a config layer under a git override is read from its cache, and an audit with no cache says so.
withWorkspace('a config layer under a git override runs -Status and -Update -Check without throwing', (ctx) => {
  const commit = servedConfigLayer(ctx);
  const override = ['-Source', `simpsonm09-org-ai-plugin=simpsonm09/org-ai-plugin@${commit}`];
  mustApply(ctx, override, { env: githubEnv(ctx) });
  assertOk(runInstaller(shell, ctx, ['-Status'], { apply: false, env: githubEnv(ctx) }));
  assertOk(runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false, env: githubEnv(ctx) }));
}, {});

withWorkspace('a config layer pinned by -Source and audited without -Apply names its config as unknown, and does not throw', (ctx) => {
  const commit = servedConfigLayer(ctx);
  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=simpsonm09/org-ai-plugin@${commit}`], { apply: false, env: githubEnv(ctx) });
  assertOk(audit);
  assert.match(audit.stdout, /Drift: .*opencode\.jsonc: unknown until -Apply syncs the layer cache/, audit.stdout);
  assert.equal(existsSync(join(ctx.workspace, '.claude', 'cache')), false, 'an audit fetched the cache');
}, {});

// Finding 2: a local tree is read with git, and its .git/config may name a program git runs. An audit must run none of it.
withWorkspace('an audit of a -Source local tree runs no program that its .git/config names', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'fsmonitor-marker');
  gitRun(checkout, ['config', 'core.fsmonitor', `touch '${marker.split('\\').join('/')}'`]);
  gitRun(checkout, ['status', '--porcelain']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the command that core.fsmonitor names when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the command that core.fsmonitor names');
}, {});

withWorkspace('finding F1: a linked git worktree is a readable local layer and its worktree filter stays guarded', (ctx) => {
  const normal = join(ctx.base, 'pstack-worktree');
  gitRun(ctx.fixture.dir, ['worktree', 'add', '-b', 'fixture-worktree', normal, 'HEAD']);
  mustApply(ctx, ['-Source', `pstack=local:${normal}`]);
  assert.equal(sourceOf(ctx, 'pstack').source.kind, 'local');

  const guarded = join(ctx.base, 'pstack-worktree-guarded');
  gitRun(ctx.fixture.dir, ['worktree', 'add', '-b', 'fixture-worktree-guarded', guarded, 'HEAD']);
  gitRun(guarded, ['config', '--local', 'extensions.worktreeConfig', 'true']);
  const marker = join(ctx.base, 'worktree-filter-marker');
  gitRun(guarded, ['config', '--worktree', 'filter.hostile.clean', touchAndCat(marker)]);
  assert.equal(gitRun(guarded, ['config', '--local', '--bool', '--get', 'extensions.worktreeConfig']), 'true');
  assert.match(gitRun(guarded, ['config', '--worktree', '--name-only', '--get-regexp', '^filter\.']), /filter\.hostile\.clean/);
  writeFileSync(join(guarded, '.gitattributes'), '*.txt filter=hostile\n');
  writeFileSync(join(guarded, 'notes.txt'), 'fixture\n');
  gitRun(guarded, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.ok(existsSync(marker), 'the worktree filter fixture did not run unguarded');
  rmSync(marker);
  const attributes = gitRun(guarded, ['rev-parse', '--git-path', 'info/attributes']);
  mkdirSync(dirname(attributes), { recursive: true });
  writeFileSync(attributes, '*.txt filter=hostile\n');
  const inspect = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile.replaceAll("'", "''")}'; Read-TreeFilterNames -Dir '${guarded.replaceAll("'", "''")}' | ConvertTo-Json -Compress`;
  const guardedRead = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', inspect], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assert.equal(guardedRead.status, 0, `${guardedRead.stdout}\n${guardedRead.stderr}`);
  assert.match(guardedRead.stdout, /hostile/, guardedRead.stdout);
  const guardedHash = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile.replaceAll("'", "''")}'; Invoke-GitGuarded -Dir '${guarded.replaceAll("'", "''")}' -Arguments @('-C', '${guarded.replaceAll("'", "''")}', 'hash-object', '--path=notes.txt', 'notes.txt') -TimeoutSeconds 15 | ConvertTo-Json -Compress`;
  const guardedRun = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', guardedHash], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assert.equal(guardedRun.status, 0, `${guardedRun.stdout}\n${guardedRun.stderr}`);
  assert.equal(existsSync(marker), false, 'git ran the hostile per-worktree filter');
  const audit = runInstaller(shell, ctx, ['-Source', `pstack=local:${guarded}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the installer ran the hostile per-worktree filter');
}, {});

// Finding 3: a recorded local override whose folder is gone is reported, and only an apply stops on it.
withWorkspace('a recorded local override whose folder is gone is reported by -Status, -Update -Check, and -Remove, and only -Apply stops', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  rmSync(checkout, { recursive: true, force: true });
  const missing = `local ${checkout}: folder missing`;

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.ok(status.stdout.includes(missing), status.stdout);

  const check = runInstaller(shell, ctx, ['-Update', '-Check', '-Strict'], { apply: false });
  assert.equal(check.status, 1, `a missing folder is counted as a change, so -Strict exits 1:\n${check.stdout}`);
  assert.ok(check.stdout.includes(missing), check.stdout);

  assertOk(runInstaller(shell, ctx, ['-Uninstall'], { apply: false }));
  assertOk(runInstaller(shell, ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin'], { apply: false }));
  const refused = removal(ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin']);
  assert.notEqual(refused.status, 0, 'a removal rewrote the config without the missing fragment');
  assert.match(plainOutput(refused), /has no folder at .*Restore the folder/i, plainOutput(refused));
  assert.doesNotMatch(plainOutput(refused), /-Source/, refused.stdout);
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-personal-ai-plugin')), 'a refused removal removed the layer');

  mustApply(ctx, ['-Source', 'simpsonm09-org-ai-plugin=default']);
  assertOk(removal(ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin']));
  assert.equal(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-personal-ai-plugin')), false, 'the other layer was not removed');
}, {});

// Finding 3: -Update resolves only the layers it selects, so a remote the selection leaves out cannot abort it.
withWorkspace('-Update resolves only the selected layers, so an unreachable remote of an unselected layer does not abort', (ctx) => {
  const { bare } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  const lock = readJson(lockPath(ctx));
  lock.selection.layers = lock.selection.layers.filter((name) => name !== 'pstack');
  setLock(ctx, lock);
  rmSync(bare, { recursive: true, force: true });

  const check = runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false, env: githubEnv(ctx) });
  assertOk(check);
  assert.doesNotMatch(plainOutput(check), /could not read the refs/, check.stdout);
}, {});

// Finding 4: the changed-file count of an -Update -Check report. A rename makes git read blobs the partial cache lacks.
// The feat branch moves the skill to a new name and edits it, which is an inexact rename that reads both blobs.
const SKILL_MOVED = 'plugins/pstack/skills/poteto-renamed/SKILL.md';

function renameSkillOnFeat(ctx) {
  const work = join(ctx.base, 'work');
  gitRun(work, ['fetch', '--quiet', 'origin']);
  gitRun(work, ['checkout', '-q', '-B', 'feat', 'origin/feat']);
  mkdirSync(join(work, dirname(SKILL_MOVED)), { recursive: true });
  gitRun(work, ['mv', SKILL_PATH, SKILL_MOVED]);
  writeFile(work, SKILL_MOVED, SKILL_FEAT_TWO);
  gitRun(work, ['add', '-A']);
  gitRun(work, ['commit', '-q', '-m', 'rename the skill']);
  gitRun(work, ['push', '-q', 'origin', 'feat']);
  return gitRun(work, ['rev-parse', 'HEAD']);
}

withWorkspace('-Update -Check counts the changed files of a rename that the partial cache must read, and does not report zero', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  const renamed = renameSkillOnFeat(ctx);
  const cache = join(ctx.workspace, '.claude', 'cache', 'pstack');
  gitRun(cache, ['fetch', '--quiet', '--filter=blob:none', 'origin', renamed]);

  const check = runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false, env: githubEnv(ctx) });
  assertOk(check);
  assert.match(check.stdout, new RegExp(`feat ${featCommit} -> ${renamed}; 2 files changed under plugins/pstack`), check.stdout);
  assert.doesNotMatch(check.stdout, /0 files changed/, check.stdout);
}, {});

test('without the test-mode flag the owner/repo shorthand names github.com, even when the test root is set', { skip }, () => {
  const env = { ...process.env, MAXSTACK_TEST_GITHUB_ROOT: join(tmpdir(), 'maxstack-seam-probe') };
  delete env.MAXSTACK_TEST_MODE;
  const run = resolveShorthand(env);
  assertOk(run);
  assert.equal(run.stdout.trim(), SHORTHAND_URL, run.stdout);
}, {});

test('with the test-mode flag and a root under the temp folder, the shorthand names that folder and warns', { skip }, () => {
  const root = join(tmpdir(), 'maxstack-seam-probe');
  const run = resolveShorthand({ ...process.env, MAXSTACK_TEST_MODE: '1', MAXSTACK_TEST_GITHUB_ROOT: root });
  assertOk(run);
  assert.ok(run.stdout.split(/\r?\n/).includes(`${root.split('\\').join('/')}/simpsonm09/pstack-max.git`), run.stdout);
  assert.match(plainOutput(run), /MAXSTACK_TEST_GITHUB_ROOT is set/, plainOutput(run));
}, {});

test('with the test-mode flag but a root outside the temp folder, the shorthand names github.com', { skip }, () => {
  const run = resolveShorthand({ ...process.env, MAXSTACK_TEST_MODE: '1', MAXSTACK_TEST_GITHUB_ROOT: repoRoot });
  assertOk(run);
  assert.equal(run.stdout.trim(), SHORTHAND_URL, run.stdout);
}, {});

withWorkspace('without the test-mode flag, a -Source owner/repo at a commit is audited against github.com', (ctx) => {
  const sha = 'a'.repeat(40);
  const env = { ...process.env, MAXSTACK_TEST_GITHUB_ROOT: join(ctx.base, 'github') };
  delete env.MAXSTACK_TEST_MODE;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', installer, '-Workspace', ctx.workspace, '-LayersFile', writeLayers(ctx),
    '-CopilotCommand', ctx.fakeCopilot, '-PiCommand', ctx.fakePi, '-Source', `pstack=simpsonm09/pstack-max@${sha}`], { windowsHide: true, encoding: 'utf8', env });
  assertOk(run);
  assert.ok(run.stdout.includes(`override, git ${SHORTHAND_URL} ref ${sha} at ${sha}`), run.stdout);
  assert.ok(!run.stdout.includes(join(ctx.base, 'github')), 'the test root was used');
}, {});

// Finding 6: a recorded override is checked as a -Source spec is, and a bad value is refused by layer and field.
const BAD_RECORDS = [
  ['commit', (block) => { block.commit = 'zz'; }],
  ['ref', (block) => { block.ref = '--upload-pack=touch x'; }],
  ['ref', (block) => { block.ref = 'feat..x'; }],
  ['url', (block) => { block.url = 'ext::sh -c touch x'; }],
  ['url', (block) => { block.url = 'https://user@github.com/simpsonm09/pstack-max.git'; }],
  ['url', (block) => { block.url = 'https://github.com/simpsonm09/pstack claude.git'; }],
  ['url', (block) => { block.url = 'https://github.com/../x'; }],
  ['url', (block) => { block.url = 'https://github.com/simpsonm09/pstack-max.git\n'; }],
  ['commit', (block) => { block.commit = `${block.commit}\n`; }],
];

// Round 2, B: an invalid recorded override is a warning for every mode that does not write its layer. A plain apply that
// would write the layer stops before any write, and names the one command that repairs it.
withWorkspace('a git override the lock holds with a bad url, ref, or commit is ignored with a warning, and a plain apply refuses it', (ctx) => {
  servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  const good = readJson(lockPath(ctx));
  for (const [field, mutate] of BAD_RECORDS) {
    const lock = structuredClone(good);
    mutate(sourceBlockIn(lock, 'pstack'));
    setLock(ctx, lock);
    const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
    const recorded = Object.values(sourceBlockIn(lock, 'pstack')).filter((value) => typeof value === 'string');
    if (recorded.some((value) => [...value].some((character) => character.charCodeAt(0) < 32))) {
      // A control character in a recorded value is refused at the lock boundary, so the lock is not read at all.
      assert.notEqual(status.status, 0, plainOutput(status));
      assert.match(plainOutput(status), /stack\.lock\.json.*holds the character \\u000A/, plainOutput(status));
    } else {
      assertOk(status);
      assert.match(plainOutput(status), new RegExp(`layer 'pstack' has an invalid ${field}`), plainOutput(status));
      assert.match(status.stdout, /pstack: invalid recorded source, ignored for this run/, status.stdout);
    }
  }
  const lock = structuredClone(good);
  sourceBlockIn(lock, 'pstack').url = 'ext::sh -c touch x';
  setLock(ctx, lock);
  const before = snapshotTree(ctx.workspace);
  const apply = runInstaller(shell, ctx, [], { env: githubEnv(ctx) });
  assert.notEqual(apply.status, 0, 'an apply wrote a layer whose recorded url is invalid');
  assert.match(plainOutput(apply), /layer 'pstack' has an invalid url/, plainOutput(apply));
  assert.match(plainOutput(apply), /-Source pstack=default -Apply/, plainOutput(apply));
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'a refused lock changed the install');
}, {});

withWorkspace('an invalid recorded override is ignored by -Update, -Remove, and -Uninstall, and -Source name=default -Apply repairs it', (ctx) => {
  servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  const lock = readJson(lockPath(ctx));
  sourceBlockIn(lock, 'pstack').url = 'ext::sh -c touch x';
  setLock(ctx, lock);
  for (const args of [['-Update', '-Check'], ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin'], ['-Uninstall']]) {
    const run = runInstaller(shell, ctx, args, { apply: false, env: githubEnv(ctx) });
    assertOk(run);
    assert.match(run.stdout, /pstack: invalid recorded source, ignored for this run/, `${args.join(' ')}: ${run.stdout}`);
  }
  mustApply(ctx, ['-Source', 'pstack=default']);
  assert.equal(sourceOf(ctx, 'pstack').source.override, false, 'the repair did not drop the invalid override');
}, {});

// Finding 7: git never waits on a credential prompt, and ls-remote gives up after its time limit with the reason.
function runAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // A run that never ends is killed, so a failing test cannot leave the process behind.
    const guard = setTimeout(() => child.kill(), 100000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(guard);
      resolve({ status, stdout, stderr });
    });
  });
}

test('the git guard sets the prompt variables, and turns on file transport only in a test run', { skip }, () => {
  const script = `. '${layerSourcesFile}'; $vars = Get-GitChildVariables -Settings (Get-GitGuardSettings); "PROMPT=$($vars.GIT_TERMINAL_PROMPT)"; "GCM=$($vars.GCM_INTERACTIVE)"; (Get-GitGuardSettings | ForEach-Object { "$($_.key)=$($_.value)" }) -join ' '`;
  const real = { ...process.env };
  delete real.MAXSTACK_TEST_MODE;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: real });
  assertOk(run);
  assert.match(run.stdout, /PROMPT=0/, run.stdout);
  assert.match(run.stdout, /GCM=never/, run.stdout);
  assert.match(run.stdout, /core\.fsmonitor= /, run.stdout);
  assert.match(run.stdout, /core\.askPass= /, run.stdout);
  assert.match(run.stdout, /protocol\.allow=never/, run.stdout);
  assert.doesNotMatch(run.stdout, /protocol\.file\.allow/, 'a real run allows file transport');

  const seam = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: { ...real, MAXSTACK_TEST_MODE: '1' } });
  assert.match(seam.stdout, /protocol\.file\.allow=always/, seam.stdout);
}, {});

test('an ls-remote that passes its time limit is stopped, and the error says so', { skip, timeout: 120000 }, async () => {
  // The silent server takes each connection and never answers. The reset a stopped git causes is expected here.
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const script = `. '${layerSourcesFile}'; Find-GitRefCommit -Url 'https://127.0.0.1:${port}/simpsonm09/pstack-max.git' -Ref 'main' -TimeoutSeconds 2`;
    const run = await runAsync(['-NoProfile', '-NonInteractive', '-Command', script], { ...process.env, GIT_TERMINAL_PROMPT: '0' });
    assert.notEqual(run.status, 0, 'a silent remote was waited for');
    assert.match(plainOutput(run), /ls-remote took longer than 2 seconds/, plainOutput(run));
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

// Finding 9: a local source is a checkout of its own only when git's top level is the folder; an ancestor of the workspace
// would contain it; a long-path prefix and a junction are followed before a path is compared; a comma and a C:\x@ref
// spec get a clear reason.
withWorkspace('a plain folder inside another git repository is not a checkout, so no commit of that repository is recorded', (ctx) => {
  const outer = join(ctx.base, 'outer');
  writeFile(outer, 'README.md', 'outer\n');
  gitRun(outer, ['init', '-q']);
  gitRun(outer, ['add', '-A']);
  gitRun(outer, ['commit', '-q', '-m', 'outer']);
  const plain = join(outer, 'plain');
  writeLayerStub(plain, { claudePlugin: 'simpsonm09-org-ai-plugin' });

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${plain}`], { apply: false });
  assertOk(audit);
  const text = sourceBlockOf(audit.stdout).lines.join('\n');
  assert.match(text, /simpsonm09-org-ai-plugin: override, local .*plain \(not a git checkout\)/, text);
  assert.doesNotMatch(text, /HEAD/, 'the enclosing repository was recorded');
}, {});

withWorkspace('a local source that contains the workspace is refused, since the layer would hold the installer that reads it', (ctx) => {
  const run = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${ctx.base}`], { apply: false });
  assert.notEqual(run.status, 0, 'an ancestor of the workspace was accepted');
  assert.match(plainOutput(run), /is an ancestor of the workspace/, run.stdout);
}, {});

withWorkspace('a device prefix in a -Source path is refused by its text, and is not compared by the folder it names', (ctx) => {
  const prefixed = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:\\\\?\\${ctx.workspace}`], { apply: false });
  assert.notEqual(prefixed.status, 0, 'a long-path prefix hid the workspace');
  assert.match(plainOutput(prefixed), /UNC or device path/, prefixed.stdout);
}, {});

withWorkspace('a comma inside a -Source path is refused with the reason, since a comma separates entries', (ctx) => {
  const folder = join(ctx.base, 'a');
  mkdirSync(folder);
  const run = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${folder},b`], { apply: false });
  assert.notEqual(run.status, 0, 'a path with a comma was accepted');
  assert.match(plainOutput(run), /comma separates -Source entries, so a path cannot hold one/i, run.stdout);
}, {});

withWorkspace('a -Source spec that is a folder with an @ref says to use local:', (ctx) => {
  const run = runInstaller(shell, ctx, ['-Source', 'pstack=C:\\x@main'], { apply: false });
  assert.notEqual(run.status, 0, 'a folder with an @ref was accepted as a git source');
  assert.ok(plainOutput(run).includes('did you mean local:C:\\x?'), run.stdout);
}, {});

// Round 2, A: a recorded local override on a drive that is gone is reported as a missing folder, not a raw drive error.
function absentDriveLetter() {
  for (const letter of 'QRSTUVWXYZ') {
    if (!existsSync(`${letter}:/`)) return letter;
  }
  return null;
}

withWorkspace('a recorded override on a drive that is gone is reported as a missing folder, and -Status, -Update, -Remove, -Uninstall run', (ctx) => {
  const gone = absentDriveLetter();
  if (!gone) return;
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  const lock = readJson(lockPath(ctx));
  sourceBlockIn(lock, 'simpsonm09-org-ai-plugin').path = `${gone}:/repo/org`;
  setLock(ctx, lock);

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.ok(status.stdout.split('\\').join('/').includes(`${gone}:/repo/org: folder missing`), status.stdout);
  assertOk(runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false }));
  assertOk(runInstaller(shell, ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin'], { apply: false }));
  assertOk(runInstaller(shell, ctx, ['-Uninstall'], { apply: false }));

  const explicit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${gone}:/nope`], { apply: false });
  assert.notEqual(explicit.status, 0, 'an explicit source on an absent drive was accepted');
  assert.match(plainOutput(explicit), /folder does not exist/, explicit.stdout);
}, {});

// Round 2, C: a drive root or a share root is refused as a local source, and its path is kept whole, never cut to "Y:".
test('the folder helper keeps a drive root whole, with its backslash', { skip }, () => {
  const driveRoot = parsePath(tmpdir()).root;
  const script = `. '${layerSourcesFile}'; Get-FullFolderPath '${driveRoot.split('\\').join('/')}'`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  assertOk(run);
  assert.equal(run.stdout.trim(), driveRoot, run.stdout);
}, {});

// Round 2, D: a clean filter that .git/config names is a program too. An audit of a local tree must run none of it.
withWorkspace('an audit of a -Source local tree runs no clean filter that its .git/config names', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'filter-marker');
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  gitRun(checkout, ['config', 'filter.mark.clean', `sh -c "touch '${marker.split('\\').join('/')}'; cat"`]);
  writeFile(checkout, 'notes.txt', 'two\n');

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the clean filter that .git/config names');
}, {});

// Round 2, E: the installer needs PowerShell 7. Windows PowerShell 5.1 must stop with that requirement, not a parse error.
const windowsPowerShell = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0;

test('the installer under Windows PowerShell 5.1 stops with the PowerShell 7 requirement, not a parse error', { skip: windowsPowerShell ? false : 'powershell.exe is not available' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-requires-'));
  try {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', installer, '-Workspace', join(base, 'missing')], { windowsHide: true, encoding: 'utf8' });
    const text = plainOutput(run);
    assert.notEqual(run.status, 0, text);
    assert.match(text, /#requires.*7\.0/i, text);
    assert.doesNotMatch(text, /ParserError|Unexpected token|Array index expression/, text);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

// Round 2, H: the refusal for a missing layer folder names the absolute folder, and the command that fits the mode.
const ORG_DEFAULT_FOLDER = (ctx) => join(ctx.workspace, 'projects', 'repos', 'simpsonm09-org-ai-plugin');

withWorkspace('finding F4: a missing default layer names the clone URL and first-time source options', (ctx) => {
  rmSync(ORG_DEFAULT_FOLDER(ctx), { recursive: true, force: true });
  const apply = runInstaller(shell, ctx, []);
  assert.notEqual(apply.status, 0, 'an apply wrote past a missing default folder');
  assert.ok(plainOutput(apply).includes(`Clone https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin.git to ${ORG_DEFAULT_FOLDER(ctx)}`), plainOutput(apply));
  assert.match(plainOutput(apply), /-Source simpsonm09-org-ai-plugin=local:<path>/);
  assert.match(plainOutput(apply), /layers\.simpsonm09-org-ai-plugin\.source in maxstack\.settings\.json/);
}, {});

withWorkspace('a missing override folder is refused with its absolute path and the -Source repair that applies', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  rmSync(checkout, { recursive: true, force: true });
  const apply = runInstaller(shell, ctx, []);
  assert.notEqual(apply.status, 0, 'an apply wrote past a missing override folder');
  assert.match(plainOutput(apply), /has no folder at .*clone the repository|pass -Source simpsonm09-org-ai-plugin=local:<path>/i, plainOutput(apply));
}, {});

withWorkspace('a removal refused for a missing layer folder gives no -Source advice, since -Remove takes no -Source', (ctx) => {
  mustApply(ctx);
  rmSync(ORG_DEFAULT_FOLDER(ctx), { recursive: true, force: true });
  const removed = removal(ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin']);
  assert.notEqual(removed.status, 0, 'a removal rewrote the config without a missing fragment');
  assert.match(plainOutput(removed), /has no folder at .*Restore the folder/i, plainOutput(removed));
  assert.doesNotMatch(plainOutput(removed), /-Source/, plainOutput(removed));
}, {});

// Round 2, J: a pipe that a stopped git's child still holds open is not waited on past the bound.
test('a git output read that never completes returns within its bound, with no output', { skip, timeout: 60000 }, () => {
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $task = [System.Threading.Tasks.TaskCompletionSource[string]]::new().Task; $read = Read-GitPipeBounded -Task $task -Milliseconds 1000; "COMPLETE=$read"`;
  const started = Date.now();
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 50000 });
  assertOk(run);
  assert.ok(Date.now() - started < 40000, 'the read was not bounded');
  assert.ok(run.stdout.includes('COMPLETE=False'), run.stdout);
}, {});

// ---- Round 3: the filter guard. A clean command that the tree's config defines writes a marker file when it runs.
// The fixture runs the command unguarded first, so a marker that is missing after an audit is a result, not a fixture gap.
const touchAndCat = (marker) => `sh -c "touch '${marker.replace(/\\/g, '/')}'; cat"`;

// Finding 1: the name comes from the config key. A clean command whose path has a dot ended the line the old parser read.
withWorkspace('an audit of a -Source local tree runs no clean filter whose command has a dot in it', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'dotted-marker.txt');
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  gitRun(checkout, ['config', 'filter.mark.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  gitRun(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the clean command that .git/config names');
}, {});

// Finding 2: the guard passes its settings in the child's environment, so a name is never split at "=", and a name the
// guard cannot pass makes the tree unreadable, with no filter run. The checkout's clean command writes the marker.
withWorkspace('an audit of a -Source local tree runs no clean filter whose name holds an equals sign', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'equals-marker.txt');
  writeFile(checkout, '.gitattributes', '*.txt filter=a=b\n');
  gitRun(checkout, ['config', 'filter.a=b.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  gitRun(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command whose filter name holds an equals sign');
}, {});

withWorkspace('a filter name with a control character makes its tree unreadable, and no filter in it runs', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const marker = join(ctx.base, 'control-marker.txt');
  writeFile(checkout, '.gitattributes', '*.txt filter=a\x01b\n');
  gitRun(checkout, ['config', 'filter.a\x01b.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  gitRun(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const status = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /simpsonm09-org-ai-plugin: override, local .*unreadable: .*control character/, plainOutput(status));
  assert.equal(existsSync(marker), false, 'a tree with an unpassable filter name was read');
}, {});

// Finding 3: a tree that names more than 100 filter drivers is unreadable, and every run reports it. Nothing throws.
function manyFilters(count) {
  return Array.from({ length: count }, (_, index) => `[filter "f${index}"]\n\tclean = false\n`).join('');
}

withWorkspace('a tree that names more than 100 filter drivers is reported as unreadable by -Status, -Update, and an audit', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  appendFileSync(join(checkout, '.git', 'config'), manyFilters(400));

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /simpsonm09-org-ai-plugin: override, local .*unreadable: too many filter drivers/, plainOutput(status));
  assertOk(runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false }));
  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /unreadable: too many filter drivers/, plainOutput(audit));
}, {});

withWorkspace('a tree that names exactly 100 filter drivers is still read', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  appendFileSync(join(checkout, '.git', 'config'), manyFilters(100));
  // The user's global config may name filters of its own, such as git-lfs, so the count is taken with an empty global config.
  // The guard's budget counts every variable the installer inherits, and a runner's environment is large, so the child gets
  // only what pwsh and git need. The 100 filter settings are then what the budget measures.
  const home = join(ctx.base, 'empty-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '');
  const inherited = ['SystemRoot', 'windir', 'SystemDrive', 'PATH', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'PSModulePath', 'ProgramFiles', 'ProgramData'];
  const minimal = Object.fromEntries(inherited.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const env = { ...minimal, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false, env });
  assertOk(audit);
  assert.doesNotMatch(plainOutput(audit), /unreadable/, plainOutput(audit));
  assert.match(plainOutput(audit), /simpsonm09-org-ai-plugin: override, local .*HEAD [0-9a-f]{40}, clean\)/, plainOutput(audit));
}, {});

// Finding 3: a git failure inside the checkout probe is reported as an unreadable layer. Set-LayerChoice must not throw,
// since a throw there would stop -Status, -Update, and -Remove.
test('a checkout probe that throws is reported as unreadable, and Set-LayerChoice does not throw', { skip }, () => {
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; function Invoke-GitGuarded { throw 'simulated git failure' }; $state = Get-LocalCheckoutState -Root $env:TEMP; "STATE=[$($state.unreadable)]"; $layer = @{ name = 'x'; sourcePath = '.'; root = $null; override = $false }; $choice = [pscustomobject]@{ kind = 'local'; url = $null; ref = $null; commit = $null; path = $env:TEMP; checkout = $env:TEMP; override = $true }; Set-LayerChoice -Layer $layer -Choice $choice; "LAYER=[$($layer.unreadable)]"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /STATE=\[the checkout could not be read: simulated git failure\]/, run.stdout);
  assert.match(run.stdout, /LAYER=\[the checkout could not be read: simulated git failure\]/, run.stdout);
}, {});

// Finding 4: the guard turns off only the filters the tree itself defines: its own config, what its includes add, its per-worktree
// config, and the names its attributes files use. The user's global and system filters run, as they do in any checkout.
function runGit(dir, args, env = process.env) {
  const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { windowsHide: true, cwd: dir, encoding: 'utf8', env });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

// The environment whose HOME holds a .gitconfig with the given settings, which is the user's global config. The installer's git
// children read the global config from HOME, unless the caller sets GIT_CONFIG_GLOBAL to another file. XDG and the system config
// are off, so the only global config is this one.
function homeEnv(home, settings = []) {
  mkdirSync(home, { recursive: true });
  const file = join(home, '.gitconfig');
  writeFileSync(file, '');
  for (const [key, value] of settings) runGit(home, ['config', '-f', file, key, value]);
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
}

// The environment with a user global config that holds one setting. The file is outside the checkout.
function globalGitEnv(ctx, key, value) {
  return homeEnv(join(ctx.base, 'home'), [[key, value]]);
}

// A local checkout with one committed file, and a .gitattributes that names the mark filter on text files.
function markedCheckoutWithCommit(ctx) {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  runGit(checkout, ['init', '-q']);
  runGit(checkout, ['add', '-A']);
  runGit(checkout, ['commit', '-q', '-m', 'layer']);
  return checkout;
}

withWorkspace('a checkout runs the smudge filter that the user global config defines, since the guard turns off only the tree filters', (ctx) => {
  const source = join(ctx.base, 'source');
  writeFile(source, '.gitattributes', '*.txt filter=up\n');
  writeFile(source, 'a.txt', 'hello\n');
  runGit(source, ['init', '-q']);
  runGit(source, ['add', '-A']);
  runGit(source, ['commit', '-q', '-m', 'source']);
  const env = globalGitEnv(ctx, 'filter.up.smudge', 'tr a-z A-Z');
  const target = join(ctx.base, 'target');
  runGit(ctx.base, ['clone', '-q', '--no-checkout', source, target], env);

  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $target = '${target.replace(/\\/g, '/')}'; $run = Invoke-GitGuarded -Dir $target -Arguments @('-C', $target, 'checkout', '--quiet', '-f', 'HEAD'); "CODE=$($run.code)"`;
  const guarded = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment(env) });
  assertOk(guarded);
  assert.match(guarded.stdout, /CODE=0/, guarded.stdout);
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'HELLO\n', 'the guarded checkout did not run the global smudge filter');
}, {});

withWorkspace('an audit turns off a filter that the tree reaches through an include in its own config', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'include-marker.txt');
  const included = join(ctx.base, 'included.cfg');
  runGit(ctx.base, ['config', '-f', included, 'filter.mark.clean', touchAndCat(marker)]);
  runGit(checkout, ['config', 'include.path', included.replace(/\\/g, '/')]);
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the included clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command that an include in the tree config defines');
}, {});

withWorkspace('an audit turns off a filter that the tree defines in its per-worktree config', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'worktree-marker.txt');
  runGit(checkout, ['config', 'extensions.worktreeConfig', 'true']);
  runGit(checkout, ['config', '--worktree', 'filter.mark.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the per-worktree clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command from the per-worktree config');
}, {});

withWorkspace('an audit turns off the filter that .git/info/attributes names when the tree config defines it', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.git/info/attributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'info-marker.txt');
  runGit(checkout, ['config', 'filter.mark.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command named by .git/info/attributes');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command named by .git/info/attributes');
}, {});

withWorkspace('an audit runs no global filter that only the tree attributes name, since the tree defines none', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.gitattributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'global-marker.txt');
  const env = globalGitEnv(ctx, 'filter.mark.clean', touchAndCat(marker));
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt'], env);
  assert.equal(existsSync(marker), true, 'the fixture did not run the global clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false, env });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a global clean command that only the in-tree attributes name');
}, {});

// Finding 1: the guard reads git's UTF-8 output as UTF-8. A filter name or a folder with non-ASCII text is read whole.
// The name rule is tested through .git/info/attributes, which git reads whatever the tree holds.
// Moves a file's mtime a minute ahead, so git cannot take the index's stat as still matching and must read the content.
// Without it a file committed in the same moment reads as unchanged, and whether a filter runs depends on the clock.
function bumpMtime(path) {
  const later = new Date(Date.now() + 60000);
  utimesSync(path, later, later);
}

function infoAttributesCheckout(ctx, { dir = 'org-checkout', attributes, filters, edit = true, env = undefined }) {
  const checkout = join(ctx.base, ...dir.split('/'));
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  runGit(checkout, ['init', '-q']);
  runGit(checkout, ['add', '-A']);
  runGit(checkout, ['commit', '-q', '-m', 'layer']);
  writeFile(checkout, '.git/info/attributes', attributes);
  for (const [name, command] of filters) runGit(checkout, ['config', `filter.${name}.clean`, command]);
  if (edit) {
    // A same-size edit, so git must run the clean filter to see it.
    writeFile(checkout, 'notes.txt', 'two\n');
    runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt'], env);
  }
  bumpMtime(join(checkout, 'notes.txt'));
  return checkout;
}

for (const [label, name] of [['a non-ASCII name', 'é'], ['a CJK name', '日本']]) {
  withWorkspace(`an audit runs no clean filter named by ${label} in .git/info/attributes`, (ctx) => {
    const marker = join(ctx.base, 'utf8-marker.txt');
    const checkout = infoAttributesCheckout(ctx, { attributes: `*.txt filter=${name}\n`, filters: [[name, touchAndCat(marker)]] });
    assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
    rmSync(marker);

    const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
    assertOk(audit);
    assert.equal(existsSync(marker), false, `the audit ran the clean command of the filter named ${name}`);
  }, {});
}

withWorkspace('a checkout under a non-ASCII folder is read as a checkout, with its HEAD and dirty state', (ctx) => {
  const checkout = infoAttributesCheckout(ctx, { dir: '日本語/org-checkout', attributes: '', filters: [] });
  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /override, local .*HEAD [0-9a-f]{40}, uncommitted changes\)/, plainOutput(audit));
}, {});

test('a non-ASCII setting reaches git intact, and a filter name git prints comes back as the same text', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-utf8-'));
  try {
    const tree = join(base, 'tree');
    mkdirSync(tree);
    runGit(tree, ['init', '-q']);
    runGit(tree, ['config', 'filter.é.clean', 'x']);
    runGit(tree, ['config', 'filter.日本.clean', 'x']);
    const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $tree = '${tree.replace(/\\/g, '/')}'; $names = @((Read-TreeFilterNames -Dir $tree).names); $probe = @([pscustomobject]@{ key = 'maxstack.probe'; value = '日本é' }); $run = Invoke-GitProcess -Arguments @('config', '--get', 'maxstack.probe') -Settings $probe; "NAMES has_e=$($names -contains 'é') has_cjk=$($names -contains '日本') count=$($names.Count)"; "ENV code=$($run.code) same=$($run.stdout[0] -ceq '日本é')"`;
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
    assertOk(run);
    assert.match(run.stdout, /NAMES has_e=True has_cjk=True count=2/, run.stdout);
    assert.match(run.stdout, /ENV code=0 same=True/, run.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

// Finding 2: an empty filter name is a name. git accepts filter..clean (a subsection that is empty), so the guard turns it off.
withWorkspace('an audit runs no clean filter whose name is empty, which .git/config names as [filter ""]', (ctx) => {
  const marker = join(ctx.base, 'empty-name-marker.txt');
  const checkout = infoAttributesCheckout(ctx, { attributes: '*.txt filter=\n', filters: [['', touchAndCat(marker)]] });
  assert.equal(existsSync(marker), true, 'the fixture did not run the empty-named clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the clean command of the empty-named filter');
}, {});

test('the driver name of filter..clean is the empty name, and the guard passes it to git', { skip }, () => {
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $name = Get-FilterDriverName 'filter..clean'; "NAME=[$name] IS_NULL=$($null -eq $name)"; $settings = @(Get-GitGuardSettings -FilterNames @($name)) | ForEach-Object { $_.key }; "HAS=$($settings -contains 'filter..clean')"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /NAME=\[\] IS_NULL=False/, run.stdout);
  assert.match(run.stdout, /HAS=True/, run.stdout);
}, {});

// Finding 3: git status spawns a status inside each populated submodule, and that status reads the submodule's own config.
// The superproject's guard names only the superproject's filters, so the local status must not look inside a submodule.
withWorkspace('an audit runs no filter that a populated submodule names in its own config', (ctx) => {
  const source = join(ctx.base, 'sub-source');
  writeFile(source, 'a.txt', 'one\n');
  runGit(source, ['init', '-q']);
  runGit(source, ['add', '-A']);
  runGit(source, ['commit', '-q', '-m', 'sub']);
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  runGit(checkout, ['init', '-q']);
  runGit(checkout, ['add', '-A']);
  runGit(checkout, ['commit', '-q', '-m', 'layer']);
  runGit(checkout, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub']);
  runGit(checkout, ['commit', '-q', '-m', 'add submodule']);
  const sub = join(checkout, 'sub');
  const marker = join(ctx.base, 'submodule-marker.txt');
  runGit(sub, ['config', 'filter.subm.clean', touchAndCat(marker)]);
  writeFile(checkout, '.git/modules/sub/info/attributes', '*.txt filter=subm\n');
  // The checkout is CRLF under core.autocrlf, so the edit keeps the byte length: git must hash the file, not compare sizes.
  const subFile = join(sub, 'a.txt');
  writeFileSync(subFile, readFileSync(subFile, 'utf8').replace('one', 'two'));
  runGit(checkout, ['-c', 'protocol.file.allow=always', 'status', '--porcelain']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the submodule clean command when the status was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command that a populated submodule names in its own config');
}, {});

// Finding 4: a status of a local tree turns off every filter name that any config scope defines, the user's global config
// included, and it reads the tree's own attributes. So a global filter that the tree names runs in neither case, and writes
// nothing into the tree. touchAndCatInTree records its run in the marker and writes a file inside the tree, as git-lfs does.
const touchAndCatInTree = (marker, file) => `sh -c "touch '${marker.replace(/\\/g, '/')}' '${file.replace(/\\/g, '/')}'; cat"`;

withWorkspace('a status runs no global filter that .git/info/attributes names, and writes nothing into the tree', (ctx) => {
  const marker = join(ctx.base, 'global-marker.txt');
  const written = join(ctx.base, 'org-checkout', '.git', 'lfs-written.txt');
  const env = globalGitEnv(ctx, 'filter.lfs.clean', touchAndCatInTree(marker, written));
  const checkout = infoAttributesCheckout(ctx, { attributes: '*.txt filter=lfs\n', filters: [], env });
  assert.equal(existsSync(marker), true, 'the fixture did not run the global clean command when git was not guarded');
  rmSync(marker);
  rmSync(written);
  const before = snapshotTree(checkout);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false, env });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a global clean command that the tree attributes name');
  assert.equal(existsSync(written), false, 'the audit wrote a file into the tree');
  assert.deepEqual(snapshotTree(checkout), before, 'the audit changed the tree');
  assert.match(plainOutput(audit), /HEAD [0-9a-f]{40}, uncommitted changes\)/, plainOutput(audit));
}, {});

withWorkspace('a clean tree whose .git/info/attributes names a global filter reports clean, and runs no filter', (ctx) => {
  const marker = join(ctx.base, 'clean-global-marker.txt');
  const env = globalGitEnv(ctx, 'filter.lfs.clean', touchAndCat(marker));
  const checkout = infoAttributesCheckout(ctx, { attributes: '*.txt filter=lfs\n', filters: [], edit: false, env });

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false, env });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a global clean command on a tree with no change');
  assert.match(plainOutput(audit), /HEAD [0-9a-f]{40}, clean\)/, plainOutput(audit));
}, {});

withWorkspace('a changed file makes a local tree read as uncommitted changes', (ctx) => {
  const checkout = infoAttributesCheckout(ctx, { attributes: '', filters: [] });

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /HEAD [0-9a-f]{40}, uncommitted changes\)/, plainOutput(audit));
}, {});

withWorkspace('an eol=crlf file that is unchanged reads as clean, since the status reads the tree attributes', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, '.gitattributes', '*.ps1 text eol=crlf\n');
  writeFile(checkout, 'tool.ps1', 'one\r\ntwo\r\n');
  runGit(checkout, ['init', '-q']);
  // The system config may set core.autocrlf, which would convert the CRLF file on its own. Off, only the attributes can match it.
  runGit(checkout, ['config', 'core.autocrlf', 'false']);
  runGit(checkout, ['add', '-A']);
  runGit(checkout, ['commit', '-q', '-m', 'layer']);
  bumpMtime(join(checkout, 'tool.ps1'));

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /HEAD [0-9a-f]{40}, clean\)/, plainOutput(audit));
}, {});

// Finding 5: a git command that names no tree runs in a fresh empty folder, so the config of the folder the installer runs in
// does not reach it. That config below rewrites the url of the remote, so a ref lookup must not read the other remote.
function bareRepoWithCommit(base, name, text) {
  const work = join(base, `${name}-work`);
  writeFile(work, 'a.txt', text);
  runGit(work, ['init', '-q', '-b', 'main']);
  runGit(work, ['add', '-A']);
  runGit(work, ['commit', '-q', '-m', text]);
  const bare = join(base, `${name}.git`);
  runGit(base, ['clone', '-q', '--bare', work, bare]);
  return bare;
}

withWorkspace('a ref lookup reads the remote it names, not the one a config in the folder it runs from rewrites it to', (ctx) => {
  const remote = bareRepoWithCommit(ctx.base, 'remote', 'the remote');
  const other = bareRepoWithCommit(ctx.base, 'other', 'the other remote');
  const remoteSha = runGit(remote, ['rev-parse', 'main']);
  const otherSha = runGit(other, ['rev-parse', 'main']);
  const evil = join(ctx.base, 'evil');
  mkdirSync(evil);
  runGit(evil, ['init', '-q']);
  runGit(evil, ['config', `url.${other.replace(/\\/g, '/')}.insteadOf`, remote.replace(/\\/g, '/')]);

  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $ref = Find-GitRefCommit -Url '${remote.replace(/\\/g, '/')}' -Ref 'main'; "REF=$ref"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', cwd: evil, env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, new RegExp(`REF=${remoteSha}`), run.stdout);
  assert.notEqual(otherSha, remoteSha);
  assert.doesNotMatch(run.stdout, new RegExp(otherSha), 'the ref lookup read the remote that the folder config rewrote it to');
}, {});

test('a git command that names no tree runs outside every repository, so the folder it runs from is not read', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-neutral-'));
  try {
    const evil = join(base, 'evil');
    mkdirSync(evil);
    runGit(evil, ['init', '-q']);
    const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $run = Invoke-GitGuarded -Arguments @('rev-parse', '--is-inside-work-tree'); "CODE=$($run.code)"`;
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', cwd: evil, env: testEnvironment() });
    assertOk(run);
    assert.doesNotMatch(run.stdout, /CODE=0/, 'a command that names no tree ran inside the repository of the folder it started from');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

// Finding 6: git takes its repository, its worktree, and its settings from variables the installer inherits. The guard removes
// the variables that name a repository, a config, or a program from each child, and leaves the installer's own environment alone.
function committedRepo(base, name, text) {
  const dir = join(base, name);
  writeFile(dir, 'a.txt', text);
  runGit(dir, ['init', '-q']);
  runGit(dir, ['add', '-A']);
  runGit(dir, ['commit', '-q', '-m', text]);
  return dir;
}

function checkoutStateScript(root) {
  return `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $state = Get-LocalCheckoutState -Root '${root.replace(/\\/g, '/')}'; "COMMIT=$($state.commit) DIRTY=$($state.dirty) UNREADABLE=$($state.unreadable)"`;
}

test('a checkout state reads its own HEAD, not the HEAD of the repository that GIT_DIR names', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-gitdir-'));
  try {
    const mine = committedRepo(base, 'mine', 'mine\n');
    const other = committedRepo(base, 'other', 'other\n');
    const mineSha = runGit(mine, ['rev-parse', 'HEAD']);
    const env = { ...testEnvironment(), GIT_DIR: join(other, '.git') };
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', checkoutStateScript(mine)], { windowsHide: true, encoding: 'utf8', env });
    assertOk(run);
    assert.match(run.stdout, new RegExp(`COMMIT=${mineSha} `), run.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

test('a checkout state reads its own worktree, not the worktree that GIT_WORK_TREE names', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-worktree-'));
  try {
    const mine = committedRepo(base, 'mine', 'mine\n');
    writeFile(mine, 'a.txt', 'changed\n');
    const clean = committedRepo(base, 'clean', 'clean\n');
    const mineSha = runGit(mine, ['rev-parse', 'HEAD']);
    const env = { ...testEnvironment(), GIT_WORK_TREE: clean };
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', checkoutStateScript(mine)], { windowsHide: true, encoding: 'utf8', env });
    assertOk(run);
    assert.match(run.stdout, new RegExp(`COMMIT=${mineSha} DIRTY=True `), run.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

withWorkspace('an audit runs no core.fsmonitor that the installer environment names in GIT_CONFIG_PARAMETERS', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, 'notes.txt', 'two\n');
  const marker = join(ctx.base, 'params-marker.txt');
  const command = `sh -c "touch ${marker.replace(/\\/g, '/')}"`;
  const env = { ...process.env, GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${command}'` };
  runGit(checkout, ['status', '--porcelain'], env);
  assert.equal(existsSync(marker), true, 'the fixture did not run the fsmonitor command that GIT_CONFIG_PARAMETERS names');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false, env });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the fsmonitor command that GIT_CONFIG_PARAMETERS names');
}, {});

test('the child environment loses each inherited git variable that names a repository, config, or program, and keeps the rest', { skip }, () => {
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_EXTERNAL_DIFF',
    'GIT_PAGER', 'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR',
    'GIT_ALLOW_PROTOCOL', 'GIT_PROTOCOL_FROM_USER', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'];
  // The names are set in lower case in a case-insensitive table, the way a Windows child environment holds them.
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $child = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase); foreach ($n in @(${names.map((name) => `'${name}'`).join(',')})) { $child[$n.ToLowerInvariant()] = 'x' }; $child['GIT_CONFIG_NOSYSTEM'] = '1'; Set-GitChildEnvironment -Environment $child -Settings @(); "LEFT=" + (@($child.Keys | Sort-Object) -join ',')`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /LEFT=GCM_INTERACTIVE,GIT_CONFIG_COUNT,GIT_CONFIG_NOSYSTEM,GIT_TERMINAL_PROMPT/, run.stdout);
}, {});

// Round 5, finding 2: GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM are not scrubbed. A user who moved the global config with GIT_CONFIG_GLOBAL
// keeps the credential helper it names, and the guard reads the same file that the status does.
test('the child environment keeps GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM, which name the config git reads', { skip }, () => {
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $child = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase); $child['GIT_CONFIG_GLOBAL'] = 'x'; $child['GIT_CONFIG_SYSTEM'] = 'x'; Set-GitChildEnvironment -Environment $child -Settings @(); "LEFT=" + (@($child.Keys | Sort-Object) -join ',')`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /LEFT=GCM_INTERACTIVE,GIT_CONFIG_COUNT,GIT_CONFIG_GLOBAL,GIT_CONFIG_SYSTEM,GIT_TERMINAL_PROMPT/, run.stdout);
}, {});

// Round 5, finding 3: GIT_ALLOW_PROTOCOL overrides protocol.allow, so a child that inherits it would run a transport the guard refuses.
// This run is not a test run, so the file transport is refused by the guard, and the inherited variable must not allow it.
test('a guarded ls-remote over file transport is refused in a real run, even when the installer environment allows file', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-protocol-'));
  try {
    const remote = bareRepoWithCommit(base, 'remote', 'the remote');
    const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
    delete env.MAXSTACK_TEST_MODE;
    const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $run = Invoke-GitGuarded -Arguments @('ls-remote', '--', 'file:///${remote.replace(/\\/g, '/')}'); "CODE=$($run.code) ERR=$(@($run.stderr) -join ' ')"`;
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env });
    assertOk(run);
    assert.doesNotMatch(run.stdout, /CODE=0 /, 'the guard read a file remote, because GIT_ALLOW_PROTOCOL allowed the transport');
    assert.match(run.stdout, /CODE=128 .*not allowed/, run.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

// Round 5, finding 5: git never prompts for a credential, and runs no askpass program. The guard sets core.askPass to the empty string,
// which overrides the global value, and the child loses GIT_ASKPASS and SSH_ASKPASS. The askpass program writes a marker when it runs.
test('a guarded credential fill runs no askpass program that the global config names', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-askpass-'));
  try {
    const marker = join(base, 'askpass-marker.txt');
    // git runs core.askPass as a program, not through a shell, so the program is a script that writes the marker and answers.
    const askpassScript = join(base, 'askpass.sh');
    writeFileSync(askpassScript, `#!/bin/sh\ntouch '${marker.replace(/\\/g, '/')}'\necho x\n`);
    const env = homeEnv(join(base, 'home'), [['core.askPass', askpassScript.replace(/\\/g, '/')]]);
    const input = 'protocol=https\nhost=example.invalid\n\n';
    // The fixture runs git with prompts on, so the askpass program runs, and a marker that is missing after the guard is a result.
    const fixture = spawnSync('git', ['credential', 'fill'], { windowsHide: true, input, encoding: 'utf8', env: { ...env, GIT_TERMINAL_PROMPT: '1' } });
    assert.equal(existsSync(marker), true, `the fixture did not run the askpass program when git was not guarded: ${fixture.stderr}`);
    rmSync(marker);

    const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $run = Invoke-GitGuarded -Arguments @('credential', 'fill'); "CODE=$($run.code)"`;
    const guarded = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, input, encoding: 'utf8', env: testEnvironment(env) });
    assertOk(guarded);
    assert.equal(existsSync(marker), false, 'the guarded credential fill ran the askpass program that core.askPass names');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

test('a guarded command reads the global config that GIT_CONFIG_GLOBAL names, and its credential helper', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-global-'));
  try {
    const home = join(base, 'home');
    const env = homeEnv(home);
    const relocated = join(base, 'relocated.gitconfig');
    runGit(base, ['config', '-f', relocated, 'credential.helper', 'relocated-helper']);
    const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $run = Invoke-GitGuarded -Arguments @('config', '--get', 'credential.helper'); "CODE=$($run.code) VALUE=$(@($run.stdout) -join ',')"`;
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment({ ...env, GIT_CONFIG_GLOBAL: relocated.replace(/\\/g, '/') }) });
    assertOk(run);
    assert.match(run.stdout, /CODE=0 VALUE=relocated-helper/, run.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

// Finding 7: the older filter fixtures again, with the attribute line in .git/info/attributes, so the name rule is what runs.
withWorkspace('an audit runs no clean filter whose command has a dot in it, when .git/info/attributes names it', (ctx) => {
  const marker = join(ctx.base, 'info-dotted-marker.txt');
  const checkout = infoAttributesCheckout(ctx, { attributes: '*.txt filter=mark\n', filters: [['mark', touchAndCat(marker)]] });
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command with a dot in it, named by .git/info/attributes');
}, {});

withWorkspace('an audit runs no clean filter whose name holds an equals sign, when .git/info/attributes names it', (ctx) => {
  const marker = join(ctx.base, 'info-equals-marker.txt');
  const checkout = infoAttributesCheckout(ctx, { attributes: '*.txt filter=a=b\n', filters: [['a=b', touchAndCat(marker)]] });
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command whose name holds an equals sign, named by .git/info/attributes');
}, {});

withWorkspace('an audit turns off a filter that the tree reaches through an include, when .git/info/attributes names it', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.git/info/attributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'info-include-marker.txt');
  const included = join(ctx.base, 'info-included.cfg');
  runGit(ctx.base, ['config', '-f', included, 'filter.mark.clean', touchAndCat(marker)]);
  runGit(checkout, ['config', 'include.path', included.replace(/\\/g, '/')]);
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the included clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command that an include in the tree config defines');
}, {});

withWorkspace('an audit turns off a filter in the per-worktree config, when .git/info/attributes names it', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  writeFile(checkout, '.git/info/attributes', '*.txt filter=mark\n');
  const marker = join(ctx.base, 'info-worktree-marker.txt');
  runGit(checkout, ['config', 'extensions.worktreeConfig', 'true']);
  runGit(checkout, ['config', '--worktree', 'filter.mark.clean', touchAndCat(marker)]);
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  assert.equal(existsSync(marker), true, 'the fixture did not run the per-worktree clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a clean command from the per-worktree config, named by .git/info/attributes');
}, {});

// Finding 7: the guard turns off core.hooksPath too. A commit the guard runs must not run the hook the tree names.
test('a commit the guard runs runs no hook that the tree names in core.hooksPath', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-hooks-'));
  try {
    const tree = join(base, 'tree');
    mkdirSync(tree);
    runGit(tree, ['init', '-q']);
    const marker = join(base, 'hook-marker.txt');
    const hooks = join(base, 'hooks');
    writeFile(base, 'hooks/pre-commit', `#!/bin/sh\ntouch '${marker.replace(/\\/g, '/')}'\n`);
    runGit(tree, ['config', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
    runGit(tree, ['commit', '-q', '--allow-empty', '-m', 'fixture']);
    assert.equal(existsSync(marker), true, 'the fixture did not run the hook when git was not guarded');
    rmSync(marker);

    const env = { ...testEnvironment(), GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $tree = '${tree.replace(/\\/g, '/')}'; $run = Invoke-GitGuarded -Dir $tree -Arguments @('-C', $tree, 'commit', '-q', '--allow-empty', '-m', 'guarded'); "CODE=$($run.code)"`;
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env });
    assertOk(run);
    assert.match(run.stdout, /CODE=0/, run.stdout);
    assert.equal(existsSync(marker), false, 'the guarded commit ran the hook that core.hooksPath names');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

// Finding 8: a tree whose config git cannot parse is not "not a repository". git stops with a parse error, so it is unreadable.
withWorkspace('a tree whose config git cannot parse is reported unreadable, not as a folder that is not a checkout', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  const broken = join(ctx.base, 'bad.cfg');
  writeFileSync(broken, '[broken\n');
  runGit(checkout, ['config', 'include.path', broken.replace(/\\/g, '/')]);
  const fixture = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf8' });
  assert.notEqual(fixture.status, 0, 'the fixture config parsed, so the tree is not broken');

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /override, local .*unreadable: config cannot be read/, plainOutput(audit));
  assert.doesNotMatch(plainOutput(audit), /org-checkout \(not a git checkout\)/, plainOutput(audit));
  assert.notEqual(runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]).status, 0, 'an apply wrote a layer from a tree whose config it cannot read');
}, {});

// Finding 9: a filter name the guard cannot pass is refused as too long, with the reason, and never read as "not a checkout".
withWorkspace('a filter name of 33000 characters makes its tree unreadable as too long, and the tree is not read as a non-checkout', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  appendFileSync(join(checkout, '.git', 'config'), `[filter "${'a'.repeat(33000)}"]\n\tclean = x\n`);
  const fixture = spawnSync('git', ['-C', checkout, 'status', '--porcelain'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(fixture.status, 0, 'the fixture config does not parse for git, so the case is not the name length');

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /override, local .*unreadable: filter name too long/, plainOutput(audit));
  assert.doesNotMatch(plainOutput(audit), /org-checkout \(not a git checkout\)/, plainOutput(audit));
}, {});

withWorkspace('filter names that together need more environment than git can take make the tree unreadable as too long', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  const lines = Array.from({ length: 100 }, (_, index) => `[filter "n${index}-${'x'.repeat(1000)}"]\n\tclean = x\n`).join('');
  appendFileSync(join(checkout, '.git', 'config'), lines);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /override, local .*unreadable: filter name too long/, plainOutput(audit));
  assert.doesNotMatch(plainOutput(audit), /org-checkout \(not a git checkout\)/, plainOutput(audit));
}, {});

test('a cut-off read of the tree config is unreadable, not a list with no filter names', { skip }, () => {
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; function Invoke-GitProcess { param($Arguments, $Settings, $TimeoutSeconds = 0, $WorkingDirectory = '', $CeilingDirectory = '') [pscustomobject]@{ unreadable = $null; timedOut = $false; code = 0; text = ''; stdout = @(); stderr = @(); incomplete = (@($Arguments) -contains 'config') } }; $info = Read-TreeFilterNames -Dir 'C:/nowhere'; "FAULT=[$($info.fault)]"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /FAULT=\[.*cut off/, run.stdout);
}, {});

// Finding 10: core.fsmonitor is off with the empty string, which git reads as no monitor on every version. On git 2.31 to 2.35
// "false" is read as a path, so the value that means off is the empty string.
test('the guard turns core.fsmonitor off with the empty string, which no git version reads as a path', { skip }, () => {
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $setting = Get-GitGuardSettings | Where-Object { $_.key -eq 'core.fsmonitor' }; "FSM=[$($setting.value)] COUNT=$(@(Get-GitGuardSettings | Where-Object { $_.key -eq 'core.fsmonitor' }).Count)"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /FSM=\[\] COUNT=1/, run.stdout);
}, {});

// Finding 11: the eol attributes that the status now reads must not hide a real change. A changed eol=crlf file is dirty.
withWorkspace('a changed eol=crlf file reads as uncommitted changes, so the tree attributes do not hide an edit', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, '.gitattributes', '*.ps1 text eol=crlf\n');
  writeFile(checkout, 'tool.ps1', 'one\r\ntwo\r\n');
  runGit(checkout, ['init', '-q']);
  runGit(checkout, ['config', 'core.autocrlf', 'false']);
  runGit(checkout, ['add', '-A']);
  runGit(checkout, ['commit', '-q', '-m', 'layer']);
  writeFile(checkout, 'tool.ps1', 'one\r\nthree\r\n');
  bumpMtime(join(checkout, 'tool.ps1'));

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /HEAD [0-9a-f]{40}, uncommitted changes\)/, plainOutput(audit));
}, {});

// A SHA-256 repository reads its HEAD and its dirty state like a SHA-1 one: the status names no SHA-1 object.
withWorkspace('a SHA-256 checkout reads its HEAD and dirty state', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  runGit(checkout, ['init', '-q', '--object-format=sha256']);
  runGit(checkout, ['add', '-A']);
  runGit(checkout, ['commit', '-q', '-m', 'layer']);
  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /override, local .*HEAD [0-9a-f]{64}, clean\)/, plainOutput(audit));
}, {});

// Finding 10: git that exits 0 while a grandchild holds its output open gives an incomplete read. That is a cut-off output,
// not a result, so the ref lookup says so instead of "no branch or tag named".
test('a ref lookup whose git output was cut off says so, and does not report a missing ref', { skip }, () => {
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; function Invoke-GitGuarded { [pscustomobject]@{ unreadable = $null; timedOut = $false; code = 0; text = ''; stdout = @(); stderr = @(); incomplete = $true } }; try { Find-GitRefCommit -Url 'https://example.com/team/layer.git' -Ref 'main' } catch { "ERR=$($_.Exception.Message)" }`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /ERR=.*git output was cut off/, run.stdout);
  assert.doesNotMatch(run.stdout, /no branch or tag named/, run.stdout);
}, {});

// ---- Round 5, finding 1: git's output is read as bytes and decoded strictly. A filter name that is not valid UTF-8 cannot be
// written as a string, so the config and attribute bytes are written as a Buffer. The guard must refuse that tree, since a name it
// cannot read back exactly is a filter it cannot turn off.
const INVALID_NAME = Buffer.from([0xff]);

// A [filter] section whose subsection name is the given bytes, with a clean command. The value is quoted as a whole, since an
// unquoted ";" starts a comment, and its quotes and backslashes are escaped, so git reads the command that is given.
function rawFilterSection(nameBytes, command) {
  const value = `"${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return Buffer.concat([Buffer.from('[filter "'), nameBytes, Buffer.from(`"]\n\tclean = ${value}\n`)]);
}

// A local checkout whose .git/config defines a filter by raw name bytes, and whose attributes name it in the file given. A committed
// .gitattributes is committed before the filter is defined. A same-size edit makes git run the clean command when it reads the file.
function rawNameCheckout(ctx, { attributesFile, attributes, nameBytes, command }) {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  runGit(checkout, ['init', '-q']);
  writeFile(checkout, 'notes.txt', 'one\n');
  writeFile(checkout, attributesFile, attributes);
  runGit(checkout, ['add', '-A']);
  runGit(checkout, ['commit', '-q', '-m', 'layer']);
  appendFileSync(join(checkout, '.git', 'config'), rawFilterSection(nameBytes, command));
  writeFile(checkout, 'notes.txt', 'two\n');
  runGit(checkout, ['hash-object', '--path=notes.txt', 'notes.txt']);
  bumpMtime(join(checkout, 'notes.txt'));
  return checkout;
}

// The attribute line "<prefix>filter=<invalid byte>", as bytes.
const invalidAttributes = (prefix) => Buffer.concat([Buffer.from(`${prefix}filter=`), INVALID_NAME, Buffer.from('\n')]);

withWorkspace('an audit turns off no filter whose name is not valid UTF-8 in .git/info/attributes, and reports the tree unreadable', (ctx) => {
  const marker = join(ctx.base, 'invalid-name-info-marker.txt');
  const checkout = rawNameCheckout(ctx, { attributesFile: '.git/info/attributes', attributes: invalidAttributes('*.txt '), nameBytes: INVALID_NAME, command: touchAndCat(marker) });
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the clean command of a filter whose name is not valid UTF-8');
  assert.match(plainOutput(audit), /override, local .*unreadable: a filter driver name is not valid UTF-8/, plainOutput(audit));

  const apply = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  assert.notEqual(apply.status, 0, 'an apply wrote a layer from a tree with a filter name that is not valid UTF-8');
  assert.match(plainOutput(apply), /cannot be read at .*: a filter driver name is not valid UTF-8/, plainOutput(apply));
  assert.equal(existsSync(marker), false, 'the apply ran the clean command of a filter whose name is not valid UTF-8');
}, {});

withWorkspace('an audit turns off no filter whose name is not valid UTF-8 in a committed .gitattributes, and reports the tree unreadable', (ctx) => {
  const marker = join(ctx.base, 'invalid-name-tracked-marker.txt');
  const checkout = rawNameCheckout(ctx, { attributesFile: '.gitattributes', attributes: invalidAttributes('*.txt '), nameBytes: INVALID_NAME, command: touchAndCat(marker) });
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the clean command of a filter named by a committed .gitattributes');
  assert.match(plainOutput(audit), /override, local .*unreadable: a filter driver name is not valid UTF-8/, plainOutput(audit));
}, {});

test('a checkout state whose filter name is not valid UTF-8 is unreadable, with no commit, and runs no filter', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-invalid-name-'));
  try {
    const marker = join(base, 'state-marker.txt');
    const checkout = join(base, 'tree');
    mkdirSync(checkout);
    runGit(checkout, ['init', '-q']);
    writeFile(checkout, 'notes.txt', 'one\n');
    writeFile(checkout, '.gitattributes', invalidAttributes('*.txt '));
    runGit(checkout, ['add', '-A']);
    runGit(checkout, ['commit', '-q', '-m', 'tree']);
    appendFileSync(join(checkout, '.git', 'config'), rawFilterSection(INVALID_NAME, touchAndCat(marker)));
    writeFile(checkout, 'notes.txt', 'two\n');
    bumpMtime(join(checkout, 'notes.txt'));

    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', checkoutStateScript(checkout)], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
    assertOk(run);
    assert.match(run.stdout, /COMMIT= DIRTY= UNREADABLE=a filter driver name is not valid UTF-8/, run.stdout);
    assert.equal(existsSync(marker), false, 'the checkout state ran the clean command of a filter whose name is not valid UTF-8');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

withWorkspace('a global filter name that is not valid UTF-8 makes a local status report the tree unreadable, and runs no filter', (ctx) => {
  const home = join(ctx.base, 'home');
  const env = homeEnv(home);
  const marker = join(ctx.base, 'global-invalid-marker.txt');
  appendFileSync(join(home, '.gitconfig'), rawFilterSection(INVALID_NAME, touchAndCat(marker)));
  const checkout = markedCheckoutWithCommit(ctx);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false, env });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran a global clean command whose name is not valid UTF-8');
  assert.match(plainOutput(audit), /override, local .*unreadable: a filter driver name is not valid UTF-8/, plainOutput(audit));
}, {});

// A name that is valid UTF-8 is disabled whatever its script: an astral-plane character is one name, two UTF-16 units in .NET.
withWorkspace('an audit runs no clean filter named by an astral-plane name in .git/info/attributes', (ctx) => {
  const marker = join(ctx.base, 'utf8-astral-marker.txt');
  const name = '\u{1F600}';
  const checkout = infoAttributesCheckout(ctx, { attributes: `*.txt filter=${name}\n`, filters: [[name, touchAndCat(marker)]] });
  assert.equal(existsSync(marker), true, 'the fixture did not run the clean command when git was not guarded');
  rmSync(marker);

  const audit = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`], { apply: false });
  assertOk(audit);
  assert.equal(existsSync(marker), false, 'the audit ran the clean command of the astral-plane filter');
}, {});

// A ref name is read strictly too: a name that is not valid UTF-8 is an error that says so, never a name with U+FFFD in it.
test('a ref lookup whose ref name is not valid UTF-8 fails with that reason, and reads no ref with a replaced name', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-invalid-ref-'));
  try {
    const remote = bareRepoWithCommit(base, 'remote', 'the remote');
    const sha = runGit(remote, ['rev-parse', 'main']);
    appendFileSync(join(remote, 'packed-refs'), Buffer.concat([Buffer.from(`${sha} refs/heads/`), INVALID_NAME, Buffer.from('\n')]));
    const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; try { $ref = Find-GitRefCommit -Url '${remote.replace(/\\/g, '/')}' -Ref 'main'; "REF=$ref" } catch { "ERR=$($_.Exception.Message)" }`;
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
    assertOk(run);
    assert.match(run.stdout, /ERR=.*git output is not valid UTF-8/, run.stdout);
    assert.doesNotMatch(run.stdout, /REF=/, run.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, {});

// Round 5, finding 4a: git refuses a folder that another user owns. The reason names that, and the apply names the fix for it, not
// the tree's config. GIT_TEST_ASSUME_DIFFERENT_OWNER makes git see a different owner on every folder.
withWorkspace('a folder git refuses as owned by another user is unreadable for that reason, and an apply names the fix for it', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  writeFile(checkout, 'notes.txt', 'one\n');
  runGit(checkout, ['init', '-q']);
  runGit(checkout, ['add', '-A']);
  runGit(checkout, ['commit', '-q', '-m', 'layer']);
  // An empty global and system config, so a safe.directory of the runner's cannot allow the folder. The guard keeps GIT_CONFIG_GLOBAL
  // but drops GIT_CONFIG_COUNT, so a reset through the count would not reach the guarded git calls.
  const emptyConfig = join(ctx.base, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  const env = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const source = ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`];

  const audit = runInstaller(shell, ctx, source, { apply: false, env });
  assertOk(audit);
  assert.match(plainOutput(audit), /override, local .*unreadable: git refused the folder: it is owned by another user; add it to safe\.directory or fix its ownership/, plainOutput(audit));
  assert.doesNotMatch(plainOutput(audit), /config cannot be read/, plainOutput(audit));

  const apply = runInstaller(shell, ctx, source, { env });
  assert.notEqual(apply.status, 0, 'an apply wrote a layer from a folder git refused');
  assert.match(plainOutput(apply), /cannot be read at .*: git refused the folder: it is owned by another user; add it to safe\.directory or fix its ownership/, plainOutput(apply));
  assert.doesNotMatch(plainOutput(apply), /Fix the tree's git config/, plainOutput(apply));
}, {});

// Round 5, finding 4b: a global config that git cannot parse makes the guard's probe fail. git is new enough, so the reason is git's own
// message, and the apply names the config, not a git that is too old.
withWorkspace('a global config that git cannot parse is named with git\'s message, not as a git that is too old', (ctx) => {
  const checkout = markedCheckoutWithCommit(ctx);
  const home = join(ctx.base, 'home');
  const env = homeEnv(home);
  appendFileSync(join(home, '.gitconfig'), '[broken\n');
  const fixture = spawnSync('git', ['config', '--get', 'user.name'], { windowsHide: true, encoding: 'utf8', env, cwd: checkout });
  assert.notEqual(fixture.status, 0, 'the fixture global config parsed, so git reads it');
  const source = ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`];

  const audit = runInstaller(shell, ctx, source, { apply: false, env });
  assertOk(audit);
  assert.match(plainOutput(audit), /unreadable: git could not read its configuration, so the filter guard cannot be passed: .*bad config/, plainOutput(audit));
  assert.doesNotMatch(plainOutput(audit), /git 2\.31 or later is needed/, plainOutput(audit));

  const apply = runInstaller(shell, ctx, source, { env });
  assert.notEqual(apply.status, 0, 'an apply wrote a layer while git could not read its config');
  assert.match(plainOutput(apply), /cannot be read at .*: git could not read its configuration.*Fix the config file that the reason names/, plainOutput(apply));
}, {});

// Round 5, finding 4b: a git older than 2.31 is named as too old, and a git that cannot run is named with its reason.
test('a git that is too old is named as too old, a git that is new enough gives its own config error, and a git that cannot start says so', { skip }, () => {
  // A git older than 2.31 ignores the settings, so its probe is silent. A git whose config cannot be parsed prints git's error.
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; function Get-GitVersion { [version] '2.30' }; $old = Get-GitEnvConfigFault ([pscustomobject]@{ code = 1; stderr = @() }); "OLD=$old"; function Get-GitVersion { [version] '2.55' }; $new = Get-GitEnvConfigFault ([pscustomobject]@{ code = 128; stderr = @('fatal: bad config line 1') }); "NEW=$new"; $silent = Get-GitEnvConfigFault ([pscustomobject]@{ code = 1; stderr = @() }); "SILENT=$silent"; function Get-GitVersion { $null }; $absent = Get-GitEnvConfigFault ([pscustomobject]@{ code = $null; stderr = @('git could not start: no such file') }); "ABSENT=$absent"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /OLD=git 2\.31 or later is needed, so the filter guard cannot be passed/, run.stdout);
  assert.match(run.stdout, /NEW=git could not read its configuration, so the filter guard cannot be passed: fatal: bad config line 1/, run.stdout);
  assert.match(run.stdout, /SILENT=git did not read the guard settings, so the filter guard cannot be passed/, run.stdout);
  assert.match(run.stdout, /ABSENT=git 2\.31 or later is needed, so the filter guard cannot be passed: git could not start: no such file/, run.stdout);
}, {});

withWorkspace('workspace discovery rejects control characters before path APIs and escapes them in errors', (ctx) => {
  const esc = String.fromCharCode(27);
  const del = String.fromCharCode(127);
  const unsafe = `bad${esc}[31m`;
  const cases = [
    { kind: 'explicit', path: unsafe, safe: 'bad\\u001B[31m' },
    { kind: 'environment', path: unsafe, safe: 'bad\\u001B[31m', scriptRoot: join(ctx.base, 'unrecognized') },
    { kind: 'scriptRoot', path: unsafe, safe: 'bad\\u001B[31m' },
  ];
  for (const item of cases) {
    const run = runWorkspaceDiscovery(ctx, item);
    assert.equal(run.status, 2, `${item.kind}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /path contains control characters/i);
    assert.ok(run.stdout.includes(item.safe), `${item.kind} did not escape the control character: ${run.stdout}`);
    assert.equal(run.stdout.includes(esc), false, `${item.kind} echoed the raw ESC byte`);
    assert.doesNotMatch(run.stdout, /Illegal characters|invalid path syntax|parameter is incorrect/i);
  }
}, {});

withWorkspace('workspace discovery refuses without a source and safely reports a missing current directory', (ctx) => {
  const noWorkspace = runWorkspaceDiscovery(ctx, { kind: 'noWorkspace', path: ctx.base, scriptRoot: join(ctx.base, 'unrecognized') });
  assert.equal(noWorkspace.status, 2, `${noWorkspace.stdout}${noWorkspace.stderr}`);
  assert.match(noWorkspace.stdout, /Workspace discovery failed.*-Workspace.*MAXSTACK_WORKSPACE.*cwd marker.*script layout/);

  const missing = join(ctx.base, 'missing-current-directory');
  const invalid = runWorkspaceDiscovery(ctx, { kind: 'currentDirectory', path: missing, scriptRoot: join(ctx.base, 'unrecognized') }, { launchCwd: ctx.base });
  assert.equal(invalid.status, 2, `${invalid.stdout}${invalid.stderr}`);
  assert.match(invalid.stdout, /Workspace discovery failed/);
  assert.doesNotMatch(invalid.stdout, /Cannot find path|Cannot bind argument|Exception calling "GetFullPath"|missing-current-directory/);
}, {});

withWorkspace('an unusable current directory holds no marker and is never echoed into an error', (ctx) => {
  const esc = String.fromCharCode(27);
  const run = runWorkspaceDiscovery(ctx, { kind: 'currentDirectory', path: `bad${esc}[31m`, scriptRoot: join(ctx.base, 'unrecognized') });
  assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /Workspace discovery failed/);
  assert.equal(run.stdout.includes(esc), false, 'the raw ESC byte reached the output');
}, {});

withWorkspace('finding F11: missing workspace source refuses before command validation and writes nothing', (ctx) => {
  const copyRoot = join(ctx.base, 'isolated-copy');
  const copyScripts = join(copyRoot, 'scripts');
  mkdirSync(copyScripts, { recursive: true });
  cpSync(installer, join(copyScripts, 'Install-Workspace.ps1'));
  cpSync(join(repoRoot, 'scripts', 'Install-WorkspaceDiscovery.ps1'), join(copyScripts, 'Install-WorkspaceDiscovery.ps1'));
  cpSync(join(repoRoot, 'scripts', 'Install-Ordinal.ps1'), join(copyScripts, 'Install-Ordinal.ps1'));
  const before = snapshotTree(ctx.base);

  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'MAXSTACK_WORKSPACE') delete env[key];
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', join(copyScripts, 'Install-Workspace.ps1'), '-Apply', '-Status'], {
    windowsHide: true,
    encoding: 'utf8',
    cwd: ctx.base,
    env,
  });
  assert.notEqual(run.status, 0, 'a run without a workspace source was accepted');
  assert.match(`${run.stdout}\n${run.stderr}`, /Workspace discovery failed.*-Workspace.*MAXSTACK_WORKSPACE.*cwd marker.*script layout/is);
  assert.deepEqual(snapshotTree(ctx.base), before, 'the rejected command wrote into the workspace');
}, {});

// N6: a read-only audit names a valid declared source, and an unavailable one is not listed as an override in the pin block.
withWorkspace('item N6: an audit names a valid declared source, and an unavailable one is listed as skipped, not as an override', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'example/fixture@main' } } });
  const valid = runInstaller(shell, ctx, [], { apply: false });
  assertOk(valid, plainOutput(valid));
  assert.match(plainOutput(valid), /layers\.pstack\.source is declared; a read-only run uses the recorded source/, plainOutput(valid));
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:nope' } } });
  const unavailable = runInstaller(shell, ctx, [], { apply: false });
  assertOk(unavailable, plainOutput(unavailable));
  assert.doesNotMatch(plainOutput(unavailable), /pstack: override, local .*nope/, 'the skipped layer is listed as an override in use');
  assert.match(plainOutput(unavailable), /pstack: declared source skipped/, plainOutput(unavailable));
}, {});
