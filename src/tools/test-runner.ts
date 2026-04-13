import { exec } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { McpConfig } from '../utils/config.js';

interface RunTestsParams {
  file?: string;
  grep?: string;
  grepInvert?: string;
  workers?: number;
  headed?: boolean;
  debug?: boolean;
  ui?: boolean;
  shard?: string;
  retries?: number;
  timeout?: number;
  skipCleanup?: boolean;
  dryRun?: boolean;
}

function buildCommand(config: McpConfig, params: RunTestsParams): { cmd: string; env: Record<string, string> } {
  const args: string[] = ['yarn', 'test-playwright'];

  if (params.file) {
    const filePath = params.file.startsWith('playwright/')
      ? params.file
      : params.file.includes('/')
        ? `playwright/tests/${params.file}`
        : `playwright/tests/**/${params.file}`;
    args.push(filePath);
  }

  if (params.grep) args.push('--grep', `"${params.grep}"`);
  if (params.grepInvert) args.push('--grep-invert', `"${params.grepInvert}"`);
  if (params.workers !== undefined) args.push(`--workers=${params.workers}`);
  if (params.headed) args.push('--headed');
  if (params.ui) args.push('--ui');
  if (params.shard) args.push(`--shard=${params.shard}`);
  if (params.retries !== undefined) args.push(`--retries=${params.retries}`);
  if (params.timeout !== undefined) args.push(`--timeout=${params.timeout}`);

  const env: Record<string, string> = {};
  if (params.debug) env['DEBUG'] = '1';
  if (params.skipCleanup) env['SKIP_TEST_CLEANUP'] = 'true';

  return { cmd: args.join(' '), env };
}

export async function runTests(config: McpConfig, params: RunTestsParams): Promise<any> {
  const { cmd, env } = buildCommand(config, params);

  if (params.dryRun) {
    return {
      dryRun: true,
      command: cmd,
      env: Object.keys(env).length > 0 ? env : undefined,
      workingDirectory: config.projectRoot,
      hint: 'Run this command from the project root, or set dryRun to false to execute.',
    };
  }

  const fullEnv = { ...process.env, ...env };
  const maxTimeout = 10 * 60 * 1000; // 10 minutes

  return new Promise((resolve) => {
    const child = exec(cmd, {
      cwd: config.projectRoot,
      env: fullEnv,
      timeout: maxTimeout,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = stdout.toString();
      const errOutput = stderr.toString();

      const passed = (output.match(/(\d+) passed/)?.[1]) ?? '0';
      const failed = (output.match(/(\d+) failed/)?.[1]) ?? '0';
      const skipped = (output.match(/(\d+) skipped/)?.[1]) ?? '0';
      const timedOut = (output.match(/(\d+) timed out/)?.[1]) ?? '0';
      const interrupted = (output.match(/(\d+) interrupted/)?.[1]) ?? '0';

      const lastLines = output.split('\n').slice(-30).join('\n');

      resolve({
        command: cmd,
        workingDirectory: config.projectRoot,
        exitCode: error?.code ?? (error ? 1 : 0),
        summary: {
          passed: parseInt(passed),
          failed: parseInt(failed),
          skipped: parseInt(skipped),
          timedOut: parseInt(timedOut),
          interrupted: parseInt(interrupted),
        },
        output: lastLines,
        stderr: errOutput ? errOutput.split('\n').slice(-15).join('\n') : undefined,
      });
    });
  });
}

export async function getTestResults(config: McpConfig, source?: string): Promise<any> {
  const junitPath = path.join(config.projectRoot, 'junit-results', 'junit.xml');
  const allureDir = path.join(config.playwrightDir, 'allure-results');
  const repoAllureDir = path.join(config.projectRoot, 'allure-results');

  const effectiveAllureDir = existsSync(allureDir) ? allureDir : existsSync(repoAllureDir) ? repoAllureDir : null;

  if (source === 'junit' || (!source && existsSync(junitPath))) {
    return parseJunitResults(junitPath);
  }

  if (source === 'allure' || (!source && effectiveAllureDir)) {
    return parseAllureResults(effectiveAllureDir!);
  }

  return {
    error: 'No test results found.',
    searched: [junitPath, allureDir, repoAllureDir],
    hint: 'Run tests first with run_tests, then call this tool.',
  };
}

function parseJunitResults(filePath: string): any {
  if (!existsSync(filePath)) {
    return { error: `JUnit file not found: ${filePath}` };
  }

  const xml = readFileSync(filePath, 'utf-8');

  const testsMatch = xml.match(/tests="(\d+)"/);
  const failuresMatch = xml.match(/failures="(\d+)"/);
  const errorsMatch = xml.match(/errors="(\d+)"/);
  const skippedMatch = xml.match(/skipped="(\d+)"/);
  const timeMatch = xml.match(/time="([\d.]+)"/);

  const failedTests: Array<{ name: string; classname: string; message: string }> = [];
  const failureRegex = /<testcase\s+name="([^"]+)"[^>]*classname="([^"]+)"[^>]*>[\s\S]*?<failure[^>]*message="([^"]*)"[\s\S]*?<\/testcase>/g;
  let match;
  while ((match = failureRegex.exec(xml)) !== null) {
    failedTests.push({
      name: match[1],
      classname: match[2],
      message: match[3].substring(0, 200),
    });
  }

  const stat = statSync(filePath);

  return {
    source: 'junit',
    file: filePath,
    generatedAt: stat.mtime.toISOString(),
    totals: {
      tests: parseInt(testsMatch?.[1] ?? '0'),
      failures: parseInt(failuresMatch?.[1] ?? '0'),
      errors: parseInt(errorsMatch?.[1] ?? '0'),
      skipped: parseInt(skippedMatch?.[1] ?? '0'),
      time: parseFloat(timeMatch?.[1] ?? '0'),
    },
    failedTests: failedTests.length > 0 ? failedTests : undefined,
  };
}

function parseAllureResults(dirPath: string): any {
  if (!existsSync(dirPath)) {
    return { error: `Allure results directory not found: ${dirPath}` };
  }

  const files = readdirSync(dirPath).filter(f => f.endsWith('-result.json'));
  if (files.length === 0) {
    return { error: 'No Allure result files found', directory: dirPath };
  }

  let passed = 0, failed = 0, broken = 0, skipped = 0;
  const failures: Array<{ name: string; status: string; message: string; duration: number }> = [];

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(path.join(dirPath, file), 'utf-8'));
      const status: string = data.status ?? 'unknown';

      if (status === 'passed') passed++;
      else if (status === 'failed') {
        failed++;
        failures.push({
          name: data.name ?? file,
          status,
          message: (data.statusDetails?.message ?? '').substring(0, 200),
          duration: data.stop && data.start ? data.stop - data.start : 0,
        });
      } else if (status === 'broken') {
        broken++;
        failures.push({
          name: data.name ?? file,
          status,
          message: (data.statusDetails?.message ?? '').substring(0, 200),
          duration: data.stop && data.start ? data.stop - data.start : 0,
        });
      } else if (status === 'skipped') skipped++;
    } catch {
      // skip malformed files
    }
  }

  const dirStat = statSync(dirPath);

  return {
    source: 'allure',
    directory: dirPath,
    lastModified: dirStat.mtime.toISOString(),
    totals: {
      total: files.length,
      passed,
      failed,
      broken,
      skipped,
    },
    failures: failures.length > 0 ? failures.slice(0, 20) : undefined,
  };
}
