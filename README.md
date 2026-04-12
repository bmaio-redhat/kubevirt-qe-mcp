# kubevirt-qe-mcp

Custom [Model Context Protocol](https://modelcontextprotocol.io/) server for KubeVirt quality engineering. Gives AI agents structured access to two capabilities:

1. **Coverage Oracle** -- static analysis of the Playwright test codebase (specs, step drivers, page objects, Jira IDs, tier distribution)
2. **Cluster State Inspector** -- live queries against an OpenShift / KubeVirt cluster (versions, VMs, namespaces, health checks)

Designed to complement the [Playwright MCP](https://github.com/playwright-community/playwright-mcp) (live browser interaction) by providing **project intelligence** -- answering "what do we cover?", "is the cluster healthy?", and "which tests touch this ticket?" without manual grep or `oc` commands.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Cursor IDE Integration](#cursor-ide-integration)
- [Tools Reference](#tools-reference)
  - [Coverage Oracle](#coverage-oracle)
  - [Cluster State Inspector](#cluster-state-inspector)
- [Usage Examples](#usage-examples)
- [Debugging](#debugging)
  - [MCP Inspector (recommended)](#mcp-inspector-recommended)
  - [Manual stdio testing](#manual-stdio-testing)
  - [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Development](#development)

---

## Prerequisites

- **Node.js** >= 18.x
- **npm** >= 9.x
- Access to the [kubevirt-ui](https://github.com/kubevirt-ui/kubevirt-plugin) test repository (for Coverage Oracle tools)
- A valid kubeconfig pointing to an OpenShift cluster (for Cluster State Inspector tools -- optional)

## Installation

```bash
git clone <this-repo>
cd kubevirt-qe-mcp

npm install
npm run build
```

The compiled output lands in `dist/`. The server runs via `node dist/index.js` over stdio (the standard MCP transport).

## Configuration

All configuration is through environment variables. Every variable is optional with sensible defaults.

| Variable | Description | Default |
|----------|-------------|---------|
| `KUBEVIRT_PROJECT_ROOT` | Absolute path to the kubevirt-ui repository root | `~/Developer/Projects/kubevirt-ui` |
| `KUBECONFIG` | Path to kubeconfig file for cluster access | `<project>/playwright/.kubeconfigs/test-config` |
| `CLUSTER_URL` | OpenShift API URL (overrides kubeconfig server) | Read from kubeconfig |

### Cluster access

The Cluster State Inspector tools need a valid kubeconfig. The server tries paths in this order:

1. `KUBECONFIG` environment variable
2. `<KUBEVIRT_PROJECT_ROOT>/playwright/.kubeconfigs/test-config` (created by the Playwright framework's global setup)
3. Default kubeconfig (`~/.kube/config`)

If no kubeconfig is available, cluster tools will return errors but coverage tools will still work.

## Cursor IDE Integration

Add the server to your project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "kubevirt-qe": {
      "command": "node",
      "args": ["/absolute/path/to/kubevirt-qe-mcp/dist/index.js"],
      "env": {
        "KUBEVIRT_PROJECT_ROOT": "/absolute/path/to/kubevirt-ui"
      }
    }
  }
}
```

After saving, Cursor will auto-start the server. You can verify it's running in **Settings > MCP** -- look for `kubevirt-qe` with a green status indicator.

To use it alongside the Playwright MCP:

```json
{
  "mcpServers": {
    "Playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--ignore-https-errors"]
    },
    "kubevirt-qe": {
      "command": "node",
      "args": ["/absolute/path/to/kubevirt-qe-mcp/dist/index.js"],
      "env": {
        "KUBEVIRT_PROJECT_ROOT": "/absolute/path/to/kubevirt-ui"
      }
    }
  }
}
```

---

## Tools Reference

### Coverage Oracle

These tools perform static analysis of the Playwright codebase. They work entirely offline -- no cluster needed.

#### `get_coverage_for_feature`

Find all test specs, step drivers, page objects, and STD docs that cover a given feature area. Returns Jira ticket IDs extracted from `ID(CNV-XXXXX)` annotations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `feature` | string | yes | Feature area keyword (e.g. `bootable-volumes`, `vm-actions`, `catalog`, `templates`, `networking`, `checkups`, `overview`, `quotas`, `settings`) |

Returns: spec files with tier/tags/Jira IDs, related step drivers, page objects, docs, and a deduplicated list of all Jira IDs.

Built-in aliases map common variations (e.g. `vm-detail` also matches `vm-tabs`, `vm-overview`, `vm-console`).

#### `get_untested_step_driver_methods`

Find public step driver methods that are never called from any spec file or other step driver. Helps identify dead code or gaps in test coverage.

Returns: total public methods, untested count, coverage percentage, and a list of untested methods with class name, file, and line number.

#### `get_orphan_page_object_methods`

Find public page object methods never referenced by any step driver or test. Candidates for removal or missing step driver wiring.

Returns: same structure as above, scoped to page objects.

#### `get_tier_distribution`

Breakdown of tests by tier (`gating`, `tier1`, `tier2`, `fleet-virtualization-acm`) with file counts, test counts, Jira IDs, and file paths per tier.

#### `find_tests_by_jira`

Look up which tests cover a given Jira ticket by searching for `ID(CNV-XXXXX)` annotations across all spec files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticket_id` | string | yes | Jira ticket ID (e.g. `CNV-78882`) |

#### `invalidate_cache`

Clear the scanner's in-memory cache. Call this after making changes to the Playwright codebase so subsequent tool calls re-scan the file system.

---

### Cluster State Inspector

These tools query the live OpenShift / KubeVirt cluster via the Kubernetes API. They require a valid kubeconfig.

#### `get_cluster_info`

Returns cluster version information: Kubernetes version, KubeVirt version, CNV operator version, CDI version, node count, and API server URL.

#### `list_vms`

List virtual machines with status, CPU, memory, and run strategy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `namespace` | string | no | Namespace to scope the query. Omit for all namespaces. |

#### `get_vm_detail`

Detailed information about a specific VM: full spec, status, conditions, volumes, networks, interfaces, and VMI runtime info (IP addresses, node placement, guest OS).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | VM name |
| `namespace` | string | yes | VM namespace |

#### `list_test_namespaces`

List all `pw-*` test namespaces with creation time, age in hours, and status. Useful for spotting orphaned namespaces from previous test runs.

#### `cleanup_stale_namespaces`

Delete `pw-*` namespaces older than a threshold.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `older_than_hours` | number | no | Delete namespaces older than this (default: `4`) |

Returns: list of deleted namespaces and any failures.

#### `check_cluster_health`

Pre-flight health check covering:
- API server reachability
- CNV operator pod status
- virt-api pod availability
- Storage classes (checks for virtualization-ready classes)
- Node readiness
- Test namespace count (warns if >20)

Returns a `healthy` boolean and an array of checks with `ok` / `warning` / `error` status.

---

## Usage Examples

Once integrated into Cursor, the agent can call these tools naturally during conversations:

**"What tests cover bootable volumes?"**
The agent calls `get_coverage_for_feature` with `feature: "bootable-volumes"` and gets back 15 tests across 2 spec files, 6 step drivers, 4 page objects, and 2 Jira IDs.

**"Is the cluster ready for a test run?"**
The agent calls `check_cluster_health` and reports: API server reachable, CNV operator running (3 pods), 6/6 nodes ready, 2 stale test namespaces.

**"Which tests cover CNV-78882?"**
The agent calls `find_tests_by_jira` and returns the exact spec files, tier, and test names.

**"Clean up old test namespaces"**
The agent calls `cleanup_stale_namespaces` with `older_than_hours: 2` and deletes 5 orphaned namespaces.

**"Show me the tier breakdown"**
The agent calls `get_tier_distribution` and reports: 38 files, 262 tests -- 42 gating, 135 tier1, 28 tier2, 57 fleet-virtualization-acm.

---

## Debugging

### MCP Inspector (recommended)

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) provides a web UI for interactively testing tools, viewing responses, and inspecting the protocol exchange.

#### Launch the Inspector

```bash
# Basic: launches the Inspector UI and connects to the server
npx @modelcontextprotocol/inspector node dist/index.js

# With environment variables
npx @modelcontextprotocol/inspector \
  -e KUBEVIRT_PROJECT_ROOT=/home/bmaio/Developer/Projects/kubevirt-ui \
  node dist/index.js

# Custom ports (defaults: UI on 6274, proxy on 6277)
CLIENT_PORT=8080 SERVER_PORT=9000 \
  npx @modelcontextprotocol/inspector node dist/index.js
```

Open `http://localhost:6274` in your browser. The Inspector provides:

- **Tools tab** -- browse all 12 tools, fill in parameters, execute them, and see JSON responses
- **Notifications pane** -- view server logs and stderr output
- **Protocol view** -- inspect raw JSON-RPC messages between client and server

#### Debugging workflow

1. Start the Inspector with your server
2. Go to the **Tools** tab
3. Select a tool (e.g. `get_tier_distribution`)
4. Click **Run** -- the response JSON appears immediately
5. For tools with parameters, fill them in the form (e.g. `feature: "catalog"` for `get_coverage_for_feature`)
6. Check the **Notifications** pane for any stderr output from the server

This is the fastest way to verify tools work before using them through Cursor.

### Manual stdio testing

Since the server uses stdio transport, you can test it directly with JSON-RPC messages piped to stdin. This is useful for CI or scripted validation.

#### Initialize the connection

Every MCP session starts with an `initialize` handshake:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | node dist/index.js 2>/dev/null
```

Expected response:

```json
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"kubevirt-qe","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
```

#### List available tools

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node dist/index.js 2>/dev/null
```

#### Call a tool

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_tier_distribution","arguments":{}}}' \
  | node dist/index.js 2>/dev/null
```

#### Pretty-print responses

Pipe the output through Python for readability:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_coverage_for_feature","arguments":{"feature":"catalog"}}}' \
  | node dist/index.js 2>/dev/null \
  | tail -1 \
  | python3 -m json.tool
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Coverage tools return empty results | Wrong `KUBEVIRT_PROJECT_ROOT` | Verify the path points to the repo root containing the `playwright/` directory |
| Cluster tools return connection errors | No valid kubeconfig | Run `oc login` or set `KUBECONFIG` to a valid file |
| Cluster tools return 401 Unauthorized | Expired token in kubeconfig | Re-run `oc login` to refresh the token |
| Stale results after editing test files | Scanner cache | Call `invalidate_cache` to force a re-scan |
| Server not appearing in Cursor | `mcp.json` syntax error or wrong path | Validate JSON syntax; use absolute paths in `args` |
| Inspector can't connect | Port conflict | Set `CLIENT_PORT` / `SERVER_PORT` to avoid conflicts |

#### Enabling server-side debug logging

The server writes diagnostic messages to stderr. In Cursor, these appear in the MCP output panel. When running manually:

```bash
# See stderr alongside stdout
node dist/index.js

# Or redirect stderr to a file for later review
node dist/index.js 2>server.log
```

---

## Architecture

```
src/
├── index.ts                      # MCP server entry point
│                                   Registers 12 tools, starts stdio transport
├── tools/
│   ├── coverage-oracle.ts        # Static analysis of the playwright codebase
│   │                               Parses spec files, step drivers, page objects
│   └── cluster-inspector.ts      # Live K8s/KubeVirt cluster queries
│                                   Uses @kubernetes/client-node
└── utils/
    ├── config.ts                 # Environment variable loading, path resolution
    └── project-scanner.ts        # File system walker + TypeScript parser
                                    Extracts tests, methods, selectors, Jira IDs
```

### Data flow

```
Cursor Agent
    │
    ├─ tools/call "get_coverage_for_feature"
    │       │
    │       └─► ProjectScanner ─► walks playwright/ ─► returns structured data
    │
    └─ tools/call "check_cluster_health"
            │
            └─► @kubernetes/client-node ─► K8s API ─► returns health checks
```

The Coverage Oracle tools cache results in memory after the first scan. Call `invalidate_cache` to reset. The Cluster State Inspector creates a single Kubernetes client per process lifetime, reset alongside the cache.

---

## Development

```bash
# Build once
npm run build

# Watch mode (rebuild on file changes)
npm run dev

# Run the server directly (for piping JSON-RPC)
node dist/index.js

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

### Adding a new tool

1. Implement the tool logic in the appropriate file under `src/tools/`
2. Register it in `src/index.ts` using `server.tool(name, description, schema, handler)`
3. Rebuild with `npm run build`
4. Test with the MCP Inspector before using in Cursor
