#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  checkClusterHealth,
  cleanupStaleNamespaces,
  getClusterInfo,
  getVmDetail,
  listTestNamespaces,
  listVms,
  resetClient,
} from './tools/cluster-inspector.js';
import {
  findTestsByJira,
  getCoverageForFeature,
  getOrphanPageObjectMethods,
  getTierDistribution,
  getUntestedStepDriverMethods,
} from './tools/coverage-oracle.js';
import { loadConfig } from './utils/config.js';
import { ProjectScanner } from './utils/project-scanner.js';

const config = loadConfig();
const scanner = new ProjectScanner(config);

const server = new McpServer({
  name: 'kubevirt-qe',
  version: '1.0.0',
});

// ─── Coverage Oracle Tools ────────────────────────────────────────────

server.tool(
  'get_coverage_for_feature',
  'Find all test specs, step drivers, page objects, and STD docs that cover a given feature area. Returns Jira ticket IDs extracted from test annotations.',
  { feature: z.string().describe('Feature area to search for (e.g. "bootable-volumes", "vm-actions", "catalog", "templates", "networking", "checkups", "overview", "quotas")') },
  async ({ feature }) => {
    try {
      const result = getCoverageForFeature(scanner, config, feature);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_untested_step_driver_methods',
  'Find public step driver methods that are never called from any spec file or other step driver. Helps identify dead code or missing test coverage.',
  {},
  async () => {
    try {
      const result = getUntestedStepDriverMethods(scanner, config);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_orphan_page_object_methods',
  'Find public page object methods never referenced by any step driver or test. Candidates for removal or missing step driver integration.',
  {},
  async () => {
    try {
      const result = getOrphanPageObjectMethods(scanner, config);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_tier_distribution',
  'Get a breakdown of tests by tier (gating, tier1, tier2, fleet-virtualization-acm) with file counts, test counts, and Jira IDs per tier.',
  {},
  async () => {
    try {
      const result = getTierDistribution(scanner);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'find_tests_by_jira',
  'Look up which tests cover a given Jira ticket by searching for ID(CNV-XXXXX) annotations in spec files.',
  { ticket_id: z.string().describe('Jira ticket ID (e.g. "CNV-78882")') },
  async ({ ticket_id }) => {
    try {
      const result = findTestsByJira(scanner, ticket_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'invalidate_cache',
  'Clear the scanner cache. Call this after making changes to the playwright codebase to get fresh results from coverage tools.',
  {},
  async () => {
    scanner.invalidateCache();
    resetClient();
    return { content: [{ type: 'text' as const, text: 'Cache invalidated. Next tool call will re-scan the project.' }] };
  },
);

// ─── Cluster State Inspector Tools ────────────────────────────────────

server.tool(
  'get_cluster_info',
  'Get cluster version information: Kubernetes version, KubeVirt version, CNV operator version, CDI version, node count.',
  {},
  async () => {
    try {
      const result = await getClusterInfo(config);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'list_vms',
  'List virtual machines in a namespace (or all namespaces) with status, CPU, memory, and run strategy.',
  { namespace: z.string().optional().describe('Namespace to list VMs from. Omit for all namespaces.') },
  async ({ namespace }) => {
    try {
      const result = await listVms(config, namespace);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_vm_detail',
  'Get detailed information about a specific VM: spec, status, conditions, volumes, networks, interfaces, and VMI runtime info (IPs, node, guest OS).',
  {
    name: z.string().describe('VM name'),
    namespace: z.string().describe('VM namespace'),
  },
  async ({ name, namespace }) => {
    try {
      const result = await getVmDetail(config, name, namespace);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'list_test_namespaces',
  'List all pw-* test namespaces with age and status. Helps identify stale namespaces from previous test runs.',
  {},
  async () => {
    try {
      const result = await listTestNamespaces(config);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'cleanup_stale_namespaces',
  'Delete pw-* test namespaces older than a threshold. Defaults to 4 hours.',
  { older_than_hours: z.number().optional().default(4).describe('Delete namespaces older than this many hours (default: 4)') },
  async ({ older_than_hours }) => {
    try {
      const result = await cleanupStaleNamespaces(config, older_than_hours);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'check_cluster_health',
  'Pre-flight cluster health check: API server reachability, CNV operator status, virt-api pods, storage classes, node readiness, test namespace count.',
  {},
  async () => {
    try {
      const result = await checkClusterHealth(config);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Start Server ─────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('kubevirt-qe MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
