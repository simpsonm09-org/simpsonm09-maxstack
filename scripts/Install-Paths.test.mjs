import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? 'pwsh' : null;

test('platform path helpers cover roots, separators, containment, and case rules', { skip: !shell }, () => {
  const helper = join(root, 'scripts', 'Install-Paths.ps1').replaceAll("'", "''");
  const ordinal = join(root, 'scripts', 'Install-Ordinal.ps1').replaceAll("'", "''");
  const script = `. '${ordinal}'; . '${helper}'; $cases = @(
    @{ name = 'Windows drive paths are absolute'; passed = (Test-MaxstackAbsolutePath 'C:\\work\\repo' Windows) },
    @{ name = 'Windows UNC paths are absolute'; passed = (Test-MaxstackAbsolutePath '\\\\server\\share\\repo' Windows) },
    @{ name = 'POSIX paths are absolute for macOS'; passed = (Test-MaxstackAbsolutePath '/Users/name/dev/x' macOS) },
    @{ name = 'relative POSIX paths are not absolute'; passed = (-not (Test-MaxstackAbsolutePath 'relative/path' macOS)) },
    @{ name = 'Windows separators normalize'; passed = ((ConvertTo-MaxstackPath 'C:/work\\repo/' Windows) -ceq 'C:\\work\\repo\\') },
    @{ name = 'macOS separators remain POSIX'; passed = ((ConvertTo-MaxstackPath '/Users/name/dev/x/' macOS) -ceq '/Users/name/dev/x/') },
    @{ name = 'Windows joins normalize child separators'; passed = ((Join-MaxstackPath 'C:\\work' 'repo/mixed' Windows) -ceq 'C:\\work\\repo\\mixed') },
    @{ name = 'macOS joins preserve literal backslashes'; passed = ((Join-MaxstackPath '/work' 'repo\\literal' macOS) -ceq '/work/repo\\literal') },
    @{ name = 'Windows relative paths use lock separators'; passed = ((Get-MaxstackRelativePath 'C:\\work\\repo' 'C:\\work\\repo\\child\\file' Windows) -ceq 'child/file') },
    @{ name = 'macOS relative paths are case-sensitive'; passed = ((Get-MaxstackRelativePath '/work/Name' '/work/name/child' macOS) -ceq '../name/child') },
    @{ name = 'Windows lock paths use POSIX separators'; passed = ((ConvertTo-MaxstackLockPath 'C:\\work\\repo\\x' Windows) -ceq 'C:/work/repo/x') },
    @{ name = 'macOS containment includes descendants'; passed = (Test-MaxstackPathInside '/a/b/c/' '/a/b/' macOS) },
    @{ name = 'macOS containment rejects matching prefixes'; passed = (-not (Test-MaxstackPathInside '/a/bc' '/a/b' macOS)) },
    @{ name = 'Windows containment rejects matching prefixes'; passed = (-not (Test-MaxstackPathInside 'C:\\a\\bc' 'C:\\a\\b' Windows)) },
    @{ name = 'Windows containment includes descendants'; passed = (Test-MaxstackPathInside 'C:\\a\\b\\c' 'C:\\a\\b\\' Windows) },
    @{ name = 'Windows path equality ignores case'; passed = (Test-MaxstackPathEqual 'C:\\A\\b' 'c:\\a\\B' Windows) },
    @{ name = 'macOS path equality preserves case'; passed = (-not (Test-MaxstackPathEqual '/A/b' '/a/b' macOS)) },
    @{ name = 'Linux path equality matches identical paths'; passed = (Test-MaxstackPathEqual '/a/b' '/a/b' Linux) }
  ); $failed = @($cases | Where-Object { -not $_.passed }); if ($failed.Count) { throw ('path helper cases failed: ' + (($failed | ForEach-Object { $_.name }) -join ', ')) }`;
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('OpenCode permissions use POSIX workspace paths and omit WSL resources', { skip: !shell }, () => {
  const helper = join(root, 'scripts', 'Install-Paths.ps1').replaceAll("'", "''");
  const ordinal = join(root, 'scripts', 'Install-Ordinal.ps1').replaceAll("'", "''");
  const script = `. '${ordinal}'; . '${helper}'; $permissions = @([pscustomobject]@{resource='__MAXSTACK_WORKSPACE__/.opencode/*'}, [pscustomobject]@{resource='__MAXSTACK_WORKSPACE_WSL__/.opencode/*'}); $result = @(Resolve-MaxstackOpenCodePermissions -Permissions $permissions -Workspace '/Users/name/dev/workspace' -Platform 'macOS'); if ($result.Count -ne 1 -or $result[0].resource -cne '/Users/name/dev/workspace/.opencode/*') { throw 'POSIX OpenCode permission rendering was incorrect' }; $windowsPermissions = @([pscustomobject]@{resource='__MAXSTACK_WORKSPACE__/.opencode/*'}, [pscustomobject]@{resource='__MAXSTACK_WORKSPACE_WSL__/.opencode/*'}); $windows = @(Resolve-MaxstackOpenCodePermissions -Permissions $windowsPermissions -Workspace 'C:\\Users\\name\\workspace' -Platform 'Windows'); if ($windows.Count -ne 2 -or $windows[1].resource -cne '/mnt/c/Users/name/workspace/.opencode/*') { throw 'Windows OpenCode permission rendering changed' }`;
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
