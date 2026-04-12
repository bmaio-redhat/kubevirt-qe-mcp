import * as k8s from '@kubernetes/client-node';

import type { McpConfig } from '../utils/config.js';

let kubeClient: {
  coreV1: k8s.CoreV1Api;
  customObjects: k8s.CustomObjectsApi;
  kc: k8s.KubeConfig;
} | null = null;

function getClient(config: McpConfig) {
  if (kubeClient) return kubeClient;

  const kc = new k8s.KubeConfig();

  if (config.kubeConfigPath) {
    try {
      kc.loadFromFile(config.kubeConfigPath);
    } catch {
      kc.loadFromDefault();
    }
  } else {
    kc.loadFromDefault();
  }

  kubeClient = {
    coreV1: kc.makeApiClient(k8s.CoreV1Api),
    customObjects: kc.makeApiClient(k8s.CustomObjectsApi),
    kc,
  };

  return kubeClient;
}

export function resetClient(): void {
  kubeClient = null;
}

export async function getClusterInfo(config: McpConfig) {
  const client = getClient(config);
  const info: Record<string, string> = {};

  info.clusterUrl = client.kc.getCurrentCluster()?.server ?? 'unknown';

  try {
    const nodes = await client.coreV1.listNode();
    const node = (nodes as any).items?.[0];
    if (node?.status?.nodeInfo) {
      info.kubernetesVersion = node.status.nodeInfo.kubeletVersion;
    }
    info.nodeCount = String((nodes as any).items?.length ?? 0);
  } catch (e: any) {
    info.kubernetesVersion = `error: ${e.body?.message ?? e.message ?? e}`;
  }

  try {
    const kubevirt = await client.customObjects.getNamespacedCustomObject({
      group: 'kubevirt.io',
      version: 'v1',
      namespace: 'openshift-cnv',
      plural: 'kubevirts',
      name: 'kubevirt-kubevirt-hyperconverged',
    }) as any;
    info.kubevirtVersion = kubevirt?.status?.observedKubeVirtVersion ?? 'unknown';
  } catch {
    try {
      const list = await client.customObjects.listClusterCustomObject({
        group: 'kubevirt.io',
        version: 'v1',
        plural: 'kubevirts',
      }) as any;
      if (list?.items?.[0]?.status?.observedKubeVirtVersion) {
        info.kubevirtVersion = list.items[0].status.observedKubeVirtVersion;
      }
    } catch {
      info.kubevirtVersion = 'not found';
    }
  }

  try {
    const csv = await client.customObjects.listNamespacedCustomObject({
      group: 'operators.coreos.com',
      version: 'v1alpha1',
      namespace: 'openshift-cnv',
      plural: 'clusterserviceversions',
    }) as any;
    const cnvCsv = csv?.items?.find((item: any) =>
      item.metadata?.name?.startsWith('kubevirt-hyperconverged-operator')
    );
    if (cnvCsv) {
      info.cnvVersion = cnvCsv.spec?.version ?? cnvCsv.metadata?.name ?? 'unknown';
    }
  } catch {
    info.cnvVersion = 'not found';
  }

  try {
    const cdi = await client.customObjects.listClusterCustomObject({
      group: 'cdi.kubevirt.io',
      version: 'v1beta1',
      plural: 'cdis',
    }) as any;
    if (cdi?.items?.[0]?.status?.observedVersion) {
      info.cdiVersion = cdi.items[0].status.observedVersion;
    }
  } catch {
    info.cdiVersion = 'not found';
  }

  return info;
}

export async function listVms(config: McpConfig, namespace?: string) {
  const client = getClient(config);

  try {
    let result: any;
    if (namespace) {
      result = await client.customObjects.listNamespacedCustomObject({
        group: 'kubevirt.io',
        version: 'v1',
        namespace,
        plural: 'virtualmachines',
      });
    } else {
      result = await client.customObjects.listClusterCustomObject({
        group: 'kubevirt.io',
        version: 'v1',
        plural: 'virtualmachines',
      });
    }

    return (result?.items ?? []).map((vm: any) => ({
      name: vm.metadata?.name,
      namespace: vm.metadata?.namespace,
      status: vm.status?.printableStatus ?? vm.status?.conditions?.[0]?.type ?? 'Unknown',
      created: vm.metadata?.creationTimestamp,
      running: vm.spec?.running ?? vm.spec?.runStrategy === 'Always',
      runStrategy: vm.spec?.runStrategy ?? (vm.spec?.running ? 'Always' : 'Manual'),
      cpu: vm.spec?.template?.spec?.domain?.cpu?.cores ?? 'N/A',
      memory: vm.spec?.template?.spec?.domain?.resources?.requests?.memory ?? 'N/A',
      labels: vm.metadata?.labels ?? {},
    }));
  } catch (e: any) {
    throw new Error(`Failed to list VMs: ${e.body?.message ?? e.message ?? e}`);
  }
}

export async function getVmDetail(config: McpConfig, name: string, namespace: string) {
  const client = getClient(config);

  try {
    const vm = await client.customObjects.getNamespacedCustomObject({
      group: 'kubevirt.io',
      version: 'v1',
      namespace,
      plural: 'virtualmachines',
      name,
    }) as any;

    let vmi: any = null;
    try {
      vmi = await client.customObjects.getNamespacedCustomObject({
        group: 'kubevirt.io',
        version: 'v1',
        namespace,
        plural: 'virtualmachineinstances',
        name,
      });
    } catch {
      // VMI may not exist if VM is stopped
    }

    const volumes = vm?.spec?.template?.spec?.volumes?.map((v: any) => ({
      name: v.name,
      type: Object.keys(v).find(k => k !== 'name') ?? 'unknown',
      source: v[Object.keys(v).find(k => k !== 'name') ?? ''],
    })) ?? [];

    const networks = vm?.spec?.template?.spec?.networks?.map((n: any) => ({
      name: n.name,
      type: Object.keys(n).find(k => k !== 'name') ?? 'unknown',
    })) ?? [];

    return {
      name: vm?.metadata?.name,
      namespace: vm?.metadata?.namespace,
      status: vm?.status?.printableStatus ?? 'Unknown',
      conditions: vm?.status?.conditions ?? [],
      running: vm?.spec?.running,
      runStrategy: vm?.spec?.runStrategy,
      created: vm?.metadata?.creationTimestamp,
      labels: vm?.metadata?.labels ?? {},
      annotations: vm?.metadata?.annotations ?? {},
      cpu: vm?.spec?.template?.spec?.domain?.cpu,
      memory: vm?.spec?.template?.spec?.domain?.resources?.requests?.memory,
      volumes,
      networks,
      interfaces: vm?.spec?.template?.spec?.domain?.devices?.interfaces ?? [],
      vmi: vmi ? {
        phase: (vmi as any).status?.phase,
        nodeName: (vmi as any).status?.nodeName,
        ipAddresses: (vmi as any).status?.interfaces?.map((i: any) => i.ipAddress).filter(Boolean) ?? [],
        guestOS: (vmi as any).status?.guestOSInfo,
      } : null,
    };
  } catch (e: any) {
    throw new Error(`Failed to get VM detail: ${e.body?.message ?? e.message ?? e}`);
  }
}

interface TestNamespaceInfo {
  name: string;
  status: string | undefined;
  created: string | Date | undefined;
  ageHours: number;
  labels: Record<string, string>;
}

export async function listTestNamespaces(config: McpConfig) {
  const client = getClient(config);

  try {
    const nsList = await client.coreV1.listNamespace() as any;

    const testNamespaces: TestNamespaceInfo[] = (nsList.items ?? [])
      .filter((ns: any) => ns.metadata?.name?.startsWith('pw-'))
      .map((ns: any) => {
        const created = ns.metadata?.creationTimestamp;
        const ageMs = created ? Date.now() - new Date(created).getTime() : 0;
        const ageHours = Math.round(ageMs / (1000 * 60 * 60) * 10) / 10;

        return {
          name: ns.metadata?.name,
          status: ns.status?.phase,
          created,
          ageHours,
          labels: ns.metadata?.labels ?? {},
        };
      })
      .sort((a: TestNamespaceInfo, b: TestNamespaceInfo) => b.ageHours - a.ageHours);

    return {
      count: testNamespaces.length,
      namespaces: testNamespaces,
    };
  } catch (e: any) {
    throw new Error(`Failed to list namespaces: ${e.body?.message ?? e.message ?? e}`);
  }
}

export async function cleanupStaleNamespaces(config: McpConfig, olderThanHours: number = 4) {
  const client = getClient(config);
  const { namespaces } = await listTestNamespaces(config);

  const stale = namespaces.filter(ns => ns.ageHours > olderThanHours);

  if (stale.length === 0) {
    return {
      message: `No stale namespaces older than ${olderThanHours}h found`,
      deleted: [] as string[],
      failed: [] as Array<{ name: string; error: string }>,
    };
  }

  const deleted: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const ns of stale) {
    try {
      await client.coreV1.deleteNamespace({ name: ns.name });
      deleted.push(ns.name);
    } catch (e: any) {
      failed.push({ name: ns.name, error: e.body?.message ?? e.message ?? String(e) });
    }
  }

  return {
    message: `Cleaned up ${deleted.length} of ${stale.length} stale namespaces`,
    deleted,
    failed,
  };
}

export async function checkClusterHealth(config: McpConfig) {
  const client = getClient(config);
  const checks: Array<{ check: string; status: 'ok' | 'warning' | 'error'; detail: string }> = [];

  // API server reachable
  try {
    await client.coreV1.listNamespace({ limit: 1 });
    checks.push({ check: 'API Server', status: 'ok', detail: 'Reachable' });
  } catch (e: any) {
    checks.push({ check: 'API Server', status: 'error', detail: e.message ?? String(e) });
    return { healthy: false, checks };
  }

  // CNV operator running
  try {
    const pods = await client.coreV1.listNamespacedPod({ namespace: 'openshift-cnv' }) as any;
    const operatorPods = (pods.items ?? []).filter((p: any) =>
      p.metadata?.name?.includes('hyperconverged') || p.metadata?.name?.includes('hco-operator')
    );
    const runningOperators = operatorPods.filter((p: any) => p.status?.phase === 'Running');
    if (runningOperators.length > 0) {
      checks.push({ check: 'CNV Operator', status: 'ok', detail: `${runningOperators.length} pod(s) running` });
    } else {
      checks.push({ check: 'CNV Operator', status: 'warning', detail: 'No running operator pods found' });
    }
  } catch {
    checks.push({ check: 'CNV Operator', status: 'warning', detail: 'Could not check openshift-cnv namespace' });
  }

  // virt-api available
  try {
    const pods = await client.coreV1.listNamespacedPod({ namespace: 'openshift-cnv' }) as any;
    const virtApiPods = (pods.items ?? []).filter((p: any) => p.metadata?.name?.startsWith('virt-api'));
    const running = virtApiPods.filter((p: any) => p.status?.phase === 'Running');
    checks.push({
      check: 'virt-api',
      status: running.length > 0 ? 'ok' : 'warning',
      detail: `${running.length}/${virtApiPods.length} pods running`,
    });
  } catch {
    checks.push({ check: 'virt-api', status: 'warning', detail: 'Could not check' });
  }

  // Storage classes available
  try {
    const storageApi = client.kc.makeApiClient(k8s.StorageV1Api);
    const scList = await storageApi.listStorageClass() as any;
    const scNames: string[] = (scList.items ?? []).map((sc: any) => sc.metadata?.name).filter(Boolean);
    const hasVirt = scNames.some(n => n.includes('ceph') || n.includes('rbd') || n.includes('virt'));
    checks.push({
      check: 'Storage Classes',
      status: hasVirt ? 'ok' : 'warning',
      detail: `${scNames.length} classes found${hasVirt ? ' (virtualization-ready)' : ' (no virt-optimized SC detected)'}`,
    });
  } catch {
    checks.push({ check: 'Storage Classes', status: 'warning', detail: 'Could not list storage classes' });
  }

  // Nodes ready
  try {
    const nodes = await client.coreV1.listNode() as any;
    const allNodes: any[] = nodes.items ?? [];
    const ready = allNodes.filter((n: any) =>
      n.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True')
    );
    checks.push({
      check: 'Nodes',
      status: ready.length === allNodes.length ? 'ok' : 'warning',
      detail: `${ready.length}/${allNodes.length} nodes ready`,
    });
  } catch {
    checks.push({ check: 'Nodes', status: 'warning', detail: 'Could not list nodes' });
  }

  // Test namespace resources
  try {
    const { count } = await listTestNamespaces(config);
    checks.push({
      check: 'Test Namespaces',
      status: count > 20 ? 'warning' : 'ok',
      detail: `${count} pw-* namespaces exist${count > 20 ? ' (consider cleanup)' : ''}`,
    });
  } catch {
    checks.push({ check: 'Test Namespaces', status: 'warning', detail: 'Could not list namespaces' });
  }

  const healthy = checks.every(c => c.status !== 'error');

  return { healthy, checks };
}
