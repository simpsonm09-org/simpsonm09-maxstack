# Local task runner. Recipes mirror .github/workflows/ci.yml and the
# repo-standard local-run commands.
set windows-shell := ["pwsh", "-NoLogo", "-Command"]

python := if os_family() == "windows" { "python" } else { "python3" }

default:
    @just --list

# Run every linter over changed files.
lint:
    mise exec -- flint run

# Run every linter over every tracked file.
lint-full:
    mise exec -- flint run --full

# Auto-fix lint issues.
lint-fix:
    mise exec -- flint run --fix

# Run the aislop score gate at the version CI pins.
aislop:
    npx --yes aislop@0.16.1 ci

# Scan the filesystem with Trivy.
security:
    trivy fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL .

# Validate the workspace manifests the installer consumes.
validate:
    {{python}} scripts/verify-manifests.py

# Validate the manifests and check the Claude pin against GitHub. Needs gh and network.
validate-online:
    {{python}} scripts/verify-manifests.py --online

# Run the same checks CI runs.
check: lint validate

# Check that the agent tool set covers the service owners. Workspace-local: it
# reads the dev-setup-starter and org plugin checkouts, which CI does not have.
check-agent-tools:
    node scripts/check-agent-tools.mjs

# Run the Biome complexity gate over the repository.
complexity:
    mise exec -- biome lint .

# Prune remote-tracking refs and delete local branches merged into main.
prune:
    node scripts/prune.mjs