import { sortByCreatedAt, byCommittedDateDesc } from './utils';

const RepositoriesQuery = (owner: string, team: string, next: string | null) => {
  const after: string = next ? `"${next}"`: 'null';

  return `{
  organization(login: "${owner}") {
    team(slug: "${team}") {
      repositories(first: 100, after: ${after}) {
        totalCount
        pageInfo {
          endCursor
          hasNextPage
        }
        edges {
          permission
          node {
            name isArchived
          }
        }
      }
    }
  }
}`;
};

const BatchQueryRecentPRs = (owner: string, repos: string[], sinceDateTime: string) => {
  const batchedRepos = repos.map((repo, index) => {
    const repoFieldAlias = 'alias' +  index;
    return `${repoFieldAlias}:repository (owner: "${owner}", name: "${repo}") { name
    ref(qualifiedName:"master") {
          target {... on Commit {history(first: 25, since: "${sinceDateTime}") {
            nodes {
              committedDate
              messageHeadline
              parents {
                totalCount
              }
              associatedPullRequests(first:5) {
                nodes { createdAt number title url author { login } repository { name } }
              }
            }
          }
        }
      }
    }
    isArchived
}`;
  }).join(' ');

  return `query RecentPRs { ${batchedRepos} }`
};

const BatchQueryOpenPRs = (owner: string, repos: string[]) => {
  const batchedRepos = repos.map((repo, index) => {
    const repoFieldAlias = 'alias' +  index;
    return `${repoFieldAlias}:repository (owner: "${owner}", name: "${repo}") { name
    pullRequests(last: 15, states: OPEN) { nodes {
    title url createdAt baseRefName headRefOid isDraft number
    author { login }
    comments (first: 50) {nodes {
      createdAt author { login }
    }}
    reviews(first: 50) {nodes {
      state createdAt author { login }
    }}
    commits(last: 1) { nodes { commit { oid statusCheckRollup { state }}
    }}}}
}`;
  }).join(' ');

  return `query OpenPRs { ${batchedRepos} }`
};

const chunks = (array: string[], chunk_size: number) =>
  Array(Math.ceil(array.length / chunk_size))
    .fill(undefined)
    .map((_: any, index: number) => index * chunk_size)
    .map((begin: any) => array.slice(begin, begin + chunk_size));

const maxConcurrentBatchQueryRecentPRs = async (token: string, owner: string, repos: string[], sinceDateTime: string) => {
  const result = chunks(repos, 4);

  return Promise.all(result.map(async (reposChunk: string[]) => {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'post',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: BatchQueryRecentPRs(owner, reposChunk, sinceDateTime) }),
    });
    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }));
};

const maxConcurrentBatchQueryOpenPRs = async (token: string, owner: string, repos: string[]) => {
  const result = chunks(repos, 4);

  return Promise.all(result.map(async (reposChunk: string[]) => {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'post',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: BatchQueryOpenPRs(owner, reposChunk) }),
    });
    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }));
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const filterTeamRepos = async (token: string, owner: string, team: string, repos: string[]) => {
  const filteredRepos: string[] = [];
  const concurrencyLimit = 20;
  const semaphore = Array(concurrencyLimit).fill(Promise.resolve());

  const makeRequest = async (repoName: string) => {
    try {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repoName}/teams`, {
        method: 'get',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new Error(`REST request failed: ${response.status} ${response.statusText}`);
      }
      const teams = await response.json();

      for (const t of teams) {
        if (t.slug === team && t.permission === 'admin') {
          filteredRepos.push(repoName);
          break;
        }
      }
    } catch (error) {
      console.error(`Error fetching teams for repo ${repoName}:`, error);
    }
  };

  const runRequests = repos.map((repoName, index) => {
    const request = () => makeRequest(repoName);
    const wrappedRequest = semaphore[index % concurrencyLimit].then(request);
    semaphore[index % concurrencyLimit] = wrappedRequest;
    return wrappedRequest;
  });

  await Promise.all(runRequests);

  return filteredRepos;
}

export const queryTeamRepos = async (token: string, owner: string, team: string) => {
  let hasNextPage = true;
  let next: string | null = null;
  const repoNames: string[] = [];

  while(hasNextPage) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'post',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: RepositoriesQuery(owner, team, next) }),
    });
    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }
    const result = await response.json();

    const repositories: any = result.data.organization.team.repositories;

    repositories.edges.forEach((repo: any) => {
      if (repo.permission === 'ADMIN' && repo.node.isArchived === false) {
        repoNames.push(repo.node.name);
      }
    });
    hasNextPage = repositories.pageInfo.hasNextPage;
    next = repositories.pageInfo.endCursor;

    /* https://developer.github.com/v3/guides/best-practices-for-integrators/#dealing-with-abuse-rate-limits
     * If you're making a large number of POST, PATCH, PUT, or DELETE requests for a single user or client ID,
     * wait at least one second between each request. */
    await sleep(1000);
  }

  return repoNames;
};

export const queryRecentPRs = async (token: string, owner: string, repos: string[], sinceDateTime: string) => {
  const results = await maxConcurrentBatchQueryRecentPRs(token, owner, repos, sinceDateTime);
  const refCommits: any[] = [];
  results.forEach((result: any) => {
    const keys = Object.keys(result.data);
    keys.forEach((key) => {
      const keyRefCommits = result.data[key]?.ref?.target?.history?.nodes ?? [];
      if (keyRefCommits.length > 0) {
        refCommits.push(result.data[key].ref);
      }
    });
  });


  const recentPullRequests: any[] = [];
  refCommits.forEach(ref => ref.target.history.nodes.forEach((commit: any) => (commit.parents.totalCount > 1) ? commit.associatedPullRequests.nodes.forEach((pr: any) => {
    pr['committedDate'] = commit.committedDate;
    recentPullRequests.push(pr);
  }) : null));
  const filteredRecentPRs = [...new Set(recentPullRequests.map(pr => pr.url))].map(url => recentPullRequests.find(pr => pr.url === url));

  return filteredRecentPRs.sort(byCommittedDateDesc);
};

export const queryOpenPRs = async (token: string, owner: string, repos: string[]) => {
  const results = await maxConcurrentBatchQueryOpenPRs(token, owner, repos);
  const resultPRs: any[] = [];
  results.forEach((result: any) => {
    const keys = Object.keys(result.data);
    keys.forEach((key) => {
      const repoName = result.data[key].name;
      const pullRequests = result.data[key]?.pullRequests.nodes ?? [];
      if (pullRequests.length > 0) {
        resultPRs.push(
          ...pullRequests.map((pr: any) => ({
            ...pr,
            repository: { name: repoName }
          }))
        );
      }
    });
  });

  return resultPRs.sort(sortByCreatedAt).filter(pr => !pr.isDraft);
};

export const queryPRs = async (token: string, owner: string, repos: string[], sinceDateTime: string) => {
  const [recentPRs, openPRs] = await Promise.all([
    queryRecentPRs(token, owner, repos, sinceDateTime),
    queryOpenPRs(token, owner, repos)
  ]);

  return { refCommits: recentPRs, resultPRs: openPRs };
}
