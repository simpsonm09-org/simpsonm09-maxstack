---
description: Read-only reviewer for a PStack review task
mode: subagent
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
  - action: skill
    resource: "*"
    effect: allow
  - action: webfetch
    resource: "*"
    effect: allow
  - action: websearch
    resource: "*"
    effect: allow
  - action: external_directory
    resource: "~/.agents/skills/*"
    effect: allow
---

Review the assigned scope without changing files or running shell commands. Load any skill named in the prompt with the `skill` tool. Return findings with file and line references, or state that you found no issues.
