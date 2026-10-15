# Current delivery state

This page tracks maxstack against the end goal: a person starts in T3 or directly in a supported provider harness, then gets the PStack, organization, and personal layers through supported providers and harnesses. T3 dispatch is an additional way to use those providers. The same layers need to install in any workspace, while the fleet follows the shared standard. It separates recorded results from live acceptance work.

## What is delivered

- PR #49 in `org-ai-plugin` merged as `ff6995162f4eb36fdb49a0e2748947d9e51afbf8`; its explicit Git pin is deployed. Strict status reports 96 matching entries and no drift. The immutable standard resolver remains at `5da…` (`82e785…`); it does not import the mutable development resolver.
- The direct Claude copy-layout fix is merged and installed. Fresh OpenCode resolved three layers. Pi is updated to 1.3.0, and its stub harness passed all 12 checks before and after the update. This does not establish real-model T3 parity.
- PR #77 added the macOS Copilot runtime and CI job. It merged as `57717445a32b01675e93ee0c168fabd8a4699b0b`.
- PR #78 added explicit T3 settings snapshots and drift reports. It merged as `670b220c9881dcb7b19f46b6cd695dbd3e09cd49`. The handoff records all 17 checks green for the merged head.
- The snapshot reads only `-T3Settings` or `MAXSTACK_T3_SETTINGS`. It writes an allowlisted snapshot, excludes models, and skips source access when `t3.snapshot` is false. New T3 defaults are report-only.
- A real workspace apply and strict status at `670b220` completed with 95 matching entries, including files and directories, and no drift, modifications, missing, untracked, or unselected entries. This is the recorded PR #78 baseline; the later strict status above reports 96 entries. The recorded status log is outside this repository.
- CLI installation and `t3.defaults: apply-defaults` remain unsupported. They are reported as such.

## Fleet snapshot

- The workspace install check covers 95 entries in this workspace. It does not measure fleet adoption.
- A read-only roster baseline captured on 2026-10-15 found matching local, fork, and organization `main` refs in all 17 repositories listed by `simpsonm09-repo-catalog`. The live `check-agent-access` drift check also exited 0 for all 17 repositories at 01:04 UTC that day.
- The baseline records current gaps as well as matching refs. Fifteen repositories still use older standard pins. Coverage jobs are absent from the four declared exceptions, and CodeQL is absent from the repository template and machine inventory. These results do not show that fleet CI adoption is complete.
- The baseline used the catalog roster and the standard's `check-agent-access` script. The private-key storage check remains unverified; no credential store was inspected.

## What still needs acceptance

- The owner has not run the fresh macOS install and Copilot session. Hosted macOS CI is evidence for the lifecycle job, not for the real Copilot CLI, login, hooks, or loaded PStack and organization skills.
- Fresh-session checks for OpenCode, Copilot, and Pi as T3 dispatch parents remain pending. Pi's instructions also need live validation. A Codex GitHub-write command was denied by the organization gate in this run. The gate is intended to guard GitHub writes across harnesses, but startup, hook-trust, and timeout conditions can prevent the hook from running, so it is not a guaranteed security boundary. See [T3 setup](../t3-setup.md) for the gate's operation and limits.
- Cursor (PR #80, `0405f1a`) and Antigravity (PR #81) are implemented on `main` as opt-in, skills-only runtimes. PR #81 merged at `2026-10-15T23:14:03Z` as `bc399aa56c33a9f26d22a09cd60cec55d8ba0e7b`; all 17 checks passed for the exact feature head `bb3ede6582c832cacbe3f3f098f04e13af85b9a1`. Its verifier fix is now on `main`. Neither runtime has been applied to an installed workspace or validated in a live session. Antigravity shares `.agents/skills` with Codex; default runtime selection is unchanged.
- The old `feat/settings-4-t3-snapshot` branch and its backup are preserved research. Snapshot delivery is already in PR #78; the old branch has not been reconciled against current main.
- The pstack pin at `61654b6` is on `feat/opencode-runtime`, while local pstack main is `60ae9e2`. This is a deliberate difference pending reconciliation, not automatic drift.
- The canonical T3 provider IDs are `claude_maxstack`, `copilot_maxstack`, and `pi_maxstack`. This migration is documented but not applied: the provider instances have not been created and project defaults have not been migrated. Human-facing labels are `maxstack`; `t3/defaults.json` remains report-only and has no provider instance ID fields. The pstack pin remains `61654b6` on `feat/opencode-runtime`, distinct from pstack `main` at `60ae9e2`; reconciliation is pending.

## How to read the status

Use [T3 setup](../t3-setup.md) for provider setup and known harness behavior. Use the [parity matrix](../parity-matrix.md) for behavior-by-harness evidence; its older audit findings need review against the post-PR #78 state before they guide implementation. Use the [workspace settings reference](settings.md) and [T3 snapshot reference](t3-settings.md) for current option behavior.

## Next acceptance work

1. Apply the opt-in Cursor and Antigravity runtimes to a scratch workspace, then verify each loads its skills in a live session. The installers and verifier are on `main`; installed-workspace and live-session evidence is still needed.
2. Complete fresh-session T3 acceptance for OpenCode, Copilot, and Pi dispatch parents, including Pi instruction loading. This depends on usable configured provider instances and does not establish general harness parity by itself.
3. When provider migration is scheduled, create the canonical provider instances and migrate project defaults together; the documented IDs are not yet applied.
4. Treat pstack-pin reconciliation and fleet alignment as separate, broader work. The unchanged `61654b6` pin and matching main refs do not establish full pstack parity or complete fleet alignment.
