import axios from 'axios';
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
}`};

const BatchQueryPRs = (owner: string, repos: string[], sinceDateTime: string) => {
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
    isArchived pullRequests(last: 15, states: OPEN) { nodes {
    title url createdAt baseRefName headRefOid isDraft number
    participants (first: 10) { nodes { isViewer login }}
    reviewRequests (first:20) { nodes {requestedReviewer { __typename ... on User { login isViewer } ... on Team { slug members { nodes { login isViewer } } }}}}
    repository { name }
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

  return `query PRs { ${batchedRepos} }`
};

const chunks = (array: string[], chunk_size: number) =>
  Array(Math.ceil(array.length / chunk_size))
    .fill(undefined)
    .map((_: any, index: number) => index * chunk_size)
    .map((begin: any) => array.slice(begin, begin + chunk_size));

export const maxConcurrentBatchQueryPRs = (token: string, owner: string, repos: string[], sinceDateTime: string) => {
  const result = chunks(repos, 4);

  return result.map((repos: string[]) => {
    return axios({
      url: 'https://api.github.com/graphql',
      method: 'post',
      headers: { Authorization: `Bearer ${token}` },
      data: { query: BatchQueryPRs(owner, repos, sinceDateTime) }
    });
  });
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const filterTeamRepos = async (token: string, owner: string, team: string, repos: string[]) => {
  const filteredRepos: string[] = [];
  const concurrencyLimit = 20;
  const semaphore = Array(concurrencyLimit).fill(Promise.resolve());

  const makeRequest = async (repoName: string) => {
    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repoName}/teams`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const teams = response.data;

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
    const result: any = await axios({
      url: 'https://api.github.com/graphql',
      method: 'post',
      headers: { Authorization: `Bearer ${token}` },
      data: { query: RepositoriesQuery(owner, team, next) }
    });

    const repositories: any = result.data.data.organization.team.repositories;

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

export const queryPRs = async (token: string, owner: string, repos: string[], sinceDateTime: string) => {
  const results = await Promise.all(maxConcurrentBatchQueryPRs(token, owner, repos, sinceDateTime));
  const resultPRs: any[] = [];
  const refCommits: any[] = [];
  results.forEach((result: any) => {
    const keys = Object.keys(result.data.data);
    keys.forEach((key) => {
      const pullRequests = result.data.data[key]?.pullRequests.nodes ?? [];
      if (pullRequests.length > 0 && !result.data.data[key].isArchived) {
        resultPRs.push(...pullRequests);
      }
      const keyRefCommits = result.data.data[key]?.ref?.target?.history?.nodes ?? [];
      if (keyRefCommits.length > 0) {
        refCommits.push(result.data.data[key].ref);
      }
    });
  });


  const recentPullRequests: any[] = [];
  refCommits.forEach(ref => ref.target.history.nodes.forEach((commit: any) => (commit.parents.totalCount > 1) ? commit.associatedPullRequests.nodes.forEach((pr: any) => {
    pr['committedDate'] = commit.committedDate;
    recentPullRequests.push(pr);
  }) : null));
  const filteredRecentPRs = [...new Set(recentPullRequests.map(pr => pr.url))].map(url => recentPullRequests.find(pr => pr.url === url));

  return { refCommits: filteredRecentPRs.sort(byCommittedDateDesc), resultPRs: resultPRs.sort(sortByCreatedAt).filter(pr => !pr.isDraft) };
}
