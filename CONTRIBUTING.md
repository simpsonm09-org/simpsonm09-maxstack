# Contributing

## Branches

- `main` is the integration branch. It is protected.
- Everything else is a feature branch that opens a pull request into `main`.

## Pull requests

- Open the pull request against `main`.
- Required checks are the lint, aislop, security, and standard jobs, plus any test job the repository adds. Keep them green.
- Merge, squash, and rebase are all allowed. Delete the branch after merge.

## Commits

Commits on a branch must be signed. The standard requires signed commits on `main`. Configure an SSH signing key and set `commit.gpgsign`, `gpg.format=ssh`, and `user.signingkey`.

## Scope

Keep changes inside the repository's purpose. Do not commit secrets or machine-specific paths. The [`repo-standard` governance doc](https://github.com/simpsonm09-org/simpsonm09-repo-standard/blob/main/docs/governance.md) defines the branch model and the protection rules.
