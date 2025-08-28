import React, { useEffect, useState, FormEvent, useRef } from 'react';
import PR from './PR';
import RecentPR from './RecentPR';
import { filterTeamRepos, queryPRs, queryTeamRepos } from './github';
import KeyboardShortcutsOverlay from './KeyboardShortcutsOverlay';
import { startProgress, stopProgress } from './utils';

// Define types for PR and config
interface PRData {
  url: string;
  author: { login: string };
  baseRefName: string;
  [key: string]: any; // For other dynamic properties
}

interface Config {
  token: string;
  owner: string;
  team: string;
  repos: string[];
  pollingInterval: number;
  ignoreRepos: string[];
}

function useInterval(callback: () => void, delay: number | null) {
  const savedCallback = useRef<() => void>(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    function tick() {
      savedCallback.current();
    }
    if (delay !== null) {
      const id = setInterval(tick, delay);
      return () => clearInterval(id);
    }
  }, [delay]);
}

const App: React.FC = () => {
  const [PRs, setPRs] = useState<PRData[]>([]);
  const [recentPRs, setRecentPRs] = useState<PRData[]>([]);
  const [intervalInput, setIntervalInput] = useState(60);
  const [showDependabotPRs, toggleDependabotPRs] = useState(false);
  const [showMasterPRs, toggleMasterPRs] = useState(true);
  const [showKeyboardShortcuts, toggleShowKeyboardShortcuts] = useState(false);
  const [showRecentPRs, toggleShowRecentPRs] = useState(false);
  const [showRepoLinks, setShowRepoLinks] = useState(false);
  const [config, setConfig] = useState<Config>(() => ({
    token: localStorage.getItem('PR_RADIATOR_TOKEN') ?? '',
    owner: localStorage.getItem('PR_RADIATOR_OWNER') ?? '',
    team: localStorage.getItem('PR_RADIATOR_TEAM') ?? '',
    repos: JSON.parse(localStorage.getItem('PR_RADIATOR_REPOS') ?? '[]'),
    pollingInterval: parseInt(localStorage.getItem('PR_RADIATOR_POLLING_INTERVAL') ?? '0'),
    ignoreRepos: JSON.parse(localStorage.getItem('PR_RADIATOR_IGNORE_REPOS') ?? '[]'),
  }));

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const owner = (document.getElementById('owner') as HTMLInputElement).value;
    const token = (document.getElementById('token') as HTMLInputElement).value;
    const team = (document.getElementById('team') as HTMLInputElement).value;
    const pollingIntervalInput = document.getElementById('polling-interval') as HTMLInputElement;
    const pollingInterval = pollingIntervalInput?.value ? parseInt(pollingIntervalInput.value) * 1000 : 0;
    localStorage.setItem('PR_RADIATOR_OWNER', owner);
    localStorage.setItem('PR_RADIATOR_TOKEN', token);
    localStorage.setItem('PR_RADIATOR_TEAM', team);
    localStorage.setItem('PR_RADIATOR_POLLING_INTERVAL', pollingInterval.toString());
    setConfig({ ...config, team, token, owner, pollingInterval });
  };

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'd') {
        toggleDependabotPRs(!showDependabotPRs);
      }
      if (event.key === 'm') {
        toggleMasterPRs(!showMasterPRs);
      }
      if (event.key === 'a') {
        toggleShowRecentPRs(!showRecentPRs);
      }
      if (event.key === 'l') {
        setShowRepoLinks(!showRepoLinks);
      }
      if (event.key === 'r') {
        (async () => {
          try {
            startProgress();
            const filteredRepos = config.repos.filter((repo) => !config.ignoreRepos.includes(repo));
            const sinceTwoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
            const PRs = await queryPRs(config.token, config.owner, filteredRepos, sinceTwoWeeksAgo);
            setPRs(PRs.resultPRs);
            setRecentPRs(PRs.refCommits);
          } catch {
            console.log('Failed to fetch PRs');
          } finally {
            stopProgress();
          }
        })().catch((error) => {
          console.error('Unexpected error in PR refresh', error);
          stopProgress();
        });
      }
      if (event.key === '\\' || event.key === 'Backslash') {
        localStorage.removeItem('PR_RADIATOR_REPOS');
        setConfig({ ...config, repos: [] });
        setPRs([]);
        setRecentPRs([]);
      }
      if (event.key === '?' && event.shiftKey) {
        toggleShowKeyboardShortcuts(!showKeyboardShortcuts);
      }
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [showDependabotPRs, showMasterPRs, showRecentPRs, showRepoLinks, showKeyboardShortcuts, config]);

  useEffect(() => {
    async function getTeamRepos(token: string, owner: string, team: string) {
      try {
        startProgress();
        const repos = await queryTeamRepos(token, owner, team);
        const filteredRepos = await filterTeamRepos(token, owner, team, repos);
        localStorage.setItem('PR_RADIATOR_REPOS', JSON.stringify(filteredRepos));
        setConfig({ ...config, repos: filteredRepos });
      } catch {
        console.log('Failed to fetch team repos');
      } finally {
        stopProgress();
      }
    }
    if (config.token && config.owner && config.team && config.repos.length === 0) {
      getTeamRepos(config.token, config.owner, config.team).catch((error) => {
        console.error('Error fetching team repos', error);
        stopProgress();
      });
    }
  }, [config]);

  useEffect(() => {
    async function getPRsFromGithub(token: string, owner: string, repos: string[]) {
      try {
        startProgress();
        const sinceTwoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const PRs = await queryPRs(token, owner, repos, sinceTwoWeeksAgo);
        setPRs(PRs.resultPRs);
        setRecentPRs(PRs.refCommits);
      } catch {
        console.log('Failed to fetch PRs');
      } finally {
        stopProgress();
      }
    }
    if (config.token && config.owner && config.repos.length > 0) {
      const filteredRepos = config.repos.filter((repo) => !config.ignoreRepos.includes(repo));
      getPRsFromGithub(config.token, config.owner, filteredRepos).catch((error) => {
        console.error('Error fetching PRs', error);
        stopProgress();
      });
    }
  }, [config]);

  useInterval(() => {
    async function getPRsFromGithub(token: string, owner: string, repos: string[]) {
      try {
        startProgress();
        const sinceTwoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const PRs = await queryPRs(token, owner, repos, sinceTwoWeeksAgo);
        setPRs(PRs.resultPRs);
        setRecentPRs(PRs.refCommits);
      } catch {
        console.log('Failed to fetch PRs');
      } finally {
        stopProgress();
      }
    }
    if (config.token && config.owner && config.repos.length > 0) {
      const filteredRepos = config.repos.filter((repo) => !config.ignoreRepos.includes(repo));
      getPRsFromGithub(config.token, config.owner, filteredRepos).catch((error) => {
        console.error('Error fetching PRs', error);
        stopProgress();
      });
    }
  }, config.pollingInterval);

  const filterDependabot = (pr: PRData) => showDependabotPRs || pr.author.login !== 'dependabot';
  const filterMasterPRs = (pr: PRData) => showMasterPRs || (pr.baseRefName !== 'master' && pr.baseRefName !== 'main');
  const displayPRs = PRs && PRs.length > 0 ? PRs.filter(filterDependabot).filter(filterMasterPRs).map((pr) => (
    <PR key={pr.url} pr={pr} showBranch={showMasterPRs} />
  )) : null;
  const handleOnChange = (e: React.ChangeEvent<HTMLInputElement>) => setIntervalInput(parseInt(e.target.value));
  const displayRecentPRs = showRecentPRs ? recentPRs.map((pr) => <RecentPR key={pr.url} pr={pr} />) : null;

  if (!config.token || !config.owner || !config.team) {
    return (
      <div className="settings-form">
        <h1>Configure PR Radiator</h1>
        <form autoComplete="off" onSubmit={onSubmit}>
          <input type="text" id="owner" placeholder="github-organization" autoFocus={true} autoComplete="off" defaultValue={config.owner} />
          <input type="text" id="team" placeholder="github-team-name" autoComplete="off" defaultValue={config.team} />
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
            Github Polling Interval{' '}
            <input type="number" id="polling-interval" onChange={handleOnChange} value={intervalInput} min="5" /> (seconds)
          </div>
          <input type="submit" value="Begin" id="submit" />
        </form>
      </div>
    );
  }

  if (config.repos.length === 0) {
    return <div>{`Fetching ${config.team} team repositories...`}</div>;
  }

  if (showRepoLinks) {
    return (
      <div className="App">
        <h1>{config.team} repositories ({config.repos.length})</h1>
        <ul>
          {config.repos.map((repo) => (
            <li key={repo}>
              <a href={`https://github.com/${config.owner}/${repo}`} target="_blank" rel="noopener noreferrer">
                {repo}
              </a>
            </li>
          ))}
        </ul>
        {showKeyboardShortcuts && <KeyboardShortcutsOverlay onClose={() => toggleShowKeyboardShortcuts(false)} />}
      </div>
    );
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
};

export default App;
