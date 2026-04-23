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
  externalMergesSinceDate: 'PR_RADIATOR_EXTERNAL_SINCE_DATE',
};

const GRAPHQL_REPO_BATCH_SIZE = 2;
const DISCOVERY_BATCH_SIZE = 4;
const RATE_LIMIT_COOLDOWN_THRESHOLD = 100;
const RATE_LIMIT_RESET_BUFFER_MS = 1000;
const STORAGE_WRITE_FRAME_DELAY = 16;
const TEAM_MEMBERS_CACHE_TTL_MS = 60 * 60 * 1000;
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
const externalMergesView = document.getElementById('external-merges-view');
const externalMergesHeaderTitle = document.getElementById('external-merges-header-title');
const externalMergesBody = document.getElementById('external-merges-body');
const externalMergesSinceDateInput = document.getElementById('external-merges-since');

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
const openPRHydrationFields = 'title url createdAt updatedAt baseRefName headRefOid isDraft number author{login} comments(first:5){nodes{createdAt author{login}}} reviews(first:15){nodes{state createdAt author{login}}} commits(last:1){nodes{commit{oid statusCheckRollup{state}}}} reviewDecision';
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

const externalMergesPRFields = 'number title url mergedAt author{__typename login} baseRefName repository{name}';

const buildExternalMergesSearchQuery = (owner, repos, sinceDate) => {
  const batchedSearches = repos
    .map((repo, index) => `${getShortGraphQLAlias(index)}:search(type:ISSUE,first:100,query:"repo:${owner}/${repo} is:pr is:merged merged:>=${sinceDate}"){issueCount pageInfo{endCursor hasNextPage}nodes{...on PullRequest{${externalMergesPRFields}}}}`)
    .join(' ');
  return `query{${graphqlCostFragment} ${batchedSearches}}`;
};

const buildExternalMergesPaginationQuery = (owner, repo, sinceDate, cursor) => {
  return `query{${graphqlCostFragment} search(type:ISSUE,first:100,after:"${cursor}",query:"repo:${owner}/${repo} is:pr is:merged merged:>=${sinceDate}"){pageInfo{endCursor hasNextPage}nodes{...on PullRequest{${externalMergesPRFields}}}}}`;
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

const fetchExternalMergesData = async (token, owner, repos, ignoreRepos, sinceDate) => {
  const filteredRepos = repos.filter((repo) => !ignoreRepos.includes(repo));
  if (filteredRepos.length === 0) return [];

  const allPRs = [];
  const issueCountWarnings = [];
  const chunks = chunkArray(filteredRepos, EXTERNAL_MERGES_SEARCH_BATCH_SIZE);
  const reposNeedingPagination = [];

  await Promise.all(chunks.map(async (chunk) => {
    const query = buildExternalMergesSearchQuery(owner, chunk, sinceDate);
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
      const query = buildExternalMergesPaginationQuery(owner, repoName, sinceDate, cursor);
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
    console.warn(`⚠️ External merges: some repos may have incomplete results (>1000 PRs): ${issueCountWarnings.join(', ')}`);
  }
  return allPRs;
};

const classifyAndAggregateExternalMerges = (prs, internalLogins) => {
  const totals = { total: 0, external: 0, internal: 0, bot: 0 };
  const perRepo = new Map();
  const externalPRs = [];

  prs.forEach((pr) => {
    const repoName = pr.repository?.name || 'unknown';
    const author = pr.author;
    if (!perRepo.has(repoName)) {
      perRepo.set(repoName, { total: 0, external: 0, internal: 0, bot: 0 });
    }
    const counts = perRepo.get(repoName);
    totals.total++;
    counts.total++;
    if (isBotLogin(author)) {
      totals.bot++;
      counts.bot++;
    } else if (internalLogins.has(author?.login || '')) {
      totals.internal++;
      counts.internal++;
    } else {
      totals.external++;
      counts.external++;
      externalPRs.push({ ...pr, mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null });
    }
  });

  externalPRs.sort((a, b) => {
    if (!a.mergedAt) return 1;
    if (!b.mergedAt) return -1;
    return b.mergedAt.getTime() - a.mergedAt.getTime();
  });

  return { totals, perRepo, externalPRs };
};

const fetchExternalMerges = async (options = {}) => {
  const { forceRefreshMembers = false } = options;
  const { token, owner, teams, ignoreRepos } = state.config;
  const sinceDate = state.externalMergesSinceDate;
  if (!token || !owner || teams.length === 0) return;
  if (shouldPauseGitHubRefresh()) {
    renderRepoRefreshStatus();
    return;
  }
  try {
    setState({ isFetchingExternalMerges: true });
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
      console.warn('⚠️ External merges: some team member lists failed to load; classifications may be incomplete.');
    }
    const prs = await fetchExternalMergesData(token, owner, repos, ignoreRepos, sinceDate);
    const { totals, perRepo, externalPRs } = classifyAndAggregateExternalMerges(prs, internalLogins);
    setState({
      externalMergesData: {
        totals,
        perRepo,
        externalPRs,
        sinceDate,
        activeTeamSlug: state.activeTeamSlug,
        fetchedAt: Date.now(),
        membersAllLoaded: allLoaded,
      },
    });
  } catch (error) {
    console.error('Failed to fetch external merges:', error);
  } finally {
    stopProgress();
    setState({ isFetchingExternalMerges: false });
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
      const repoData = repoDataMap[getShortGraphQLAlias(index)];
      if (!repoData) return;

      Object.keys(repoData).forEach((pullRequestKey) => {
        const pullRequest = repoData[pullRequestKey];
        if (!pullRequest) return;
        hydratedPRs.push(decoratePullRequest(pullRequest, repoName));
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

    const sinceOneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const results = await api.fetchRecentBatches(token, owner, filteredRepos, sinceOneWeekAgo);
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
        const nodes = repoDataMap[getShortGraphQLAlias(index)]?.pullRequests?.nodes ?? [];
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
    setState({
      PRs: merge
        ? mergePullRequestCache(state.PRs, openPRs, filteredRepos, sortByCreatedAt)
        : openPRs,
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

  if (!token || !owner) return;
  if (shouldPauseGitHubRefresh()) {
    renderRepoRefreshStatus();
    return;
  }

  if (state.showRepoLinks) {
    render();
    return;
  }

  if (state.showExternalMerges) {
    await fetchExternalMerges();
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
};
const combineReviewsAndComments = (reviews, comments) => {
  const events = [];

  reviews.nodes.forEach((review) => {
    const currentState = review.state === 'COMMENTED' ? 'COMMENTED' : review.state;
    events.push({
      createdAt: review.createdAt,
      author: getActorLogin(review.author),
      state: currentState,
    });
  });

  comments.nodes.forEach((comment) => {
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

const getCommitState = (headRefOid, commits) => {
  const icons = {
    SUCCESS: ICONS.check,
    PENDING: ICONS.hourglass,
    FAILURE: ICONS.times,
    EXPECTED: ICONS.hourglass,
    ERROR: ICONS.warning,
  };

  const conclusion = getCommitConclusion(headRefOid, commits) || 'ERROR';
  const icon = icons[conclusion] || ICONS.minus;
  const className = conclusion.toLowerCase();

  return `<span class="${className}">${icon}</span>`;
};

const TimelineEvent = ({ count, author, createdAt, state: eventState }) => {
  const countBadge = (count ?? 1) > 1 ? `(${count})` : '';
  const authorWithCount = `${author}${countBadge}`;
  const formattedDate = createdAt.toLocaleString();
  let tooltip = `${authorWithCount} ${eventState.toLowerCase()} at ${formattedDate}`;

  if (eventState === 'APPROVED') {
    return `<span class="event-group approved" title="${tooltip}">${authorWithCount}${ICONS.check}</span>`;
  }
  if (eventState === 'CHANGES_REQUESTED') {
    tooltip = `${authorWithCount} requested changes at ${formattedDate}`;
    return `<span class="event-group changes-requested" title="${tooltip}">${authorWithCount}${ICONS.times}</span>`;
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
      eventLines: '',
    };
  }

  const { createdAt, reviews, comments, baseRefName, headRefOid, commits } = pr;
  const events = combineReviewsAndComments(reviews, comments);
  const commitState = getCommitState(headRefOid, commits);
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
  const mainContent = mainParts.join(' ');

  const eventLines = events.length > 0
    ? `<div class="pr-event-lines">&nbsp;&nbsp;${events.map((event, eventIndex) => TimelineEvent({ ...event, key: eventIndex })).join('')}</div>`
    : '';

  return {
    signature: `open|${teamBadges}|${commitState}|${branch}|${author}|${repository.name}|${pr.number}|${title}|${eventLines}`,
    ageMarkup,
    ageClass,
    mainContent,
    eventLines,
  };
};

const syncPRNode = (node, pr, presentation, index, isSelected, isRecent) => {
  node.className = `pr-item${isSelected ? ' selected' : ''}`;
  node.dataset.index = `${index}`;
  node.dataset.url = pr.url;

  if (node.dataset.signature !== presentation.signature) {
    const mainLineClass = isRecent
      ? 'pr-main-line'
      : `pr-main-line ${presentation.ageClass}`;
    node.innerHTML = `<div class="${mainLineClass}">${presentation.ageMarkup} ${presentation.mainContent}</div>${presentation.eventLines}`;
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
    });
    let node = existingNodesByUrl.get(pr.url);

    if (!node) {
      node = document.createElement('li');
    } else {
      existingNodesByUrl.delete(pr.url);
    }

    syncPRNode(node, pr, presentation, index, index === selectedPrIndex, isRecent);

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
  showDependabotPRs: false,
  showNeedsReviewPRs: false,
  showRecentPRs: false,
  showRepoLinks: false,
  showExternalMerges: false,
  externalMergesData: null,
  externalMergesSinceDate: localStorage.getItem(STORAGE_KEYS.externalMergesSinceDate) || `${new Date().getFullYear()}-01-01`,
  isFetchingExternalMerges: false,
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

  if (!state.isFetchingRepos) {
    repoRefreshStatus.textContent = '';
    repoRefreshStatus.classList.remove('active');
    repoRefreshStatus.classList.add('hidden');
    return;
  }

  const teamCount = state.config.teams.length;
  repoRefreshStatus.textContent = `Refreshing team repositories for ${teamCount} team${teamCount === 1 ? '' : 's'}...`;
  repoRefreshStatus.classList.remove('hidden');
  repoRefreshStatus.classList.add('active');
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
    showExternalMerges: false,
    externalMergesData: null,
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

const renderExternalMergesView = () => {
  externalMergesSinceDateInput.value = state.externalMergesSinceDate;
  const { externalMergesData, isFetchingExternalMerges, config: { owner } } = state;
  const scopeLabel = state.activeTeamSlug ? ` <span class="view-summary">— team: ${state.activeTeamSlug}</span>` : '';
  const spinnerOrCount = isFetchingExternalMerges
    ? `<span class="fetching-spinner">${ICONS.hourglass}</span>`
    : externalMergesData
      ? `${externalMergesData.totals.external} external`
      : '—';
  externalMergesHeaderTitle.innerHTML = `External merges (${spinnerOrCount})${scopeLabel}`;

  if (!externalMergesData && !isFetchingExternalMerges) {
    externalMergesBody.innerHTML = '<div class="external-merges-empty">Press <strong>r</strong> to load external merge data.</div>';
    return;
  }
  if (!externalMergesData) {
    externalMergesBody.innerHTML = '<div class="external-merges-empty">Loading…</div>';
    return;
  }

  const { totals, perRepo, externalPRs, membersAllLoaded } = externalMergesData;
  const warningBanner = !membersAllLoaded
    ? `<div class="external-merges-warning">${ICONS.warning} Some team member lists failed to load; classifications may be inaccurate.</div>`
    : '';
  const summaryHtml = `<div class="external-merges-summary">Total: <strong>${totals.total}</strong> · External: <strong class="external-count">${totals.external}</strong> · Internal: <strong>${totals.internal}</strong> · Bots: <strong>${totals.bot}</strong></div>`;

  const sortedRepos = [...perRepo.entries()]
    .filter(([, counts]) => counts.total > 0)
    .sort((a, b) => b[1].external - a[1].external || a[0].localeCompare(b[0]));
  const tableRows = sortedRepos.map(([repoName, counts]) => `<tr><td><a href="https://github.com/${owner}/${repoName}" target="_blank" rel="noopener noreferrer">${repoName}</a></td><td class="count-cell">${counts.total}</td><td class="count-cell external-count">${counts.external}</td><td class="count-cell">${counts.internal}</td><td class="count-cell dim-count">${counts.bot}</td></tr>`).join('');
  const tableHtml = sortedRepos.length > 0
    ? `<table class="external-merges-table"><thead><tr><th>Repository</th><th class="count-cell">Total</th><th class="count-cell">External</th><th class="count-cell">Internal</th><th class="count-cell">Bots</th></tr></thead><tbody>${tableRows}</tbody></table>`
    : '';

  const prsByRepo = new Map();
  externalPRs.forEach((pr) => {
    const repoName = pr.repository?.name || 'unknown';
    if (!prsByRepo.has(repoName)) prsByRepo.set(repoName, []);
    prsByRepo.get(repoName).push(pr);
  });
  let prListHtml = '';
  if (externalPRs.length > 0) {
    const groupsHtml = [...prsByRepo.entries()].map(([repoName, repoPRs]) => {
      const rowsHtml = repoPRs.map((pr) => {
        const authorLogin = getActorLogin(pr.author, 'ghost');
        const mergedAgo = pr.mergedAt ? formatCompactDistanceToNow(pr.mergedAt) : '';
        const branch = pr.baseRefName ? ` · ${pr.baseRefName}` : '';
        return `<li class="external-pr-item"><a href="${pr.url}" target="_blank" rel="noopener noreferrer">#${pr.number} ${pr.title}</a><span class="external-pr-meta"> — ${authorLogin}${mergedAgo ? ` · ${mergedAgo} ago` : ''}${branch}</span></li>`;
      }).join('');
      return `<div class="external-prs-repo-group"><div class="external-prs-repo-name"><a href="https://github.com/${owner}/${repoName}" target="_blank" rel="noopener noreferrer">${repoName}</a> (${repoPRs.length})</div><ul class="external-prs-list">${rowsHtml}</ul></div>`;
    }).join('');
    prListHtml = `<div class="external-prs-section"><h3 class="external-prs-heading">External pull requests (${externalPRs.length})</h3>${groupsHtml}</div>`;
  } else if (totals.total > 0) {
    prListHtml = '<div class="external-merges-empty">No external PRs found in this period.</div>';
  }

  externalMergesBody.innerHTML = warningBanner + summaryHtml + tableHtml + prListHtml;
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
  const showInlineTeamBadges = teams.length > 1 && !state.activeTeamSlug;
  const teamBadgeCache = new Map();
  document.title = 'PR Radiator';
  renderCache.visibleRepos = visibleRepos;
  renderCache.displayPRs = [];
  renderCache.mode = '';

  if (!token || !owner || teams.length === 0) {
    openSettings();
    repoView.classList.add('hidden');
    prView.classList.add('hidden');
    externalMergesView.classList.add('hidden');
    return;
  }
  settingsForm.style.display = 'none';

  if (getAllReposFromMappings(repos).length === 0) {
    repoView.classList.add('hidden');
    externalMergesView.classList.add('hidden');
    const loadingMessage = state.isFetchingRepos
      ? 'Fetching configured team repositories...'
      : 'No repositories loaded yet. Press R to refresh team repositories.';
    openPrHeader.innerHTML = `<div>${loadingMessage}</div>`;
    openPrList.innerHTML = '';
    openPrView.classList.remove('hidden');
    recentPrView.classList.add('hidden');
    return;
  }

  if (state.showExternalMerges) {
    repoView.classList.add('hidden');
    prView.classList.add('hidden');
    externalMergesView.classList.remove('hidden');
    renderCache.mode = 'external-merges';
    renderExternalMergesView();
    return;
  }
  externalMergesView.classList.add('hidden');

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
    if (scopeLabel) summaryParts.push(scopeLabel);
    if (isDependabotFilterActive()) summaryParts.push('+dependabot');
    if (isNeedsReviewFilterActive()) summaryParts.push('awaiting review');
    const summaryEl = summaryParts.length > 0 ? `<span class="view-summary">— ${summaryParts.join(' | ')}</span>` : '';
    return `${title} (${badgeContent})${summaryEl ? ` ${summaryEl}` : ''}`;
  };

  if (state.showRecentPRs) {
    const count = displayPRs.length;
    const badge = state.isFetchingRecentPRs
      ? `<span class="fetching-spinner">${ICONS.hourglass}</span>`
      : count;
    recentPrHeader.innerHTML = buildSectionHeader('Pull requests', badge, 'MERGED');
    syncPRList(recentPrList, displayPRs, {
      isRecent: true,
      showBranch: false,
      showInlineTeamBadges,
      teamBadgeCache,
      selectedPrIndex,
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
    showBranch: true,
    showInlineTeamBadges,
    teamBadgeCache,
    selectedPrIndex,
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
    if (state.config.token && state.config.owner && repos.length > 0 && !state.showRepoLinks && !state.showExternalMerges && !state.isFetchingOpenPRs && !state.isFetchingRecentPRs && !getActiveGitHubRateLimit().isCoolingDown) {
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

  externalMergesSinceDateInput.addEventListener('change', (event) => {
    const newDate = event.target.value;
    if (!newDate || !state.showExternalMerges) return;
    localStorage.setItem(STORAGE_KEYS.externalMergesSinceDate, newDate);
    setState({ externalMergesSinceDate: newDate, externalMergesData: null });
    fetchExternalMerges().catch((error) => {
      console.error('Error fetching external merges after date change', error);
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
      const handled = !state.showExternalMerges && handleNavigation(
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
          showExternalMerges: false,
          selectedRepoIndex: -1,
          selectedPrIndex: -1,
        });
        refreshCurrentView().catch((error) => {
          console.error('Error refreshing open PRs', error);
        });
      },
      m: () => {
        const showRecentPRs = !state.showRecentPRs || state.showRepoLinks || state.showExternalMerges;
        setState({
          showRecentPRs,
          showRepoLinks: false,
          showExternalMerges: false,
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
            showExternalMerges: false,
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
          showExternalMerges: false,
          selectedRepoIndex: -1,
          selectedPrIndex: -1,
        });
      },
      x: () => {
        const needsFetch = !state.showExternalMerges
          || !state.externalMergesData
          || state.externalMergesData.sinceDate !== state.externalMergesSinceDate
          || state.externalMergesData.activeTeamSlug !== state.activeTeamSlug;
        setState({
          showExternalMerges: true,
          showRecentPRs: false,
          showRepoLinks: false,
          selectedRepoIndex: -1,
          selectedPrIndex: -1,
        });
        if (needsFetch) {
          fetchExternalMerges().catch((error) => {
            console.error('Error fetching external merges', error);
          });
        }
      },
      d: () => setState({ showDependabotPRs: !state.showDependabotPRs, selectedPrIndex: -1 }),
      n: () => setState({ showNeedsReviewPRs: !state.showNeedsReviewPRs, selectedPrIndex: -1 }),
      r: () => {
        setState({ selectedPrIndex: -1, selectedRepoIndex: -1 });
        if (state.showExternalMerges) {
          fetchExternalMerges().catch((error) => {
            console.error('Error refreshing external merges', error);
          });
          return;
        }
        refreshCurrentView().catch((error) => {
          console.error('Error refreshing current view', error);
        });
      },
      R: () => {
        setState({ externalMergesData: null });
        localStorage.removeItem(STORAGE_KEYS.teamMembersCache);
        refreshAllTeamRepos()
          .then((config) => {
            if (state.showExternalMerges) {
              return fetchExternalMerges({ forceRefreshMembers: true });
            }
            return refreshCurrentView({ configOverride: config, reposOverride: getAllConfiguredRepos(config), merge: false });
          })
          .catch((error) => {
            console.error('Error refreshing team repositories', error);
          });
      },
      t: () => {
        cycleActiveTeam();
        if (state.showExternalMerges) {
          setState({ externalMergesData: null });
          fetchExternalMerges().catch((error) => {
            console.error('Error refreshing external merges after team change', error);
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
    if (document.visibilityState === 'visible' && state.config.token && state.config.owner && repos.length > 0 && !state.showRepoLinks && !state.showExternalMerges && !state.isFetchingOpenPRs && !state.isFetchingRecentPRs && !getActiveGitHubRateLimit().isCoolingDown) {
      refreshCurrentView().catch((error) => {
        console.error('Error refreshing PRs on tab focus', error);
      });
    }
  });

  render();
};

init();
