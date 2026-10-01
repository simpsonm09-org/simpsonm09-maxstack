> Source guide, kept for provenance. Its JSON uses the V1 shape (`mcp` with server names directly and an `enabled` field). The applied configuration is [`mcp.md`](mcp.md), which uses the V2 `mcp.servers` shape and `disabled`.

# MCP Installation & Configuration Guide

This guide outlines the complete setup for the recommended Model Context Protocol (MCP) servers tailored for a high-performance personal development workflow. It includes both local and remote OAuth-enabled configurations, context management strategies, and local validation steps.

---

## 🛠️ Recommended MCP Servers Overview

### Standard Developer Toolkit
*   **GitHub:** Connects to the GitHub API for issues, pull requests, and repository context management.
*   **Context7:** Provides up-to-date documentation search to minimize AI hallucinations.
*   **Grep.app:** Enables large-scale public code searches for finding real-world implementation examples.
*   **Sentry:** Integrates application error tracking and active crash logs into the workflow.
*   **SQLite:** Enables inspection and querying of local database files.

### Automation & API Testing
*   **Playwright:** Provides real browser automation, allowing the agent to test UI elements, inspect the DOM, and execute end-to-end user workflows.
*   **Postman:** Connects to your Postman workspaces to execute collections and test API endpoints.
* include chrome dev tools mcp as well in here (off by default)

### Context Enhancements & Workflow Helpers
*   **Sequential Thinking:** Forces the agent into a step-by-step reasoning framework before writing complex code, reducing structural design errors.
*   **Fetch:** Downloads web pages and parses noisy HTML directly into clean Markdown—ideal for reading third-party documentation (e.g., Adyen or OpenText docs).

---

## 🔐 Authentication & Deployment Matrix

| MCP Server | Connection Type | Authentication Method | Recommended Default State |
| :--- | :--- | :--- | :--- |
| **Sequential Thinking** | Local (`npx`) | None | **Enabled (`true`)** |
| **Fetch** | Local (`npx`) | None | **Enabled (`true`)** |
| **Context7** | Remote (`https`) | None | **Enabled (`true`)** |
| **Grep.app** | Remote (`https`) | None | **Enabled (`true`)** |
| **Postman** | Remote (`https`) | **OAuth 2.0** | Disabled (`false`) |
| **GitHub** | Remote / Local | **OAuth 2.1 / Personal Access Token** | Disabled (`false`) |
| **Playwright** | Local (`npx`) | None (Local Execution Only) | Disabled (`false`) |
| **SQLite** | Local (Binary) | Local File Access | Disabled (`false`) |
| **Sentry** | Local (`npx`) | Auth Token | Disabled (`false`) |

---

## 🗂️ Global Configuration: `opencode.json`

Save this file globally in `~/.config/opencode/opencode.jsonc` or `opencode.json`. 

> 💡 **Architectural Best Practice:** To avoid severe token bloat and save context window overhead, general developer utility modules (`sequential-thinking`, `fetch`, `context7`, `grep_app`) are turned **on** by default. Environment-specific platforms (`playwright`, `postman`, `github`, `sqlite`, `sentry`) are kept **off** globally and should only be toggled `true` inside target workspaces.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sequential-thinking": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      "enabled": true
    },
    "fetch": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "enabled": true
    },
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true
    },
    "grep_app": {
      "type": "remote",
      "url": "https://mcp.grep.app/mcp",
      "enabled": true
    },
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "enabled": false
    },
    "postman": {
      "type": "remote",
      "url": "https://mcp.postman.com/mcp",
      "enabled": false
    },
    "playwright": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "enabled": false
    },
    "sqlite": {
      "type": "local",
      "command": "docker",
      "args": ["run", "-i", "--rm", "mcp/sqlite"],
      "enabled": false
    },
    "sentry": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@sentry/mcp-server"],
      "env": {
        "SENTRY_AUTH_TOKEN": "YOUR_SENTRY_AUTH_TOKEN_HERE"
      },
      "enabled": false
    }
  }
}
```

---

## 💻 OpenCode CLI Control Commands

Use these native terminal commands to interactively configure and inspect your local engine runtime.

### Add a New Server Interactively
```bash
opencode mcp add
```

### List Registered Servers & Operational Status
```bash
opencode mcp list
```

### Check Active Tools and Context Budgets
```bash
opencode mcp status
```

---

## 📦 Local Workspace Activation

When working on a project requiring end-to-end browser workflows or API suite testing, create a local workspace override file named `opencode.json` at your git repository root directory to enable specific tools cleanly:

```json
{
  "mcp": {
    "playwright": {
      "enabled": true
    },
    "postman": {
      "enabled": true
    }
  }
}
```
