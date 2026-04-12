function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

interface ScaffoldTestParams {
  feature: string;
  tier: 'gating' | 'tier1' | 'tier2';
  jiraIds?: string[];
  describeName?: string;
  testNames?: string[];
  tags?: string[];
  useSharedResources?: boolean;
}

export function scaffoldTest(params: ScaffoldTestParams): { filePath: string; content: string } {
  const {
    feature,
    tier,
    jiraIds = [],
    describeName,
    testNames = [],
    tags = [],
    useSharedResources = false,
  } = params;

  const kebab = toKebabCase(feature);
  const describe = describeName ?? toPascalCase(feature).replace(/([a-z])([A-Z])/g, '$1 $2');
  const filePath = `tests/${tier}/${kebab}/${kebab}.spec.ts`;

  const tierTag = tier === 'gating' ? '@gating' : `@${tier}`;
  const allTags = [tierTag, ...tags.filter(t => t !== tierTag)];
  const tagString = allTags.map(t => `'${t}'`).join(', ');

  const fixtures = useSharedResources
    ? 'steps, utils, sharedResources'
    : 'steps, utils, cleanup, testConfig';

  const tests = testNames.length > 0
    ? testNames
    : jiraIds.length > 0
      ? jiraIds.map(id => `ID(${id}) ${describe} scenario`)
      : [`${describe} basic scenario`];

  const testBlocks = tests.map((testName, idx) => {
    const jiraId = jiraIds[idx];
    const name = jiraId && !testName.includes(jiraId) ? `ID(${jiraId}) ${testName}` : testName;

    if (useSharedResources) {
      return `  test('${name}', async ({ ${fixtures} }) => {
    utils.withAllure({ suite: '${describe}', feature: '${toPascalCase(tier)}', tags: [${tagString}] });

    const vm = await sharedResources.getSharedVm({
      templateName: utils.TEMPLATE_METADATA_NAMES.RHEL9,
      running: true,
      prefix: 'shared-${kebab}',
    });

    // TODO: Navigate and perform read-only verifications
    await steps.virtualMachineDetail.navigateToVmDetail(vm.name, vm.namespace);

    // TODO: Add assertions
  });`;
    }

    return `  test('${name}', async ({ ${fixtures} }) => {
    utils.withAllure({ suite: '${describe}', feature: '${toPascalCase(tier)}', tags: [${tagString}] });

    const namespace = testConfig?.testNamespace || utils.EnvVariables.testNamespace;

    // TODO: Implement test steps
    await test.step('${jiraId ?? `Step 1`}: Setup', async () => {
      // Create resources, navigate to page
    });

    await test.step('${jiraId ?? `Step 2`}: Verify', async () => {
      // Perform assertions
    });
  });`;
  }).join('\n\n');

  const content = `/**
 * ${toPascalCase(tier)} tests: ${describe}
 */

import { expect, test } from '@/fixtures/scenario-test-fixture';

test.describe('${describe}', { tag: [${tagString}] }, () => {
  test.beforeEach(async ({ steps }) => {
    // TODO: Add navigation and common setup
  });

${testBlocks}
});
`;

  return { filePath, content };
}

interface ScaffoldPageObjectParams {
  name: string;
  baseClass?: 'BasePage' | 'PageCommons';
  urlPattern?: string;
}

export function scaffoldPageObject(params: ScaffoldPageObjectParams): { filePath: string; content: string } {
  const { name, baseClass = 'PageCommons', urlPattern } = params;

  const pascal = toPascalCase(name);
  const kebab = toKebabCase(name);
  const className = pascal.endsWith('Page') ? pascal : `${pascal}Page`;
  const filePath = `src/page-objects/${kebab}-page.ts`;

  const baseImport = baseClass === 'BasePage'
    ? `import BasePage from './base-page';`
    : `import PageCommons from './page-commons';`;

  const navMethod = urlPattern
    ? `
  async navigateToProject${pascal}(projectName: string): Promise<void> {
    await this.goTo(\`${urlPattern.replace('{namespace}', '${projectName}')}\`);
  }

  async navigateToAllNamespaces${pascal}(): Promise<void> {
    await this.goTo('${urlPattern.replace('/ns/{namespace}', '/all-namespaces')}');
  }
`
    : `
  // TODO: Add navigation methods
`;

  const content = `/**
 * Page object for the ${pascal.replace(/([a-z])([A-Z])/g, '$1 $2')} page.
 */

import { TestTimeouts } from '@/utils/test-config';
import { Page } from '@playwright/test';

${baseImport}

export default class ${className} extends ${baseClass} {
  constructor(page: Page) {
    super(page);
  }
${navMethod}
  // TODO: Add locators as private readonly properties
  // private readonly _exampleButton = this.locator('[data-test="example-button"]');

  // TODO: Add interaction methods
}
`;

  return { filePath, content };
}

interface ScaffoldStepDriverParams {
  feature: string;
  pageObjectName?: string;
}

export function scaffoldStepDriver(params: ScaffoldStepDriverParams): { filePath: string; content: string } {
  const { feature, pageObjectName } = params;

  const pascal = toPascalCase(feature);
  const kebab = toKebabCase(feature);
  const className = `${pascal}StepDriver`;

  const poName = pageObjectName ?? `${pascal}Page`;
  const poKebab = toKebabCase(poName.replace(/Page$/, ''));
  const filePath = `src/step-drivers/${kebab}-step-driver.ts`;

  const content = `import ${poName} from '@/page-objects/${poKebab}-page';
import { Page } from '@playwright/test';

import BasePageStepDriver from './base-page-step-driver';

/**
 * StepDriver for ${pascal.replace(/([a-z])([A-Z])/g, '$1 $2')} operations.
 *
 * @example
 * \`\`\`typescript
 * const ${toCamelCase(feature)} = ${className}.Init(page);
 * \`\`\`
 *
 * @since 1.0.0
 */
export default class ${className} extends BasePageStepDriver<${poName}> {
  constructor(page: Page) {
    super(page, ${poName});
  }

  // TODO: Add step methods following this pattern:
  //
  // async navigateTo${pascal}(): Promise<void> {
  //   return await this.step('Navigate to ${pascal.replace(/([a-z])([A-Z])/g, '$1 $2')}', async () => {
  //     await this.pageObject.navigateToProject${pascal}(projectName);
  //   });
  // }
  //
  // async verifySomething(): Promise<boolean> {
  //   return await this.step('Verify something', async () => {
  //     return await this.pageObject.verifySomething();
  //   });
  // }
}
`;

  return { filePath, content };
}

interface ScaffoldStdParams {
  feature: string;
  tier: 'gating' | 'tier1' | 'tier2';
  jiraIds?: string[];
  testCases?: Array<{ title: string; steps: Array<{ action: string; expected: string }> }>;
}

export function scaffoldStd(params: ScaffoldStdParams): { filePath: string; content: string } {
  const { feature, tier, jiraIds = [], testCases = [] } = params;

  const pascal = toPascalCase(feature);
  const kebab = toKebabCase(feature);
  const humanName = pascal.replace(/([a-z])([A-Z])/g, '$1 $2');
  const filePath = `docs/${tier}/${kebab}.md`;

  const relatedIds = jiraIds.length > 0
    ? jiraIds.map(id => `[${id}](https://issues.redhat.com/browse/${id})`).join(', ')
    : 'N/A';

  const today = new Date().toISOString().split('T')[0];
  const specPath = `tests/${tier}/${kebab}/${kebab}.spec.ts`;

  let testCaseSection: string;

  if (testCases.length > 0) {
    testCaseSection = testCases.map((tc, idx) => {
      const num = String(idx + 1).padStart(3, '0');
      const stepsTable = tc.steps.map((s, sIdx) =>
        `| ${sIdx + 1} | ${s.action} | ${s.expected} |`
      ).join('\n');

      return `### \`${num}\`: ${tc.title}
*   **Objective:** Verify ${tc.title.toLowerCase()}.
*   **Pre-conditions:** User is authenticated and on the ${humanName} page.

| Step | Action | Expected Result |
| :--- | :--- | :--- |
${stepsTable}

---`;
    }).join('\n\n');
  } else {
    testCaseSection = `### \`001\`: [Test case title]
*   **Objective:** [Describe the specific goal.]
*   **Pre-conditions:** User is authenticated and on the ${humanName} page.

| Step | Action | Expected Result |
| :--- | :--- | :--- |
| 1 | [Action] | [Expected result] |

---`;
  }

  const traceabilityRows = jiraIds.length > 0
    ? jiraIds.map((id, idx) =>
        `| ${id} | \`${String(idx + 1).padStart(3, '0')}\` | \`${specPath}\` |`
      ).join('\n')
    : `| N/A | \`001\` | \`${specPath}\` |`;

  const content = `# Software Test Description (STD): ${humanName} (${toPascalCase(tier)})

## 1. Project Overview
*   **Project Name:** OpenShift Virtualization (CNV)
*   **Feature Area:** ${toPascalCase(tier)} -- ${humanName}
*   **Related IDs:** ${relatedIds}
*   **Date:** ${today}
*   **Document Status:** Draft

## 2. Introduction
### 2.1 Purpose
Documents \`playwright/${specPath}\`: ${humanName} test scenarios.

### 2.2 Scope
*   **In-Scope:** ${humanName} page functionality, CRUD operations, navigation.
*   **Out-of-Scope:** Other feature areas not covered by this spec file.

## 3. Test Environment & Prerequisites
*   **Environment:** OpenShift with OpenShift Virtualization.
*   **Configuration:** Standard test namespace with required permissions.
*   **Initial Setup:**
    *   Authenticated user with appropriate permissions
    *   Test namespace created and accessible

## 4. Test Case Definitions

*Automation:* \`${specPath}\`

${testCaseSection}

## 5. Requirements Traceability Matrix

| Requirement ID | Test Case ID | Automation (Spec) |
| :--- | :--- | :--- |
${traceabilityRows}
`;

  return { filePath, content };
}
