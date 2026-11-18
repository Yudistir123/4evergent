import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Overview from '../Overview';

const {
  mockHealth,
  mockListAllAgents,
  mockListApprovals,
  mockListActivity,
  mockGetOverviewAttention,
} = vi.hoisted(() => ({
  mockHealth: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockListApprovals: vi.fn(),
  mockListActivity: vi.fn(),
  mockGetOverviewAttention: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    health: mockHealth,
    listAllAgents: mockListAllAgents,
    listApprovals: mockListApprovals,
    listActivity: mockListActivity,
    getOverviewAttention: mockGetOverviewAttention,
  },
}));

describe('Overview page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading skeleton on mount', () => {
    mockHealth.mockReturnValue(new Promise(() => {}));
    mockListAllAgents.mockReturnValue(new Promise(() => {}));
    mockListApprovals.mockReturnValue(new Promise(() => {}));
    mockListActivity.mockReturnValue(new Promise(() => {}));
    mockGetOverviewAttention.mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    );

    expect(screen.getByText('Connecting to API...')).toBeInTheDocument();
  });

  it('renders error state when initial API calls reject', async () => {
    mockHealth.mockRejectedValue(new Error('API server down'));
    mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
    mockListApprovals.mockResolvedValue({ approvals: [] });
    mockListActivity.mockResolvedValue({ activity: [] });

    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('API Unavailable')).toBeInTheDocument();
      expect(screen.getByText('API server down')).toBeInTheDocument();
    });
  });

  it('renders summary cards with correct metrics from mocked data', async () => {
    mockHealth.mockResolvedValue({
      status: 'ok',
      signerAccountId: 'GD6WTESTACCOUNT1234567890',
    });
    mockListAllAgents.mockResolvedValue({
      agents: [
        {
          id: 'agent-1',
          displayName: 'Agent 1',
          description: '',
          ownerId: 'o1',
          stellarAddress: 'G1',
          capabilities: ['payment'],
          status: 'active',
          active: true,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'agent-2',
          displayName: 'Agent 2',
          description: '',
          ownerId: 'o1',
          stellarAddress: 'G2',
          capabilities: ['payment'],
          status: 'active',
          active: true,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'agent-3',
          displayName: 'Agent 3',
          description: '',
          ownerId: 'o1',
          stellarAddress: 'G3',
          capabilities: ['payment'],
          status: 'active',
          active: true,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'agent-4',
          displayName: 'Agent 4',
          description: '',
          ownerId: 'o1',
          stellarAddress: 'G4',
          capabilities: [],
          status: 'paused',
          active: false,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'agent-5',
          displayName: 'Agent 5',
          description: '',
          ownerId: 'o1',
          stellarAddress: 'G5',
          capabilities: [],
          status: 'paused',
          active: false,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'agent-6',
          displayName: 'Agent 6',
          description: '',
          ownerId: 'o1',
          stellarAddress: 'G6',
          capabilities: [],
          status: 'disabled',
          active: false,
          createdAt: '',
          updatedAt: '',
        },
      ],
      total: 6,
      truncated: false,
    });
    mockListApprovals.mockResolvedValue({
      approvals: [
        { id: 'app-1', status: 'pending_approval' },
        { id: 'app-2', status: 'pending_approval' },
        { id: 'app-3', status: 'pending_approval' },
        { id: 'app-4', status: 'pending_approval' },
      ],
    });
    mockListActivity.mockResolvedValue({ activity: [] });
    mockGetOverviewAttention.mockResolvedValue({
      pendingApprovals: 0,
      failedExecutions: 0,
      deadLetterExecutions: 0,
      retryingExecutions: 0,
      stuckExecutions: 0,
    });

    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Overview')).toBeInTheDocument();
    });

    // Check header
    expect(screen.getByText('What needs your attention right now.')).toBeInTheDocument();

    // Check summary cards
    const signerCard = screen.getByText('Signer Account').closest('.card')!;
    expect(signerCard).toHaveTextContent('GD6WTESTACCO...');

    const activeCard = screen.getByText('Active Agents').closest('.card')!;
    expect(activeCard).toHaveTextContent('3');

    const pausedCard = screen.getByText('Paused Agents').closest('.card')!;
    expect(pausedCard).toHaveTextContent('2');

    const disabledCard = screen.getByText('Disabled Agents').closest('.card')!;
    expect(disabledCard).toHaveTextContent('1');

    const pendingCard = screen.getByText('Pending Approvals').closest('.card')!;
    expect(pendingCard).toHaveTextContent('4');
  });

  it('renders operational state when attention issues are zero', async () => {
    mockHealth.mockResolvedValue({ status: 'ok', signerAccountId: 'GD6WTEST1234' });
    mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
    mockListApprovals.mockResolvedValue({ approvals: [] });
    mockListActivity.mockResolvedValue({ activity: [] });
    mockGetOverviewAttention.mockResolvedValue({
      pendingApprovals: 0,
      failedExecutions: 0,
      deadLetterExecutions: 0,
      retryingExecutions: 0,
      stuckExecutions: 0,
    });

    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('All systems operational')).toBeInTheDocument();
      expect(screen.getByText('No pending approvals or failed executions.')).toBeInTheDocument();
    });
  });

  it('renders attention table when there are attention issues', async () => {
    mockHealth.mockResolvedValue({ status: 'ok', signerAccountId: 'GD6WTEST1234' });
    mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
    mockListApprovals.mockResolvedValue({ approvals: [] });
    mockListActivity.mockResolvedValue({ activity: [] });
    mockGetOverviewAttention.mockResolvedValue({
      pendingApprovals: 3,
      failedExecutions: 2,
      deadLetterExecutions: 1,
      retryingExecutions: 4,
      stuckExecutions: 5,
    });

    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Pending approvals')).toBeInTheDocument();
    });

    expect(screen.getByText('Failed executions')).toBeInTheDocument();
    expect(screen.getByText('Dead-letter executions')).toBeInTheDocument();
    expect(screen.getByText('Retrying executions')).toBeInTheDocument();
    expect(screen.getByText('Stuck executions')).toBeInTheDocument();

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();

    const reviewLinks = screen.getAllByRole('link', { name: 'Review' });
    expect(reviewLinks.length).toBe(5);
    expect(reviewLinks[0]).toHaveAttribute('href', '/approvals');
    expect(reviewLinks[1]).toHaveAttribute('href', '/executions');
  });

  it('renders attention error banner if getOverviewAttention rejects', async () => {
    mockHealth.mockResolvedValue({ status: 'ok', signerAccountId: 'GD6WTEST1234' });
    mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
    mockListApprovals.mockResolvedValue({ approvals: [] });
    mockListActivity.mockResolvedValue({ activity: [] });
    mockGetOverviewAttention.mockRejectedValue(new Error('Attention service failed'));

    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Attention service failed')).toBeInTheDocument();
    });
  });

  it('renders recent activity table when activity records exist', async () => {
    mockHealth.mockResolvedValue({ status: 'ok', signerAccountId: 'GD6WTEST1234' });
    mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
    mockListApprovals.mockResolvedValue({ approvals: [] });
    mockListActivity.mockResolvedValue({
      activity: [
        {
          id: 'activity-12345678',
          agentId: 'agent-12345678',
          ownerId: 'owner-1',
          intent: { type: 'payment', asset: 'XLM', amount: '10' },
          policyDecision: { result: 'allow', reason: 'ok', rule: 'rule-1', intent: {} as any },
          authorizationStatus: null,
          simulationResult: null,
          txHash: null,
          status: 'submitted',
          error: null,
          createdAt: '2026-03-01T12:00:00Z',
          updatedAt: '2026-03-01T12:00:00Z',
        },
      ],
    });
    mockGetOverviewAttention.mockResolvedValue({
      pendingApprovals: 0,
      failedExecutions: 0,
      deadLetterExecutions: 0,
      retryingExecutions: 0,
      stuckExecutions: 0,
    });

    render(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Recent Activity')).toBeInTheDocument();
    });

    expect(screen.getByText('activity')).toBeInTheDocument();
    expect(screen.getByText('agent-12')).toBeInTheDocument();
    expect(screen.getByText('submitted')).toBeInTheDocument();
  });
});
