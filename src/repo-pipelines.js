const WORKFLOW_FILE = /\.ya?ml$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const SAFE_HOST_LABEL = /^[A-Za-z0-9-]+$/;

const OTHER_CI_HOSTS = [
  { host: /(^|\.)circleci\.com$/i, kind: 'circleci', label: 'circle', title: 'CircleCI' },
  { host: /(^|\.)buildkite\.com$/i, kind: 'buildkite', label: 'buildkite', title: 'Buildkite' },
  { host: /(^|\.)gitlab\.com$/i, kind: 'gitlab', label: 'gitlab', title: 'GitLab CI' },
  { host: /travis-ci\.(com|org)$/i, kind: 'travis', label: 'travis', title: 'Travis CI' },
  { host: /(^|\.)harness\.io$/i, kind: 'harness', label: 'harness', title: 'Harness' },
  { host: /(^|\.)teamcity\./i, kind: 'teamcity', label: 'teamcity', title: 'TeamCity' },
  { host: /(^|\.)jenkins\./i, kind: 'jenkins', label: 'jenkins', title: 'Jenkins' },
];

const KIND_ORDER = { azure: 0, actions: 1 };

const httpsUrl = (value) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
};

const pathSegment = (value) => (SAFE_SEGMENT.test(value) ? value : encodeURIComponent(value));

const pipelineName = (name) => String(name || '').split(' (')[0].trim();

const numericId = (value) => (/^\d+$/.test(value || '') ? value : '');

const queryDefinitionId = (parsed) => {
  for (const [key, value] of parsed.searchParams) {
    if (key.toLowerCase() === 'definitionid') return numericId(value);
  }
  return '';
};

/** Project pipeline index, not a pipeline. `/_build/definition?definitionId=` is a pipeline. */
const isAzurePipelineIndex = (parsed) => {
  const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  return path.endsWith('/_build') || path.endsWith('/_build/definition') || path.endsWith('/_build/definitions');
};

const preferShorterTitle = (existing, next) => {
  if (!existing) return next;
  if ((next.title || '').length < (existing.title || '').length) {
    return { ...existing, title: next.title };
  }
  return existing;
};

/**
 * Azure Pipelines check runs use externalId `definitionId|buildId|projectId`
 * and detailsUrl `https://dev.azure.com/{org}/{project}/_build/results?buildId=…`.
 * The definition page is stable; a single build is only a fallback.
 * Some runs omit externalId and put definitionId on `/_build/definition?definitionId=`.
 * That query has to be kept, or the link collapses to the project pipeline list.
 */
const azureLinkFromRun = (run) => {
  const parsed = httpsUrl(run?.detailsUrl || run?.details_url || '');
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const isDevAzure = host === 'dev.azure.com';
  const isVisualStudio = host.endsWith('.visualstudio.com');
  if (!isDevAzure && !isVisualStudio) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  const external = String(run.externalId || run.external_id || '').split('|');
  const definitionId = numericId(external[0]) || queryDefinitionId(parsed);
  const projectFromId = external[2] || '';

  let org = '';
  let project = '';
  if (isDevAzure) {
    org = parts[0] || '';
    project = parts[1] || projectFromId;
  } else {
    org = host.slice(0, -'.visualstudio.com'.length);
    project = parts[0] || projectFromId;
  }
  if (!org || !project) return null;
  if (!definitionId && isAzurePipelineIndex(parsed)) return null;

  const buildId = parsed.searchParams.get('buildId');
  const buildUrl = buildId
    ? `${parsed.origin}${parsed.pathname}?buildId=${encodeURIComponent(buildId)}`
    : `${parsed.origin}${parsed.pathname}`;

  let url = buildUrl;
  if (definitionId && (isDevAzure || SAFE_HOST_LABEL.test(org))) {
    const projectPath = pathSegment(project);
    url = isDevAzure
      ? `https://dev.azure.com/${pathSegment(org)}/${projectPath}/_build?definitionId=${definitionId}`
      : `https://${org}.visualstudio.com/${projectPath}/_build?definitionId=${definitionId}`;
  }

  const name = pipelineName(run.name);
  return {
    kind: 'azure',
    key: `azure:${org.toLowerCase()}/${project.toLowerCase()}/${definitionId || url}`,
    url,
    label: 'azure',
    title: name ? `Azure Pipelines: ${name}` : 'Azure Pipelines',
  };
};

const actionsLink = (owner, repoName) => ({
  kind: 'actions',
  key: 'actions',
  url: `https://github.com/${pathSegment(owner)}/${pathSegment(repoName)}/actions`,
  label: 'actions',
  title: 'GitHub Actions',
});

const otherCiLink = (run) => {
  const parsed = httpsUrl(run?.detailsUrl || run?.details_url || '');
  if (!parsed) return null;
  const match = OTHER_CI_HOSTS.find((entry) => entry.host.test(parsed.hostname));
  if (!match) return null;
  return {
    kind: match.kind,
    key: match.kind,
    url: parsed.toString(),
    label: match.label,
    title: match.title,
  };
};

const isWorkflowFile = (name) => WORKFLOW_FILE.test(String(name || ''));

export const collectRepoPipelineLinks = (owner, repoName, repoData) => {
  if (!owner || !repoName || !repoData) return [];
  const links = new Map();

  const entries = repoData.workflows?.entries || [];
  if (entries.some((entry) => isWorkflowFile(entry?.name))) {
    const link = actionsLink(owner, repoName);
    links.set(link.key, link);
  }

  const target = repoData.defaultBranchRef?.target;
  const commits = target?.history?.nodes || (target?.checkSuites ? [target] : []);
  commits.forEach((commit) => {
    (commit?.checkSuites?.nodes || []).forEach((suite) => {
      const slug = suite?.app?.slug || '';
      const runs = suite?.checkRuns?.nodes || [];
      if (slug === 'github-actions' && !links.has('actions')) {
        links.set('actions', actionsLink(owner, repoName));
      }
      if (slug === 'azure-pipelines') {
        runs.forEach((run) => {
          const link = azureLinkFromRun(run);
          if (!link) return;
          links.set(link.key, preferShorterTitle(links.get(link.key), link));
        });
        return;
      }
      if (slug === 'github-actions') return;
      runs.forEach((run) => {
        const link = otherCiLink(run);
        if (!link || links.has(link.key)) return;
        links.set(link.key, link);
      });
    });
  });

  const list = [...links.values()];
  const counts = new Map();
  list.forEach((link) => counts.set(link.kind, (counts.get(link.kind) || 0) + 1));
  const seen = new Map();
  list.forEach((link) => {
    if ((counts.get(link.kind) || 0) < 2) return;
    const index = (seen.get(link.kind) || 0) + 1;
    seen.set(link.kind, index);
    link.label = `${link.label}${index}`;
  });

  return list.sort((a, b) => (
    (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
    || a.label.localeCompare(b.label)
  ));
};
