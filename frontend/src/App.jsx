import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const { ipcRenderer } = window.require ? window.require('electron') : { ipcRenderer: null };

const backendUrl = 'http://localhost:8765';
const agentOptions = [
  { key: 'claude', label: 'Claude', fullLabel: 'Claude Code', icon: '✳' },
  { key: 'codex', label: 'Codex', fullLabel: 'Codex', icon: 'C' },
  { key: 'antigravity', label: 'Antigravity', fullLabel: 'Antigravity CLI', icon: '◇' },
  { key: 'opencode', label: 'OpenCode', fullLabel: 'OpenCode', icon: 'O' },
];
const agentMeta = Object.fromEntries(agentOptions.map((agent) => [agent.key, agent]));

function sessionKey(agent, id) {
  return `${agent}:${id}`;
}

function agentIcon(agent) {
  return agentMeta[agent]?.icon || '◌';
}

function agentLabel(agent, full = false) {
  const meta = agentMeta[agent];
  return full ? meta?.fullLabel || agent : meta?.label || agent;
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
  const detailsRequestRef = useRef(0);

  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchSessions() {
    try {
      setLoading(true);
      const res = await fetch(`${backendUrl}/api/sessions`);
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
    } catch (err) {
      console.error('Error connecting to backend:', err);
    } finally {
      setLoading(false);
    }
  }

  async function selectSession(agent, id) {
    const requestId = detailsRequestRef.current + 1;
    detailsRequestRef.current = requestId;
    setActiveSession({ agent, id, key: sessionKey(agent, id) });
    setActiveDetails(null);
    setDetailsError('');
    setDetailsLoading(true);
    try {
      const res = await fetch(`${backendUrl}/api/sessions/${agent}/${id}`);
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
        setDetailsError(err.message || 'Error fetching session details.');
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
      const res = await fetch(`${backendUrl}/api/sessions/${agent}/${id}`);
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
    if (!ipcRenderer) {
      setDebugTerminal({ error: 'IPC not available (running in browser, not Electron).' });
      return;
    }
    setDebugLoading(true);
    setDebugTerminal(null);
    try {
      const ctx = await ipcRenderer.invoke('detect-terminal');
      if (ctx.error) {
        setDebugTerminal(ctx);
        return;
      }
      // Try to resolve against backend
      let resolveResult = null;
      if (ctx.cwd || ctx.command) {
        try {
          const res = await fetch(`${backendUrl}/api/takeover/resolve`, {
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
  const selectedAgentMeta = agentFilter === 'all'
    ? { label: 'All agents', fullLabel: 'All coding agents', icon: 'A' }
    : agentMeta[agentFilter];

  return (
    <div className="session-manager-app">
      <header className="manager-topbar">
        <button className="back-button" title="Back" disabled>
          ←
        </button>
        <div>
          <h1>Session Manager</h1>
          <p>Local coding agent handoff</p>
        </div>
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
            <span className={`agent-filter-icon ${agentFilter}`}>{selectedAgentMeta?.icon}</span>
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
            {loading ? (
              <div className="loading-block">
                <div className="spinner"></div>
                <span>Loading sessions...</span>
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
                        {agentIcon(session.agent)}
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

          {ipcRenderer && (
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
          {detailsLoading ? (
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
                    {agentIcon(activeDetails.metadata.agent)}
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
