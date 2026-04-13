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
import {
  getPrComments,
  getPrDetails,
  getPrFilesWithCoverage,
  listOpenPrs,
  searchPrs,
} from './tools/github-integration.js';
import { getTestResults, runTests } from './tools/test-runner.js';
import {
  scaffoldPageObject,
  scaffoldStd,
  scaffoldStepDriver,
  scaffoldTest,
} from './tools/test-scaffolder.js';
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

// ─── Test Scaffolder Tools ─────────────────────────────────────────────

server.tool(
  'scaffold_test',
  'Generate a .spec.ts test file skeleton following project conventions. Includes proper imports, test.describe, Allure registration, cleanup tracking, and ID(CNV-XXXXX) annotations. Returns the file path and content -- does NOT write to disk.',
  {
    feature: z.string().describe('Feature name in kebab-case or natural language (e.g. "storage-migration", "vm-snapshots")'),
    tier: z.enum(['gating', 'tier1', 'tier2']).describe('Test tier'),
    jira_ids: z.array(z.string()).optional().describe('Jira ticket IDs to annotate (e.g. ["CNV-78882", "CNV-83178"])'),
    describe_name: z.string().optional().describe('Custom test.describe title. Defaults to PascalCase of feature.'),
    test_names: z.array(z.string()).optional().describe('Custom test names. Defaults to one test per Jira ID.'),
    tags: z.array(z.string()).optional().describe('Additional tags beyond the tier tag (e.g. ["@nonpriv", "@adminOnly"])'),
    use_shared_resources: z.boolean().optional().describe('Generate read-only test pattern using sharedResources fixture (default: false)'),
  },
  async (params) => {
    try {
      const result = scaffoldTest({
        feature: params.feature,
        tier: params.tier,
        jiraIds: params.jira_ids,
        describeName: params.describe_name,
        testNames: params.test_names,
        tags: params.tags,
        useSharedResources: params.use_shared_resources,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'scaffold_page_object',
  'Generate a page object class extending BasePage or PageCommons with project conventions. Returns the file path and content -- does NOT write to disk.',
  {
    name: z.string().describe('Page object name (e.g. "storage-migration", "vm-snapshots"). "Page" suffix added automatically.'),
    base_class: z.enum(['BasePage', 'PageCommons']).optional().describe('Base class to extend (default: PageCommons)'),
    url_pattern: z.string().optional().describe('URL pattern for navigation methods. Use {namespace} as placeholder (e.g. "/k8s/ns/{namespace}/storage-migration")'),
  },
  async (params) => {
    try {
      const result = scaffoldPageObject({
        name: params.name,
        baseClass: params.base_class,
        urlPattern: params.url_pattern,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'scaffold_step_driver',
  'Generate a StepDriver class wired to a page object following the BasePageStepDriver pattern. Returns the file path and content -- does NOT write to disk.',
  {
    feature: z.string().describe('Feature name (e.g. "storage-migration"). Used for class name and file path.'),
    page_object_name: z.string().optional().describe('Page object class name to bind. Defaults to PascalCase(feature) + "Page".'),
  },
  async (params) => {
    try {
      const result = scaffoldStepDriver({
        feature: params.feature,
        pageObjectName: params.page_object_name,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'scaffold_std',
  'Generate a Software Test Description (STD) document from the project template. Returns the file path and content -- does NOT write to disk.',
  {
    feature: z.string().describe('Feature name (e.g. "storage-migration")'),
    tier: z.enum(['gating', 'tier1', 'tier2']).describe('Test tier for the STD'),
    jira_ids: z.array(z.string()).optional().describe('Related Jira ticket IDs'),
    test_cases: z.array(z.object({
      title: z.string().describe('Test case title'),
      steps: z.array(z.object({
        action: z.string().describe('Action to perform'),
        expected: z.string().describe('Expected result'),
      })).describe('Test steps'),
    })).optional().describe('Test case definitions with steps'),
  },
  async (params) => {
    try {
      const result = scaffoldStd({
        feature: params.feature,
        tier: params.tier,
        jiraIds: params.jira_ids,
        testCases: params.test_cases,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Test Runner Tools ────────────────────────────────────────────────

server.tool(
  'run_tests',
  'Execute Playwright tests with structured parameters. Builds the correct `yarn test-playwright` command from the inputs. Use dryRun to preview the command without executing. Runs from the project root.',
  {
    file: z.string().optional().describe('Test file or glob to run (e.g. "checkups.spec.ts", "tier1/checkups/checkups.spec.ts", or full path). Omit to run all tests.'),
    grep: z.string().optional().describe('Tag or name filter, passed to --grep (e.g. "@tier1", "@smoke", "(?=.*@tier1)(?=.*@nonpriv)" for AND, "@tier1|@filter" for OR)'),
    grep_invert: z.string().optional().describe('Exclude tests matching this pattern (passed to --grep-invert)'),
    workers: z.number().optional().describe('Number of parallel workers (e.g. 1 for serial, 4 for parallel). Omit to use config default.'),
    headed: z.boolean().optional().describe('Run in headed mode (visible browser). Default: false (headless).'),
    debug: z.boolean().optional().describe('Enable debug mode (DEBUG=1): headed browser, Allure skipped, minimal setup. Default: false.'),
    ui: z.boolean().optional().describe('Launch Playwright UI mode for interactive test selection and debugging.'),
    shard: z.string().optional().describe('Shard specification (e.g. "1/4" to run shard 1 of 4)'),
    retries: z.number().optional().describe('Number of retries for failed tests. Omit to use config default.'),
    timeout: z.number().optional().describe('Test timeout in milliseconds. Omit to use config default (480000ms).'),
    skip_cleanup: z.boolean().optional().describe('Skip test resource cleanup (SKIP_TEST_CLEANUP=true). Useful for debugging leftover resources.'),
    dry_run: z.boolean().optional().describe('If true, returns the command without executing it. Great for verification before running.'),
  },
  async (params) => {
    try {
      const result = await runTests(config, {
        file: params.file,
        grep: params.grep,
        grepInvert: params.grep_invert,
        workers: params.workers,
        headed: params.headed,
        debug: params.debug,
        ui: params.ui,
        shard: params.shard,
        retries: params.retries,
        timeout: params.timeout,
        skipCleanup: params.skip_cleanup,
        dryRun: params.dry_run,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_test_results',
  'Parse the latest test results from JUnit XML or Allure result files. Returns pass/fail counts, failed test names with error messages, and execution time.',
  {
    source: z.enum(['junit', 'allure']).optional().describe('Which result source to parse. Omit to auto-detect (prefers JUnit if available).'),
  },
  async ({ source }) => {
    try {
      const result = await getTestResults(config, source);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ─── GitHub Integration Tools ─────────────────────────────────────────

const REPO_PARAM = z.string().optional().describe('GitHub repo in owner/repo format (e.g. "kubevirt-ui/kubevirt-plugin"). Falls back to GITHUB_REPO env var.');

server.tool(
  'get_pr_details',
  'Get comprehensive PR information in a single call: metadata, files changed, CI check status. Replaces multiple gh commands.',
  {
    pr_number: z.number().describe('Pull request number'),
    repo: REPO_PARAM,
  },
  async ({ pr_number, repo }) => {
    try {
      const result = await getPrDetails(config, pr_number, repo);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_pr_files_coverage',
  'Cross-reference a PR\'s changed files with test coverage. Shows which playwright specs, page objects, and step drivers are changed, and which tests are impacted by those changes. The key tool for PR review.',
  {
    pr_number: z.number().describe('Pull request number'),
    repo: REPO_PARAM,
  },
  async ({ pr_number, repo }) => {
    try {
      const result = await getPrFilesWithCoverage(config, scanner, pr_number, repo);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_pr_comments',
  'Get all review comments (inline code comments) and issue comments (general discussion) for a PR.',
  {
    pr_number: z.number().describe('Pull request number'),
    repo: REPO_PARAM,
  },
  async ({ pr_number, repo }) => {
    try {
      const result = await getPrComments(config, pr_number, repo);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'list_open_prs',
  'List open pull requests with optional filters for author and label. Returns title, branch, review status, and diff stats.',
  {
    repo: REPO_PARAM,
    author: z.string().optional().describe('Filter by PR author (GitHub username)'),
    label: z.string().optional().describe('Filter by label name'),
    limit: z.number().optional().describe('Max results to return (default: 20)'),
  },
  async ({ repo, author, label, limit }) => {
    try {
      const result = await listOpenPrs(config, repo, author, label, limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'search_prs',
  'Search pull requests by keyword across title, body, and comments. Supports GitHub search qualifiers. Returns PRs in any state (open, closed, merged).',
  {
    query: z.string().describe('Search query (supports GitHub search qualifiers like "is:merged", "label:bug", keywords)'),
    repo: REPO_PARAM,
    limit: z.number().optional().describe('Max results to return (default: 20)'),
  },
  async ({ query, repo, limit }) => {
    try {
      const result = await searchPrs(config, query, repo, limit);
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
