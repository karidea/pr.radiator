const sortByCreatedAt = (a, b) => a.createdAt.getTime() - b.createdAt.getTime();
const byCommittedDateDesc = (a, b) => b.committedDate.getTime() - a.committedDate.getTime();

const RepositoriesQuery = (owner, team, next) => {
  const after = next ? `"${next}"`: 'null';

  return `{organization(login: "${owner}") {team(slug: "${team}") {repositories(first: 100, after: ${after}) {totalCount pageInfo {endCursor hasNextPage} edges {permission node {name isArchived}}}}}}`;
};

const innerRecentPRsQuery = `ref(qualifiedName:"master") {target {... on Commit {history(first: 25, since: "%s") {nodes {committedDate messageHeadline parents {totalCount} associatedPullRequests(first:5) {nodes { createdAt number title url author { login } repository { name } }}}}}}}`;
const innerOpenPRsQuery = `pullRequests(last: 15, states: OPEN) { nodes {title url createdAt baseRefName headRefOid isDraft number author { login } comments (first: 50) {nodes {createdAt author { login }}} reviews(first: 50) {nodes {state createdAt author { login }}} commits(last: 1) { nodes { commit { oid statusCheckRollup { state }}}} reviewDecision }}`;

const buildBatchQuery = (type, owner, repos, sinceDateTime = '') => {
  const innerQuery = type === 'recent' ? innerRecentPRsQuery.replace('%s', sinceDateTime) : innerOpenPRsQuery;
  const batchedRepos = repos.map((repo) => `${repo.replace(/[^a-zA-Z0-9]/g, '')}:repository(owner: "${owner}", name: "${repo}") { name ${innerQuery} }`).join(' ');

  return `query ${type}PRs { ${batchedRepos} }`;
};

const chunks = (array, chunk_size) =>
  Array.from({ length: Math.ceil(array.length / chunk_size) }, (_, index) =>
    array.slice(index * chunk_size, (index + 1) * chunk_size)
  );

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const api = {
  fetchBatchQueries: async (token, type, owner, repos, sinceDateTime) => {
    const result = chunks(repos, 4);

    return Promise.all(result.map(async (reposChunk) => {
      const response = await fetch('https://api.github.com/graphql', {
        method: 'post',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: buildBatchQuery(type, owner, reposChunk, sinceDateTime) }),
      });
      if (!response.ok) {
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
      }
      return response.json();
    }));
  },
  queryTeamRepos: async (token, owner, team) => {
    let hasNextPage = true;
    let next = null;
    const repoNames = [];

    while (hasNextPage) {
      const response = await fetch('https://api.github.com/graphql', {
        method: 'post',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: RepositoriesQuery(owner, team, next) }),
      });
      if (!response.ok) {
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
      }
      const result = await response.json();

      const repositories = result.data.organization.team.repositories;

      repositories.edges.forEach((repo) => {
        if (repo.permission === 'ADMIN' && repo.node.isArchived === false) {
          repoNames.push(repo.node.name);
        }
      });
      hasNextPage = repositories.pageInfo.hasNextPage;
      next = repositories.pageInfo.endCursor;

      await sleep(1000);
    }

    return repoNames;
  },
  filterTeamRepos: async (token, owner, team, repos) => {
    const filteredRepos = [];
    const concurrencyLimit = 20;
    const semaphore = Array(concurrencyLimit).fill(Promise.resolve());

    const makeRequest = async (repoName) => {
      try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repoName}/teams`, {
          headers: { Authorization: `Bearer ${token}` },
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
};

const parseDatesInPR = (pr) => {
  pr.createdAt = new Date(pr.createdAt);
  if (pr.committedDate) pr.committedDate = new Date(pr.committedDate);
  pr.reviews?.nodes?.forEach((review) => { review.createdAt = new Date(review.createdAt); });
  pr.comments?.nodes?.forEach((comment) => { comment.createdAt = new Date(comment.createdAt); });
};

const fetchRecentPRs = async (token, owner, repos, ignoreRepos) => {
  try {
    startProgress();
    const filteredRepos = repos.filter(repo => !ignoreRepos.includes(repo));
    const sinceTwoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const results = await api.fetchBatchQueries(token, 'recent', owner, filteredRepos, sinceTwoWeeksAgo);
    const refCommits = [];
    results.forEach((result) => {
      const keys = Object.keys(result.data);
      keys.forEach((key) => {
        const keyRefCommits = result.data[key]?.ref?.target?.history?.nodes ?? [];
        if (keyRefCommits.length > 0) {
          refCommits.push(result.data[key].ref);
        }
      });
    });


    const recentPullRequests = [];
    refCommits.forEach(ref => ref.target.history.nodes.forEach((commit) => (commit.parents.totalCount > 1) ? commit.associatedPullRequests.nodes.forEach((pr) => {
      pr['committedDate'] = commit.committedDate;
      recentPullRequests.push(pr);
    }) : null));
    const filteredRecentPRs = [...new Set(recentPullRequests.map(pr => pr.url))].map(url => recentPullRequests.find(pr => pr.url === url));

    filteredRecentPRs.forEach(parseDatesInPR);
    const recentPRs = filteredRecentPRs.sort(byCommittedDateDesc);

    setState({ recentPRs });
  } catch (error) {
    console.log('Failed to fetch recent PRs', error);
  } finally {
    stopProgress();
  }
};

const fetchOpenPRs = async (token, owner, repos, ignoreRepos) => {
  try {
    setState({ isFetchingOpenPRs: true });
    startProgress();
    const filteredRepos = repos.filter(repo => !ignoreRepos.includes(repo));

    const results = await api.fetchBatchQueries(token, 'open', owner, filteredRepos);
    const resultPRs = [];
    results.forEach((result) => {
      const keys = Object.keys(result.data);
      keys.forEach((key) => {
        const repoName = result.data[key].name;
        const pullRequests = result.data[key]?.pullRequests.nodes ?? [];
        if (pullRequests.length > 0) {
          resultPRs.push(
            ...pullRequests.map((pr) => ({
              ...pr,
              repository: { name: repoName }
            }))
          );
        }
      });
    });

    resultPRs.forEach(parseDatesInPR);
    const openPRs = resultPRs.sort(sortByCreatedAt).filter(pr => !pr.isDraft);

    setState({ PRs: openPRs });
  } catch (error) {
    console.log('Failed to fetch open PRs', error);
  } finally {
    stopProgress();
    setState({ isFetchingOpenPRs: false });
  }
};


const CommentDots = () => `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M256 32C114.6 32 0 125.1 0 240c0 49.6 21.4 95 57 130.7C44.5 421.1 2.7 466 2.2 466.5c-2.2 2.3-2.8 5.7-1.5 8.7S4.8 480 8 480c66.3 0 116-31.8 140.6-51.4 32.7 12.3 69 19.4 107.4 19.4 141.4 0 256-93.1 256-208S397.4 32 256 32zM128 272c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.3 32-32 32zm128 0c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.3 32-32 32zm128 0c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.3 32-32 32z" /></svg>`;
const HourglassHalf = () => `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M360 0H24C10.745 0 0 10.745 0 24v16c0 13.255 10.745 24 24 24 0 90.965 51.016 167.734 120.842 192C75.016 280.266 24 357.035 24 448c-13.255 0-24 10.745-24 24v16c0 13.255 10.745 24 24 24h336c13.255 0 24-10.745 24-24v-16c0-13.255-10.745-24-24-24 0-90.965-51.016-167.734-120.842-192C308.984 231.734 360 154.965 360 64c13.255 0 24-10.745 24-24V24c0-13.255-10.745-24-24-24zm-75.078 384H99.08c17.059-46.797 52.096-80 92.92-80 40.821 0 75.862 33.196 92.922 80zm.019-256H99.078C91.988 108.548 88 86.748 88 64h208c0 22.805-3.987 44.587-11.059 64z" /></svg>`;
const Minus = () => `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M3 13h18v-2H3v2z" /></svg>`;
const Times = () => `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 352 512" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M242.72 256l100.07-100.07c12.28-12.28 12.28-32.19 0-44.48l-22.24-22.24c-12.28-12.28-32.19-12.28-44.48 0L176 189.28 75.93 89.21c-12.28-12.28-32.19-12.28-44.48 0L9.21 111.45c-12.28 12.28-12.28 32.19 0 44.48L109.28 256 9.21 356.07c-12.28 12.28-12.28 32.19 0 44.48l22.24 22.24c12.28 12.28 32.2 12.28 44.48 0L176 322.72l100.07 100.07c12.28 12.28 32.2 12.28 44.48 0l22.24-22.24c12.28-12.28 12.28-32.19 0-44.48L242.72 256z" /></svg>`;
const Check = () => `<svg stroke="currentColor" fill="currentColor" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M173.898 439.404l-166.4-166.4c-9.997-9.997-9.997-26.206 0-36.204l36.203-36.204c9.997-9.998 26.207-9.998 36.204 0L192 312.69 432.095 72.596c9.997-9.997 26.207-9.997 36.204 0l36.203 36.204c9.997 9.997 9.997 26.206 0 36.204l-294.4 294.401c-9.998 9.997-26.207 9.997-36.204-.001z" /></svg>`;
const ExclamationTriangle = () => `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" /></svg>`;
const ExclamationCircle = () => `<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" class="event-icon unreviewed-icon"><title>Unreviewed PR - Needs review</title><path d="M504 256c0 136.997-111.043 248-248 248S8 392.997 8 256C8 119.083 119.043 8 256 8s248 111.083 248 248zm-248 50c-25.405 0-46 20.595-46 46s20.595 46 46 46 46-20.595 46-46-20.595-46-46-46zm-43.673-165.346l7.418 136c.347 6.364 5.609 11.346 11.982 11.346h48.546c6.373 0 11.635-4.982 11.982-11.346l7.418-136c.375-6.874-5.098-12.654-11.982-12.654h-63.383c-6.884 0-12.356 5.78-11.981 12.654z" /></svg>`;

const combineReviewsAndComments = (reviews, comments) => {
  const events = [];

  reviews.nodes.forEach((review) => {
    const state = review.state === 'COMMENTED' ? 'COMMENTED' : review.state;
    events.push({
      createdAt: review.createdAt,
      author: review.author.login,
      state,
    });
  });

  comments.nodes.forEach((comment) => {
    events.push({
      createdAt: comment.createdAt,
      author: comment.author.login,
      state: 'COMMENTED',
    });
  });

  const compressedEvents = [];
  let currentEvent = null;

  events.sort(sortByCreatedAt).forEach((curr) => {
    if (
      !currentEvent ||
      curr.author !== currentEvent.author ||
      curr.state !== currentEvent.state
    ) {
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
  if (diffMs < 3600000) return 'last-hour'; // 1 hour
  if (diffMs < 7200000) return 'last-two-hours'; // 2 hours
  if (diffMs < 86400000) return 'last-day'; // 1 day
  if (diffMs < 604800000) return 'last-week'; // 1 week
  return 'over-week-old';
};

const getCommitState = (headRefOid, commits) => {
  const node = commits.nodes.find((node) => node.commit.oid === headRefOid);

  const icons = {
    'SUCCESS': Check(),
    'PENDING': HourglassHalf(),
    'FAILURE': Times(),
    'EXPECTED': HourglassHalf(),
    'ERROR': ExclamationTriangle()
  };

  const conclusion = node?.commit?.statusCheckRollup?.state || 'ERROR';
  const icon = icons[conclusion] || Minus();
  const className = conclusion.toLowerCase();

  return `<span class="${className}">${icon}</span>`;
};

const TimelineEvent = ({ count, author, createdAt, state }) => {
  const countBadge = (count ?? 1) > 1 ? `(${count})` : '';
  const authorWithCount = `${author}${countBadge}`;
  const formattedDate = createdAt.toLocaleString();
  let tooltip = `${authorWithCount} ${state.toLowerCase()} at ${formattedDate}`;

  if (state === 'APPROVED') {
    return `<span class="event-group approved" title="${tooltip}">${authorWithCount}${Check()}</span>`;
  } else if (state === 'CHANGES_REQUESTED') {
    tooltip = `${authorWithCount} requested changes at ${formattedDate}`;
    return `<span class="event-group changes-requested" title="${tooltip}">${authorWithCount}${Times()}</span>`;
  } else if (state === 'COMMENTED') {
    tooltip = `${authorWithCount} commented at ${formattedDate}`;
    return `<span class="event-group commented" title="${tooltip}">${authorWithCount}${CommentDots()}</span>`;
  } else if (state === 'DISMISSED') {
    tooltip = `${authorWithCount} dismissed at ${formattedDate}`;
    return `<span class="event-group dismissed" title="${tooltip}">${authorWithCount}${Minus()}</span>`;
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

const renderPR = (pr, isRecent = true, showBranch = false) => {
  const { number, title, url, repository } = pr;
  const dateKey = isRecent ? 'committedDate' : 'createdAt';
  const date = pr[dateKey];
  const elapsedTimeStr = formatDistanceToNow(date, { addSuffix: true, includeSeconds: true });
  const id = `pr-time-${pr.url}`;

  if (isRecent) {
    return `<div><span id="${id}" title="${date}">${elapsedTimeStr}</span> ${pr.author.login}&nbsp;<a href="${url}" target="_blank" rel="noopener noreferrer">${repository.name}/pull/${number}</a>&nbsp;${title}</div>`;
  }

  const { createdAt, reviews, comments, baseRefName, author: { login: author }, headRefOid, commits } = pr;
  const events = combineReviewsAndComments(reviews, comments);
  const commitState = getCommitState(headRefOid, commits);
  const reviewState = reviews.nodes.length === 0 ? ExclamationCircle() : '';
  const prLink = `<a href="${url}" target="_blank" rel="noopener noreferrer">${repository.name}#${pr.number}</a>`;
  const branch = showBranch ? baseRefName : '';
  const eventOutput = events.length > 0 ? `<br>&nbsp;&nbsp;${events.map((event, index) => TimelineEvent({ ...event, key: index })).join('')}` : '';
  const timestamp = `<span id="${id}" title="${date}">${elapsedTimeStr}</span>`;

  return `<div class="${getAgeString(createdAt)}">${timestamp} ${reviewState} ${commitState} ${branch} ${author} ${prLink} ${title} ${eventOutput}</div>`;
};

const initialState = {
  config: {
    token: localStorage.getItem('PR_RADIATOR_TOKEN') || '',
    owner: localStorage.getItem('PR_RADIATOR_OWNER') || '',
    team: localStorage.getItem('PR_RADIATOR_TEAM') || '',
    repos: JSON.parse(localStorage.getItem('PR_RADIATOR_REPOS') || '[]'),
    ignoreRepos: JSON.parse(localStorage.getItem('PR_RADIATOR_IGNORE_REPOS') || '[]'),
  },
  PRs: [],
  recentPRs: [],
  showDependabotPRs: false,
  showMasterPRs: true,
  showNeedsReviewPRs: false,
  showRecentPRs: false,
  showRepoLinks: false,
  ignoreMode: false,
  selectedRepoIndex: -1,
  isFetchingOpenPRs: false,
};

let state = { ...initialState };

const progressBar = document.getElementById('progress-bar');

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

const setState = (updates) => {
  state = { ...state, ...updates };
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
  setState({ config: { ...state.config, ignoreRepos } });
};

const onSubmit = (event) => {
  event.preventDefault();
  const owner = document.getElementById('owner').value;
  const token = document.getElementById('token').value;
  const team = document.getElementById('team').value;
  localStorage.setItem('PR_RADIATOR_OWNER', owner);
  localStorage.setItem('PR_RADIATOR_TOKEN', token);
  localStorage.setItem('PR_RADIATOR_TEAM', team);
  setState({ config: { ...state.config, team, token, owner } });

  if (state.config.token && state.config.owner && state.config.repos.length > 0) {
    fetchOpenPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch((error) => {
      console.error('Error fetching PRs after submit', error);
    });
  } else if (state.config.token && state.config.owner && state.config.team && state.config.repos.length === 0) {
    startProgress();
    render();
    api.queryTeamRepos(token, owner, team)
      .then(repos => api.filterTeamRepos(token, owner, team, repos))
      .then(filteredRepos => {
        localStorage.setItem('PR_RADIATOR_REPOS', JSON.stringify(filteredRepos));
        setState({ config: { ...state.config, repos: filteredRepos } });
        render();
        if (filteredRepos.length > 0) {
          fetchOpenPRs(token, owner, filteredRepos, state.config.ignoreRepos).catch(error => {
            console.error('Error fetching PRs after repos', error);
            stopProgress();
          });
        } else {
          stopProgress();
        }
      })
      .catch(error => {
        console.error('Error fetching repos after submit', error);
        stopProgress();
        render();
      });
  }
};

const filters = {
  dependabot: (pr) => state.showDependabotPRs || pr.author.login !== 'dependabot',
  masterPRs: (pr) => state.showMasterPRs || (pr.baseRefName !== 'master' && pr.baseRefName !== 'main'),
  needsReview: (pr) => !state.showNeedsReviewPRs || (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === null),
};

const render = () => {
  const { config: { token, owner, team, repos, ignoreRepos }, ignoreMode, selectedRepoIndex, showRepoLinks } = state;
  document.title = 'PR Radiator';
  const root = document.getElementById('root');
  const settingsForm = document.getElementById('settings-form');

  if (!token || !owner || !team) {
    settingsForm.style.display = 'block';
    root.innerHTML = '';
    return;
  }

  settingsForm.style.display = 'none';

  if (repos.length === 0) {
    root.innerHTML = `<div>Fetching ${team} team repositories...</div>`;
    return;
  }

  let content = '';

  // Combined Repo View (toggled by 'l')
  if (showRepoLinks) {
    const baseUrl = `https://github.com/${owner}/`;

    if (repos.length === 0) {
      content = '<div>No repositories available.</div>';
    } else {
      // NEW: Dynamic rendering based on ignoreMode (within repo view)
      if (ignoreMode) {
        // Interactive ignore mode (no JS tag; CSS handles ::after)
        const repoItems = repos.map((repo, index) => {
          const isIgnored = isRepoIgnored(repo);
          const classes = `repo-item ${isIgnored ? 'ignored' : ''} ${index === selectedRepoIndex ? 'selected' : ''}`;
          return `<li class="${classes}" data-index="${index}" data-repo="${repo}">${repo}</li>`; // FIX: Removed ${tag} to avoid duplication
        }).join('');
        content = `
          <h1>${team} repositories (${repos.length}) - Edit Ignores (press i to exit)</h1> <!-- UPDATED: Consistent title -->
          <ul id="ignore-list" class="repo-list ignore-mode" tabindex="-1">
            ${repoItems}
          </ul>
          <p>Navigate: j/k or arrows | Toggle: Enter/space or click</p>
        `;
      } else {
        // Static links mode (consistent formatting with ignore mode; shows subtle ignored status)
        const repoItems = repos.map((repo) => {
          const isIgnored = isRepoIgnored(repo);
          return `<li class="repo-item ${isIgnored ? 'ignored' : ''}"><a href="${baseUrl}${repo}" target="_blank" rel="noopener">${repo}</a></li>`;
        }).join('');
        content = `
          <h1>${team} repositories (${repos.length}) (i to edit ignores)</h1> <!-- UPDATED: Subtle hint -->
          <ul id="repo-links" class="repo-list static-mode">
            ${repoItems}
          </ul>
        `;
      }
    }
    root.innerHTML = `<div class="App">${content}</div>`;

    // Attach mouse handlers if in ignore mode (click to toggle)
    if (ignoreMode) {
      const ignoreList = document.getElementById('ignore-list');
      if (ignoreList) ignoreList.focus(); // For keyboard accessibility

      // Add click listeners to each repo item
      const repoItems = ignoreList.querySelectorAll('.repo-item');
      repoItems.forEach(item => {
        item.addEventListener('click', (e) => {
          const repo = e.currentTarget.dataset.repo;
          // Add toggled class immediately for feedback
          const el = e.currentTarget;
          el.classList.add('toggled');
          setTimeout(() => {
            // Check if element still exists in DOM before removing class (prevents error on re-render)
            if (el && el.parentNode) {
              el.classList.remove('toggled');
            }
          }, 200);
          toggleIgnoreForRepo(repo);
        });
      });
    }
    return;
  }

  // Other views unchanged (recent PRs, open PRs, etc.)
  if (state.showRecentPRs) {
    content = state.recentPRs.map(pr => renderPR(pr)).join('');
  } else if (state.isFetchingOpenPRs && state.PRs.length === 0) {
    content = `Fetching ${team} pull requests...`;
  } else {
    const displayPRs = state.PRs.filter(filters.dependabot).filter(filters.masterPRs).filter(filters.needsReview);
    if (displayPRs.length === 0) {
      document.title = `(${displayPRs.length}) PR Radiator`;
      content = 'No PRs found';
    } else {
      document.title = `(${displayPRs.length}) PR Radiator`;
      content = displayPRs.map(pr => renderPR(pr, false, state.showMasterPRs)).join('');
    }
  }

  root.innerHTML = `<div class="App">${content}</div>`;
};

const useInterval = (callback, delay) => {
  let savedCallback = callback;
  let id;

  const tick = () => savedCallback();

  if (delay !== null) {
    id = setInterval(tick, delay);
    return () => clearInterval(id);
  }
};

const init = async () => {
  const { config: { token, owner, team, repos, ignoreRepos } } = state;
  if (token && owner && repos.length > 0) {
    await fetchOpenPRs(token, owner, repos, ignoreRepos);
  }

  const fiveMinutes = 300 * 1000;
  useInterval(() => {
    if (token && owner && repos.length > 0) {
      fetchOpenPRs(token, owner, repos, ignoreRepos).catch((error) => {
        console.error('Error in fetchOpenPRs on interval', error);
      });
    }
  }, fiveMinutes);

  const settingsForm = document.getElementById('settings-form');
  if (!settingsForm.hasAttribute('data-initialized')) {
    const ownerInput = document.getElementById('owner');
    const teamInput = document.getElementById('team');
    const tokenInput = document.getElementById('token');

    ownerInput.value = owner;
    teamInput.value = team;
    tokenInput.value = token;

    document.getElementById('config-form').addEventListener('submit', onSubmit);

    settingsForm.setAttribute('data-initialized', 'true');  // Prevent duplicate setup
  }

  document.addEventListener('keydown', (event) => {
  const settingsForm = document.getElementById('settings-form');
  if (settingsForm.style.display === 'block' || document.activeElement.tagName === 'INPUT') return;

  const { showRepoLinks, ignoreMode } = state;

  // Ignore mode handlers (only active when in repo view and ignoreMode)
  if (showRepoLinks && ignoreMode) {
      let handled = true;
      switch (event.key) {
      case 'j':
      case 'ArrowDown':
          if (state.config.repos.length > 0) {
          const newIndex = Math.min(state.config.repos.length - 1, state.selectedRepoIndex + 1);
          setState({ selectedRepoIndex: newIndex });
          }
          break;
      case 'k':
      case 'ArrowUp':
          if (state.config.repos.length > 0) {
          const newIndex = Math.max(0, state.selectedRepoIndex - 1);
          setState({ selectedRepoIndex: newIndex });
          }
          break;
      case 'Enter':
      case ' ':
          event.preventDefault(); // Prevent space from scrolling
          if (state.config.repos.length > 0 && state.selectedRepoIndex >= 0) {
          const repo = state.config.repos[state.selectedRepoIndex];
          toggleIgnoreForRepo(repo);
          }
          break;
      default:
          handled = false;
      }
      if (handled) return;
  }

  // FIX: Existing handlers (skip if in repo view and ignoreMode, except for 'i' and 'l' to allow toggle-off and full exit)
  if (showRepoLinks && ignoreMode && event.key !== 'i' && event.key !== 'l') return;

  const handlers = {
      d: () => setState({ showDependabotPRs: !state.showDependabotPRs }),
      m: () => setState({ showMasterPRs: !state.showMasterPRs }),
      n: () => setState({ showNeedsReviewPRs: !state.showNeedsReviewPRs }),
      a: () => {
      const newShow = !state.showRecentPRs;
      setState({ showRecentPRs: newShow });
      if (newShow && state.config.token && state.config.owner && state.config.repos.length > 0) {
          fetchRecentPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch(console.error);
      }
      },
      l: () => {
        // UPDATED: Toggle repo view (combined static/interactive); in ignore mode, full exit to PRs
        const newShow = !showRepoLinks;
        if (newShow) {
          // Entering repo view: Always start in static mode
          setState({
            showRepoLinks: newShow,
            ignoreMode: false,
            selectedRepoIndex: 0,
            showRecentPRs: false, // Exit recent view if entering
          });
        } else {
          // Exiting repo view: Save ignores and refresh PRs
          localStorage.setItem('PR_RADIATOR_IGNORE_REPOS', JSON.stringify(state.config.ignoreRepos));
          if (state.config.token && state.config.owner && state.config.repos.length > 0) {
            fetchOpenPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch(console.error);
          }
          setState({
            showRepoLinks: newShow,
            ignoreMode: false, // Ensure cleanup
            selectedRepoIndex: -1,
          });
        }
      },
      i: () => {
      // Toggle ignore mode ONLY if in repo view; otherwise ignore
      if (!showRepoLinks) return; // Contextual: Only works in repo view
      const newMode = !ignoreMode;
      if (!newMode) {
          // Exiting: Save and refresh PRs (like other toggles)
          localStorage.setItem('PR_RADIATOR_IGNORE_REPOS', JSON.stringify(state.config.ignoreRepos));
          if (state.config.token && state.config.owner && state.config.repos.length > 0) {
          fetchOpenPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch(console.error);
          }
      }
      setState({
          ignoreMode: newMode,
          selectedRepoIndex: newMode ? 0 : -1,
      });
      },
      r: () => {
      if (state.config.token && state.config.owner && state.config.repos.length > 0) {
          fetchOpenPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch(console.error);
      }
      },
      '\\': () => {
      setState({ config: { ...state.config, repos: [] }, PRs: [], recentPRs: [] });
      startProgress();
      render();
      api.queryTeamRepos(state.config.token, state.config.owner, state.config.team)
          .then(repos => api.filterTeamRepos(state.config.token, state.config.owner, state.config.team, repos))
          .then(filteredRepos => {
          localStorage.setItem('PR_RADIATOR_REPOS', JSON.stringify(filteredRepos));
          setState({ config: { ...state.config, repos: filteredRepos } });
          render();
          if (filteredRepos.length > 0) {
              fetchOpenPRs(state.config.token, state.config.owner, filteredRepos, state.config.ignoreRepos).catch(error => {
              console.error('Error fetching PRs after repos', error);
              stopProgress();
              });
          } else {
              stopProgress();
          }
          })
          .catch(error => {
          console.error('Error fetching repos after submit', error);
          stopProgress();
          render();
          });
      },
      '?': () => {
      const overlay = document.getElementById('shortcuts-overlay');
      overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none';
      }
  };

  if (handlers[event.key]) handlers[event.key]();
  });

  if (token && owner && team && repos.length === 0) {
    try {
      startProgress();
      const reposList = await api.queryTeamRepos(token, owner, team);
      const filteredRepos = await api.filterTeamRepos(token, owner, team, reposList);
      localStorage.setItem('PR_RADIATOR_REPOS', JSON.stringify(filteredRepos));
      setState({ config: { ...state.config, repos: filteredRepos } });
    } catch (error) {
      console.error('Error in getTeamRepos', error);
      stopProgress();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token && owner && repos.length > 0 && !state.isFetchingOpenPRs) {
      fetchOpenPRs(token, owner, repos, ignoreRepos).catch((error) => {
        console.error('Error in fetchOpenPRs on tab focus', error);
      });
    }
  });

  render();
};

init();
