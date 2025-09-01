import React, { useEffect, FormEvent, useRef, useReducer } from 'react';
import PR from './PR';
import { filterTeamRepos, queryOpenPRs, queryRecentPRs, queryTeamRepos } from './github';

interface PRData {
  url: string;
  author: { login: string };
  baseRefName: string;
  [key: string]: any; // For other dynamic properties
}

interface AppState {
  config: {
    token: string;
    owner: string;
    team: string;
    repos: string[];
    pollingInterval: number;
    ignoreRepos: string[];
  };
  PRs: PRData[];
  recentPRs: PRData[];
  intervalInput: number;
  showDependabotPRs: boolean;
  showMasterPRs: boolean;
  showKeyboardShortcuts: boolean;
  showRecentPRs: boolean;
  showRepoLinks: boolean;
}

type AppAction =
  | { type: 'SET_CONFIG'; payload: Partial<AppState['config']> }
  | { type: 'SET_PRS'; payload: PRData[] }
  | { type: 'SET_RECENT_PRS'; payload: PRData[] }
  | { type: 'SET_INTERVAL_INPUT'; payload: number }
  | { type: 'TOGGLE_DEPENDABOT' }
  | { type: 'TOGGLE_MASTER' }
  | { type: 'TOGGLE_KEYBOARD_SHORTCUTS' }
  | { type: 'TOGGLE_RECENT_PRS' }
  | { type: 'TOGGLE_REPO_LINKS' }
  | { type: 'RESET_REPOS' };

const initialState: AppState = {
  config: {
    token: localStorage.getItem('PR_RADIATOR_TOKEN') ?? '',
    owner: localStorage.getItem('PR_RADIATOR_OWNER') ?? '',
    team: localStorage.getItem('PR_RADIATOR_TEAM') ?? '',
    repos: JSON.parse(localStorage.getItem('PR_RADIATOR_REPOS') ?? '[]'),
    pollingInterval: parseInt(localStorage.getItem('PR_RADIATOR_POLLING_INTERVAL') ?? '0'),
    ignoreRepos: JSON.parse(localStorage.getItem('PR_RADIATOR_IGNORE_REPOS') ?? '[]'),
  },
  PRs: [],
  recentPRs: [],
  intervalInput: 60,
  showDependabotPRs: false,
  showMasterPRs: true,
  showKeyboardShortcuts: false,
  showRecentPRs: false,
  showRepoLinks: false,
};

const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case 'SET_CONFIG':
      return { ...state, config: { ...state.config, ...action.payload } };
    case 'SET_PRS':
      return { ...state, PRs: action.payload };
    case 'SET_RECENT_PRS':
      return { ...state, recentPRs: action.payload };
    case 'SET_INTERVAL_INPUT':
      return { ...state, intervalInput: action.payload };
    case 'TOGGLE_DEPENDABOT':
      return { ...state, showDependabotPRs: !state.showDependabotPRs };
    case 'TOGGLE_MASTER':
      return { ...state, showMasterPRs: !state.showMasterPRs };
    case 'TOGGLE_KEYBOARD_SHORTCUTS':
      return { ...state, showKeyboardShortcuts: !state.showKeyboardShortcuts };
    case 'TOGGLE_RECENT_PRS':
      return { ...state, showRecentPRs: !state.showRecentPRs };
    case 'TOGGLE_REPO_LINKS':
      return { ...state, showRepoLinks: !state.showRepoLinks };
    case 'RESET_REPOS':
      return { ...state, config: { ...state.config, repos: [] }, PRs: [], recentPRs: [] };
    default:
      return state;
  }
};

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

const progressBar = document.getElementById('progress-bar') as HTMLDivElement;

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

const App: React.FC = () => {
  const [state, dispatch] = useReducer(appReducer, initialState);

  const fetchOpenPRs = async (token: string, owner: string, repos: string[], ignoreRepos: string[]) => {
    try {
      startProgress();
      const filteredRepos = repos.filter(repo => !ignoreRepos.includes(repo));
      const openPRs = await queryOpenPRs(token, owner, filteredRepos);
      dispatch({ type: 'SET_PRS', payload: openPRs });
    } catch (error) {
      console.log('Failed to fetch open PRs', error);
    } finally {
      stopProgress();
    }
  };

  const fetchRecentPRs = async (token: string, owner: string, repos: string[], ignoreRepos: string[]) => {
    try {
      startProgress();
      const filteredRepos = repos.filter(repo => !ignoreRepos.includes(repo));
      const sinceTwoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const recentPRs = await queryRecentPRs(token, owner, filteredRepos, sinceTwoWeeksAgo);
      dispatch({ type: 'SET_RECENT_PRS', payload: recentPRs });
    } catch (error) {
      console.log('Failed to fetch recent PRs', error);
    } finally {
      stopProgress();
    }
  };

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
    dispatch({ type: 'SET_CONFIG', payload: { team, token, owner, pollingInterval } });
  };

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'd') {
        dispatch({ type: 'TOGGLE_DEPENDABOT' });
      }
      if (event.key === 'm') {
        dispatch({ type: 'TOGGLE_MASTER' });
      }
      if (event.key === 'a') {
        const newShowRecentPRs = !state.showRecentPRs;
        dispatch({ type: 'TOGGLE_RECENT_PRS' });
        if (newShowRecentPRs && state.config.token && state.config.owner && state.config.repos.length > 0) {
          fetchRecentPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch((error) => {
            console.error('Error in fetchRecentPRs on keydown', error);
          });
        }
      }
      if (event.key === 'l') {
        dispatch({ type: 'TOGGLE_REPO_LINKS' });
      }
      if (event.key === 'r') {
        if (state.config.token && state.config.owner && state.config.repos.length > 0) {
          fetchOpenPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch((error) => {
            console.error('Error in fetchOpenPRs on keydown', error);
          });
        }
      }
      if (event.key === '\\' || event.key === 'Backslash') {
        localStorage.removeItem('PR_RADIATOR_REPOS');
        dispatch({ type: 'RESET_REPOS' });
      }
      if (event.key === '?' && event.shiftKey) {
        dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' });
      }
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [state.config, state.showRecentPRs]);

  useEffect(() => {
    async function getTeamRepos(token: string, owner: string, team: string) {
      try {
        startProgress();
        const repos = await queryTeamRepos(token, owner, team);
        const filteredRepos = await filterTeamRepos(token, owner, team, repos);
        localStorage.setItem('PR_RADIATOR_REPOS', JSON.stringify(filteredRepos));
        dispatch({ type: 'SET_CONFIG', payload: { repos: filteredRepos } });
      } catch {
        console.log('Failed to fetch team repos');
      } finally {
        stopProgress();
      }
    }
    if (state.config.token && state.config.owner && state.config.team && state.config.repos.length === 0) {
      getTeamRepos(state.config.token, state.config.owner, state.config.team).catch((error) => {
        console.error('Error in getTeamRepos', error);
        stopProgress();
      });
    }
  }, [state.config]);

  useEffect(() => {
    if (state.config.token && state.config.owner && state.config.repos.length > 0) {
      fetchOpenPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch((error) => {
        console.error('Error in fetchOpenPRs on initial load', error);
        stopProgress();
      });
    }
  }, [state.config]);

  useInterval(() => {
    if (state.config.token && state.config.owner && state.config.repos.length > 0) {
      fetchOpenPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch((error) => {
        console.error('Error in fetchOpenPRs on interval', error);
      });
    }
  }, state.config.pollingInterval);

  useEffect(() => {
    if (state.showRecentPRs && state.config.token && state.config.owner && state.config.repos.length > 0) {
      fetchRecentPRs(state.config.token, state.config.owner, state.config.repos, state.config.ignoreRepos).catch((error) => {
        console.error('Error in fetchRecentPRs on show recent PRs', error);
      });
    }
  }, [state.showRecentPRs, state.config]);

  const filterDependabot = (pr: PRData) => state.showDependabotPRs || pr.author.login !== 'dependabot';
  const filterMasterPRs = (pr: PRData) => state.showMasterPRs || (pr.baseRefName !== 'master' && pr.baseRefName !== 'main');
  const displayPRs = React.useMemo(() => {
    if (!state.PRs || state.PRs.length === 0) return null;
    return state.PRs.filter(filterDependabot).filter(filterMasterPRs).map((pr) => (
      <PR key={pr.url} pr={pr} showBranch={state.showMasterPRs} />
    ));
  }, [state.PRs, state.showDependabotPRs, state.showMasterPRs]);
  const handleOnChange = (e: React.ChangeEvent<HTMLInputElement>) => dispatch({ type: 'SET_INTERVAL_INPUT', payload: parseInt(e.target.value) });
  const displayRecentPRs = React.useMemo(() => state.showRecentPRs && state.recentPRs.length > 0 ? state.recentPRs.map((pr) => <PR key={pr.url} pr={pr} isRecent={state.showRecentPRs} />) : null, [state.showRecentPRs, state.recentPRs]);

  const ShortcutsOverlay = ({ onClose }: { onClose: () => void }) => (
    <div className="keyboard-shortcuts-overlay" onClick={onClose}>
      <div className="keyboard-shortcuts-content">
        <h2>Shortcuts</h2>
        <ul>
          <li><strong>d</strong>: Toggle Dependabot</li>
          <li><strong>a</strong>: Toggle Recent PRs</li>
          <li><strong>m</strong>: Toggle Master PRs</li>
          <li><strong>l</strong>: Toggle Repo Links</li>
          <li><strong>r</strong>: Refresh PRs</li>
          <li><strong>\</strong>: Reset Repos</li>
          <li><strong>?</strong>: This Overlay</li>
        </ul>
      </div>
    </div>
  );


  if (!state.config.token || !state.config.owner || !state.config.team) {
    return (
      <div className="settings-form">
        <h1>Configure PR Radiator</h1>
        <form autoComplete="off" onSubmit={onSubmit}>
          <input type="text" id="owner" placeholder="github-organization" autoFocus={true} autoComplete="off" defaultValue={state.config.owner} />
          <input type="text" id="team" placeholder="github-team-name" autoComplete="off" defaultValue={state.config.team} />
          <input type="password" id="token" placeholder="Github Personal Access Token" autoComplete="new-password" defaultValue={state.config.token} />
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
            <input type="number" id="polling-interval" onChange={handleOnChange} value={state.intervalInput} min="5" /> (seconds)
          </div>
          <input type="submit" value="Begin" id="submit" />
        </form>
      </div>
    );
  }

  if (state.config.repos.length === 0) {
    return <div>{`Fetching ${state.config.team} team repositories...`}</div>;
  }

  if (state.showRepoLinks) {
    return (
      <div className="App">
        <h1>{state.config.team} repositories ({state.config.repos.length})</h1>
        <ul>
          {state.config.repos.map((repo) => (
            <li key={repo}>
              <a href={`https://github.com/${state.config.owner}/${repo}`} target="_blank" rel="noopener noreferrer">
                {repo}
              </a>
            </li>
          ))}
        </ul>
        {state.showKeyboardShortcuts && <ShortcutsOverlay onClose={() => dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' })} />}
      </div>
    );
  }

  if (state.showRecentPRs) {
    document.title = `PR Radiator`;
    return (
      <div className="App">
        {displayRecentPRs}
        {state.showKeyboardShortcuts && <ShortcutsOverlay onClose={() => dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' })} />}
      </div>
    );
  }

  document.title = `(${displayPRs?.length ?? ''}) PR Radiator`;
  if (displayPRs?.length === 0) {
    return (
      <div className="App">
        No PRs found
        {state.showKeyboardShortcuts && <ShortcutsOverlay onClose={() => dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' })} />}
      </div>
    );
  }

  return (
    <div className="App">
      {displayPRs}
      {state.showKeyboardShortcuts && <ShortcutsOverlay onClose={() => dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' })} />}
    </div>
  );
};

export default App;
