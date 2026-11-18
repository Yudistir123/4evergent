import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Agents from '../Agents';

const { mockListAllAgents, mockCreateAgent } = vi.hoisted(() => ({
  mockListAllAgents: vi.fn(),
  mockCreateAgent: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listAllAgents: mockListAllAgents,
    createAgent: mockCreateAgent,
  },
}));

describe('Agents page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state on mount', () => {
    mockListAllAgents.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    expect(screen.getByText('Loading agents...')).toBeInTheDocument();
  });

  it('renders error state when api.listAgents fails', async () => {
    mockListAllAgents.mockRejectedValue(new Error('Failed to fetch agents'));
    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Failed to load agents')).toBeInTheDocument();
      expect(screen.getByText('Failed to fetch agents')).toBeInTheDocument();
    });

    // Error banner must be announced to screen readers
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch agents');
  });

  it('renders empty state when there are no agents', async () => {
    mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No agents yet')).toBeInTheDocument();
      expect(
        screen.getByText('Create your first agent to start submitting intents and schedules.')
      ).toBeInTheDocument();
    });
  });

  it('renders table with fetched agents data', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [
        {
          id: 'agent-1',
          displayName: 'Treasury Agent',
          description: 'Autonomous payment agent',
          ownerId: 'owner-1',
          stellarAddress: 'GBAGENT12345678901234567890',
          capabilities: ['payment', 'trustline'],
          status: 'active',
          active: true,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
      truncated: false,
    });

    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Treasury Agent')).toBeInTheDocument();
    });

    expect(screen.getByText('GBAGENT12345678901234567890')).toBeInTheDocument();
    expect(screen.getByText('payment, trustline')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/agents/agent-1');
  });

  it('shows an explicit truncation notice when the full list could not be loaded', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [
        {
          id: 'agent-1',
          displayName: 'Treasury Agent',
          description: '',
          ownerId: 'owner-1',
          stellarAddress: '',
          capabilities: [],
          status: 'active',
          active: true,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      total: 3,
      truncated: true,
    });

    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Treasury Agent')).toBeInTheDocument();
    });

    expect(screen.getByRole('status')).toHaveTextContent('Showing 1 of 3 agents');
  });

  it('shows no truncation notice when the full list was loaded', async () => {
    mockListAllAgents.mockResolvedValue({
      agents: [
        {
          id: 'agent-1',
          displayName: 'Treasury Agent',
          description: '',
          ownerId: 'owner-1',
          stellarAddress: '',
          capabilities: [],
          status: 'active',
          active: true,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
      truncated: false,
    });

    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Treasury Agent')).toBeInTheDocument();
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  describe('Create Agent modal', () => {
    it('opens create modal when clicking Create Agent button', async () => {
      mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

      expect(screen.getByRole('heading', { name: 'Create Agent' })).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText(/Description/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Capabilities/i)).toBeInTheDocument();
    });

    it('exposes the modal as an accessible dialog', async () => {
      mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby');

      const labelledById = dialog.getAttribute('aria-labelledby')!;
      const title = document.getElementById(labelledById);
      expect(title).toBeInTheDocument();
      expect(title).toHaveTextContent('Create Agent');
    });

    it('closes the modal when Escape is pressed', async () => {
      mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('shows validation error when name is empty', async () => {
      mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

      // Submit with empty name
      const form = screen.getByLabelText('Name').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeInTheDocument();
      });

      expect(mockCreateAgent).not.toHaveBeenCalled();
    });

    it('submits form with valid input and calls api.createAgent with expected body', async () => {
      mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
      mockCreateAgent.mockResolvedValue({
        agent: {
          id: 'agent-new-123',
          displayName: 'Yield Agent',
          description: 'Automates yield strategies',
          ownerId: 'owner-1',
          stellarAddress: 'GBYIELD12345',
          capabilities: ['payment', 'trustline'],
          status: 'active',
          active: true,
          createdAt: '2026-02-01T00:00:00Z',
          updatedAt: '2026-02-01T00:00:00Z',
        },
      });

      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Yield Agent' } });
      fireEvent.change(screen.getByLabelText(/Description/i), {
        target: { value: 'Automates yield strategies' },
      });
      fireEvent.change(screen.getByLabelText(/Capabilities/i), {
        target: { value: 'payment, trustline' },
      });

      const form = screen.getByLabelText('Name').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledWith({
          displayName: 'Yield Agent',
          description: 'Automates yield strategies',
          capabilities: ['payment', 'trustline'],
        });
      });

      // Modal closes on success
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('shows API error when createAgent rejects', async () => {
      mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
      mockCreateAgent.mockRejectedValue(new Error('Agent name already exists'));

      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Duplicate Agent' } });

      const form = screen.getByLabelText('Name').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText('Agent name already exists')).toBeInTheDocument();
      });

      // Modal error must be announced to screen readers
      expect(screen.getByRole('alert')).toHaveTextContent('Agent name already exists');
    });

    it('closes modal when clicking Cancel button', async () => {
      mockListAllAgents.mockResolvedValue({ agents: [], total: 0, truncated: false });
      render(
        <MemoryRouter>
          <Agents />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
