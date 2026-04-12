import path from 'node:path';

import type { McpConfig } from '../utils/config.js';
import type { ProjectScanner } from '../utils/project-scanner.js';

const FEATURE_ALIASES: Record<string, string[]> = {
  'virtual-machines': ['virtualmachines', 'vm-', 'virtual-machine'],
  'vm-detail': ['virtual-machine-detail', 'vm-tabs', 'vm-overview', 'vm-console', 'vm-configuration'],
  'vm-actions': ['vm-lifecycle', 'vm-resource', 'vm-migration'],
  'bootable-volumes': ['bootable-volume', 'bootable_volume'],
  'catalog': ['catalog'],
  'templates': ['template'],
  'instance-types': ['instancetype', 'instance-type'],
  'overview': ['overview'],
  'networking': ['network', 'nad', 'udn', 'nnc'],
  'migration-policies': ['migration-polic', 'migrationpolic'],
  'checkups': ['checkup'],
  'quotas': ['quota', 'aaq'],
  'settings': ['cluster-settings', 'user-settings'],
  'storage-migration': ['storage_migration', 'storage-migration'],
};

function featureMatches(text: string, feature: string): boolean {
  const lower = text.toLowerCase();
  const featureLower = feature.toLowerCase();

  if (lower.includes(featureLower)) return true;

  const aliases = FEATURE_ALIASES[featureLower]
    ?? Object.entries(FEATURE_ALIASES)
      .find(([, v]) => v.some(a => a === featureLower))?.[1]
    ?? [];

  return aliases.some(alias => lower.includes(alias));
}

export function getCoverageForFeature(scanner: ProjectScanner, config: McpConfig, feature: string) {
  const tests = scanner.scanTestFiles();
  const allSdMethods = scanner.scanStepDriverMethods();
  const allPoMethods = scanner.scanPageObjectMethods();

  const matchingTests = tests.filter(t =>
    featureMatches(t.relativePath, feature)
    || t.describeTitles.some(d => featureMatches(d, feature))
    || t.feature.toLowerCase().includes(feature.toLowerCase())
    || t.tags.some(tag => featureMatches(tag, feature))
  );

  const usedStepDriverNames = new Set(matchingTests.flatMap(t => t.stepDriversUsed));

  const relatedStepDrivers = allSdMethods
    .filter(m => usedStepDriverNames.has(toCamelCase(m.className.replace(/StepDriver$/, ''))))
    .reduce((acc, m) => {
      const relPath = path.relative(config.playwrightDir, m.filePath);
      if (!acc.includes(relPath)) acc.push(relPath);
      return acc;
    }, [] as string[]);

  const relatedPageObjects = allPoMethods
    .filter(m => featureMatches(m.className, feature) || featureMatches(m.filePath, feature))
    .reduce((acc, m) => {
      const relPath = path.relative(config.playwrightDir, m.filePath);
      if (!acc.includes(relPath)) acc.push(relPath);
      return acc;
    }, [] as string[]);

  const relatedDocs = scanner.scanDocsForFeature(feature);

  const allJiraIds = [...new Set(matchingTests.flatMap(t => t.jiraIds))];

  return {
    feature,
    totalTests: matchingTests.reduce((sum, t) => sum + t.testNames.length, 0),
    specFiles: matchingTests.map(t => ({
      path: t.relativePath,
      tier: t.tier,
      tests: t.testNames,
      jiraIds: t.jiraIds,
      tags: t.tags,
    })),
    stepDrivers: relatedStepDrivers,
    pageObjects: relatedPageObjects,
    docs: relatedDocs,
    jiraIds: allJiraIds,
    stepDriversUsed: [...usedStepDriverNames],
  };
}

function toCamelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

export function getUntestedStepDriverMethods(scanner: ProjectScanner, config: McpConfig) {
  const sdMethods = scanner.scanStepDriverMethods()
    .filter(m => m.visibility === 'public' && !m.name.startsWith('_'));

  const specFiles = [config.testsDir, config.stepDriversDir];
  const untested: Array<{ method: string; className: string; file: string; line: number }> = [];

  for (const method of sdMethods) {
    const refs = scanner.findMethodReferences(method.name, specFiles);
    const selfFile = path.relative(config.playwrightDir, method.filePath);
    const externalRefs = refs.filter(r => r !== selfFile);

    if (externalRefs.length === 0) {
      untested.push({
        method: method.name,
        className: method.className,
        file: path.relative(config.playwrightDir, method.filePath),
        line: method.lineNumber,
      });
    }
  }

  return {
    totalPublicMethods: sdMethods.length,
    untestedCount: untested.length,
    coveragePercent: sdMethods.length > 0
      ? Math.round(((sdMethods.length - untested.length) / sdMethods.length) * 100)
      : 100,
    untestedMethods: untested,
  };
}

export function getOrphanPageObjectMethods(scanner: ProjectScanner, config: McpConfig) {
  const poMethods = scanner.scanPageObjectMethods()
    .filter(m => m.visibility === 'public' && !m.name.startsWith('_'));

  const searchDirs = [config.stepDriversDir, config.testsDir];
  const orphans: Array<{ method: string; className: string; file: string; line: number }> = [];

  for (const method of poMethods) {
    const refs = scanner.findMethodReferences(method.name, searchDirs);
    if (refs.length === 0) {
      orphans.push({
        method: method.name,
        className: method.className,
        file: path.relative(config.playwrightDir, method.filePath),
        line: method.lineNumber,
      });
    }
  }

  return {
    totalPublicMethods: poMethods.length,
    orphanCount: orphans.length,
    coveragePercent: poMethods.length > 0
      ? Math.round(((poMethods.length - orphans.length) / poMethods.length) * 100)
      : 100,
    orphanMethods: orphans,
  };
}

export function getTierDistribution(scanner: ProjectScanner) {
  const tests = scanner.scanTestFiles();

  const tiers: Record<string, { fileCount: number; testCount: number; jiraIds: string[]; files: string[] }> = {};

  for (const test of tests) {
    if (!tiers[test.tier]) {
      tiers[test.tier] = { fileCount: 0, testCount: 0, jiraIds: [], files: [] };
    }
    tiers[test.tier].fileCount++;
    tiers[test.tier].testCount += test.testNames.length;
    tiers[test.tier].jiraIds.push(...test.jiraIds);
    tiers[test.tier].files.push(test.relativePath);
  }

  for (const tier of Object.values(tiers)) {
    tier.jiraIds = [...new Set(tier.jiraIds)];
  }

  const totalTests = Object.values(tiers).reduce((sum, t) => sum + t.testCount, 0);
  const totalFiles = Object.values(tiers).reduce((sum, t) => sum + t.fileCount, 0);

  return {
    totalFiles,
    totalTests,
    tiers,
  };
}

export function findTestsByJira(scanner: ProjectScanner, ticketId: string) {
  const normalized = ticketId.toUpperCase().replace(/\s/g, '');
  const tests = scanner.scanTestFiles();

  const matches = tests.filter(t =>
    t.jiraIds.some(id => id.toUpperCase() === normalized)
  );

  if (matches.length === 0) {
    return {
      ticketId: normalized,
      found: false,
      message: `No tests found for ${normalized}`,
      tests: [],
    };
  }

  return {
    ticketId: normalized,
    found: true,
    tests: matches.map(t => ({
      file: t.relativePath,
      tier: t.tier,
      feature: t.feature,
      tests: t.testNames.filter(name => {
        const testContent = name;
        return testContent.includes(normalized) || t.jiraIds.includes(normalized);
      }),
      allTestsInFile: t.testNames,
      tags: t.tags,
    })),
  };
}
