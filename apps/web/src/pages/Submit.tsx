import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { SubmitPaymentIntent } from '../types';

interface SubmitResult {
  agentId: string;
  activityId: string;
  approvalId?: string;
  status: string;
}

export default function Submit() {
  const [agents, setAgents] = useState<{ id: string; displayName: string }[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [intentType, setIntentType] = useState<'payment' | 'trustline'>('payment');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [assetCode, setAssetCode] = useState<'XLM' | 'USDC' | 'BTC' | 'other'>('XLM');
  const [otherAssetCode, setOtherAssetCode] = useState('');
  const [issuer, setIssuer] = useState('');
  const [trustlineAssetCode, setTrustlineAssetCode] = useState('');
  const [trustlineIssuer, setTrustlineIssuer] = useState('');
  const [trustlineLimit, setTrustlineLimit] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  useEffect(() => {
    // Page through GET /agents so the dropdown lists every agent, not just
    // the first 200.
    api.listAllAgents()
      .then((a) => {
        setAgents(a.agents.map((x) => ({ id: x.id, displayName: x.displayName })));
        if (a.agents.length > 0) setSelectedAgent(a.agents[0]!.id);
      })
      .catch((e: any) => setError(e.message));
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!selectedAgent) return setError('Select an agent');
    if (!reason || reason.length < 3) return setError('Reason must be at least 3 characters');

    setLoading(true);
    if (intentType === 'payment') {
      if (!amount || parseFloat(amount) <= 0) { setLoading(false); return setError('Amount must be positive'); }
      if (!destination || !destination.startsWith('G')) { setLoading(false); return setError('Destination must be a valid Stellar account (G...)'); }
      const isNativeXLM = assetCode === 'XLM';
      const actualAssetCode = assetCode === 'other' ? otherAssetCode : assetCode;
      const intent: SubmitPaymentIntent = {
        type: 'payment',
        asset: actualAssetCode === 'XLM' ? 'XLM' : actualAssetCode,
        ...((!isNativeXLM && issuer) ? { assetDetails: { code: actualAssetCode, issuer } } : {}),
        destination,
        amount,
        reason,
      };
      api.submitPayment(selectedAgent, intent)
        .then((r) => {
          setResult({ agentId: selectedAgent, activityId: r.activityId, approvalId: r.approvalId, status: r.status });
        })
        .catch((e: any) => setError(e.message))
        .finally(() => setLoading(false));
    } else {
      if (!trustlineAssetCode || trustlineAssetCode.length < 1) { setLoading(false); return setError('Asset code is required'); }
      if (trustlineAssetCode === 'XLM') { setLoading(false); return setError('XLM is native — use payment instead'); }
      if (!trustlineIssuer || !trustlineIssuer.startsWith('G')) { setLoading(false); return setError('Issuer must be a valid Stellar account (G...)'); }
      api.submitTrustline(selectedAgent, {
        type: 'trustline',
        assetCode: trustlineAssetCode,
        issuer: trustlineIssuer,
        limit: trustlineLimit || undefined,
        reason,
      })
        .then((r) => {
          setResult({ agentId: selectedAgent, activityId: r.activityId, approvalId: r.approvalId, status: r.status });
        })
        .catch((e: any) => setError(e.message))
        .finally(() => setLoading(false));
    }
  };

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Submit Intent</h1>
          <p className="muted">Create a new intent for an agent to execute.</p>
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {result && (
        <div
          className="success-banner"
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-sm)',
            flexWrap: 'wrap',
          }}
        >
          <span>
            Intent submitted. Activity: {result.activityId}
            {result.approvalId ? `, Approval: ${result.approvalId}` : ''}. Status: {result.status}
          </span>
          {result.activityId && (
            <Link
              to={`/agents/${encodeURIComponent(result.agentId)}/activity/${encodeURIComponent(result.activityId)}`}
              className="btn btn-ghost btn-sm"
              style={{ flex: '0 0 auto' }}
            >
              View activity
            </Link>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="surface" style={{ maxWidth: '500px' }}>
        <div className="field">
          <label htmlFor="intent-type">Intent Type</label>
          <select id="intent-type" value={intentType} onChange={(e) => setIntentType(e.target.value as any)} className="select">
            <option value="payment">Payment</option>
            <option value="trustline">Trustline</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="agent-select">Agent</label>
          <select id="agent-select" value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)} className="select">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.displayName || a.id}</option>)}
          </select>
        </div>

        {intentType === 'payment' ? (
          <>
            <div className="field">
              <label htmlFor="asset">Asset</label>
              <select id="asset" value={assetCode} onChange={(e) => setAssetCode(e.target.value as "XLM" | "USDC" | "BTC" | "other")} className="select">
                <option value="XLM">XLM (native)</option>
                <option value="USDC">USDC</option>
                <option value="BTC">BTC</option>
                <option value="other">Other (specify)</option>
              </select>
            </div>
            {assetCode === 'other' && (
              <div className="field">
                <label htmlFor="asset-code">Asset Code</label>
                <input id="asset-code" type="text" value={otherAssetCode} onChange={(e) => setOtherAssetCode(e.target.value)} placeholder="e.g. USDC" className="input" aria-describedby="asset-code-hint" />
                <div id="asset-code-hint" className="field-hint">Enter the asset code, e.g. USDC.</div>
              </div>
            )}
            {assetCode !== 'XLM' && (
              <div className="field">
                <label htmlFor="issuer">Issuer (Stellar G...)</label>
                <input id="issuer" type="text" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="G..." className="input" />
              </div>
            )}
            <div className="field">
              <label htmlFor="amount">Amount</label>
              <input id="amount" type="number" step="0.0000001" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" />
            </div>
            <div className="field">
              <label htmlFor="destination">Destination (Stellar G...)</label>
              <input id="destination" type="text" value={destination} onChange={(e) => setDestination(e.target.value)} className="input" />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="tl-asset-code">Asset Code</label>
              <input id="tl-asset-code" type="text" value={trustlineAssetCode} onChange={(e) => setTrustlineAssetCode(e.target.value)} placeholder="e.g. USDC" className="input" />
            </div>
            <div className="field">
              <label htmlFor="tl-issuer">Issuer (Stellar G...)</label>
              <input id="tl-issuer" type="text" value={trustlineIssuer} onChange={(e) => setTrustlineIssuer(e.target.value)} placeholder="G..." className="input" />
            </div>
            <div className="field">
              <label htmlFor="tl-limit">Trustline Limit (optional)</label>
              <input id="tl-limit" type="number" step="0.0000001" min="0" value={trustlineLimit} onChange={(e) => setTrustlineLimit(e.target.value)} placeholder="No limit" className="input" />
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="reason">Reason</label>
          <input id="reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Monthly payment" className="input" aria-describedby="reason-hint" />
          <div id="reason-hint" className="field-hint">Minimum 3 characters. Describes the purpose of this intent.</div>
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Submitting...' : 'Submit Intent'}</button>
        </div>
      </form>
    </section>
  );
}
