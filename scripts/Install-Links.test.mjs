import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? 'pwsh' : null;

function runPowerShell(script) {
  return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
}

test('link helpers keep the platform record kind injectable', { skip: !shell }, () => {
  const ordinal = join(root, 'scripts', 'Install-Ordinal.ps1').replaceAll("'", "''");
  const paths = join(root, 'scripts', 'Install-Paths.ps1').replaceAll("'", "''");
  const links = join(root, 'scripts', 'Install-Links.ps1').replaceAll("'", "''");
  const script = `. '${ordinal}'; . '${paths}'; . '${links}'; if ((Get-MaxstackLinkRecordKind Windows) -cne 'junction') { throw 'Windows must keep the junction record kind' }; if ((Get-MaxstackLinkRecordKind macOS) -cne 'symlink') { throw 'macOS must record symbolic links' }; if (-not (Test-MaxstackLinkRecordKind 'junction') -or -not (Test-MaxstackLinkRecordKind 'symlink')) { throw 'a legacy or current link kind was rejected' }`;
  const result = runPowerShell(script);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('link helpers create, detect, read, compare, and remove a host directory link without changing its target', { skip: !shell }, () => {
  const ordinal = join(root, 'scripts', 'Install-Ordinal.ps1').replaceAll("'", "''");
  const paths = join(root, 'scripts', 'Install-Paths.ps1').replaceAll("'", "''");
  const links = join(root, 'scripts', 'Install-Links.ps1').replaceAll("'", "''");
  const script = `. '${ordinal}'; . '${paths}'; . '${links}'; $base = [IO.Path]::Combine([IO.Path]::GetTempPath(), [guid]::NewGuid().ToString('N')); $target = Join-MaxstackPath $base 'target'; $link = Join-MaxstackPath $base 'link'; [IO.Directory]::CreateDirectory($target) | Out-Null; [IO.File]::WriteAllText((Join-MaxstackPath $target 'keep.txt'), 'target bytes'); try { New-MaxstackDirectoryLink -Path $link -Target $target; if (-not (Test-MaxstackLink $link)) { throw 'the link was not detected' }; if (-not (Test-MaxstackLinkTarget -Path $link -Target $target)) { throw 'the target did not match' }; if (Test-MaxstackLinkTarget -Path $link -Target (Join-MaxstackPath $base 'other')) { throw 'an incorrect target matched' }; $kind = Get-MaxstackLinkKind $link; if ($kind -cne (Get-MaxstackLinkRecordKind)) { throw ('wrong link kind: ' + $kind) }; if (-not (Get-MaxstackLinkTarget $link)) { throw 'the target was not readable' }; Remove-MaxstackLink $link; if (Test-MaxstackLink $link) { throw 'the link remained after removal' }; if ([IO.File]::ReadAllText((Join-MaxstackPath $target 'keep.txt')) -cne 'target bytes') { throw 'removal changed the target' } } finally { if ([IO.Directory]::Exists($base)) { [IO.Directory]::Delete($base, $true) } }`;
  const result = runPowerShell(script);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('symbolic link policy creates and removes a symlink when the host permits it', { skip: !shell }, (t) => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-symlink-policy-'));
  const target = join(base, 'target');
  const link = join(base, 'link');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'target bytes');
  try {
    const ordinal = join(root, 'scripts', 'Install-Ordinal.ps1').replaceAll("'", "''");
    const paths = join(root, 'scripts', 'Install-Paths.ps1').replaceAll("'", "''");
    const links = join(root, 'scripts', 'Install-Links.ps1').replaceAll("'", "''");
    const psBase = base.replaceAll("'", "''");
    const script = `. '${ordinal}'; . '${paths}'; . '${links}'; $base = '${psBase}'; New-MaxstackDirectoryLink -Path (Join-MaxstackPath $base 'link') -Target (Join-MaxstackPath $base 'target') -Platform 'macOS'; if ((Get-MaxstackLinkKind (Join-MaxstackPath $base 'link') 'macOS') -cne 'symlink') { throw 'the symbolic link was not detected' }; if (-not (Test-MaxstackLinkTarget -Path (Join-MaxstackPath $base 'link') -Target (Join-MaxstackPath $base 'target') -Platform 'macOS')) { throw 'the symbolic link target did not match' }; Remove-MaxstackLink -Path (Join-MaxstackPath $base 'link') -Platform 'macOS'`;
    const result = runPowerShell(script);
    const output = `${result.stderr}\n${result.stdout}`;
    if (result.status !== 0 && process.platform === 'win32' && /Administrator privilege required|privilege is unavailable/i.test(output)) {
      t.skip(`Windows symbolic-link privilege unavailable: ${output.trim()}`);
      return;
    }
    assert.equal(result.status, 0, output);
    assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined, 'the symbolic link was not removed');
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'target bytes', 'symbolic-link removal changed its target');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
