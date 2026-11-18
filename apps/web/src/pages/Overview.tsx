import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, Skeleton, EmptyState, StatusBadge, Section } from '../components';
import type { AgentRecord, ActivityRecord, ApprovalRecord } from '../types';

interface AttentionCounts {
  pendingApprovals: number;
  failedExecutions: number;
  deadLetterExecutions: number;
  retryingExecutions: number;
  stuckExecutions: number;
}

export default function Overview() {
  const [health, setHealth] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attention, setAttention] = useState<AttentionCounts | null>(null);
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAttentionError(null);
    (async () => {
      try {
        const [h, a, ap, act] = await Promise.all([
          api.health(),
          // Page through GET /agents so the status counts cover every agent,
          // not just the first 200.
          api.listAllAgents(),
          api.listApprovals('pending_approval'),
          api.listActivity(),
        ]);
        if (cancelled) return;
        setHealth(h.signerAccountId);
        setAgents(a.agents);
        setApprovals(ap.approvals);
        setActivity(act.activity);

        try {
          const att = await api.getOverviewAttention();
          if (!cancelled) setAttention(att);
        } catch (e: any) {
          if (!cancelled) setAttentionError(e.message ?? 'Failed to load operational status');
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Failed to fetch');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const retry = () => setReloadKey((k) => k + 1);

  if (loading) return <Skeleton label="Connecting to API..." />;
  if (error) return <EmptyState title="API Unavailable" message={error} error={true} actionLabel="Retry" onAction={retry} />;

  const activeAgents = agents.filter((a) => a.status === 'active').length;
  const pausedAgents = agents.filter((a) => a.status === 'paused').length;
  const disabledAgents = agents.filter((a) => a.status === 'disabled').length;
  const pendingApprovals = approvals.length;

  const hasAttention = attention && (
    attention.pendingApprovals > 0 ||
    attention.failedExecutions > 0 ||
    attention.deadLetterExecutions > 0 ||
    attention.retryingExecutions > 0 ||
    attention.stuckExecutions > 0
  );

  const recentActivity = activity.slice(0, 10);
  const hasRecentActivity = recentActivity.length > 0;

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Overview</h1>
          <p className="muted">What needs your attention right now.</p>
        </div>
      </div>

      <div className="card-grid">
        <Card title="Signer Account" value={health ? health.slice(0, 12) + '...' : 'unknown'} />
        <Card title="Active Agents" value={String(activeAgents)} />
        <Card title="Paused Agents" value={String(pausedAgents)} />
        <Card title="Disabled Agents" value={String(disabledAgents)} />
        <Card title="Pending Approvals" value={String(pendingApprovals)} />
      </div>

      <Section title="Needs Attention">
        {attention === null && !attentionError ? (
          <Skeleton label="Loading operational status..." />
        ) : attentionError ? (
          <div className="error-banner">{attentionError}</div>
        ) : hasAttention ? (
          <table className="table">
            <thead>
              <tr><th>Issue</th><th>Count</th><th>Action</th></tr>
            </thead>
            <tbody>
              {attention!.pendingApprovals > 0 && (
                <tr>
                  <td>Pending approvals</td>
                  <td>{attention!.pendingApprovals}</td>
                  <td><Link to="/approvals" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
              {attention!.failedExecutions > 0 && (
                <tr>
                  <td>Failed executions</td>
                  <td>{attention!.failedExecutions}</td>
                  <td><Link to="/executions" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
              {attention!.retryingExecutions > 0 && (
                <tr>
                  <td>Retrying executions</td>
                  <td>{attention!.retryingExecutions}</td>
                  <td><Link to="/executions" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
              {attention!.deadLetterExecutions > 0 && (
                <tr>
                  <td>Dead-letter executions</td>
                  <td>{attention!.deadLetterExecutions}</td>
                  <td><Link to="/executions" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
              {attention!.stuckExecutions > 0 && (
                <tr>
                  <td>Stuck executions</td>
                  <td>{attention!.stuckExecutions}</td>
                  <td><Link to="/executions" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <h3>All systems operational</h3>
            <p>No pending approvals or failed executions.</p>
          </div>
        )}
      </Section>

      {hasRecentActivity && (
        <Section title="Recent Activity">
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr><th>Activity</th><th>Agent</th><th>Status</th><th>Time</th></tr>
              </thead>
              <tbody>
                {recentActivity.map((a) => (
                  <tr key={a.id}>
                    <td><code>{a.id.slice(0, 8)}</code></td>
                    <td><code>{a.agentId.slice(0, 8)}</code></td>
                    <td><StatusBadge status={a.status} /></td>
                    <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </section>
  );
}
