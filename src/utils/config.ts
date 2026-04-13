import path from 'node:path';

export interface McpConfig {
  projectRoot: string;
  playwrightDir: string;
  testsDir: string;
  srcDir: string;
  pageObjectsDir: string;
  stepDriversDir: string;
  docsDir: string;
  kubeConfigPath?: string;
  clusterUrl?: string;
  githubRepo?: string;
}

export function loadConfig(): McpConfig {
  const projectRoot = process.env.KUBEVIRT_PROJECT_ROOT
    ?? path.resolve(process.env.HOME ?? '', 'Developer/Projects/kubevirt-ui');

  const playwrightDir = path.join(projectRoot, 'playwright');

  return {
    projectRoot,
    playwrightDir,
    testsDir: path.join(playwrightDir, 'tests'),
    srcDir: path.join(playwrightDir, 'src'),
    pageObjectsDir: path.join(playwrightDir, 'src', 'page-objects'),
    stepDriversDir: path.join(playwrightDir, 'src', 'step-drivers'),
    docsDir: path.join(playwrightDir, 'docs'),
    kubeConfigPath: process.env.KUBECONFIG
      ?? path.join(playwrightDir, '.kubeconfigs', 'test-config'),
    clusterUrl: process.env.CLUSTER_URL,
    githubRepo: process.env.GITHUB_REPO,
  };
}
