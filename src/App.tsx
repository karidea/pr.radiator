import React, { useEffect, useState, FormEvent, useRef } from 'react';
import PR from './PR';
import RecentPR from './RecentPR';
import { filterTeamRepos, queryPRs, queryTeamRepos } from './github';
import KeyboardShortcutsOverlay from './KeyboardShortcutsOverlay';

function useInterval(callback: any, delay: any) {
  const savedCallback = useRef();

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    function tick() {
      // @ts-ignore
      savedCallback.current();
    }
    if (delay) {
      const id = setInterval(tick, delay);
      return () => clearInterval(id);
    }
  }, [delay]);
}


function App() {
  const [PRs, setPRs] = useState<any[]>([]);
  const [recentPRs, setRecentPRs] = useState<any[]>([]);
  const [intervalInput, setIntervalInput] = useState(60);
  const [showCodeOwnerPRs, setShowCodeOwnerPRs] = useState(false);
  const [showDependabotPRs, toggleDependabotPRs] = useState(false);
  const [showMasterPRs, toggleMasterPRs] = useState(false);
  const [showKeyboardShortcuts, toggleShowKeyboardShortcuts] = useState(false);
  const [showRecentPRs, toggleShowRecentPRs] = useState(false);

  const [config, setConfig] = useState(() => ({
    token: localStorage.getItem('PR_RADIATOR_TOKEN') ?? '',
    owner: localStorage.getItem('PR_RADIATOR_OWNER') ?? '',
    team: localStorage.getItem('PR_RADIATOR_TEAM') ?? '',
    repos: JSON.parse(localStorage.getItem('PR_RADIATOR_REPOS') ?? '[]'),
    pollingInterval: parseInt(localStorage.getItem('PR_RADIATOR_POLLING_INTERVAL') ?? '0'),
    ignoreRepos: JSON.parse(localStorage.getItem('PR_RADIATOR_IGNORE_REPOS') ?? '[]')
  }));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();

    const owner = (document.getElementById('owner') as HTMLInputElement).value;
    const token = (document.getElementById('token') as HTMLInputElement).value;
    const team = (document.getElementById('team') as HTMLInputElement).value;
    const pollingIntervalInput: HTMLInputElement = document.getElementById('polling-interval') as HTMLInputElement;
    const pollingInterval = pollingIntervalInput?.value ? parseInt(pollingIntervalInput.value) * 1000 : 0;

    localStorage.setItem('PR_RADIATOR_OWNER', owner);
    localStorage.setItem('PR_RADIATOR_TOKEN', token);
    localStorage.setItem('PR_RADIATOR_TEAM', team);
    localStorage.setItem('PR_RADIATOR_POLLING_INTERVAL', pollingInterval.toString());

    setConfig({ ...config, team, token, owner, pollingInterval })
  }

  useEffect(() => {
    function onKeydown(event: any) {
      // 'c' toggles code owned or participated in PR visibility
      if (event.key === 'c') {
        setShowCodeOwnerPRs(!showCodeOwnerPRs);
      }
      // 'd' toggles dependabot PR visibility
      if (event.key === 'd') {
        toggleDependabotPRs(!showDependabotPRs);
      }
      // 'm' toggles showing PRs to master
      if (event.key === 'm') {
        toggleMasterPRs(!showMasterPRs);
      }
      // 'l' toggles showing recent PRs to master
      if (event.key === 'l') {
        toggleShowRecentPRs(!showRecentPRs);
      }
      // 'r' triggers refresh of PRs
      if (event.key === 'r') {
        (async () => {
          try {
            const filteredRepos = config.repos.filter((repo: string) => !config.ignoreRepos.includes(repo));
            const sinceTwoWeeksAgo = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000)).toISOString();
            const PRs = await queryPRs(config.token, config.owner, filteredRepos, sinceTwoWeeksAgo);
            setPRs(PRs.resultPRs);
            setRecentPRs(PRs.refCommits);
          } catch {
            console.log('Failed to fetch PRs');
          }
        })().catch(error => {
          console.error('Unexpected error in PR refresh', error);
        });
      }
      // '\' backslash clears repo names to trigger refetching
      if (event.key === '\\' || event.key === 'Backslash') { // handle both '\' and 'Backslash' key names
        localStorage.removeItem('PR_RADIATOR_REPOS');
        setConfig({ ...config, repos: [] });
      }
      // '?' shows the keyboard shortcuts overlay
      if (event.key === '?' && event.shiftKey) {
        toggleShowKeyboardShortcuts(!showKeyboardShortcuts);
      }
    }

    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [showCodeOwnerPRs, showDependabotPRs, showMasterPRs, showRecentPRs, showKeyboardShortcuts, config]);

  useEffect(() => {
    async function getTeamRepos(token: string, owner: string, team: string) {
      try{
        const repos = await queryTeamRepos(token, owner, team);
        const filteredRepos = await filterTeamRepos(token, owner, team, repos);
        localStorage.setItem('PR_RADIATOR_REPOS', JSON.stringify(filteredRepos));
        setConfig({ ...config, repos });
      } catch {
        console.log('Failed to fetch team repos');
      }
    }
    if (config.token && config.owner && config.team && config.repos.length === 0) {
      getTeamRepos(config.token, config.owner, config.team).catch(console.error);
    }
  }, [config]);

  useEffect(() => {
    async function getPRsFromGithub(token: string, owner: string, repos: string[]) {
      try {
        const sinceTwoWeeksAgo = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000)).toISOString();
        const PRs = await queryPRs(token, owner, repos, sinceTwoWeeksAgo);
        setPRs(PRs.resultPRs);
        setRecentPRs(PRs.refCommits);
      } catch {
        console.log('Failed to fetch PRs');
      }
    }
    if (config.token && config.owner && config.repos.length > 0) {
      const filteredRepos = config.repos.filter((repo: string) => !config.ignoreRepos.includes(repo));
      getPRsFromGithub(config.token, config.owner, filteredRepos).catch(console.error);
    }
  }, [config]);

  useInterval(() => {
    async function getPRsFromGithub(token: string, owner: string, repos: string[]) {
      try {
        const sinceTwoWeeksAgo = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000)).toISOString();
        const PRs = await queryPRs(token, owner, repos, sinceTwoWeeksAgo);
        setPRs(PRs.resultPRs);
        setRecentPRs(PRs.refCommits);
      } catch {
        console.log('Failed to fetch PRs');
      }
    }
    if (config.token && config.owner && config.repos.length > 0) {
      const filteredRepos = config.repos.filter((repo: string) => !config.ignoreRepos.includes(repo));
      getPRsFromGithub(config.token, config.owner, filteredRepos).catch(console.error);
    }
  }, config.pollingInterval);

  const isViewerRequestedUser = (req: any) => {
    if (req.length === 0) {
      return false;
    }
    return req.some((req: any) => req.requestedReviewer.isViewer);
  }

  const isViewerInRequestedTeam = (req: any) => {
    if (req.length === 0) {
      return false;
    }
    return req.some((req: any) => req.requestedReviewer.members.nodes.some((req: any) => req.isViewer));
  }

  const isViewerParticipant = (participants: any) => participants.nodes.some((participant: any) => participant.isViewer)
  const filterCombined = (pr: any) => !showCodeOwnerPRs || (isViewerRequestedUser(pr.reviewRequests.nodes.filter((req: any) => req.requestedReviewer.__typename === "User")) || isViewerParticipant(pr.participants) || isViewerInRequestedTeam(pr.reviewRequests.nodes.filter((req: any) => req.requestedReviewer.__typename === "Team")));
  const filterDependabot = (pr: any) => showDependabotPRs || pr.author.login !== 'dependabot';
  const filterMasterPRs = (pr: any) => showMasterPRs || (pr.baseRefName !== 'master' && pr.baseRefName !== 'main');
  const combinedPRs = PRs.length > 0 ? PRs.filter(filterCombined): null;
  const displayPRs = combinedPRs && combinedPRs.length > 0 ? combinedPRs.filter(filterDependabot).filter(filterMasterPRs).map(pr => <PR key={pr.url} pr={pr} showBranch={showMasterPRs} />) : null;
  const handleOnChange = (e: React.ChangeEvent<HTMLInputElement>) => setIntervalInput(parseInt(e.target.value));
  const displayRecentPRs = showRecentPRs ? recentPRs.map(pr => <RecentPR key={pr.url} pr={pr} />) : null;

  if (!config.token || !config.owner || !config.team) {
    return (
      <div className="settings-form">
        <h1>Configure PR Radiator</h1>
        <form autoComplete="off" onSubmit={onSubmit}>
          <input type="text" id="owner" placeholder="Github Organization" autoFocus={true} autoComplete="off" defaultValue={config.owner} />
          <input type="text" id="team" placeholder="Github Team" autoComplete="off" defaultValue={config.team} />
          <input type="password" id="token" placeholder="Github Personal Access Token" autoComplete="new-password" defaultValue={config.token} />
          <a
            href="https://github.com/settings/tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="info-link"
            title="Generate a personal access token with read:org and repo scopes"
          >
            https://github.com/settings/tokens
          </a>
        <span> - Generate a personal access token with read:org and repo scopes</span>
          <div>
        Github Polling Interval <input type="number" id="polling-interval" onChange={handleOnChange} value={intervalInput} min="5" /> (seconds)</div>
          <input type="submit" value="Begin" id="submit" />
        </form>
      </div>
    );
  }

  if (config.repos.length === 0) {
    return <div>{`Fetching ${config.team} team repositories..`}</div>;
  }

  if (showRecentPRs) {
    document.title = `PR Radiator`;
    return (
      <div className="App">
        {displayRecentPRs}
        {showKeyboardShortcuts && <KeyboardShortcutsOverlay onClose={() => toggleShowKeyboardShortcuts(false)} />}
      </div>
    );
  }

  document.title = `(${displayPRs?.length ?? ''}) PR Radiator`;

  if (displayPRs?.length === 0) {
    return (
      <div className="App">
        No PRs found
        {showKeyboardShortcuts && <KeyboardShortcutsOverlay onClose={() => toggleShowKeyboardShortcuts(false)} />}
      </div>
    );
  }

  return (
    <div className="App">
      {displayPRs}
      {showKeyboardShortcuts && <KeyboardShortcutsOverlay onClose={() => toggleShowKeyboardShortcuts(false)} />}
    </div>
  );
}

export default App;
