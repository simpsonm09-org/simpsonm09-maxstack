# Current delivery state

This page tracks maxstack against the end goal: a person starts in T3, then gets the PStack, organization, and personal layers through supported providers and harnesses. The same layers need to install in any workspace, while the fleet follows the shared standard. It separates recorded results from live acceptance work.

## What is delivered

- PR #77 added the macOS Copilot runtime and CI job. It merged as `57717445a32b01675e93ee0c168fabd8a4699b0b`.
- PR #78 added explicit T3 settings snapshots and drift reports. It merged as `670b220c9881dcb7b19f46b6cd695dbd3e09cd49`. The handoff records all 17 checks green for the merged head.
- The snapshot reads only `-T3Settings` or `MAXSTACK_T3_SETTINGS`. It writes an allowlisted snapshot, excludes models, and skips source access when `t3.snapshot` is false. New T3 defaults are report-only.
- A real workspace apply and strict status at `670b220` completed with 95 matching files and no drift, modifications, missing, untracked, or unselected files. The recorded status log is `.audit/install-status-after78.txt` outside this repository.
- CLI installation and `t3.defaults: apply-defaults` remain unsupported. They are reported as such.

## What still needs acceptance

- The owner has not run the fresh macOS install and Copilot session. Hosted macOS CI is evidence for the lifecycle job, not for the real Copilot CLI, login, hooks, or loaded PStack and organization skills.
- Fresh-session checks for OpenCode, Copilot, and Pi as T3 dispatch parents remain pending. Pi's instructions also need live validation. A Codex live gate denial was observed in this thread; do not reuse earlier claims about a universal Codex denial.
- Cursor and Antigravity have no installer target. The parity matrix describes their current limitations and evidence.
- The old `feat/settings-4-t3-snapshot` branch and its backup are preserved research. Snapshot delivery is already in PR #78; the old branch has not been reconciled against current main.
- The pstack pin at `61654b6` is on `feat/opencode-runtime`, while local pstack main is `60ae9e2`. This is a deliberate difference pending reconciliation, not automatic drift.

## How to read the status

Use [T3 setup](../t3-setup.md) for provider setup and known harness behavior. Use the [parity matrix](../parity-matrix.md) for behavior-by-harness evidence; its older audit findings need review against the post-PR #78 state before they guide implementation. Use the [workspace settings reference](settings.md) and [T3 snapshot reference](t3-settings.md) for current option behavior.

Keep the next work focused on harness delivery, any-workspace acceptance, and fleet alignment before adding more hardening to paths that already work.
