import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const vibesync = window.vibesync || null;

const DEFAULT_BACKEND_URL = 'http://localhost:8765';
const FETCH_TIMEOUT_MS = 8000;
const HEALTH_POLL_INTERVAL_MS = 30000;

const agentOptions = [
  { key: 'claude', label: 'Claude', fullLabel: 'Claude Code', icon: 'agents/claude.png' },
  { key: 'codex', label: 'Codex', fullLabel: 'Codex', icon: 'agents/codex.png' },
  { key: 'antigravity', label: 'Antigravity', fullLabel: 'Antigravity CLI', icon: 'agents/antigravity.png' },
  { key: 'opencode', label: 'OpenCode', fullLabel: 'OpenCode', icon: 'agents/opencode.png' },
];
const agentMeta = Object.fromEntries(agentOptions.map((agent) => [agent.key, agent]));

function sessionKey(agent, id) {
  return `${agent}:${id}`;
}

function AgentIcon({ agent, size = 24 }) {
  const src = agentMeta[agent]?.icon;
  if (!src) return <span className="agent-glyph-fallback">◌</span>;
  return (
    <img
      src={src}
      alt={agentLabel(agent, true)}
      width={size}
      height={size}
      className="agent-icon-img"
    />
  );
}

function agentLabel(agent, full = false) {
  const meta = agentMeta[agent];
  return full ? meta?.fullLabel || agent : meta?.label || agent;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [activeDetails, setActiveDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const [copiedTarget, setCopiedTarget] = useState(null);
  const [debugTerminal, setDebugTerminal] = useState(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL);
  const [backendStatus, setBackendStatus] = useState('checking');
  const detailsRequestRef = useRef(0);
  const healthTimerRef = useRef(null);
  const fetchSessionsRef = useRef(null);

  // ── Backend lifecycle ──────────────────────────────────────────────────

  const checkBackendHealth = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${backendUrl}/api/health`, {}, 4000);
      if (res.ok) {
        setBackendStatus('connected');
        return true;
      }
    } catch (err) {
      console.debug('Backend health check failed:', err);
    }
    setBackendStatus('disconnected');
    return false;
  }, [backendUrl]);

  const startReconnecting = useCallback(() => {
    if (healthTimerRef.current) return;
    const delays = [2000, 4000, 8000, 16000, 30000];
    let attempt = 0;
    async function tick() {
      const ok = await checkBackendHealth();
      if (ok) {
        healthTimerRef.current = setTimeout(() => {
          healthTimerRef.current = null;
          startReconnecting();
        }, HEALTH_POLL_INTERVAL_MS);
        fetchSessionsRef.current?.();
        return;
      }
      attempt++;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      healthTimerRef.current = setTimeout(tick, delay);
    }
    tick();
  }, [checkBackendHealth]);

  useEffect(() => {
    return () => {
      if (healthTimerRef.current) {
        clearTimeout(healthTimerRef.current);
        healthTimerRef.current = null;
      }
    };
  }, []);

  // ── Init ───────────────────────────────────────────────────────────────

  useEffect(() => {
    async function init() {
      if (vibesync) {
        try {
          const url = await vibesync.getBackendUrl();
          if (url) setBackendUrl(url);
        } catch (err) {
          console.debug('Could not read backend URL from Electron preload:', err);
        }
      }
      const ok = await checkBackendHealth();
      if (ok) {
        fetchSessions();
      } else {
        setLoading(false);
        startReconnecting();
      }
    }
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Session fetching ──────────────────────────────────────────────────

  async function fetchSessions() {
    try {
      setLoading(true);
      const res = await fetchWithTimeout(`${backendUrl}/api/sessions`);
      if (!res.ok) {
        console.error('Failed to fetch sessions');
        return;
      }
      const data = await res.json();
      setSessions(data);
      if (data.length > 0) {
        selectSession(data[0].agent, data[0].id);
      } else {
        setActiveDetails(null);
        setActiveSession(null);
        setDetailsError('');
      }
      setBackendStatus('connected');
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error('Sessions request timed out');
      } else {
        console.error('Error connecting to backend:', err);
      }
      setBackendStatus('disconnected');
      startReconnecting();
    } finally {
      setLoading(false);
    }
  }
  fetchSessionsRef.current = fetchSessions;

  async function selectSession(agent, id) {
    const requestId = detailsRequestRef.current + 1;
    detailsRequestRef.current = requestId;
    setActiveSession({ agent, id, key: sessionKey(agent, id) });
    setActiveDetails(null);
    setDetailsError('');
    setDetailsLoading(true);
    try {
      const res = await fetchWithTimeout(`${backendUrl}/api/sessions/${agent}/${id}`);
      if (res.ok) {
        const data = await res.json();
        if (
          detailsRequestRef.current === requestId &&
          data?.metadata?.agent === agent &&
          data?.metadata?.id === id
        ) {
          setActiveDetails(data);
        }
      } else {
        const errorText = await res.text();
        if (detailsRequestRef.current === requestId) {
          setDetailsError(errorText || `Failed to fetch ${agentLabel(agent, true)} session details.`);
        }
        console.error('Failed to fetch session details');
      }
    } catch (err) {
      if (detailsRequestRef.current === requestId) {
        if (err.name === 'AbortError') {
          setDetailsError('Request timed out — backend may be overloaded.');
        } else {
          setDetailsError(err.message || 'Error fetching session details.');
        }
      }
      console.error('Error fetching session details:', err);
    } finally {
      if (detailsRequestRef.current === requestId) {
        setDetailsLoading(false);
      }
    }
  }

  function copyToClipboard(text, target) {
    navigator.clipboard.writeText(text || '');
    setCopiedTarget(target);
    setTimeout(() => setCopiedTarget(null), 1600);
  }

  async function handleQuickCopy(agent, id, e) {
    e.stopPropagation();
    try {
      const res = await fetchWithTimeout(`${backendUrl}/api/sessions/${agent}/${id}`);
      if (!res.ok) return;

      const data = await res.json();
      if (data?.takeover_prompt) {
        copyToClipboard(data.takeover_prompt, `quick-${sessionKey(agent, id)}`);
      }
    } catch (err) {
      console.error('Quick copy failed:', err);
    }
  }

  async function detectTerminal() {
    if (!vibesync) {
      setDebugTerminal({ error: 'IPC not available (running in browser, not Electron).' });
      return;
    }
    setDebugLoading(true);
    setDebugTerminal(null);
    try {
      const ctx = await vibesync.detectTerminal();
      if (ctx.error) {
        setDebugTerminal(ctx);
        return;
      }
      let resolveResult = null;
      if (ctx.cwd || ctx.command) {
        try {
          const res = await fetchWithTimeout(`${backendUrl}/api/takeover/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ terminalApp: ctx.terminalApp, cwd: ctx.cwd, command: ctx.command }),
          });
          resolveResult = await res.json();
          resolveResult.status = res.status;
        } catch {
          resolveResult = { error: 'Backend unreachable' };
        }
      }
      setDebugTerminal({ ...ctx, resolve: resolveResult });
    } catch (err) {
      setDebugTerminal({ error: err.message || 'Detection failed' });
    } finally {
      setDebugLoading(false);
    }
  }

  function formatTime(ts) {
    if (!ts) return 'Unknown';
    try {
      const date = new Date(typeof ts === 'number' && ts < 100000000000 ? ts * 1000 : ts);
      return date.toLocaleString();
    } catch {
      return ts.toString();
    }
  }

  function shortTitle(session) {
    const title = session.title || 'Untitled session';
    const handoffMatch = title.match(/^#\s*.*VIBESYNC CONTEXT HANDOVER[\s\S]*?Sync Session:\s*([A-Z][A-Z0-9 _-]+)/i);
    if (handoffMatch) {
      return `VibeSync handoff from ${handoffMatch[1].trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}`;
    }
    if (/^#\s*.*VIBESYNC CONTEXT HANDOVER/i.test(title)) {
      return 'VibeSync handoff prompt';
    }
    return title;
  }

  function sessionProject(session) {
    return session.project?.split('/').filter(Boolean).pop() || session.project || 'Unknown workspace';
  }

  const agentCounts = useMemo(() => {
    return sessions.reduce(
      (counts, session) => {
        counts.all += 1;
        counts[session.agent] = (counts[session.agent] || 0) + 1;
        return counts;
      },
      { all: 0, claude: 0, codex: 0, antigravity: 0, opencode: 0 }
    );
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return sessions.filter((session) => {
      const matchesAgent = agentFilter === 'all' || session.agent === agentFilter;
      const matchesQuery =
        !query ||
        session.title?.toLowerCase().includes(query) ||
        session.agent_label?.toLowerCase().includes(query) ||
        agentLabel(session.agent, true).toLowerCase().includes(query) ||
        session.project?.toLowerCase().includes(query) ||
        session.id?.toLowerCase().includes(query) ||
        session.agent?.toLowerCase().includes(query);
      return matchesAgent && matchesQuery;
    });
  }, [agentFilter, searchQuery, sessions]);

  const conversation = activeDetails?.conversation || [];
  const transcriptPath = activeDetails?.metadata?.transcript_path || '';
  const projectPath = activeDetails?.metadata?.project || '';
  return (
    <div className="session-manager-app">
      <header className="manager-topbar">
        <img src="app-icon.png" alt="VibeSync" width={32} height={32} className="app-logo" />
        <div>
          <h1>Session Manager</h1>
          <p>Local coding agent handoff</p>
        </div>
        {backendStatus !== 'connected' && (
          <div className={`backend-banner ${backendStatus}`}>
            {backendStatus === 'checking' ? 'Connecting to backend...' : 'Backend connection lost. Reconnecting...'}
          </div>
        )}
      </header>

      <div className="manager-shell">
        <aside className="session-list-panel">
          <div className="panel-header">
            <div className="panel-title-row">
              <span className="panel-title">Sessions</span>
              <span className="count-pill">{filteredSessions.length}</span>
            </div>
            <button className="icon-button" onClick={fetchSessions} title="Refresh sessions">
              ↻
            </button>
          </div>

          <input
            className="session-search"
            type="text"
            placeholder="Search sessions, projects, IDs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <label className="agent-filter" htmlFor="agent-filter">
            <span className={`agent-filter-icon ${agentFilter}`}>
              {agentFilter === 'all' ? (
                <img src="app-icon.png" alt="VibeSync" width={18} height={18} className="agent-icon-img" />
              ) : (
                <AgentIcon agent={agentFilter} size={18} />
              )}
            </span>
            <select
              id="agent-filter"
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              aria-label="Filter sessions by coding agent"
            >
              <option value="all">All coding agents ({agentCounts.all})</option>
              {agentOptions.map(({ key, fullLabel }) => (
                <option key={key} value={key}>
                  {fullLabel} ({agentCounts[key]})
                </option>
              ))}
            </select>
          </label>

          <div className="session-scroll">
            {loading && backendStatus !== 'disconnected' ? (
              <div className="loading-block">
                <div className="spinner"></div>
                <span>Loading sessions...</span>
              </div>
            ) : backendStatus === 'checking' ? (
              <div className="loading-block">
                <div className="spinner"></div>
                <span>Starting backend...</span>
              </div>
            ) : backendStatus === 'disconnected' ? (
              <div className="empty-panel">
                <h3>Backend Unavailable</h3>
                <p>Check that Python 3 is installed and the VibeSync backend can start.</p>
                <button className="primary-action" onClick={fetchSessions}>
                  Retry Connection
                </button>
              </div>
            ) : filteredSessions.length > 0 ? (
              filteredSessions.map((session) => {
                const cardKey = sessionKey(session.agent, session.id);
                const isActive = activeSession?.key === cardKey;
                return (
                  <article
                    key={cardKey}
                    className={`manager-session-card ${isActive ? 'active' : ''}`}
                    onClick={() => selectSession(session.agent, session.id)}
                  >
                    <div className="session-card-main">
                      <span className={`agent-glyph ${session.agent}`} title={agentLabel(session.agent, true)}>
                        <AgentIcon agent={session.agent} size={20} />
                      </span>
                      <div className="session-card-copy">
                        <h2>{shortTitle(session)}</h2>
                        <p>
                          <span className={`agent-mini-chip ${session.agent}`}>{agentLabel(session.agent, true)}</span>
                          {sessionProject(session)}
                        </p>
                      </div>
                      <span className="session-chevron">{isActive ? '⌄' : '›'}</span>
                    </div>
                    <div className="session-card-meta">
                      <span>◷ {formatTime(session.timestamp)}</span>
                      <button
                        className={`quick-copy ${copiedTarget === `quick-${cardKey}` ? 'copied' : ''}`}
                        onClick={(e) => handleQuickCopy(session.agent, session.id, e)}
                        title="Copy takeover prompt"
                      >
                        {copiedTarget === `quick-${cardKey}` ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="empty-panel">No sessions match this filter.</div>
            )}
          </div>

          {vibesync && (
            <div className="debug-panel">
              <button
                className="debug-detect-button"
                onClick={detectTerminal}
                disabled={debugLoading}
              >
                {debugLoading ? 'Detecting...' : 'Detect Current Terminal'}
              </button>
              {debugTerminal && (
                <div className="debug-output">
                  {debugTerminal.error && !debugTerminal.terminalApp && (
                    <div className="debug-row error">{debugTerminal.error}</div>
                  )}
                  {debugTerminal.terminalApp && (
                    <>
                      <div className="debug-row">
                        <span>app</span><code>{debugTerminal.terminalApp}</code>
                      </div>
                      {debugTerminal.error ? (
                        <div className="debug-row warn">{debugTerminal.error}</div>
                      ) : (
                        <>
                          <div className="debug-row">
                            <span>cwd</span><code>{debugTerminal.cwd || 'unknown'}</code>
                          </div>
                          <div className="debug-row">
                            <span>command</span><code>{debugTerminal.command || 'unknown'}</code>
                          </div>
                          <div className="debug-row">
                            <span>confidence</span><code>{debugTerminal.confidence}</code>
                          </div>
                          <div className="debug-row">
                            <span>source</span><code>{debugTerminal.source}</code>
                          </div>
                        </>
                      )}
                      {debugTerminal.resolve && (
                        <>
                          <div className="debug-divider" />
                          {debugTerminal.resolve.session ? (
                            <>
                              <div className="debug-row">
                                <span>matched</span>
                                <code>
                                  {debugTerminal.resolve.session.agent}/
                                  {debugTerminal.resolve.session.id.slice(0, 12)}...
                                </code>
                              </div>
                              <div className="debug-row">
                                <span>reason</span><code>{debugTerminal.resolve.reason}</code>
                              </div>
                              <div className="debug-row">
                                <span>confidence</span><code>{debugTerminal.resolve.confidence}</code>
                              </div>
                            </>
                          ) : (
                            <div className="debug-row warn">
                              {debugTerminal.resolve.error || `HTTP ${debugTerminal.resolve.status}`}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </aside>

        <main className="conversation-panel">
          {backendStatus === 'checking' ? (
            <div className="loading-block full">
              <div className="spinner"></div>
              <span>Starting backend...</span>
            </div>
          ) : backendStatus === 'disconnected' ? (
            <div className="empty-state">
              <img src="app-icon.png" alt="VibeSync" width={48} height={48} className="empty-state-logo" />
              <h3>Backend Connection Lost</h3>
              <p>VibeSync is attempting to reconnect automatically.</p>
              <button className="primary-action" onClick={fetchSessions}>
                Reconnect Now
              </button>
            </div>
          ) : detailsLoading ? (
            <div className="loading-block full">
              <div className="spinner"></div>
              <span>Preparing local takeover view...</span>
            </div>
          ) : detailsError ? (
            <div className="empty-state">
              <h3>Session Details Failed</h3>
              <p>
                {activeSession
                  ? `${agentLabel(activeSession.agent, true)} session ${activeSession.id} could not be loaded.`
                  : 'The selected session could not be loaded.'}
              </p>
              <pre className="error-detail">{detailsError}</pre>
              <button className="primary-action" onClick={fetchSessions}>
                Try Reconnecting Backend
              </button>
            </div>
          ) : activeDetails ? (
            <>
              <section className="session-detail-header">
                <div className="detail-title-row">
                  <span className={`agent-glyph large ${activeDetails.metadata.agent}`}>
                    <AgentIcon agent={activeDetails.metadata.agent} size={28} />
                  </span>
                  <div className="detail-title-copy">
                    <h2>{shortTitle(activeDetails.metadata) || 'Active Workspace Session'}</h2>
                    <div className="detail-meta">
                      <span>◷ {formatTime(activeDetails.metadata.timestamp)}</span>
                      <span>▣ {sessionProject(activeDetails.metadata)}</span>
                      <span className={`agent-chip ${activeDetails.metadata.agent}`}>
                        {agentLabel(activeDetails.metadata.agent, true)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="detail-actions">
                  <button
                    className="primary-action"
                    onClick={() => copyToClipboard(activeDetails.takeover_prompt, 'takeover')}
                  >
                    {copiedTarget === 'takeover' ? 'Copied' : 'Copy Takeover Prompt'}
                  </button>
                  <button
                    className="danger-action"
                    onClick={() => copyToClipboard(transcriptPath, 'transcript')}
                  >
                    {copiedTarget === 'transcript' ? 'Copied' : 'Copy Transcript Path'}
                  </button>
                </div>
              </section>

              <section className="takeover-strip">
                <div className="path-row">
                  <span>workspace</span>
                  <code>{projectPath}</code>
                  <button onClick={() => copyToClipboard(projectPath, 'workspace')}>
                    {copiedTarget === 'workspace' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="path-row">
                  <span>transcript</span>
                  <code>{transcriptPath}</code>
                  <button onClick={() => copyToClipboard(transcriptPath, 'transcript-inline')}>
                    {copiedTarget === 'transcript-inline' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </section>

              <section className="takeover-prompt-card">
                <div className="section-heading">
                  <span>Takeover Prompt</span>
                  <strong>{activeDetails.takeover_prompt.length} chars</strong>
                </div>
                <textarea readOnly value={activeDetails.takeover_prompt} />
              </section>

              <section className="state-summary-grid">
                <div className="summary-card">
                  <span className="summary-label">Branch</span>
                  <strong>{activeDetails.git.branch || 'N/A'}</strong>
                </div>
                <div className="summary-card">
                  <span className="summary-label">Files touched</span>
                  <strong>{activeDetails.files_touched.length}</strong>
                </div>
                <div className="summary-card">
                  <span className="summary-label">Commands</span>
                  <strong>{activeDetails.commands.length}</strong>
                </div>
                <div className="summary-card">
                  <span className="summary-label">Turns</span>
                  <strong>{activeDetails.raw_steps_count}</strong>
                </div>
              </section>

              <section className="conversation-history-panel">
                <div className="section-heading">
                  <span>Conversation History</span>
                  <strong>{conversation.length}</strong>
                </div>
                <div className="conversation-list">
                  {conversation.length > 0 ? (
                    conversation.map((turn) => (
                      <article key={turn.index} className={`conversation-turn ${turn.role}`}>
                        <div className="turn-header">
                          <span>{turn.role}</span>
                          <time>{formatTime(turn.timestamp)}</time>
                        </div>
                        <pre>{turn.content || '*No textual content captured.*'}</pre>
                        {(turn.tool_count > 0 || turn.truncated) && (
                          <div className="turn-footer">
                            {turn.tool_count > 0 && <span>{turn.tool_count} tool calls</span>}
                            {turn.truncated && <span>preview truncated</span>}
                          </div>
                        )}
                      </article>
                    ))
                  ) : (
                    <div className="empty-panel">No conversation preview is available for this session.</div>
                  )}
                </div>
              </section>
            </>
          ) : (
            <div className="empty-state">
              <img src="app-icon.png" alt="VibeSync" width={48} height={48} className="empty-state-logo" />
              <h3>No Sessions Loaded</h3>
              <p>Start the VibeSync backend and make sure local coding agent sessions exist.</p>
              <button className="primary-action" onClick={fetchSessions}>
                Try Reconnecting Backend
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
