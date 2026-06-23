const sortByCreatedAt = (a, b) => a.createdAt.getTime() - b.createdAt.getTime();
const sortByCommittedDateDesc = (a, b) => b.committedDate.getTime() - a.committedDate.getTime();

const STORAGE_KEYS = {
  token: 'PR_RADIATOR_TOKEN',
  owner: 'PR_RADIATOR_OWNER',
  teams: 'PR_RADIATOR_TEAMS',
  repos: 'PR_RADIATOR_REPOS',
  ignoreRepos: 'PR_RADIATOR_IGNORE_REPOS',
  extraRepos: 'PR_RADIATOR_EXTRA_REPOS',
  graphqlCostDebug: 'PR_RADIATOR_GRAPHQL_COST_DEBUG',
  teamMembersCache: 'PR_RADIATOR_TEAM_MEMBERS_CACHE',
  collaboratorPermissionCache: 'PR_RADIATOR_COLLAB_PERM_CACHE',
  shortlogSinceDate: 'PR_RADIATOR_SHORTLOG_SINCE_DATE',
  recentPRsSinceDate: 'PR_RADIATOR_RECENT_PRS_SINCE_DATE',
  activityOnSeparateLine: 'PR_RADIATOR_ACTIVITY_SEPARATE_LINE',
};

const GRAPHQL_REPO_BATCH_SIZE = 2;
const DISCOVERY_BATCH_SIZE = 4;
const RATE_LIMIT_COOLDOWN_THRESHOLD = 100;
const RATE_LIMIT_RESET_BUFFER_MS = 1000;
const STORAGE_WRITE_FRAME_DELAY = 16;
const TEAM_MEMBERS_CACHE_TTL_MS = 60 * 60 * 1000;
const COLLABORATOR_PERMISSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const COLLABORATOR_PERMISSION_LOOKUPS_PER_QUERY = 30;
const EXTERNAL_MERGES_SEARCH_BATCH_SIZE = 10;

const progressBar = document.getElementById('progress-bar');
const repoRefreshStatus = document.getElementById('repo-refresh-status');
const repoView = document.getElementById('repo-view');
const repoHeader = document.getElementById('repo-header');
const repoList = document.getElementById('repo-list');
const prView = document.getElementById('pr-view');
const openPrView = document.getElementById('open-pr-view');
const openPrHeader = document.getElementById('open-pr-header');
const openPrList = document.getElementById('open-pr-list');
const recentPrView = document.getElementById('recent-pr-view');
const recentPrHeader = document.getElementById('recent-pr-header');
const recentPrList = document.getElementById('recent-pr-list');
const settingsForm = document.getElementById('settings-form');
const shortcutsOverlay = document.getElementById('shortcuts-overlay');
const ownerInput = document.getElementById('owner');
const teamsInput = document.getElementById('teams');
const tokenInput = document.getElementById('token');
const applyConfigButton = document.getElementById('apply-config');
const shortlogView = document.getElementById('shortlog-view');
const shortlogHeaderTitle = document.getElementById('shortlog-header-title');
const shortlogBody = document.getElementById('shortlog-body');
const shortlogSinceDateInput = document.getElementById('shortlog-since');
const recentPrSinceDateInput = document.getElementById('recent-pr-since');

const parseStoredJSON = (key, fallback) => {
  try {
    const rawValue = localStorage.getItem(key);
    return rawValue ? JSON.parse(rawValue) : fallback;
  } catch (error) {
    console.warn(`Failed to parse localStorage key ${key}`, error);
    return fallback;
  }
};

const dedupeStrings = (values) => [...new Set(values.filter(Boolean))];
const getActorLogin = (actor, fallback = 'unknown') => actor?.login || fallback;
const shouldLogGraphQLCost = () => window.location.hostname === 'localhost'
  || localStorage.getItem(STORAGE_KEYS.graphqlCostDebug) === 'true';
const formatTiming = (ms) => `${Math.round(ms)}ms`;
const GRAPHQL_ALIAS_CHARS = 'abcdefghijklmnopqrstuvwxyz';
const getShortGraphQLAlias = (index) => GRAPHQL_ALIAS_CHARS[index] || `a${index.toString(36)}`;

const parseTeamInput = (value) => dedupeStrings(
  value
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean)
);

const getAllReposFromMappings = (repoMappings) => dedupeStrings(
  repoMappings.flatMap((team) => Array.isArray(team.repos) ? team.repos : [])
);

const getRepoTeamSlugs = (repoName) => state.config.repos
  .filter((team) => team.repos.includes(repoName))
  .map((team) => team.slug);

const getVisibleRepos = (config = state.config, activeTeamSlug = state.activeTeamSlug) => {
  const visibleTeamSlugs = new Set(activeTeamSlug ? [activeTeamSlug] : config.teams);
  const visibleRepos = [];
  const seenRepos = new Set();

  config.repos.forEach((team) => {
    if (!visibleTeamSlugs.has(team.slug) || !Array.isArray(team.repos)) return;
    team.repos.forEach((repo) => {
      if (seenRepos.has(repo)) return;
      seenRepos.add(repo);
      visibleRepos.push(repo);
    });
  });

  return visibleRepos;
};

const getAllConfiguredRepos = (config = state.config) => getAllReposFromMappings(config.repos);

const isDependabotFilterActive = () => state.showDependabotPRs && !state.showRecentPRs && !state.showRepoLinks;
const shouldHideDependabotPRs = () => !state.showDependabotPRs && !state.showRecentPRs && !state.showRepoLinks;

const isNeedsReviewFilterActive = () => state.showNeedsReviewPRs && !state.showRecentPRs && !state.showRepoLinks;

let persistConfigFrame = 0;
let pendingConfigPersist = null;

const flushPersistedConfig = () => {
  persistConfigFrame = 0;
  if (!pendingConfigPersist) return;

  const config = pendingConfigPersist;
  pendingConfigPersist = null;
  localStorage.setItem(STORAGE_KEYS.owner, config.owner);
  localStorage.setItem(STORAGE_KEYS.token, config.token);
  localStorage.setItem(STORAGE_KEYS.teams, JSON.stringify(config.teams));
  localStorage.setItem(STORAGE_KEYS.repos, JSON.stringify(config.repos));
  localStorage.setItem(STORAGE_KEYS.ignoreRepos, JSON.stringify(config.ignoreRepos));
  localStorage.setItem(STORAGE_KEYS.extraRepos, JSON.stringify(config.extraRepos));
};

const persistConfig = (config) => {
  pendingConfigPersist = config;
  if (persistConfigFrame) return;
  persistConfigFrame = window.setTimeout(flushPersistedConfig, STORAGE_WRITE_FRAME_DELAY);
};

const storedRepos = parseStoredJSON(STORAGE_KEYS.repos, []);
const initialTeams = dedupeStrings(
  parseStoredJSON(STORAGE_KEYS.teams, [])
    .map((team) => (typeof team === 'string' ? team.trim() : ''))
    .filter(Boolean)
);
const storedRepoMappings = new Map(
  (Array.isArray(storedRepos) ? storedRepos : [])
    .map((entry) => {
      const slug = typeof entry?.slug === 'string' ? entry.slug.trim() : '';
      return [slug, dedupeStrings(Array.isArray(entry?.repos) ? entry.repos : [])];
    })
    .filter(([slug]) => Boolean(slug))
);
const initialRepos = initialTeams.map((slug) => ({
  slug,
  repos: storedRepoMappings.get(slug) || [],
}));

const RepositoriesQuery = (owner, team, next) => {
  const after = next ? `"${next}"` : 'null';

  return `{organization(login: "${owner}") {team(slug: "${team}") {repositories(first: 100, after: ${after}) {totalCount pageInfo {endCursor hasNextPage} edges {permission node {name isArchived}}}}}}`;
};

const innerRecentPRsQuery = 'mainRef:ref(qualifiedName:"refs/heads/main"){...R} masterRef:ref(qualifiedName:"refs/heads/master"){...R}';

const buildRecentCommitHistoryFragment = (sinceDateTime) => `fragment R on Ref{target{... on Commit{history(first:25,since:"${sinceDateTime}"){nodes{committedDate messageHeadline parents{totalCount} associatedPullRequests(first:5){nodes{createdAt number title url author{login} repository{name}}}}}}}}`;

const innerOpenPRDiscoveryQuery = 'pullRequests(last:15,states:OPEN){nodes{number updatedAt commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}';
const commitStatusFields = 'oid statusCheckRollup{state contexts(first:25){totalCount nodes{__typename ... on StatusContext{context state targetUrl} ... on CheckRun{name conclusion status detailsUrl}}}}';
const openPRHydrationFields = `title url createdAt updatedAt baseRefName headRefOid isDraft number author{login} reviews(first:15){nodes{state createdAt author{login} authorAssociation}} latestReviews(first:15){nodes{state author{login} authorAssociation}} comments(first:5){nodes{createdAt author{login}}} commits(last:1){nodes{commit{${commitStatusFields}}}} reviewDecision`;
const graphqlCostFragment = 'rateLimit{cost remaining resetAt}';

const buildDiscoveryQuery = (owner, repos) => {
  const batchedRepos = repos
    .map((repo, index) => `${getShortGraphQLAlias(index)}:repository(owner:"${owner}",name:"${repo}"){${innerOpenPRDiscoveryQuery}}`)
    .join(' ');
  return `query{${graphqlCostFragment} ${batchedRepos}}`;
};

const buildRecentQuery = (owner, repos, sinceDateTime) => {
  const fragmentPart = buildRecentCommitHistoryFragment(sinceDateTime);
  const batchedRepos = repos
    .map((repo, index) => `${getShortGraphQLAlias(index)}:repository(owner:"${owner}",name:"${repo}"){${innerRecentPRsQuery}}`)
    .join(' ');
  return `${fragmentPart} query{${graphqlCostFragment} ${batchedRepos}}`;
};

const buildHydrationQuery = (owner, repoRequests) => {
  const batchedRepos = repoRequests.map(({ repoName, numbers }, repoIndex) => {
    const prQueries = numbers
      .map((number, prIndex) => `${getShortGraphQLAlias(prIndex)}:pullRequest(number:${number}){${openPRHydrationFields}}`)
      .join(' ');
    return `${getShortGraphQLAlias(repoIndex)}:repository(owner:"${owner}",name:"${repoName}"){${prQueries}}`;
  }).join(' ');
  return `query{${graphqlCostFragment} ${batchedRepos}}`;
};

const TeamMembersQuery = (owner, team, after = null) => {
  const afterArg = after ? `, after: "${after}"` : '';
  return `{organization(login:"${owner}"){team(slug:"${team}"){members(first:100${afterArg}){pageInfo{endCursor hasNextPage}nodes{login}}}}}`;
};

const buildCollaboratorPermissionsQuery = (owner, lookupsByRepo) => {
  const repoFragments = [...lookupsByRepo.entries()].map(([repoName, logins], rIdx) => {
    const fields = logins.map((login, lIdx) => {
      const safeLogin = String(login).replace(/[^A-Za-z0-9_\-]/g, '');
      return `${getShortGraphQLAlias(lIdx)}:collaborators(query:"${safeLogin}",first:5){edges{permission node{login}}}`;
    }).join(' ');
    return `${getShortGraphQLAlias(rIdx)}:repository(owner:"${owner}",name:"${repoName}"){${fields}}`;
  }).join(' ');
  return `query{${graphqlCostFragment} ${repoFragments}}`;
};

const shortlogPRFields = 'number title url mergedAt author{__typename login} baseRefName repository{name}';
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'development']);

const buildShortlogSearchQuery = (owner, repos, sinceDate) => {
  const batchedSearches = repos
    .map((repo, index) => `${getShortGraphQLAlias(index)}:search(type:ISSUE,first:100,query:"repo:${owner}/${repo} is:pr is:merged merged:>=${sinceDate}"){issueCount pageInfo{endCursor hasNextPage}nodes{...on PullRequest{${shortlogPRFields}}}}`)
    .join(' ');
  return `query{${graphqlCostFragment} ${batchedSearches}}`;
};

const buildShortlogPaginationQuery = (owner, repo, sinceDate, cursor) => {
  return `query{${graphqlCostFragment} search(type:ISSUE,first:100,after:"${cursor}",query:"repo:${owner}/${repo} is:pr is:merged merged:>=${sinceDate}"){pageInfo{endCursor hasNextPage}nodes{...on PullRequest{${shortlogPRFields}}}}}`;
};

const chunkArray = (items, size) => Array.from(
  { length: Math.ceil(items.length / size) },
  (_, index) => items.slice(index * size, (index + 1) * size)
);

const api = {
  fetchDiscoveryBatches: async (token, owner, repos) => {
    const chunks = chunkArray(repos, DISCOVERY_BATCH_SIZE);
    return Promise.all(chunks.map(async (chunk) => {
      const payload = await api.fetchGraphQL(token, buildDiscoveryQuery(owner, chunk), { type: 'open-discovery' });
      return { payload, repos: chunk };
    }));
  },
  fetchRecentBatches: async (token, owner, repos, sinceDateTime) => {
    const chunks = chunkArray(repos, GRAPHQL_REPO_BATCH_SIZE);
    return Promise.all(chunks.map(async (chunk) => ({
      payload: await api.fetchGraphQL(token, buildRecentQuery(owner, chunk, sinceDateTime), { type: 'recent' }),
      repos: chunk,
    })));
  },
  fetchHydrationBatches: async (token, owner, repoRequests) => {
    const chunks = chunkArray(repoRequests, GRAPHQL_REPO_BATCH_SIZE);
    return Promise.all(chunks.map(async (chunk) => ({
      payload: await api.fetchGraphQL(token, buildHydrationQuery(owner, chunk), { type: 'open-hydrate' }),
      repoRequests: chunk,
    })));
  },
  fetchGraphQL: async (token, query, { type = 'graphql' } = {}) => {
    if (shouldPauseGitHubRefresh()) {
      throw new Error(getGitHubRateLimitPauseMessage());
    }

    const startedAt = performance.now();
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    const responseReceivedAt = performance.now();
    const payload = await response.json();
    const payloadParsedAt = performance.now();
    const networkMs = responseReceivedAt - startedAt;
    const parseMs = payloadParsedAt - responseReceivedAt;
    const totalMs = payloadParsedAt - startedAt;

    const rateLimit = getGitHubRateLimitFromHeaders(response.headers);
    if (rateLimit) {
      updateGitHubRateLimit(rateLimit);
    }

    const graphQLRateLimit = payload?.data?.rateLimit;
    if (graphQLRateLimit) {
      const resetAt = graphQLRateLimit.resetAt ? Date.parse(graphQLRateLimit.resetAt) : null;
      updateGitHubRateLimit({
        remaining: Number.isFinite(graphQLRateLimit.remaining) ? graphQLRateLimit.remaining : null,
        resetAt: Number.isFinite(resetAt) ? resetAt : null,
        isCoolingDown: false,
      });

      if (shouldLogGraphQLCost()) {
        console.log(
          `[GraphQL ${type}] network: ${formatTiming(networkMs)} | parse: ${formatTiming(parseMs)} | total: ${formatTiming(totalMs)} | cost: ${graphQLRateLimit.cost} | remaining: ${graphQLRateLimit.remaining} | reset: ${graphQLRateLimit.resetAt}`
        );
      }
    } else if (shouldLogGraphQLCost()) {
      console.log(
        `[GraphQL ${type}] network: ${formatTiming(networkMs)} | parse: ${formatTiming(parseMs)} | total: ${formatTiming(totalMs)}`
      );
    }

    Object.defineProperty(payload, '__meta', {
      value: {
        networkDurationMs: networkMs,
        parseDurationMs: parseMs,
        totalDurationMs: totalMs,
        cost: Number.isFinite(graphQLRateLimit?.cost) ? graphQLRateLimit.cost : null,
      },
      enumerable: false,
    });

    const hitRateLimit = hasRateLimitError(response, payload, rateLimit);

    if (hitRateLimit) {
      if (rateLimit?.resetAt) {
        updateGitHubRateLimit({ ...rateLimit, isCoolingDown: true });
      }
      throw new Error(getGitHubRateLimitPauseMessage(rateLimit));
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    return payload;
  },
  queryTeamRepos: async (token, owner, team) => {
    let hasNextPage = true;
    let next = null;
    const repoNames = [];

    while (hasNextPage) {
      const result = await api.fetchGraphQL(token, RepositoriesQuery(owner, team, next));
      const repositories = result?.data?.organization?.team?.repositories;

      if (!repositories) {
        throw new Error(`Unable to load repositories for team ${team}`);
      }

      repositories.edges.forEach((repo) => {
        if (repo.permission === 'ADMIN' && repo.node.isArchived === false) {
          repoNames.push(repo.node.name);
        }
      });
      hasNextPage = repositories.pageInfo.hasNextPage;
      next = repositories.pageInfo.endCursor;
    }

    return repoNames;
  },
  queryTeamMembers: async (token, owner, team) => {
    let hasNextPage = true;
    let next = null;
    const logins = [];

    while (hasNextPage) {
      const result = await api.fetchGraphQL(token, TeamMembersQuery(owner, team, next), { type: 'team-members' });
      const members = result?.data?.organization?.team?.members;

      if (!members) {
        throw new Error(`Unable to load members for team ${team}`);
      }

      members.nodes.forEach((member) => {
        if (member?.login) logins.push(member.login);
      });
      hasNextPage = members.pageInfo.hasNextPage;
      next = members.pageInfo.endCursor;
    }

    return logins;
  },
};

const prCacheKey = (repoName, number) => `${repoName}:${number}`;

const BOT_LOGINS = new Set(['dependabot', 'github-actions', 'renovate', 'renovate-bot', 'snyk-bot']);

const isBotLogin = (author) => {
  if (!author) return false;
  if (author.__typename === 'Bot') return true;
  const login = (author.login || '').toLowerCase();
  return login.endsWith('[bot]') || BOT_LOGINS.has(login);
};

const isSonarQubeLogin = (author) => {
  if (!author) return false;
  const login = (typeof author === 'string' ? author : (author.login || '')).toLowerCase();
  return login.includes('sonarqube');
};

const isCopilotLogin = (author) => {
  if (!author) return false;
  const login = (typeof author === 'string' ? author : (author.login || '')).toLowerCase();
  return login.includes('copilot');
};

const isSonarQubeFailing = (pr) => {
  const commit = pr.commits?.nodes?.[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return contexts.some((ctx) => {
    if (!ctx) return false;
    const name = (ctx.name || ctx.context || '').toLowerCase();
    if (!name.includes('sonar')) return false;
    const state = (ctx.conclusion || ctx.state || '').toUpperCase();
    return state === 'FAILURE' || state === 'FAILED' || state === 'ERROR';
  });
};

const getSonarQubeUrl = (pr) => {
  const commit = pr.commits?.nodes?.[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts?.nodes ?? [];
  for (const ctx of contexts) {
    if (!ctx) continue;
    const name = (ctx.name || ctx.context || '').toLowerCase();
    const url = (ctx.__typename === 'CheckRun' ? ctx.detailsUrl : ctx.targetUrl) || '';
    if (name.includes('sonar') || /sonar(qube|cloud)?/i.test(url)) {
      if (url) return url;
    }
  }
  return '';
};

const loadPersistedMemberCache = () => {
  const raw = parseStoredJSON(STORAGE_KEYS.teamMembersCache, {});
  const cache = new Map();
  Object.entries(raw).forEach(([slug, entry]) => {
    if (entry && Array.isArray(entry.logins)) {
      cache.set(slug, { logins: new Set(entry.logins), fetchedAt: entry.fetchedAt || 0, error: false });
    }
  });
  return cache;
};

const persistMemberCache = (cache) => {
  const obj = {};
  cache.forEach((entry, slug) => {
    if (!entry.error) {
      obj[slug] = { logins: [...entry.logins], fetchedAt: entry.fetchedAt };
    }
  });
  localStorage.setItem(STORAGE_KEYS.teamMembersCache, JSON.stringify(obj));
};

const getInternalLoginsFromCache = (cache, teams) => {
  const logins = new Set();
  let allLoaded = true;
  teams.forEach((slug) => {
    const entry = cache.get(slug);
    if (!entry || entry.error) {
      allLoaded = false;
      return;
    }
    entry.logins.forEach((login) => logins.add(login));
  });
  return { logins, allLoaded };
};

const ensureTeamMembersLoaded = () => {
  const { token, owner, teams } = state.config;
  if (!token || !owner || teams.length === 0) return;
  const membersCache = loadPersistedMemberCache();
  const { allLoaded } = getInternalLoginsFromCache(membersCache, teams);
  if (!allLoaded) {
    refreshTeamMembersCache(token, owner, teams, membersCache).then(() => {
      render();
    }).catch(() => {});
  }
};

const refreshTeamMembersCache = async (token, owner, teams, existingCache = new Map()) => {
  const now = Date.now();
  const staleTeams = teams.filter((slug) => {
    const entry = existingCache.get(slug);
    return !entry || entry.error || (now - entry.fetchedAt) > TEAM_MEMBERS_CACHE_TTL_MS;
  });
  if (staleTeams.length === 0) return existingCache;

  const results = await Promise.allSettled(
    staleTeams.map(async (slug) => {
      const teamLogins = await api.queryTeamMembers(token, owner, slug);
      return { slug, logins: teamLogins };
    })
  );

  const updatedCache = new Map(existingCache);
  results.forEach((result, index) => {
    const slug = staleTeams[index];
    if (result.status === 'fulfilled') {
      updatedCache.set(slug, { logins: new Set(result.value.logins), fetchedAt: now, error: false });
    } else {
      console.error(`Failed to fetch members for team ${slug}:`, result.reason);
      const existing = updatedCache.get(slug);
      updatedCache.set(slug, { logins: existing?.logins || new Set(), fetchedAt: existing?.fetchedAt || 0, error: true });
    }
  });

  persistMemberCache(updatedCache);
  return updatedCache;
};

const fetchViewerLogin = async (token) => {
  if (currentViewerLogin) return currentViewerLogin;
  if (!token) return null;
  try {
    const payload = await api.fetchGraphQL(token, '{ viewer { login } }', { type: 'viewer' });
    const login = payload?.data?.viewer?.login || null;
    if (login) {
      currentViewerLogin = login;
    }
    return currentViewerLogin;
  } catch (err) {
    console.error('Failed to fetch viewer login:', err);
    return null;
  }
};

let collaboratorPermissionCache = null;
let pendingPermissionLookups = null;
let currentViewerLogin = null;

const loadPersistedPermissionCache = () => {
  if (collaboratorPermissionCache) return collaboratorPermissionCache;
  const raw = parseStoredJSON(STORAGE_KEYS.collaboratorPermissionCache, {});
  const cache = new Map();
  Object.entries(raw).forEach(([repo, perRepo]) => {
    if (!perRepo || typeof perRepo !== 'object') return;
    const inner = new Map();
    Object.entries(perRepo).forEach(([loginLower, entry]) => {
      if (entry && typeof entry.permission === 'string') {
        inner.set(loginLower, { permission: entry.permission, fetchedAt: entry.fetchedAt || 0 });
      }
    });
    cache.set(repo, inner);
  });
  collaboratorPermissionCache = cache;
  return cache;
};

const persistPermissionCache = () => {
  if (!collaboratorPermissionCache) return;
  const obj = {};
  collaboratorPermissionCache.forEach((inner, repo) => {
    const flat = {};
    inner.forEach((entry, loginLower) => {
      flat[loginLower] = { permission: entry.permission, fetchedAt: entry.fetchedAt };
    });
    obj[repo] = flat;
  });
  localStorage.setItem(STORAGE_KEYS.collaboratorPermissionCache, JSON.stringify(obj));
};

const getCachedPermission = (repoName, login) => {
  if (!repoName || !login) return null;
  const cache = loadPersistedPermissionCache();
  const inner = cache.get(repoName);
  if (!inner) return null;
  return inner.get(login.toLowerCase()) || null;
};

const setCachedPermission = (repoName, login, permission, fetchedAt) => {
  const cache = loadPersistedPermissionCache();
  let inner = cache.get(repoName);
  if (!inner) {
    inner = new Map();
    cache.set(repoName, inner);
  }
  inner.set(login.toLowerCase(), { permission, fetchedAt });
};

const PRIVILEGED_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
const isPrivilegedPermission = (permission) => PRIVILEGED_PERMISSIONS.has(permission);

const isPermissionEntryFresh = (entry, now = Date.now()) =>
  !!entry && (now - (entry.fetchedAt || 0)) < COLLABORATOR_PERMISSION_CACHE_TTL_MS;

const collectPermissionLookups = (prs) => {
  const seen = new Set();
  const lookups = [];
  const now = Date.now();
  prs.forEach((pr) => {
    if (shouldHideDependabotPRs() && getActorLogin(pr?.author, '') === 'dependabot') return;
    const repoName = pr?.repository?.name;
    if (!repoName) return;
    const reviewers = new Set();
    pr.latestReviews?.nodes?.forEach((r) => {
      const state = r?.state;
      if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED') return;
      const login = getActorLogin(r?.author, '');
      if (login) reviewers.add(login);
    });
    pr.reviews?.nodes?.forEach((r) => {
      const state = r?.state;
      if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED') return;
      const login = getActorLogin(r?.author, '');
      if (login) reviewers.add(login);
    });
    reviewers.forEach((login) => {
      const dedupeKey = `${repoName}::${login.toLowerCase()}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      const cached = getCachedPermission(repoName, login);
      if (isPermissionEntryFresh(cached, now)) return;
      lookups.push({ repoName, login });
    });
  });
  return lookups;
};

const fetchCollaboratorPermissions = async (token, owner, lookups) => {
  if (lookups.length === 0) return;
  const now = Date.now();
  const chunks = chunkArray(lookups, COLLABORATOR_PERMISSION_LOOKUPS_PER_QUERY);

  await Promise.all(chunks.map(async (chunk) => {
    const lookupsByRepo = new Map();
    chunk.forEach(({ repoName, login }) => {
      const list = lookupsByRepo.get(repoName) || [];
      list.push(login);
      lookupsByRepo.set(repoName, list);
    });

    const query = buildCollaboratorPermissionsQuery(owner, lookupsByRepo);

    let payload;
    try {
      payload = await api.fetchGraphQL(token, query, { type: 'collab-permissions' });
    } catch (error) {
      console.error('Failed to fetch collaborator permissions:', error);
      return;
    }

    const data = payload?.data || {};
    const repoEntries = [...lookupsByRepo.entries()];
    repoEntries.forEach(([repoName, logins], rIdx) => {
      const repoData = data[getShortGraphQLAlias(rIdx)];
      logins.forEach((login, lIdx) => {
        const lookupKey = getShortGraphQLAlias(lIdx);
        const edges = repoData?.[lookupKey]?.edges || [];
        const lowerLogin = login.toLowerCase();
        const matched = edges.find((edge) => (edge?.node?.login || '').toLowerCase() === lowerLogin);
        const permission = matched?.permission || 'NONE';
        setCachedPermission(repoName, login, permission, now);
      });
    });
  }));

  persistPermissionCache();
};

const ensureCollaboratorPermissionsLoaded = async (prs) => {
  const { token, owner } = state.config;
  if (!token || !owner) return;

  const lookups = collectPermissionLookups(prs);
  if (lookups.length === 0) return;

  const pendingKey = lookups
    .map(({ repoName, login }) => `${repoName}::${login.toLowerCase()}`)
    .sort()
    .join('|');
  if (pendingPermissionLookups === pendingKey) return;

  pendingPermissionLookups = pendingKey;

  try {
    await fetchCollaboratorPermissions(token, owner, lookups);
  } catch (error) {
    console.error('Permission lookup batch failed:', error);
  } finally {
    pendingPermissionLookups = null;
  }
};

const fetchShortlogData = async (token, owner, repos, ignoreRepos, sinceDate) => {
  const filteredRepos = repos.filter((repo) => !ignoreRepos.includes(repo));
  if (filteredRepos.length === 0) return [];

  const allPRs = [];
  const issueCountWarnings = [];
  const chunks = chunkArray(filteredRepos, EXTERNAL_MERGES_SEARCH_BATCH_SIZE);
  const reposNeedingPagination = [];

  await Promise.all(chunks.map(async (chunk) => {
    const query = buildShortlogSearchQuery(owner, chunk, sinceDate);
    const payload = await api.fetchGraphQL(token, query, { type: 'external-search' });
    const data = payload?.data || {};
    chunk.forEach((repoName, index) => {
      const alias = getShortGraphQLAlias(index);
      const searchData = data[alias];
      if (!searchData) return;
      if (searchData.issueCount > 1000) {
        issueCountWarnings.push(`${repoName} (${searchData.issueCount})`);
      }
      searchData.nodes.forEach((node) => {
        if (node && node.url) allPRs.push(node);
      });
      if (searchData.pageInfo.hasNextPage) {
        reposNeedingPagination.push({ repoName, cursor: searchData.pageInfo.endCursor });
      }
    });
  }));

  await Promise.all(reposNeedingPagination.map(async ({ repoName, cursor: initialCursor }) => {
    let cursor = initialCursor;
    let hasNextPage = true;
    while (hasNextPage) {
      const query = buildShortlogPaginationQuery(owner, repoName, sinceDate, cursor);
      const payload = await api.fetchGraphQL(token, query, { type: 'external-search-page' });
      const searchData = payload?.data?.search;
      if (!searchData) break;
      searchData.nodes.forEach((node) => {
        if (node && node.url) allPRs.push(node);
      });
      hasNextPage = searchData.pageInfo.hasNextPage;
      cursor = searchData.pageInfo.endCursor;
    }
  }));

  if (issueCountWarnings.length > 0) {
    console.warn(`⚠️ shortlog: some repos may have incomplete results (>1000 PRs): ${issueCountWarnings.join(', ')}`);
  }
  return allPRs;
};

const classifyAndAggregateShortlog = (prs, internalLogins) => {
  const totals = { total: 0, external: 0, internal: 0, bot: 0 };
  const perRepo = new Map();
  const allPRs = [];

  prs.forEach((pr) => {
    const repoName = pr.repository?.name || 'unknown';
    const author = pr.author;
    if (!perRepo.has(repoName)) perRepo.set(repoName, { total: 0, external: 0, internal: 0, bot: 0 });
    const counts = perRepo.get(repoName);
    totals.total++;
    counts.total++;
    let authorType;
    if (isBotLogin(author)) {
      authorType = 'bot';
      totals.bot++;
      counts.bot++;
    } else if (internalLogins.has(author?.login || '')) {
      authorType = 'internal';
      totals.internal++;
      counts.internal++;
    } else {
      authorType = 'external';
      totals.external++;
      counts.external++;
    }
    allPRs.push({
      ...pr,
      mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
      authorType,
      authorLogin: author?.login || 'ghost',
    });
  });

  allPRs.sort((a, b) => {
    if (!a.mergedAt) return 1;
    if (!b.mergedAt) return -1;
    return b.mergedAt.getTime() - a.mergedAt.getTime();
  });

  return { totals, perRepo, allPRs };
};

const fetchShortlog = async (options = {}) => {
  const { forceRefreshMembers = false } = options;
  const { token, owner, teams, ignoreRepos } = state.config;
  const sinceDate = state.shortlogSinceDate;
  if (!token || !owner || teams.length === 0) return;
  if (shouldPauseGitHubRefresh()) {
    renderRepoRefreshStatus();
    return;
  }
  try {
    setState({ isFetchingShortlog: true });
    startProgress();
    const repos = getVisibleRepos();
    let membersCache = loadPersistedMemberCache();
    if (forceRefreshMembers) {
      teams.forEach((slug) => {
        const entry = membersCache.get(slug);
        if (entry) membersCache.set(slug, { ...entry, fetchedAt: 0 });
      });
    }
    membersCache = await refreshTeamMembersCache(token, owner, teams, membersCache);
    const { logins: internalLogins, allLoaded } = getInternalLoginsFromCache(membersCache, teams);
    if (!allLoaded) {
      console.warn('⚠️ shortlog: some team member lists failed to load; classifications may be incomplete.');
    }
    const prs = await fetchShortlogData(token, owner, repos, ignoreRepos, sinceDate);
    const { totals, perRepo, allPRs } = classifyAndAggregateShortlog(prs, internalLogins);
    setState({
      shortlogData: {
        totals,
        perRepo,
        allPRs,
        sinceDate,
        activeTeamSlug: state.activeTeamSlug,
        fetchedAt: Date.now(),
        membersAllLoaded: allLoaded,
      },
    });
  } catch (error) {
    console.error('Failed to fetch shortlog:', error);
  } finally {
    stopProgress();
    setState({ isFetchingShortlog: false });
  }
};

const getCommitConclusion = (headRefOid, commits) => commits?.nodes
  ?.find((currentNode) => currentNode.commit.oid === headRefOid)
  ?.commit?.statusCheckRollup?.state || null;

const needsHydration = (cachedPR, discoveredUpdatedAt, discoveredCommitConclusion) => {
  if (!cachedPR) return true;
  if (!(cachedPR.updatedAt instanceof Date)) return true;
  if (cachedPR.updatedAt.getTime() !== discoveredUpdatedAt?.getTime()) return true;
  const cachedCommitConclusion = getCommitConclusion(cachedPR.headRefOid, cachedPR.commits);
  if (cachedCommitConclusion !== discoveredCommitConclusion) return true;
  return false;
};

const hydrateOpenPRs = async (token, owner, repoRequests) => {
  if (repoRequests.length === 0) return [];

  const results = await api.fetchHydrationBatches(token, owner, repoRequests);
  const hydratedPRs = [];

  results.forEach(({ payload, repoRequests: repoChunk }) => {
    const repoDataMap = payload?.data || {};
    repoChunk.forEach(({ repoName }, index) => {
      const repoAlias = getShortGraphQLAlias(index);
      const repoData = repoDataMap[repoAlias];
      if (!repoData) return;

      Object.keys(repoData).forEach((key) => {
        const val = repoData[key];
        if (!val || typeof val !== 'object' || val.number == null) return;
        hydratedPRs.push(decoratePullRequest(val, repoName));
      });
    });
  });

  return hydratedPRs;
};



const decoratePullRequest = (pr, repoName) => ({
  ...pr,
  repository: { name: repoName },
  teamSlugs: getRepoTeamSlugs(repoName),
});

const mergePullRequestCache = (existingPRs, fetchedPRs, targetRepos, sortFn) => {
  const targetRepoSet = new Set(targetRepos);
  const mergedByUrl = new Map();

  existingPRs
    .filter((pr) => !targetRepoSet.has(pr.repository.name))
    .forEach((pr) => mergedByUrl.set(pr.url, pr));

  fetchedPRs.forEach((pr) => mergedByUrl.set(pr.url, pr));

  return [...mergedByUrl.values()].sort(sortFn);
};

const parseDatesInPR = (pr) => {
  if (pr.createdAt) pr.createdAt = new Date(pr.createdAt);
  if (pr.updatedAt) pr.updatedAt = new Date(pr.updatedAt);
  if (pr.committedDate) pr.committedDate = new Date(pr.committedDate);
  pr.reviews?.nodes?.forEach((review) => { review.createdAt = new Date(review.createdAt); });
  pr.comments?.nodes?.forEach((comment) => { comment.createdAt = new Date(comment.createdAt); });
};

const fetchRecentPRs = async (token, owner, repos, ignoreRepos, options = {}) => {
  ensureTeamMembersLoaded();
  const { merge = false } = options;
  const refreshStartedAt = performance.now();
  try {
    setState({ isFetchingRecentPRs: true });
    startProgress();
    const filteredRepos = repos.filter((repo) => !ignoreRepos.includes(repo));

    if (filteredRepos.length === 0) {
      if (!merge) setState({ recentPRs: [] });
      return;
    }

    const sinceDateTime = `${state.recentPRsSinceDate}T00:00:00.000Z`;
    const results = await api.fetchRecentBatches(token, owner, filteredRepos, sinceDateTime);
    const fetchCompletedAt = performance.now();
    const refCommits = [];
    results.forEach(({ payload, repos: chunkRepos }) => {
      const repoDataMap = payload?.data || {};
      chunkRepos.forEach((_, index) => {
        const repoData = repoDataMap[getShortGraphQLAlias(index)];
        if (!repoData) return;
        const mainRef = repoData.mainRef;
        if (mainRef?.target?.history?.nodes?.length > 0) {
          refCommits.push(mainRef);
        }
        const masterRef = repoData.masterRef;
        if (masterRef?.target?.history?.nodes?.length > 0) {
          refCommits.push(masterRef);
        }
      });
    });

    const recentPullRequests = [];
    refCommits.forEach((ref) => ref.target.history.nodes.forEach((commit) => {
      if (commit.parents.totalCount > 1) {
        commit.associatedPullRequests.nodes.forEach((pr) => {
          recentPullRequests.push(decoratePullRequest({ ...pr, committedDate: commit.committedDate }, pr.repository.name));
        });
      }
    }));
    const filteredRecentPRs = [...new Set(recentPullRequests.map((pr) => pr.url))]
      .map((url) => recentPullRequests.find((pr) => pr.url === url));

    filteredRecentPRs.forEach(parseDatesInPR);
    const recentPRs = filteredRecentPRs.sort(sortByCommittedDateDesc);
    const transformCompletedAt = performance.now();

    const renderStartedAt = performance.now();
    setState({
      recentPRs: merge
        ? mergePullRequestCache(state.recentPRs, recentPRs, filteredRepos, sortByCommittedDateDesc)
        : recentPRs,
    });
    const renderCompletedAt = performance.now();

    if (shouldLogGraphQLCost()) {
      console.log(
        `[PR refresh recent] total: ${formatTiming(renderCompletedAt - refreshStartedAt)} | fetch: ${formatTiming(fetchCompletedAt - refreshStartedAt)} | transform: ${formatTiming(transformCompletedAt - fetchCompletedAt)} | render: ${formatTiming(renderCompletedAt - renderStartedAt)} | repos: ${filteredRepos.length} | prs: ${recentPRs.length}`
      );
    }
  } catch (error) {
    console.log('Failed to fetch recent PRs', error);
  } finally {
    stopProgress();
    setState({ isFetchingRecentPRs: false });
  }
};

const knownDraftTimestamps = new Map();

const fetchOpenPRs = async (token, owner, repos, ignoreRepos, options = {}) => {
  ensureTeamMembersLoaded();
  if (token) {
    fetchViewerLogin(token).catch(() => {});
  }

  const { merge = false } = options;
  const refreshStartedAt = performance.now();
  try {
    setState({ isFetchingOpenPRs: true });
    startProgress();
    const filteredRepos = repos.filter((repo) => !ignoreRepos.includes(repo));

    if (filteredRepos.length === 0) {
      if (!merge) setState({ PRs: [] });
      return;
    }

    const discoveryBatchSize = DISCOVERY_BATCH_SIZE;
    const discoveryBatches = await api.fetchDiscoveryBatches(token, owner, filteredRepos);
    const discoveryCompletedAt = performance.now();

    const discoveredPRs = [];
    discoveryBatches.forEach(({ payload, repos: chunkRepos }) => {
      const repoDataMap = payload?.data || {};
      chunkRepos.forEach((repoName, index) => {
        const repoAlias = getShortGraphQLAlias(index);
        const repoEntry = repoDataMap[repoAlias] || {};

        const nodes = repoEntry.pullRequests?.nodes ?? [];

        nodes.forEach((pr) => {
          discoveredPRs.push({
            number: pr.number,
            updatedAt: pr.updatedAt ? new Date(pr.updatedAt) : null,
            commitConclusion: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null,
            repoName,
          });
        });
      });
    });

    const cachedPRsByKey = new Map(
      state.PRs.map((pr) => [prCacheKey(pr.repository.name, pr.number), pr])
    );
    const unchangedPRsByKey = new Map();
    const hydrateRequestsByRepo = new Map();
    let unchangedCount = 0;

    discoveredPRs.forEach((pr) => {
      const key = prCacheKey(pr.repoName, pr.number);
      const cachedPR = cachedPRsByKey.get(key);

      if (knownDraftTimestamps.get(key) === pr.updatedAt?.getTime()) {
        return;
      }

      if (!needsHydration(cachedPR, pr.updatedAt, pr.commitConclusion)) {
        unchangedCount += 1;
        unchangedPRsByKey.set(key, cachedPR);
        return;
      }

      if (cachedPR) {
        unchangedPRsByKey.set(key, cachedPR);
      }
      const numbers = hydrateRequestsByRepo.get(pr.repoName) || [];
      numbers.push(pr.number);
      hydrateRequestsByRepo.set(pr.repoName, numbers);
    });

    const hydrateRequests = [...hydrateRequestsByRepo.entries()].map(([repoName, numbers]) => ({
      repoName,
      numbers,
    }));

    const hydratedPRs = await hydrateOpenPRs(token, owner, hydrateRequests);
    const hydrateCompletedAt = performance.now();
    hydratedPRs.forEach(parseDatesInPR);
    hydratedPRs.forEach((pr) => {
      const key = prCacheKey(pr.repository.name, pr.number);
      if (pr.isDraft) {
        knownDraftTimestamps.set(key, pr.updatedAt?.getTime() || 0);
        return;
      }
      knownDraftTimestamps.delete(key);
    });

    const hydratedByKey = new Map(
      hydratedPRs.map((pr) => [prCacheKey(pr.repository.name, pr.number), pr])
    );

    const openPRs = discoveredPRs
      .map((pr) => {
        const key = prCacheKey(pr.repoName, pr.number);
        return hydratedByKey.get(key) || unchangedPRsByKey.get(key);
      })
      .filter((pr) => pr && !pr.isDraft)
      .sort(sortByCreatedAt);

    const transformCompletedAt = performance.now();

    const renderStartedAt = performance.now();
    const finalPRs = merge
      ? mergePullRequestCache(state.PRs, openPRs, filteredRepos, sortByCreatedAt)
      : openPRs;

    setState({ PRs: finalPRs });

    ensureCollaboratorPermissionsLoaded(finalPRs)
      .then(() => {
        render();
      })
      .catch((error) => {
        console.error('Permission lookup failed:', error);
      });

    const renderCompletedAt = performance.now();

    if (shouldLogGraphQLCost()) {
      console.log(
        `[PR refresh open] total: ${formatTiming(renderCompletedAt - refreshStartedAt)} | discovery: ${formatTiming(discoveryCompletedAt - refreshStartedAt)} | discovery batch: ${discoveryBatchSize} | hydrate: ${formatTiming(hydrateCompletedAt - discoveryCompletedAt)} | transform: ${formatTiming(transformCompletedAt - hydrateCompletedAt)} | render: ${formatTiming(renderCompletedAt - renderStartedAt)} | repos: ${filteredRepos.length} | prs: ${openPRs.length} | hydrated: ${hydratedPRs.length} | unchanged: ${unchangedCount}`
      );
    }
  } catch (error) {
    console.log('Failed to fetch open PRs', error);
  } finally {
    stopProgress();
    setState({ isFetchingOpenPRs: false });
  }
};

const refreshCurrentView = async (options = {}) => {
  const { merge = Boolean(state.activeTeamSlug) } = options;
  const config = options.configOverride || state.config;
  const activeTeamSlug = options.activeTeamSlugOverride ?? state.activeTeamSlug;
  const { token, owner, ignoreRepos } = config;
  const repos = options.reposOverride || getVisibleRepos(config, activeTeamSlug);

  if (token) {
    fetchViewerLogin(token).catch(() => {});
  }

  if (!token || !owner) return;
  if (shouldPauseGitHubRefresh()) {
    renderRepoRefreshStatus();
    return;
  }

  if (state.showRepoLinks) {
    render();
    return;
  }

  if (state.showShortlog) {
    await fetchShortlog();
    return;
  }

  if (state.showRecentPRs) {
    await fetchRecentPRs(token, owner, repos, ignoreRepos, { merge });
    return;
  }

  await fetchOpenPRs(token, owner, repos, ignoreRepos, { merge });
};

const refreshAllTeamRepos = async (configOverride = state.config) => {
  const { token, owner, teams } = configOverride;
  if (!token || !owner || teams.length === 0) {
    console.warn('Cannot refresh repos: missing config');
    return configOverride;
  }
  if (shouldPauseGitHubRefresh()) {
    renderRepoRefreshStatus();
    return configOverride;
  }

  try {
    setState({ isFetchingRepos: true });
    startProgress();

    console.log(`🔄 Refreshing repositories for ${teams.length} team${teams.length === 1 ? '' : 's'}...`);

    const results = await Promise.allSettled(teams.map(async (teamSlug) => {
      const repos = await api.queryTeamRepos(token, owner, teamSlug);
      return { slug: teamSlug, repos };
    }));

    const updatedRepos = teams.map((teamSlug, index) => {
      const result = results[index];
      if (result.status === 'fulfilled') {
        return result.value;
      }
      console.error(`Failed to refresh repos for team ${teamSlug}`, result.reason);
      return configOverride.repos.find((entry) => entry.slug === teamSlug) || { slug: teamSlug, repos: [] };
    });

    const nextConfig = {
      ...state.config,
      ...configOverride,
      teams: [...teams],
      repos: updatedRepos,
    };

    persistConfig(nextConfig);
    setState({
      config: nextConfig,
      selectedRepoIndex: -1,
      selectedPrIndex: -1,
    });

    console.log(`✅ Team repositories refreshed (${getAllReposFromMappings(nextConfig.repos).length} repos total)`);
    refreshTeamMembersCache(token, owner, teams, loadPersistedMemberCache()).catch(() => {});
    return nextConfig;
  } catch (error) {
    console.error('Failed to refresh team repositories:', error);
    throw error;
  } finally {
    stopProgress();
    setState({ isFetchingRepos: false });
  }
};

const ICONS = {
  commentDots: `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M256 32C114.6 32 0 125.1 0 240c0 49.6 21.4 95 57 130.7C44.5 421.1 2.7 466 2.2 466.5c-2.2 2.3-2.8 5.7-1.5 8.7S4.8 480 8 480c66.3 0 116-31.8 140.6-51.4 32.7 12.3 69 19.4 107.4 19.4 141.4 0 256-93.1 256-208S397.4 32 256 32zM128 272c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.3 32-32 32zm128 0c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.3 32-32 32zm128 0c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.3 32-32 32z" /></svg>`,
  hourglass: `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M360 0H24C10.745 0 0 10.745 0 24v16c0 13.255 10.745 24 24 24 0 90.965 51.016 167.734 120.842 192C75.016 280.266 24 357.035 24 448c-13.255 0-24 10.745-24 24v16c0 13.255 10.745 24 24 24h336c13.255 0 24-10.745 24-24v-16c0-13.255-10.745-24-24-24 0-90.965-51.016-167.734-120.842-192C308.984 231.734 360 154.965 360 64c13.255 0 24-10.745 24-24V24c0-13.255-10.745-24-24-24zm-75.078 384H99.08c17.059-46.797 52.096-80 92.92-80 40.821 0 75.862 33.196 92.922 80zm.019-256H99.078C91.988 108.548 88 86.748 88 64h208c0 22.805-3.987 44.587-11.059 64z" /></svg>`,
  minus: `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M3 13h18v-2H3v2z" /></svg>`,
  times: `<svg stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M6 6l12 12M18 6L6 18" /></svg>`,
  check: `<svg stroke="currentColor" fill="currentColor" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M173.898 439.404l-166.4-166.4c-9.997-9.997-9.997-26.206 0-36.204l36.203-36.204c9.997-9.998 26.207-9.998 36.204 0L192 312.69 432.095 72.596c9.997-9.997 26.207-9.997 36.204 0l36.203 36.204c9.997 9.997 9.997 26.206 0 36.204l-294.4 294.401c-9.998 9.997-26.207 9.997-36.204-.001z" /></svg>`,
  warning: `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" /></svg>`,
  sonarQube: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" class="event-icon"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2a10 10 0 0 1 10 10"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M2 12a10 10 0 0 1 10 10"/></svg>`,
  copilot: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.15em" height="1.15em" class="event-icon" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="13" rx="2"/><path d="M12 2v4"/><circle cx="8.5" cy="12.5" r="1.5"/><circle cx="15.5" cy="12.5" r="1.5"/><path d="M8 16h8"/></svg>`,
};

const getEffectivePermission = (repoName, login) => {
  const cached = getCachedPermission(repoName, login);
  if (cached) return cached.permission;
  return null;
};

const combineReviewsAndComments = (reviews, comments, latestReviews, reviewDecision, repoName) => {
  const events = [];

  reviews?.nodes?.forEach((review) => {
    const currentState = review.state === 'COMMENTED' ? 'COMMENTED' : review.state;
    events.push({
      createdAt: review.createdAt,
      author: getActorLogin(review.author),
      state: currentState,
      authorAssociation: review.authorAssociation,
    });
  });

  comments?.nodes?.forEach((comment) => {
    events.push({
      createdAt: comment.createdAt,
      author: getActorLogin(comment.author),
      state: 'COMMENTED',
    });
  });

  const compressedEvents = [];
  let currentEvent = null;

  events.sort(sortByCreatedAt).forEach((curr) => {
    if (!currentEvent || curr.author !== currentEvent.author || curr.state !== currentEvent.state) {
      if (currentEvent) compressedEvents.push(currentEvent);
      currentEvent = { ...curr, count: 1 };
    } else {
      currentEvent.count = (currentEvent.count || 1) + 1;
    }
  });
  if (currentEvent) compressedEvents.push(currentEvent);

  const latestByAuthor = new Map();
  latestReviews?.nodes?.forEach((review) => {
    const login = getActorLogin(review.author);
    if (!login) return;
    latestByAuthor.set(login, {
      state: review.state,
      authorAssociation: review.authorAssociation,
    });
  });

  compressedEvents.forEach((ev) => {
    if (ev.state === 'APPROVED' || ev.state === 'CHANGES_REQUESTED') {
      const latest = latestByAuthor.get(ev.author);
      ev.isActive = !!latest && latest.state === ev.state;
      const association = latest?.authorAssociation || ev.authorAssociation;
      const permission = getEffectivePermission(repoName, ev.author);
      if (permission) {
        ev.isPrivileged = isPrivilegedPermission(permission);
        ev.permissionKnown = true;
      } else if (currentViewerLogin && ev.author) {
        const lower = ev.author.toLowerCase();
        if (lower === currentViewerLogin.toLowerCase()) {
          ev.isPrivileged = true;
          ev.permissionKnown = true;
        }
      } else if (ev.author && state.config?.teams?.length) {
        const membersCache = loadPersistedMemberCache();
        const { logins: internals } = getInternalLoginsFromCache(membersCache, state.config.teams);
        if (internals.has(ev.author)) {
          ev.isPrivileged = true;
          ev.permissionKnown = true;
        }
      }

      if (typeof ev.permissionKnown !== 'boolean') {
        const fromAssociation = association === 'OWNER' || association === 'COLLABORATOR';
        ev.isPrivileged = fromAssociation;
        ev.permissionKnown = fromAssociation;
      }

      ev.approvalDoesNotCount = ev.state === 'APPROVED'
        && ev.isActive
        && ev.isPrivileged
        && reviewDecision === 'REVIEW_REQUIRED';
    } else {
      ev.isActive = true;
      ev.isPrivileged = false;
      ev.approvalDoesNotCount = false;
      ev.permissionKnown = true;
    }
  });

  return compressedEvents;
};

const getAgeString = (createdAt) => {
  const diffMs = Date.now() - createdAt.getTime();
  if (diffMs < 3600000) return 'last-hour';
  if (diffMs < 7200000) return 'last-two-hours';
  if (diffMs < 86400000) return 'last-day';
  if (diffMs < 604800000) return 'last-week';
  return 'over-week-old';
};

const getContextUrl = (ctx) => (ctx?.__typename === 'CheckRun' ? ctx.detailsUrl : ctx?.targetUrl) || '';

const isSonarContext = (ctx) => {
  const url = getContextUrl(ctx);
  if (url && /sonar(qube|cloud)?/i.test(url)) return true;
  const name = (ctx?.context || ctx?.name || '').toLowerCase();
  return name.includes('sonar');
};

// When a GHA check is re-run via a new workflow trigger, GitHub keeps both the
// old failed run and the new run in statusCheckRollup.contexts, causing the
// rollup state to remain FAILURE even though the latest run passed.
// This deduplicates CheckRun entries by name, keeping a passing run (SUCCESS/SKIPPED)
// over a failing one, so the displayed status reflects the actual current state.
const deduplicateCheckRuns = (contexts) => {
  const bestByName = new Map();
  contexts.forEach((ctx) => {
    if (ctx.__typename !== 'CheckRun' || !ctx.name) return;
    const existing = bestByName.get(ctx.name);
    if (!existing) { bestByName.set(ctx.name, ctx); return; }
    const currentPasses = ctx.conclusion === 'SUCCESS' || ctx.conclusion === 'SKIPPED';
    const existingPasses = existing.conclusion === 'SUCCESS' || existing.conclusion === 'SKIPPED';
    if (currentPasses && !existingPasses) bestByName.set(ctx.name, ctx);
  });
  return contexts.filter((ctx) => ctx.__typename !== 'CheckRun' || !ctx.name || bestByName.get(ctx.name) === ctx);
};

const pickBuildUrl = (rawContexts, conclusion, prUrl) => {
  const contexts = (rawContexts || []).filter((ctx) => !isSonarContext(ctx));
  if (!contexts.length) return prUrl ? `${prUrl}/checks` : '';

  const isAdo = (ctx) => {
    const url = getContextUrl(ctx);
    return url && /dev\.azure\.com|visualstudio\.com/i.test(url);
  };
  const isFailed = (ctx) =>
    ctx.__typename === 'CheckRun'
      ? ctx.conclusion === 'FAILURE'
      : ctx.state === 'FAILURE' || ctx.state === 'ERROR';
  const isPending = (ctx) =>
    ctx.__typename === 'CheckRun'
      ? ctx.status !== 'COMPLETED' || !ctx.conclusion || ctx.conclusion === 'NEUTRAL'
      : ctx.state === 'PENDING' || ctx.state === 'EXPECTED';

  const adoContexts = contexts.filter(isAdo);

  let chosen;
  if (conclusion === 'FAILURE' || conclusion === 'ERROR') {
    chosen = adoContexts.find(isFailed) || contexts.find(isFailed) || adoContexts[0];
  } else if (conclusion === 'PENDING' || conclusion === 'EXPECTED') {
    chosen = adoContexts.find(isPending) || contexts.find(isPending) || adoContexts[0];
  } else {
    chosen = adoContexts[0] || contexts[0];
  }

  return getContextUrl(chosen) || (prUrl ? `${prUrl}/checks` : '');
};

const getCommitState = (headRefOid, commits, prUrl) => {
  const icons = {
    SUCCESS: ICONS.check,
    PENDING: ICONS.hourglass,
    FAILURE: ICONS.times,
    EXPECTED: ICONS.hourglass,
    ERROR: ICONS.warning,
  };

  const rollupConclusion = getCommitConclusion(headRefOid, commits) || 'ERROR';
  const commit = commits?.nodes?.find((currentNode) => currentNode.commit.oid === headRefOid)?.commit;
  const contextData = commit?.statusCheckRollup?.contexts;
  const rawContexts = contextData?.nodes ?? [];
  const totalCount = contextData?.totalCount;
  const contexts = deduplicateCheckRuns(rawContexts);

  // When all contexts are fetched and deduplication removes every failure (old re-run
  // artifacts), override the rollup conclusion so the icon reflects the real state.
  let conclusion = rollupConclusion;
  const hasAllContexts = totalCount != null && rawContexts.length >= totalCount;
  if ((rollupConclusion === 'FAILURE' || rollupConclusion === 'ERROR') && hasAllContexts) {
    const stillFailing = contexts.some((ctx) =>
      ctx.__typename === 'CheckRun'
        ? ctx.status === 'COMPLETED' && ctx.conclusion === 'FAILURE'
        : ctx.state === 'FAILURE' || ctx.state === 'ERROR'
    );
    if (!stillFailing) {
      const hasPending = contexts.some((ctx) =>
        ctx.__typename === 'CheckRun'
          ? ctx.status !== 'COMPLETED' || !ctx.conclusion
          : ctx.state === 'PENDING' || ctx.state === 'EXPECTED'
      );
      conclusion = hasPending ? 'PENDING' : 'SUCCESS';
    }
  }

  const icon = icons[conclusion] || ICONS.minus;
  const className = conclusion.toLowerCase();

  let title = '';
  if (conclusion === 'PENDING' || conclusion === 'EXPECTED') {
    const pending = contexts
      .filter((ctx) => {
        if (ctx.__typename === 'CheckRun') {
          return ctx.status !== 'COMPLETED' || ctx.conclusion === 'NEUTRAL' || !ctx.conclusion;
        }
        return ctx.state === 'PENDING' || ctx.state === 'EXPECTED';
      })
      .map((ctx) => ctx.name || ctx.context)
      .filter(Boolean);
    if (pending.length) {
      title = 'Pending checks:\n' + pending.join('\n');
    }
  } else if (conclusion === 'FAILURE' || conclusion === 'ERROR') {
    const failed = contexts
      .filter((ctx) => {
        if (ctx.__typename === 'CheckRun') {
          return ctx.conclusion === 'FAILURE';
        }
        return ctx.state === 'FAILURE' || ctx.state === 'ERROR';
      })
      .map((ctx) => ctx.name || ctx.context)
      .filter(Boolean);
    if (failed.length) {
      title = 'Failed checks:\n' + failed.join('\n');
    }
  }

  const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;').replace(/\n/g, '&#10;')}"` : '';
  const iconSpan = `<span class="${className}"${titleAttr}>${icon}</span>`;
  const buildUrl = pickBuildUrl(contexts, conclusion, prUrl);
  if (!buildUrl) return iconSpan;
  return `<a class="commit-status-link" href="${buildUrl}" target="_blank" rel="noopener noreferrer">${iconSpan}</a>`;
};

const TimelineEvent = ({ count, author, createdAt, state: eventState, isActive = true, isPrivileged: isPrivilegedProp, approvalDoesNotCount = false, permissionKnown = true }) => {
  const countBadge = (count ?? 1) > 1 ? `(${count})` : '';
  const authorWithCount = `${author}${countBadge}`;
  const formattedDate = createdAt.toLocaleString();
  const isStale = !isActive && (eventState === 'APPROVED' || eventState === 'CHANGES_REQUESTED');
  const isPrivileged = typeof isPrivilegedProp === 'boolean' ? isPrivilegedProp : false;
  const permissionResolved = typeof permissionKnown === 'boolean' ? permissionKnown : true;
  const muted = (eventState === 'APPROVED' || eventState === 'CHANGES_REQUESTED') && permissionResolved && (!isPrivileged || approvalDoesNotCount);
  const pending = (eventState === 'APPROVED' || eventState === 'CHANGES_REQUESTED') && !permissionResolved;
  let tooltip = `${authorWithCount} ${eventState.toLowerCase()} at ${formattedDate}`;

  if (eventState === 'APPROVED') {
    if (isStale) tooltip += ' (stale)';
    if (muted) tooltip += isPrivileged ? ' (does not count toward review)' : ' (no write access)';
    const cls = `event-group approved${isStale ? ' stale' : ''}${muted ? ' muted' : ''}${pending ? ' permission-pending' : ''}`;
    return `<span class="${cls}" title="${tooltip}">${authorWithCount}${ICONS.check}</span>`;
  }
  if (eventState === 'CHANGES_REQUESTED') {
    tooltip = `${authorWithCount} requested changes at ${formattedDate}${isStale ? ' (stale)' : ''}`;
    if (muted) tooltip += ' (no write access)';
    const cls = `event-group changes-requested${isStale ? ' stale' : ''}${muted ? ' muted' : ''}${pending ? ' permission-pending' : ''}`;
    return `<span class="${cls}" title="${tooltip}">${authorWithCount}${ICONS.times}</span>`;
  }
  if (eventState === 'COMMENTED') {
    tooltip = `${authorWithCount} commented at ${formattedDate}`;
    return `<span class="event-group commented" title="${tooltip}">${authorWithCount}${ICONS.commentDots}</span>`;
  }
  if (eventState === 'DISMISSED') {
    tooltip = `${authorWithCount} dismissed at ${formattedDate}`;
    return `<span class="event-group dismissed" title="${tooltip}">${authorWithCount}${ICONS.minus}</span>`;
  }
  return '';
};

const formatDistanceToNow = (date) => {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0 || isNaN(diffMs)) return 'Invalid Date';
  const minutes = Math.round(diffMs / 6e4);
  const days = Math.round(diffMs / 864e5);
  const months = Math.round(days / 30);
  const years = Math.round(days / 360);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 45) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  if (minutes < 90) return 'about 1 hour ago';
  if (days < 1) return `about ${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? '' : 's'} ago`;
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (months < 12) return `about ${months} month${months === 1 ? '' : 's'} ago`;
  return `about ${years} year${years === 1 ? '' : 's'} ago`;
};

const formatCompactDistanceToNow = (date) => {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0 || isNaN(diffMs)) return '--';
  const seconds = Math.max(1, Math.floor(diffMs / 1e3));
  const minutes = Math.round(diffMs / 6e4);
  const days = Math.round(diffMs / 864e5);
  const months = Math.round(days / 30);
  const years = Math.round(days / 360);

  if (minutes < 1) return `${seconds}s`;
  if (minutes < 45) return `${minutes}m`;
  if (minutes < 90) return '1h';
  if (days < 1) return `${Math.floor(minutes / 60)}h`;
  if (days < 30) return `${days}d`;
  if (months < 12) return `${months}mo`;
  return `${years}y`;
};

const getTeamBadgesMarkup = (teamSlugs = [], showInlineTeamBadges = false, teamBadgeCache = null) => {
  let teamBadges = '';
  if (showInlineTeamBadges && teamSlugs.length > 0) {
    const badgeKey = teamSlugs.join('|');
    teamBadges = teamBadgeCache?.get(badgeKey) || '';
    if (!teamBadges) {
      teamBadges = `<span class="team-badges">${teamSlugs.map((slug) => `<span class="team-badge" title="Team ${slug}">${slug}</span>`).join('')}</span>`;
      teamBadgeCache?.set(badgeKey, teamBadges);
    }
  }
  return teamBadges;
};

const buildPRAgeMarkup = (pr, isRecent) => {
  const date = pr[isRecent ? 'committedDate' : 'createdAt'];
  const elapsedTimeStr = formatCompactDistanceToNow(date);
  const elapsedTimeTitle = `${formatDistanceToNow(date)} (${date.toLocaleString()})`;
  return `<span id="pr-time-${pr.url}" class="pr-age" title="${elapsedTimeTitle}">${elapsedTimeStr}</span>`;
};

const getPRPresentation = (pr, {
  isRecent = true,
  showBranch = false,
  showInlineTeamBadges = false,
  teamBadgeCache = null,
  activityOnSeparateLine = false,
  showActivity = true,
} = {}) => {
  const { number, title, url, repository, teamSlugs = [] } = pr;
  const teamBadges = getTeamBadgesMarkup(teamSlugs, showInlineTeamBadges, teamBadgeCache);
  const ageMarkup = buildPRAgeMarkup(pr, isRecent);
  const author = getActorLogin(pr.author);

  if (isRecent) {
    const mainParts = [];
    if (teamBadges) mainParts.push(teamBadges);
    mainParts.push(author);
    mainParts.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${repository.name}#${number}</a>`);
    mainParts.push(title);
    const mainContent = mainParts.join(' ');
    return {
      signature: `recent|${teamBadges}|${author}|${repository.name}|${number}|${title}`,
      ageMarkup,
      ageClass: '',
      mainContent,
    };
  }

  const { createdAt, reviews, comments, baseRefName, headRefOid, commits, latestReviews, reviewDecision } = pr;
  const commitState = getCommitState(headRefOid, commits, url);
  const prLink = `<a href="${url}" target="_blank" rel="noopener noreferrer">${repository.name}#${pr.number}</a>`;
  const branch = showBranch ? baseRefName : '';
  const ageClass = getAgeString(createdAt);

  const mainParts = [];
  if (teamBadges) mainParts.push(teamBadges);
  mainParts.push(commitState);
  if (branch) mainParts.push(branch);
  mainParts.push(author);
  mainParts.push(prLink);
  mainParts.push(title);
  const mainCore = mainParts.join(' ');

  let activitySpan = '';
  let eventsForSignature = [];
  let eventsLengthForSignature = 0;

  if (showActivity) {
    const events = combineReviewsAndComments(reviews, comments, latestReviews, reviewDecision, repository.name);

    const regularEvents = [];
    let sonarEvent = null;
    events.forEach((ev) => {
      if (isSonarQubeLogin(ev.author)) {
        sonarEvent = ev;
      } else {
        regularEvents.push(ev);
      }
    });

    const activityParts = [];
    if (sonarEvent) {
      const countBadge = (sonarEvent.count ?? 1) > 1 ? `(${sonarEvent.count})` : '';
      const authorWithCount = `${sonarEvent.author}${countBadge}`;
      const formattedDate = sonarEvent.createdAt.toLocaleString();
      let tooltip = `${authorWithCount} commented at ${formattedDate}`;
      const failing = isSonarQubeFailing(pr);
      if (failing) tooltip = `${authorWithCount} quality gate failed at ${formattedDate}`;
      const sonarClass = failing ? 'sonar failure' : 'sonar';
      const sonarUrl = getSonarQubeUrl(pr);
      const sonarSpan = `<span class="${sonarClass}" title="${tooltip}">${ICONS.sonarQube}</span>`;
      activityParts.push(sonarUrl ? `<a class="commit-status-link" href="${sonarUrl}" target="_blank" rel="noopener">${sonarSpan}</a>` : sonarSpan);
    }
    activityParts.push(...regularEvents.map((event, eventIndex) => {
      if (isCopilotLogin(event.author)) {
        const countBadge = (event.count ?? 1) > 1 ? `(${event.count})` : '';
        const authorWithCount = `${event.author}${countBadge}`;
        const formattedDate = event.createdAt.toLocaleString();
        const tooltip = `${authorWithCount} commented at ${formattedDate}`;
        return `<span class="copilot" title="${tooltip}">${ICONS.copilot}</span>`;
      } else {
        return TimelineEvent({ ...event, key: eventIndex });
      }
    }));
    const activity = activityParts.length > 0
      ? ' ' + activityParts.join('')
      : '';
    activitySpan = activity ? `<span class="pr-activity">${activity}</span>` : '';

    eventsForSignature = events;
    eventsLengthForSignature = events.length;
  }

  return {
    signature: `open|${teamBadges}|${commitState}|${branch}|${author}|${repository.name}|${pr.number}|${title}|${reviewDecision || ''}|${eventsLengthForSignature}|${eventsForSignature.map(e => {
      const flag = (e.state === 'APPROVED' || e.state === 'CHANGES_REQUESTED') ? (e.isActive ? '1' : '0') : '';
      const priv = (e.state === 'APPROVED' || e.state === 'CHANGES_REQUESTED')
        ? (e.isPrivileged ? 'P' : 'p') + (e.permissionKnown ? 'K' : 'k')
        : '';
      const dnc = e.approvalDoesNotCount ? 'X' : '';
      return `${e.author}:${e.state}:${e.count||1}${flag ? ':' + flag : ''}${priv ? ':' + priv : ''}${dnc ? ':' + dnc : ''}`;
    }).join(',')}|act:${activityOnSeparateLine ? 'b' : 'i'}|tail:${showActivity ? '1' : '0'}`,
    ageMarkup,
    ageClass,
    mainCore,
    activitySpan,
  };
};

const syncPRNode = (node, pr, presentation, index, isSelected, isRecent, activityOnSeparateLine = false) => {
  node.className = `pr-item${isSelected ? ' selected' : ''}${activityOnSeparateLine ? ' activity-below' : ''}`;
  node.dataset.index = `${index}`;
  node.dataset.url = pr.url;

  if (node.dataset.signature !== presentation.signature) {
    const mainLineClass = isRecent
      ? 'pr-main-line'
      : `pr-main-line ${presentation.ageClass}`;
    const ageAndCore = `${presentation.ageMarkup} ${presentation.mainCore || presentation.mainContent}`;
    let innerHTML;
    if (!isRecent && activityOnSeparateLine && presentation.activitySpan) {
      innerHTML = `<div class="${mainLineClass}">${ageAndCore}</div><div class="pr-activity-line">${presentation.activitySpan}</div>`;
    } else {
      let combined = ageAndCore;
      if (!isRecent && presentation.activitySpan) {
        combined += ` ${presentation.activitySpan}`;
      }
      innerHTML = `<div class="${mainLineClass}">${combined}</div>`;
    }
    node.innerHTML = innerHTML;
    node.dataset.signature = presentation.signature;
    return;
  }

  const ageEl = node.querySelector('.pr-age');
  if (ageEl) {
    const date = pr[isRecent ? 'committedDate' : 'createdAt'];
    ageEl.textContent = formatCompactDistanceToNow(date);
    ageEl.title = `${formatDistanceToNow(date)} (${date.toLocaleString()})`;
  }

  if (!isRecent) {
    const mainLineEl = node.querySelector('.pr-main-line');
    if (mainLineEl) {
      mainLineEl.className = `pr-main-line ${presentation.ageClass}`;
    }
  }
};

const syncPRList = (listEl, displayPRs, {
  isRecent = true,
  showBranch = false,
  showInlineTeamBadges = false,
  teamBadgeCache = null,
  selectedPrIndex = -1,
  activityOnSeparateLine = false,
  showActivity = true,
} = {}) => {
  const existingNodesByUrl = new Map(
    Array.from(listEl.children).map((child) => [child.dataset.url, child])
  );

  let nextSibling = listEl.firstElementChild;

  displayPRs.forEach((pr, index) => {
    const presentation = getPRPresentation(pr, {
      isRecent,
      showBranch,
      showInlineTeamBadges,
      teamBadgeCache,
      activityOnSeparateLine,
      showActivity,
    });
    let node = existingNodesByUrl.get(pr.url);

    if (!node) {
      node = document.createElement('li');
    } else {
      existingNodesByUrl.delete(pr.url);
    }

    syncPRNode(node, pr, presentation, index, index === selectedPrIndex, isRecent, activityOnSeparateLine);

    if (node !== nextSibling) {
      listEl.insertBefore(node, nextSibling);
    }

    nextSibling = node.nextElementSibling;
  });

  existingNodesByUrl.forEach((node) => node.remove());
};

const initialState = {
  config: {
    token: localStorage.getItem(STORAGE_KEYS.token) || '',
    owner: localStorage.getItem(STORAGE_KEYS.owner) || '',
    teams: initialTeams,
    repos: initialRepos,
    ignoreRepos: parseStoredJSON(STORAGE_KEYS.ignoreRepos, []),
    extraRepos: parseStoredJSON(STORAGE_KEYS.extraRepos, []),
  },
  PRs: [],
  recentPRs: [],
  recentPRsSinceDate: (() => {
    const now = new Date();
    const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    return localStorage.getItem(STORAGE_KEYS.recentPRsSinceDate) || startOfMonth;
  })(),
  showDependabotPRs: false,
  showNeedsReviewPRs: false,
  showRecentPRs: false,
  showRepoLinks: false,
  showShortlog: false,
  showTeamBadges: false,
  showBranch: false,
  activityOnSeparateLine: localStorage.getItem(STORAGE_KEYS.activityOnSeparateLine) === 'true',
  shortlogData: null,
  shortlogSinceDate: localStorage.getItem(STORAGE_KEYS.shortlogSinceDate) || `${new Date().getFullYear()}-01-01`,
  shortlogAuthorFilter: 'external',
  isFetchingShortlog: false,
  selectedRepoIndex: -1,
  selectedPrIndex: -1,
  isFetchingOpenPRs: false,
  isFetchingRecentPRs: false,
  isFetchingRepos: false,
  githubRateLimit: {
    remaining: null,
    resetAt: null,
    isCoolingDown: false,
  },
  activeTeamSlug: '',
};

let state = { ...initialState };
const renderCache = {
  visibleRepos: [],
  displayPRs: [],
  mode: '',
  shortcutsOverlayHeight: 0,
};

const getActiveGitHubRateLimit = (rateLimit = state.githubRateLimit) => {
  if (!rateLimit?.resetAt || rateLimit.resetAt <= (Date.now() + RATE_LIMIT_RESET_BUFFER_MS)) {
    return {
      ...rateLimit,
      resetAt: null,
      isCoolingDown: false,
    };
  }

  return rateLimit;
};

const getGitHubRateLimitPauseMessage = (rateLimit = state.githubRateLimit) => {
  const activeRateLimit = getActiveGitHubRateLimit(rateLimit);
  if (!activeRateLimit.isCoolingDown || !activeRateLimit.resetAt) {
    return 'GitHub rate limit pause is active.';
  }
  return `GitHub rate limit pause until ${formatRateLimitResetTime(activeRateLimit.resetAt)}.`;
};

const shouldPauseGitHubRefresh = () => {
  const activeRateLimit = getActiveGitHubRateLimit();
  if (state.githubRateLimit.isCoolingDown && !activeRateLimit.resetAt) {
    updateGitHubRateLimit({ remaining: null, resetAt: null, isCoolingDown: false });
    return false;
  }
  return Boolean(activeRateLimit.isCoolingDown && activeRateLimit.resetAt);
};

const updateGitHubRateLimit = (updates) => {
  const nextRateLimit = getActiveGitHubRateLimit({
    ...state.githubRateLimit,
    ...updates,
  });
  const shouldCoolDown = Boolean(
    nextRateLimit.resetAt
    && nextRateLimit.remaining !== null
    && nextRateLimit.remaining <= RATE_LIMIT_COOLDOWN_THRESHOLD
  );
  nextRateLimit.isCoolingDown = Boolean(nextRateLimit.isCoolingDown || shouldCoolDown);
  const currentRateLimit = state.githubRateLimit;

  if (
    currentRateLimit.remaining === nextRateLimit.remaining
    && currentRateLimit.resetAt === nextRateLimit.resetAt
    && currentRateLimit.isCoolingDown === nextRateLimit.isCoolingDown
  ) {
    return;
  }

  state = { ...state, githubRateLimit: nextRateLimit };
  renderRepoRefreshStatus();
};

const getGitHubRateLimitFromHeaders = (headers) => {
  const remaining = Number.parseInt(headers.get('x-ratelimit-remaining') || '', 10);
  const reset = Number.parseInt(headers.get('x-ratelimit-reset') || '', 10);

  if (!Number.isFinite(remaining) && !Number.isFinite(reset)) {
    return null;
  }

  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(reset) ? reset * 1000 : null,
    isCoolingDown: false,
  };
};

const hasRateLimitError = (response, payload, rateLimit) => {
  if (response.status === 403 && rateLimit?.remaining === 0) return true;
  return Boolean(payload?.errors?.some((error) => /rate limit/i.test(error.message)));
};

const formatRateLimitResetTime = (timestamp) => new Date(timestamp).toLocaleTimeString([], {
  hour: 'numeric',
  minute: '2-digit',
});

const startProgress = () => {
  if (progressBar) progressBar.classList.add('active');
};

const stopProgress = () => {
  if (progressBar) {
    progressBar.classList.add('fade-out');
    setTimeout(() => {
      if (progressBar) progressBar.classList.remove('active', 'fade-out');
    }, 300);
  }
};

const renderRepoRefreshStatus = () => {
  if (!repoRefreshStatus) return;

  const activeRateLimit = getActiveGitHubRateLimit();
  if (activeRateLimit.isCoolingDown && activeRateLimit.resetAt) {
    repoRefreshStatus.textContent = getGitHubRateLimitPauseMessage(activeRateLimit);
    repoRefreshStatus.classList.remove('hidden');
    repoRefreshStatus.classList.add('active');
    return;
  }

  if (state.isFetchingRepos) {
    const teamCount = state.config.teams.length;
    repoRefreshStatus.textContent = `Refreshing team repositories for ${teamCount} team${teamCount === 1 ? '' : 's'}...`;
    repoRefreshStatus.classList.remove('hidden');
    repoRefreshStatus.classList.add('active');
  } else {
    repoRefreshStatus.textContent = '';
    repoRefreshStatus.classList.remove('active');
    repoRefreshStatus.classList.add('hidden');
  }
};

const setState = (updates) => {
  state = { ...state, ...updates };
  renderRepoRefreshStatus();
  render();
};

const isRepoIgnored = (repoName) => state.config.ignoreRepos.includes(repoName);

const toggleIgnoreForRepo = (repoName) => {
  const ignoreRepos = [...state.config.ignoreRepos];
  const index = ignoreRepos.indexOf(repoName);
  if (index > -1) {
    ignoreRepos.splice(index, 1);
  } else {
    ignoreRepos.push(repoName);
  }
  const nextConfig = { ...state.config, ignoreRepos };
  persistConfig(nextConfig);
  setState({ config: nextConfig });
};

const openSettings = () => {
  ownerInput.value = state.config.owner;
  teamsInput.value = state.config.teams.join(', ');
  tokenInput.value = state.config.token;
  settingsForm.style.display = 'block';
  repoView.classList.add('hidden');
  prView.classList.add('hidden');
  requestAnimationFrame(() => teamsInput.focus());
};

const closeSettings = () => {
  settingsForm.style.display = 'none';
  render();
};

const updateShortcutsOverlayLayout = () => {
  const isVisible = shortcutsOverlay.style.display !== 'none';
  document.body.classList.toggle('shortcuts-open', isVisible);

  if (!isVisible) {
    document.body.style.removeProperty('--shortcuts-overlay-height');
    return;
  }

  if (!renderCache.shortcutsOverlayHeight) {
    renderCache.shortcutsOverlayHeight = shortcutsOverlay.offsetHeight;
  }
  document.body.style.setProperty('--shortcuts-overlay-height', `${renderCache.shortcutsOverlayHeight}px`);
};

const updateSelectedListItem = (listElement, itemClassName, oldIndex, nextIndex) => {
  if (!listElement || oldIndex === nextIndex) return;

  if (oldIndex >= 0) {
    listElement.querySelector(`.${itemClassName}[data-index="${oldIndex}"]`)?.classList.remove('selected');
  }

  if (nextIndex >= 0) {
    const nextEl = listElement.querySelector(`.${itemClassName}[data-index="${nextIndex}"]`);
    if (nextEl) {
      nextEl.classList.add('selected');
      listElement.focus();
      nextEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
};

const updateSelectionState = (indexKey, nextIndex) => {
  if (state[indexKey] === nextIndex) return;

  const oldIndex = state[indexKey];
  state = { ...state, [indexKey]: nextIndex };

  if (indexKey === 'selectedRepoIndex') {
    updateSelectedListItem(repoList, 'repo-item', oldIndex, nextIndex);
    return;
  }

  updateSelectedListItem(state.showRecentPRs ? recentPrList : openPrList, 'pr-item', oldIndex, nextIndex);
};

const canRefreshConfig = (config) => Boolean(config.token && config.owner && config.teams.length > 0);

const buildRepoMappings = (teamSlugs, repoMappings = state.config.repos) => {
  const previousRepos = new Map(repoMappings.map((team) => [team.slug, team.repos]));
  return teamSlugs.map((slug) => ({
    slug,
    repos: previousRepos.get(slug) || [],
  }));
};

const applyConfigLocally = (nextConfig, updates = {}) => {
  persistConfig(nextConfig);
  setState({
    config: nextConfig,
    ...updates,
  });
};

const refreshAfterConfigChange = async (nextConfig, { activeTeamSlugOverride = state.activeTeamSlug } = {}) => {
  const refreshedConfig = await refreshAllTeamRepos(nextConfig);
  await refreshCurrentView({
    configOverride: refreshedConfig,
    activeTeamSlugOverride,
    reposOverride: getVisibleRepos(refreshedConfig, activeTeamSlugOverride),
    merge: false,
  });
  closeSettings();
};

const applyConfig = async () => {
  const owner = ownerInput.value.trim();
  const token = tokenInput.value.trim();
  const teamSlugs = parseTeamInput(teamsInput.value);

  if (!owner) {
    console.warn('Please configure an owner.');
    return;
  }

  if (teamSlugs.length === 0) {
    console.warn('Please configure at least one team.');
    return;
  }

  const nextConfig = {
    ...state.config,
    owner,
    token,
    teams: teamSlugs,
    repos: buildRepoMappings(teamSlugs),
  };

  applyConfigLocally(nextConfig, {
    activeTeamSlug: '',
    selectedRepoIndex: -1,
    selectedPrIndex: -1,
    showShortlog: false,
    shortlogData: null,
    shortlogAuthorFilter: 'external',
  });

  if (!canRefreshConfig(nextConfig)) {
    requestAnimationFrame(() => {
      if (!nextConfig.owner || nextConfig.teams.length === 0) {
        teamsInput.focus();
      } else {
        tokenInput.focus();
      }
    });
    return;
  }

  try {
    await refreshAfterConfigChange(nextConfig, { activeTeamSlugOverride: '' });
  } catch (error) {
    console.error('Error applying configuration', error);
  }
};

const renderShortlogView = () => {
  shortlogSinceDateInput.value = state.shortlogSinceDate;
  const { shortlogData, isFetchingShortlog, config: { owner } } = state;

  if (!shortlogData && !isFetchingShortlog) {
    shortlogBody.innerHTML = '<div class="shortlog-empty">press <strong>r</strong> to load</div>';
    return;
  }
  if (!shortlogData) {
    shortlogBody.innerHTML = '<div class="shortlog-empty">Loading…</div>';
    return;
  }

  const filterType = state.shortlogAuthorFilter;
  const { totals, perRepo, allPRs, membersAllLoaded } = shortlogData;

  const warningBanner = !membersAllLoaded
    ? `<div class="shortlog-warning">${ICONS.warning} Some team member lists failed to load; classifications may be inaccurate.</div>`
    : '';
  const sortedRepos = [...perRepo.entries()]
    .filter(([, counts]) => counts.total > 0)
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
  const tableRows = sortedRepos.map(([repoName, counts]) => `<tr><td><a href="https://github.com/${owner}/${repoName}" target="_blank" rel="noopener noreferrer">${repoName}</a></td><td class="count-cell">${counts.total}</td><td class="count-cell external-count">${counts.external}</td><td class="count-cell">${counts.internal}</td><td class="count-cell dim-count">${counts.bot}</td></tr>`).join('');
  const tableHtml = sortedRepos.length > 0
    ? `<table class="shortlog-table"><thead><tr><th>Repository</th><th class="count-cell">Total <span class="th-count">${totals.total}</span></th><th class="count-cell">External <span class="th-count external-count">${totals.external}</span></th><th class="count-cell">Internal <span class="th-count">${totals.internal}</span></th><th class="count-cell">Bots <span class="th-count dim-count">${totals.bot}</span></th></tr></thead><tbody>${tableRows}</tbody></table>`
    : '';

  const visiblePRs = (filterType === 'all' || filterType === 'repo')
    ? allPRs
    : allPRs.filter((pr) => pr.authorType === filterType);
  let prListHtml = '';
  if (visiblePRs.length > 0) {
    let groupsHtml;
    if (filterType === 'repo') {
      const byRepo = new Map();
      visiblePRs.forEach((pr) => {
        const repoName = pr.repository?.name || 'unknown';
        if (!byRepo.has(repoName)) byRepo.set(repoName, []);
        byRepo.get(repoName).push(pr);
      });
      const sortedByRepo = [...byRepo.entries()].sort(([aName, a], [bName, b]) => {
        if (b.length !== a.length) return b.length - a.length;
        return aName.localeCompare(bName);
      });
      groupsHtml = sortedByRepo.map(([repoName, repoPRs]) => {
        const rowsHtml = repoPRs.map((pr) => {
          const mergedAgo = pr.mergedAt ? formatCompactDistanceToNow(pr.mergedAt) : '';
          const branchStr = pr.baseRefName && !DEFAULT_BRANCHES.has(pr.baseRefName) ? ` · ${pr.baseRefName}` : '';
          const authorClass = pr.authorType === 'external' ? ' class="external-count"' : pr.authorType === 'bot' ? ' class="dim-count"' : '';
          return `<li class="shortlog-pr-item"><a href="${pr.url}" target="_blank" rel="noopener noreferrer">#${pr.number} ${pr.title}</a><span class="shortlog-pr-meta"> — <span${authorClass}>${pr.authorLogin}</span>${mergedAgo ? ` · ${mergedAgo} ago` : ''}${branchStr}</span></li>`;
        }).join('');
        return `<div class="shortlog-author-group"><div class="shortlog-author-name"><a href="https://github.com/${owner}/${repoName}" target="_blank" rel="noopener noreferrer">${repoName}</a> (${repoPRs.length})</div><ul class="shortlog-pr-list">${rowsHtml}</ul></div>`;
      }).join('');
    } else {
      const byAuthor = new Map();
      visiblePRs.forEach((pr) => {
        if (!byAuthor.has(pr.authorLogin)) {
          byAuthor.set(pr.authorLogin, { authorType: pr.authorType, prs: [], latestMergedAt: null });
        }
        const group = byAuthor.get(pr.authorLogin);
        group.prs.push(pr);
        if (pr.mergedAt && (!group.latestMergedAt || pr.mergedAt > group.latestMergedAt)) {
          group.latestMergedAt = pr.mergedAt;
        }
      });
      const sortedAuthors = [...byAuthor.entries()].sort(([aLogin, a], [bLogin, b]) => {
        if (b.prs.length !== a.prs.length) return b.prs.length - a.prs.length;
        const aTime = a.latestMergedAt ? a.latestMergedAt.getTime() : 0;
        const bTime = b.latestMergedAt ? b.latestMergedAt.getTime() : 0;
        if (bTime !== aTime) return bTime - aTime;
        return aLogin.localeCompare(bLogin);
      });
      groupsHtml = sortedAuthors.map(([login, { authorType, prs }]) => {
        const nameClass = filterType === 'all'
          ? (authorType === 'external' ? ' class="external-count"' : authorType === 'bot' ? ' class="dim-count"' : '')
          : '';
        const rowsHtml = prs.map((pr) => {
          const mergedAgo = pr.mergedAt ? formatCompactDistanceToNow(pr.mergedAt) : '';
          const repoName = pr.repository?.name || 'unknown';
          const branchStr = pr.baseRefName && !DEFAULT_BRANCHES.has(pr.baseRefName) ? ` · ${pr.baseRefName}` : '';
          return `<li class="shortlog-pr-item"><a href="${pr.url}" target="_blank" rel="noopener noreferrer">#${pr.number} ${pr.title}</a><span class="shortlog-pr-meta"> — ${repoName}${mergedAgo ? ` · ${mergedAgo} ago` : ''}${branchStr}</span></li>`;
        }).join('');
        return `<div class="shortlog-author-group"><div class="shortlog-author-name"${nameClass}>${login} (${prs.length})</div><ul class="shortlog-pr-list">${rowsHtml}</ul></div>`;
      }).join('');
    }
    prListHtml = `<div class="shortlog-pr-section">${groupsHtml}</div>`;
  } else if (totals.total > 0) {
    prListHtml = `<div class="shortlog-empty">No ${filterType === 'all' ? '' : `${filterType} `}PRs found in this period.</div>`;
  }

  shortlogBody.innerHTML = warningBanner + tableHtml + prListHtml;
};

const render = () => {
  const {
    config: { token, owner, teams, repos },
    selectedRepoIndex,
    selectedPrIndex,
    showRepoLinks,
  } = state;
  const visibleRepos = getVisibleRepos();
  const scopeLabel = teams.length === 0
    ? ''
    : state.activeTeamSlug
      ? `team: ${state.activeTeamSlug}`
      : teams.length === 1
        ? `team: ${teams[0]}`
        : 'all teams';
  const showInlineTeamBadges = state.showTeamBadges && teams.length > 1 && !state.activeTeamSlug;
  const teamBadgeCache = new Map();
  document.title = 'PR Radiator';
  renderCache.visibleRepos = visibleRepos;
  renderCache.displayPRs = [];
  renderCache.mode = '';

  if (!token || !owner || teams.length === 0) {
    openSettings();
    repoView.classList.add('hidden');
    prView.classList.add('hidden');
    shortlogView.classList.add('hidden');
    return;
  }
  settingsForm.style.display = 'none';

  if (getAllReposFromMappings(repos).length === 0) {
    repoView.classList.add('hidden');
    shortlogView.classList.add('hidden');
    const loadingMessage = state.isFetchingRepos
      ? 'Fetching configured team repositories...'
      : 'No repositories loaded yet. Press R to refresh team repositories.';
    openPrHeader.innerHTML = `<div>${loadingMessage}</div>`;
    openPrList.innerHTML = '';
    openPrView.classList.remove('hidden');
    recentPrView.classList.add('hidden');
    return;
  }

  if (state.showShortlog) {
    repoView.classList.add('hidden');
    prView.classList.add('hidden');
    shortlogView.classList.remove('hidden');
    renderCache.mode = 'shortlog';
    const { shortlogData, isFetchingShortlog } = state;
    const filterType = state.shortlogAuthorFilter;
    const filteredCount = shortlogData
      ? (['all', 'repo'].includes(filterType) ? shortlogData.totals.total : shortlogData.totals[filterType])
      : null;
    const badge = isFetchingShortlog
      ? `<span class="fetching-spinner">${ICONS.hourglass}</span>`
      : filteredCount !== null ? filteredCount : '—';
    const shortlogSummaryParts = ['shortlog'];
    if (filterType !== 'all') shortlogSummaryParts.push(filterType);
    if (scopeLabel) shortlogSummaryParts.push(scopeLabel);
    const shortlogSummaryEl = `<span class="view-summary">— ${shortlogSummaryParts.join(' | ')}</span>`;
    shortlogHeaderTitle.innerHTML = `Pull requests (${badge}) ${shortlogSummaryEl}`;
    renderShortlogView();
    return;
  }
  shortlogView.classList.add('hidden');

  if (showRepoLinks) {
    repoView.classList.remove('hidden');
    prView.classList.add('hidden');
    renderCache.mode = 'repos';

    const badgeEl = `(${visibleRepos.length})`;
    const summaryEl = scopeLabel ? `<span class="view-summary">— ${scopeLabel}</span>` : '';
    repoHeader.innerHTML = `Repositories ${badgeEl}${summaryEl ? ` ${summaryEl}` : ''}`;

    repoList.innerHTML = visibleRepos.map((repo, index) => {
      const isIgnored = isRepoIgnored(repo);
      const classes = `repo-item ${isIgnored ? 'ignored' : ''} ${index === selectedRepoIndex ? 'selected' : ''}`;
      let teamBadges = '';
      if (showInlineTeamBadges) {
        const teamSlugs = getRepoTeamSlugs(repo);
        if (teamSlugs.length > 0) {
          const badgeKey = teamSlugs.join('|');
          teamBadges = teamBadgeCache.get(badgeKey) || '';
          if (!teamBadges) {
            teamBadges = `<span class="team-badges">${teamSlugs.map((slug) => `<span class="team-badge" title="Team ${slug}">${slug}</span>`).join('')}</span>`;
            teamBadgeCache.set(badgeKey, teamBadges);
          }
        }
      }
      return `<li class="${classes}" data-index="${index}" data-repo="${repo}">${teamBadges}<a href="https://github.com/${owner}/${repo}" target="_blank" rel="noopener noreferrer">${repo}</a></li>`;
    }).join('');

    if (selectedRepoIndex >= 0) {
      repoList.focus();
      setTimeout(() => {
        const selectedItem = repoList.querySelector('.repo-item.selected');
        if (selectedItem) {
          selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 0);
    }
    return;
  }

  repoView.classList.add('hidden');
  prView.classList.remove('hidden');

  const sourcePRs = state.showRecentPRs ? state.recentPRs : state.PRs;
  const visibleTeamSlugs = new Set(state.activeTeamSlug ? [state.activeTeamSlug] : teams);
  const ignoredRepos = new Set(state.config.ignoreRepos);
  const hideDependabot = shouldHideDependabotPRs();
  const needsReviewOnly = isNeedsReviewFilterActive();
  const displayPRs = [];

  sourcePRs.forEach((pr) => {
    if (!pr.teamSlugs.some((slug) => visibleTeamSlugs.has(slug))) return;
    if (ignoredRepos.has(pr.repository.name)) return;
    if (hideDependabot && getActorLogin(pr.author, '') === 'dependabot') return;
    if (needsReviewOnly && pr.reviewDecision !== 'REVIEW_REQUIRED' && pr.reviewDecision !== null) return;
    displayPRs.push(pr);
  });

  renderCache.displayPRs = displayPRs;
  renderCache.mode = state.showRecentPRs ? 'recent-prs' : 'open-prs';

  const buildSectionHeader = (title, badgeContent, prState) => {
    const summaryParts = [];
    if (prState) summaryParts.push(prState.toLowerCase());
    if (isDependabotFilterActive()) summaryParts.push('dependabot');
    if (isNeedsReviewFilterActive()) summaryParts.push('awaiting review');
    if (scopeLabel) summaryParts.push(scopeLabel);
    const summaryEl = summaryParts.length > 0 ? `<span class="view-summary">— ${summaryParts.join(' | ')}</span>` : '';
    return `${title} (${badgeContent})${summaryEl ? ` ${summaryEl}` : ''}`;
  };

  if (state.showRecentPRs) {
    recentPrSinceDateInput.value = state.recentPRsSinceDate;
    const count = displayPRs.length;
    const badge = state.isFetchingRecentPRs
      ? `<span class="fetching-spinner">${ICONS.hourglass}</span>`
      : count;
    recentPrHeader.innerHTML = buildSectionHeader('Pull requests', badge, 'MERGED');
    syncPRList(recentPrList, displayPRs, {
      isRecent: true,
      showBranch: state.showBranch,
      showInlineTeamBadges,
      teamBadgeCache,
      selectedPrIndex,
      activityOnSeparateLine: state.activityOnSeparateLine,
    });
    document.title = `(${count}) PR Radiator`;

    recentPrView.classList.remove('hidden');
    openPrView.classList.add('hidden');

    if (selectedPrIndex >= 0) {
      recentPrList.focus();
      setTimeout(() => {
        const selectedItem = recentPrList.querySelector('.pr-item.selected');
        if (selectedItem) {
          selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 0);
    }
    return;
  }

  const count = displayPRs.length;
  const badge = state.isFetchingOpenPRs
    ? `<span class="fetching-spinner">${ICONS.hourglass}</span>`
    : count;
  openPrHeader.innerHTML = buildSectionHeader('Pull requests', badge, 'OPEN');
  syncPRList(openPrList, displayPRs, {
    isRecent: false,
    showBranch: state.showBranch,
    showInlineTeamBadges,
    teamBadgeCache,
    selectedPrIndex,
    activityOnSeparateLine: state.activityOnSeparateLine,
    showActivity: true,
  });
  document.title = `(${count}) PR Radiator`;

  openPrView.classList.remove('hidden');
  recentPrView.classList.add('hidden');

  if (selectedPrIndex >= 0) {
    openPrList.focus();
    setTimeout(() => {
      const selectedItem = openPrList.querySelector('.pr-item.selected');
      if (selectedItem) {
        selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 0);
  }
};

const useInterval = (callback, delay) => {
  let id;

  if (delay !== null) {
    id = setInterval(() => callback(), delay);
    return () => clearInterval(id);
  }

  return undefined;
};

const cycleActiveTeam = () => {
  const teamSlugs = state.config.teams;
  if (teamSlugs.length <= 1) return false;

  const currentIndex = state.activeTeamSlug ? teamSlugs.indexOf(state.activeTeamSlug) : -1;
  const nextActiveTeam = currentIndex >= teamSlugs.length - 1 ? '' : teamSlugs[currentIndex + 1];

  setState({
    activeTeamSlug: nextActiveTeam,
    selectedRepoIndex: -1,
    selectedPrIndex: -1,
  });
  return true;
};

const init = async () => {
  if (state.config.token && state.config.owner && getAllReposFromMappings(state.config.repos).length > 0) {
    await fetchOpenPRs(state.config.token, state.config.owner, getVisibleRepos(), state.config.ignoreRepos);
  }

  useInterval(() => {
    const repos = getVisibleRepos();
    if (state.config.token && state.config.owner && repos.length > 0 && !state.showRepoLinks && !state.showShortlog && !state.isFetchingOpenPRs && !state.isFetchingRecentPRs && !getActiveGitHubRateLimit().isCoolingDown) {
      refreshCurrentView().catch((error) => {
        console.error('Error refreshing PRs on interval', error);
      });
    }
  }, 300000);

  if (!settingsForm.hasAttribute('data-initialized')) {
    ownerInput.value = state.config.owner;
    teamsInput.value = state.config.teams.join(', ');
    tokenInput.value = state.config.token;

    applyConfigButton.addEventListener('click', () => {
      applyConfig().catch((error) => {
        console.error('Error applying configuration', error);
      });
    });

    [ownerInput, teamsInput, tokenInput].forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        applyConfig().catch((error) => {
          console.error('Error applying configuration', error);
        });
      });
    });
    settingsForm.setAttribute('data-initialized', 'true');
  }

  shortlogSinceDateInput.addEventListener('change', (event) => {
    const newDate = event.target.value;
    if (!newDate || !state.showShortlog) return;
    localStorage.setItem(STORAGE_KEYS.shortlogSinceDate, newDate);
    setState({ shortlogSinceDate: newDate, shortlogData: null });
    fetchShortlog().catch((error) => {
      console.error('Error fetching shortlog after date change', error);
    });
  });

  recentPrSinceDateInput.addEventListener('change', (event) => {
    const newDate = event.target.value;
    if (!newDate || !state.showRecentPRs) return;
    localStorage.setItem(STORAGE_KEYS.recentPRsSinceDate, newDate);
    setState({ recentPRsSinceDate: newDate });
    const { token, owner, ignoreRepos } = state.config;
    fetchRecentPRs(token, owner, getVisibleRepos(), ignoreRepos).catch((error) => {
      console.error('Error fetching merged PRs after date change', error);
    });
  });

  let lastKeyPress = { key: null, timestamp: 0 };

  document.addEventListener('keydown', (event) => {
    if (settingsForm.style.display === 'block') {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSettings();
      }
      return;
    }
    if (document.activeElement.tagName === 'INPUT') return;

    const { showRepoLinks } = state;

    const handleNavigation = (items, currentIndex, indexKey, onEnter, extraHandlers = {}) => {
      let handled = true;
      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          if (items.length > 0) {
            const newIndex = currentIndex < 0 ? 0 : Math.min(items.length - 1, currentIndex + 1);
            updateSelectionState(indexKey, newIndex);
          }
          break;
        case 'k':
        case 'ArrowUp':
          if (items.length > 0) {
            const newIndex = currentIndex < 0 ? 0 : Math.max(0, currentIndex - 1);
            updateSelectionState(indexKey, newIndex);
          }
          break;
        case 'g': {
          const now = Date.now();
          if (lastKeyPress.key === 'g' && (now - lastKeyPress.timestamp) < 500) {
            if (items.length > 0) {
              updateSelectionState(indexKey, 0);
            }
            lastKeyPress = { key: null, timestamp: 0 };
          } else {
            lastKeyPress = { key: 'g', timestamp: now };
          }
          break;
        }
        case 'G':
          if (items.length > 0) {
            updateSelectionState(indexKey, items.length - 1);
          }
          break;
        case 'Enter':
          if (items.length > 0 && currentIndex >= 0) {
            onEnter(items[currentIndex]);
          }
          break;
        default:
          if (extraHandlers[event.key]) {
            extraHandlers[event.key]();
          } else {
            handled = false;
          }
      }
      return handled;
    };

    if (showRepoLinks) {
      const visibleRepos = renderCache.visibleRepos;
      const handled = handleNavigation(
        visibleRepos,
        state.selectedRepoIndex,
        'selectedRepoIndex',
        (repo) => {
          const url = `https://github.com/${state.config.owner}/${repo}`;
          window.open(url, '_blank', 'noopener,noreferrer');
        },
        {
          i: () => {
            if (visibleRepos.length > 0 && state.selectedRepoIndex >= 0) {
              const repo = visibleRepos[state.selectedRepoIndex];
              toggleIgnoreForRepo(repo);
            }
          },
        }
      );
      if (handled) {
        event.preventDefault();
        return;
      }
    }

    if (!showRepoLinks) {
      const displayPRs = renderCache.displayPRs;
      const handled = !state.showShortlog && handleNavigation(
        displayPRs,
        state.selectedPrIndex,
        'selectedPrIndex',
        (pr) => window.open(pr.url, '_blank', 'noopener,noreferrer')
      );
      if (handled) {
        event.preventDefault();
        return;
      }
    }

    const handlers = {
      o: () => {
        setState({
          showRecentPRs: false,
          showRepoLinks: false,
          showShortlog: false,
          selectedRepoIndex: -1,
          selectedPrIndex: -1,
        });
        refreshCurrentView().catch((error) => {
          console.error('Error refreshing open PRs', error);
        });
      },
      m: () => {
        const showRecentPRs = !state.showRecentPRs || state.showRepoLinks || state.showShortlog;
        setState({
          showRecentPRs,
          showRepoLinks: false,
          showShortlog: false,
          selectedRepoIndex: -1,
          selectedPrIndex: -1,
        });
        refreshCurrentView().catch((error) => {
          console.error('Error refreshing merged PRs', error);
        });
      },
      l: () => {
        if (state.showRepoLinks) {
          persistConfig(state.config);
          setState({
            showRepoLinks: false,
            showRecentPRs: false,
            showShortlog: false,
            selectedRepoIndex: -1,
            selectedPrIndex: -1,
          });
          refreshCurrentView().catch((error) => {
            console.error('Error refreshing PRs after repo view', error);
          });
          return;
        }

        setState({
          showRepoLinks: true,
          showShortlog: false,
          selectedRepoIndex: -1,
          selectedPrIndex: -1,
        });
      },
      s: () => {
        const needsFetch = !state.showShortlog
          || !state.shortlogData
          || state.shortlogData.sinceDate !== state.shortlogSinceDate
          || state.shortlogData.activeTeamSlug !== state.activeTeamSlug;
        setState({
          showShortlog: true,
          showRecentPRs: false,
          showRepoLinks: false,
          selectedRepoIndex: -1,
          selectedPrIndex: -1,
        });
        if (needsFetch) {
          fetchShortlog().catch((error) => {
            console.error('Error fetching shortlog', error);
          });
        }
      },
      d: () => setState({ showDependabotPRs: !state.showDependabotPRs, selectedPrIndex: -1 }),
      n: () => setState({ showNeedsReviewPRs: !state.showNeedsReviewPRs, selectedPrIndex: -1 }),
      b: () => setState({ showTeamBadges: !state.showTeamBadges }),
      B: () => setState({ showBranch: !state.showBranch }),
      A: () => {
        const next = !state.activityOnSeparateLine;
        localStorage.setItem(STORAGE_KEYS.activityOnSeparateLine, next);
        setState({ activityOnSeparateLine: next });
      },
      f: () => {
        if (!state.showShortlog) return;
        const cycle = { all: 'external', external: 'internal', internal: 'bot', bot: 'repo', repo: 'all' };
        setState({ shortlogAuthorFilter: cycle[state.shortlogAuthorFilter] ?? 'external' });
      },
      r: () => {
        setState({ selectedPrIndex: -1, selectedRepoIndex: -1 });
        if (state.showShortlog) {
          fetchShortlog().catch((error) => {
            console.error('Error refreshing shortlog', error);
          });
          return;
        }
        refreshCurrentView().catch((error) => {
          console.error('Error refreshing current view', error);
        });
      },
      R: () => {
        setState({ shortlogData: null });
        const membersCache = loadPersistedMemberCache();
        state.config.teams.forEach((slug) => {
          const entry = membersCache.get(slug);
          if (entry) {
            membersCache.set(slug, { ...entry, fetchedAt: 0 });
          }
        });
        persistMemberCache(membersCache);
        localStorage.removeItem(STORAGE_KEYS.collaboratorPermissionCache);
        collaboratorPermissionCache = null;
        pendingPermissionLookups = null;
        refreshAllTeamRepos()
          .then((config) => {
            if (state.showShortlog) {
              return fetchShortlog({ forceRefreshMembers: true });
            }
            return refreshCurrentView({ configOverride: config, reposOverride: getAllConfiguredRepos(config), merge: false });
          })
          .catch((error) => {
            console.error('Error refreshing team repositories', error);
          });
      },
      t: () => {
        cycleActiveTeam();
        if (state.showShortlog) {
          setState({ shortlogData: null });
          fetchShortlog().catch((error) => {
            console.error('Error refreshing shortlog after team change', error);
          });
        }
      },
      c: () => openSettings(),
      '?': () => {
        const opening = shortcutsOverlay.style.display === 'none';
        shortcutsOverlay.style.display = opening ? 'block' : 'none';
        if (!opening) {
          renderCache.shortcutsOverlayHeight = 0;
        }
        updateShortcutsOverlayLayout();
      },
    };

    if (handlers[event.key]) {
      event.preventDefault();
      handlers[event.key]();
    }
  });

  if (state.config.token && state.config.owner && state.config.teams.length > 0 && getAllReposFromMappings(state.config.repos).length === 0) {
    try {
      const refreshedConfig = await refreshAllTeamRepos();
      await refreshCurrentView({
        configOverride: refreshedConfig,
        reposOverride: getAllConfiguredRepos(refreshedConfig),
        merge: false,
      });
    } catch (error) {
      console.error('Error loading team repositories', error);
    }
  }

  document.addEventListener('visibilitychange', () => {
    const repos = getVisibleRepos();
    if (document.visibilityState === 'visible' && state.config.token && state.config.owner && repos.length > 0 && !state.showRepoLinks && !state.showShortlog && !state.isFetchingOpenPRs && !state.isFetchingRecentPRs && !getActiveGitHubRateLimit().isCoolingDown) {
      refreshCurrentView().catch((error) => {
        console.error('Error refreshing PRs on tab focus', error);
      });
    }
  });

  render();
};

init();
