# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately through GitHub's security advisory form on this repository. Do not open a public issue for a security report.

## What is scanned

- Trivy scans the filesystem for vulnerable dependencies, hardcoded secrets, and misconfiguration.
- A dedicated secret scanner scans the full git history for credentials.
- aislop flags risky patterns alongside AI-slop findings.
- Dependabot keeps action and dependency pins current.

## Secrets

No secret is committed to this repository or to the repositories it governs. Configuration references secrets by environment variable name, and the value comes from the secrets manager. See the `dev-setup-starter` repository for the secrets manager setup.
