import fs from 'node:fs';
import path from 'node:path';

import type { McpConfig } from './config.js';

export interface TestFileInfo {
  filePath: string;
  relativePath: string;
  tier: string;
  feature: string;
  jiraIds: string[];
  testNames: string[];
  describeTitles: string[];
  tags: string[];
  stepDriversUsed: string[];
}

export interface MethodInfo {
  name: string;
  filePath: string;
  className: string;
  lineNumber: number;
  isAsync: boolean;
  visibility: 'public' | 'protected' | 'private';
}

export interface SelectorInfo {
  selector: string;
  type: 'data-test' | 'data-test-id' | 'role' | 'css' | 'text';
  filePath: string;
  className: string;
  lineNumber: number;
}

function walkDir(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...walkDir(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

export class ProjectScanner {
  private config: McpConfig;
  private testFilesCache: TestFileInfo[] | null = null;
  private poMethodsCache: MethodInfo[] | null = null;
  private sdMethodsCache: MethodInfo[] | null = null;

  constructor(config: McpConfig) {
    this.config = config;
  }

  invalidateCache(): void {
    this.testFilesCache = null;
    this.poMethodsCache = null;
    this.sdMethodsCache = null;
  }

  scanTestFiles(): TestFileInfo[] {
    if (this.testFilesCache) return this.testFilesCache;

    const specFiles = walkDir(this.config.testsDir, '.spec.ts');
    this.testFilesCache = specFiles.map(f => this.parseTestFile(f));
    return this.testFilesCache;
  }

  private parseTestFile(filePath: string): TestFileInfo {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.config.playwrightDir, filePath);

    const tierMatch = relativePath.match(/tests\/(gating|tier1|tier2|fleet-virtualization-acm)\//);
    const tier = tierMatch?.[1] ?? 'unknown';

    const featureParts = relativePath.split('/').slice(2, -1);
    const feature = featureParts.join('/') || path.basename(filePath, '.spec.ts');

    const jiraIds = [...content.matchAll(/ID\((CNV-\d+)\)/g)].map(m => m[1]);

    const testNames = [...content.matchAll(/test\(\s*'([^']+)'/g)].map(m => m[1]);
    const testNamesDouble = [...content.matchAll(/test\(\s*"([^"]+)"/g)].map(m => m[1]);
    const testNamesBacktick = [...content.matchAll(/test\(\s*`([^`]+)`/g)].map(m => m[1]);

    const describeTitles = [
      ...[...content.matchAll(/test\.describe(?:\.serial)?\(\s*'([^']+)'/g)].map(m => m[1]),
      ...[...content.matchAll(/test\.describe(?:\.serial)?\(\s*"([^"]+)"/g)].map(m => m[1]),
    ];

    const tagMatches = [...content.matchAll(/tag:\s*\[([^\]]+)\]/g)];
    const tags = tagMatches.flatMap(m =>
      m[1].split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean)
    );

    const stepDriversUsed = [
      ...new Set(
        [...content.matchAll(/steps\.(\w+)\./g)].map(m => m[1])
      ),
    ];

    return {
      filePath,
      relativePath,
      tier,
      feature,
      jiraIds,
      testNames: [...testNames, ...testNamesDouble, ...testNamesBacktick],
      describeTitles,
      tags,
      stepDriversUsed,
    };
  }

  scanMethods(dir: string): MethodInfo[] {
    const files = walkDir(dir, '.ts');
    return files.flatMap(f => this.parseClassMethods(f));
  }

  scanPageObjectMethods(): MethodInfo[] {
    if (this.poMethodsCache) return this.poMethodsCache;
    this.poMethodsCache = this.scanMethods(this.config.pageObjectsDir);
    return this.poMethodsCache;
  }

  scanStepDriverMethods(): MethodInfo[] {
    if (this.sdMethodsCache) return this.sdMethodsCache;
    this.sdMethodsCache = this.scanMethods(this.config.stepDriversDir);
    return this.sdMethodsCache;
  }

  private parseClassMethods(filePath: string): MethodInfo[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const methods: MethodInfo[] = [];

    const classMatch = content.match(/(?:export\s+)?(?:default\s+)?class\s+(\w+)/);
    const className = classMatch?.[1] ?? path.basename(filePath, '.ts');

    const methodPattern = /^\s*(public\s+|protected\s+|private\s+)?(async\s+)?(\w+)\s*\(/;
    const arrowPropPattern = /^\s*(public\s+|protected\s+|private\s+)?(readonly\s+)?(\w+)\s*=\s*(async\s+)?\(/;
    const getterPattern = /^\s*(public\s+|protected\s+|private\s+)?get\s+(\w+)\s*\(\)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      let match = line.match(methodPattern);
      if (match) {
        const vis = (match[1]?.trim() ?? 'public') as MethodInfo['visibility'];
        if (match[3] === 'constructor' || match[3] === 'if' || match[3] === 'for'
          || match[3] === 'while' || match[3] === 'switch' || match[3] === 'catch'
          || match[3] === 'return' || match[3] === 'throw' || match[3] === 'await'
          || match[3] === 'try') continue;
        methods.push({
          name: match[3],
          filePath,
          className,
          lineNumber: i + 1,
          isAsync: !!match[2],
          visibility: vis,
        });
        continue;
      }

      match = line.match(arrowPropPattern);
      if (match) {
        const vis = (match[1]?.trim() ?? 'public') as MethodInfo['visibility'];
        methods.push({
          name: match[3],
          filePath,
          className,
          lineNumber: i + 1,
          isAsync: !!match[4],
          visibility: vis,
        });
        continue;
      }

      match = line.match(getterPattern);
      if (match) {
        const vis = (match[1]?.trim() ?? 'public') as MethodInfo['visibility'];
        methods.push({
          name: match[2],
          filePath,
          className,
          lineNumber: i + 1,
          isAsync: false,
          visibility: vis,
        });
      }
    }

    return methods;
  }

  findMethodReferences(methodName: string, searchDirs: string[]): string[] {
    const references: string[] = [];

    for (const dir of searchDirs) {
      const files = walkDir(dir, '.ts');
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        const pattern = new RegExp(`\\.${methodName}\\s*\\(`, 'g');
        if (pattern.test(content)) {
          references.push(path.relative(this.config.playwrightDir, file));
        }
      }
    }

    return references;
  }

  scanSelectors(): SelectorInfo[] {
    const files = walkDir(this.config.pageObjectsDir, '.ts');
    const selectors: SelectorInfo[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      const classMatch = content.match(/class\s+(\w+)/);
      const className = classMatch?.[1] ?? path.basename(file, '.ts');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const m of line.matchAll(/\[data-test="([^"]+)"\]/g)) {
          selectors.push({ selector: m[1], type: 'data-test', filePath: file, className, lineNumber: i + 1 });
        }
        for (const m of line.matchAll(/\[data-test-id="([^"]+)"\]/g)) {
          selectors.push({ selector: m[1], type: 'data-test-id', filePath: file, className, lineNumber: i + 1 });
        }
        for (const m of line.matchAll(/\[role="([^"]+)"\]/g)) {
          selectors.push({ selector: m[1], type: 'role', filePath: file, className, lineNumber: i + 1 });
        }
      }
    }

    return selectors;
  }

  scanDocsForFeature(feature: string): string[] {
    if (!fs.existsSync(this.config.docsDir)) return [];

    const mdFiles = walkDir(this.config.docsDir, '.md');
    const matches: string[] = [];
    const featureLower = feature.toLowerCase();

    for (const file of mdFiles) {
      const relativePath = path.relative(this.config.playwrightDir, file);
      const content = fs.readFileSync(file, 'utf-8').toLowerCase();
      if (relativePath.toLowerCase().includes(featureLower) || content.includes(featureLower)) {
        matches.push(relativePath);
      }
    }

    return matches;
  }
}
