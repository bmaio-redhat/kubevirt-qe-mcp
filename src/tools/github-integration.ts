import { execSync } from 'node:child_process';

import type { McpConfig } from '../utils/config.js';
import type { ProjectScanner } from '../utils/project-scanner.js';

function gh(args: string, repo?: string): string {
  const repoFlag = repo ? ` -R ${repo}` : '';
  try {
    return execSync(`gh ${args}${repoFlag}`, {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString().trim() ?? '';
    const msg = stderr || e.message;
    throw new Error(`gh command failed: ${msg}`);
  }
}

function resolveRepo(config: McpConfig, repo?: string): string {
  const resolved = repo ?? config.githubRepo;
  if (!resolved) {
    throw new Error(
      'No repository specified. Pass a repo parameter (e.g. "owner/repo") '
      + 'or set the GITHUB_REPO environment variable.',
    );
  }
  return resolved;
}

export async function getPrDetails(config: McpConfig, prNumber: number, repo?: string) {
  const r = resolveRepo(config, repo);

  const prJson = gh(
    `pr view ${prNumber} --json number,title,body,state,author,baseRefName,headRefName,`
    + `url,createdAt,updatedAt,mergedAt,closedAt,additions,deletions,changedFiles,`
    + `reviewDecision,isDraft,labels,milestone,mergeable,reviewRequests,assignees`,
    r,
  );
  const pr = JSON.parse(prJson);

  const filesJson = gh(`pr view ${prNumber} --json files`, r);
  const { files } = JSON.parse(filesJson);

  let checks: any[] = [];
  try {
    const raw = gh(`pr checks ${prNumber} --json name,state,conclusion,link`, r);
    checks = JSON.parse(raw);
  } catch {
    // checks may not be available
  }

  return {
    ...pr,
    files: (files ?? []).map((f: any) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
    })),
    checks,
  };
}

export async function getPrFilesWithCoverage(
  config: McpConfig,
  scanner: ProjectScanner,
  prNumber: number,
  repo?: string,
) {
  const r = resolveRepo(config, repo);

  const filesJson = gh(`pr view ${prNumber} --json files,title,url`, r);
  const { files, title, url } = JSON.parse(filesJson);

  const playwrightFiles: any[] = [];
  const otherFiles: string[] = [];

  for (const f of (files ?? [])) {
    const filePath: string = f.path;
    if (filePath.startsWith('playwright/')) {
      playwrightFiles.push(f);
    } else {
      otherFiles.push(filePath);
    }
  }

  const changedSpecs = playwrightFiles
    .filter((f: any) => f.path.endsWith('.spec.ts'))
    .map((f: any) => f.path);

  const changedPageObjects = playwrightFiles
    .filter((f: any) => f.path.includes('page-objects/'))
    .map((f: any) => f.path);

  const changedStepDrivers = playwrightFiles
    .filter((f: any) => f.path.includes('step-drivers/'))
    .map((f: any) => f.path);

  const changedOtherSrc = playwrightFiles
    .filter((f: any) =>
      !f.path.endsWith('.spec.ts')
      && !f.path.includes('page-objects/')
      && !f.path.includes('step-drivers/')
    )
    .map((f: any) => f.path);

  // Cross-reference: for each changed PO/SD, find which tests use them
  const impactedTests: Array<{ source: string; type: string; tests: string[] }> = [];

  const allTests = scanner.scanTestFiles();

  for (const poFile of changedPageObjects) {
    const poClassName = extractClassNameFromPath(poFile);
    const sdRefs = scanner.findMethodReferences(poClassName, [config.stepDriversDir]);

    const testsUsingPo = allTests.filter(t =>
      t.stepDriversUsed.some(sd => {
        const sdClassName = toPascalCase(sd) + 'StepDriver';
        return sdRefs.some(ref => ref.includes(toKebabCase(sd)));
      })
    );

    if (testsUsingPo.length > 0) {
      impactedTests.push({
        source: poFile,
        type: 'page-object',
        tests: testsUsingPo.map(t => t.relativePath),
      });
    }
  }

  for (const sdFile of changedStepDrivers) {
    const sdName = sdFile
      .replace(/.*step-drivers\//, '')
      .replace(/-step-driver\.ts$/, '');

    const camelName = toCamelCase(sdName);
    const testsUsingSd = allTests.filter(t => t.stepDriversUsed.includes(camelName));

    if (testsUsingSd.length > 0) {
      impactedTests.push({
        source: sdFile,
        type: 'step-driver',
        tests: testsUsingSd.map(t => t.relativePath),
      });
    }
  }

  return {
    pr: { number: prNumber, title, url },
    summary: {
      totalFiles: (files ?? []).length,
      playwrightFiles: playwrightFiles.length,
      otherFiles: otherFiles.length,
    },
    playwrightChanges: {
      specs: changedSpecs,
      pageObjects: changedPageObjects,
      stepDrivers: changedStepDrivers,
      other: changedOtherSrc,
    },
    impactedTests,
    nonPlaywrightFiles: otherFiles,
  };
}

export async function getPrComments(config: McpConfig, prNumber: number, repo?: string) {
  const r = resolveRepo(config, repo);

  const commentsJson = gh(
    `api repos/${r}/pulls/${prNumber}/comments --jq '[.[] | {id: .id, path: .path, body: .body, user: .user.login, created_at: .created_at, line: .line, side: .side, in_reply_to_id: .in_reply_to_id}]'`,
    undefined,
  );

  let reviewComments: any[] = [];
  try {
    reviewComments = JSON.parse(commentsJson);
  } catch {
    // fallback: try without jq
    const raw = gh(`api repos/${r}/pulls/${prNumber}/comments`, undefined);
    const parsed = JSON.parse(raw);
    reviewComments = parsed.map((c: any) => ({
      id: c.id,
      path: c.path,
      body: c.body,
      user: c.user?.login,
      created_at: c.created_at,
      line: c.line,
      side: c.side,
      in_reply_to_id: c.in_reply_to_id,
    }));
  }

  // Also get issue comments (general PR discussion)
  let issueComments: any[] = [];
  try {
    const issueJson = gh(
      `api repos/${r}/issues/${prNumber}/comments --jq '[.[] | {id: .id, body: .body, user: .user.login, created_at: .created_at}]'`,
      undefined,
    );
    issueComments = JSON.parse(issueJson);
  } catch {
    try {
      const raw = gh(`api repos/${r}/issues/${prNumber}/comments`, undefined);
      const parsed = JSON.parse(raw);
      issueComments = parsed.map((c: any) => ({
        id: c.id,
        body: c.body,
        user: c.user?.login,
        created_at: c.created_at,
      }));
    } catch {
      // ignore
    }
  }

  return {
    prNumber,
    reviewComments,
    issueComments,
    totalReviewComments: reviewComments.length,
    totalIssueComments: issueComments.length,
  };
}

export async function listOpenPrs(config: McpConfig, repo?: string, author?: string, label?: string, limit?: number) {
  const r = resolveRepo(config, repo);
  const n = limit ?? 20;

  let filterArgs = '';
  if (author) filterArgs += ` --author ${author}`;
  if (label) filterArgs += ` --label "${label}"`;

  const json = gh(
    `pr list --state open --limit ${n}${filterArgs} --json number,title,author,createdAt,updatedAt,headRefName,isDraft,labels,reviewDecision,additions,deletions,changedFiles`,
    r,
  );

  const prs = JSON.parse(json);

  return {
    repo: r,
    count: prs.length,
    prs: prs.map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author?.login ?? pr.author,
      branch: pr.headRefName,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      labels: (pr.labels ?? []).map((l: any) => l.name),
      created: pr.createdAt,
      updated: pr.updatedAt,
      stats: {
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
      },
    })),
  };
}

export async function searchPrs(config: McpConfig, query: string, repo?: string, limit?: number) {
  const r = resolveRepo(config, repo);
  const n = limit ?? 20;

  const json = gh(
    `pr list --search "${query}" --limit ${n} --state all --json number,title,author,state,createdAt,headRefName,url,labels`,
    r,
  );

  const prs = JSON.parse(json);

  return {
    repo: r,
    query,
    count: prs.length,
    prs: prs.map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author?.login ?? pr.author,
      state: pr.state,
      branch: pr.headRefName,
      url: pr.url,
      labels: (pr.labels ?? []).map((l: any) => l.name),
      created: pr.createdAt,
    })),
  };
}

function extractClassNameFromPath(filePath: string): string {
  const basename = filePath.replace(/.*\//, '').replace(/\.ts$/, '');
  return toPascalCase(basename);
}

function toPascalCase(str: string): string {
  return str.split(/[-_\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

function toCamelCase(str: string): string {
  const parts = str.split(/[-_\s]+/);
  return parts[0].toLowerCase() + parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

function toKebabCase(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase();
}
