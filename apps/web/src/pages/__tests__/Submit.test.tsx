import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { test, expect, describe, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const { mockSubmitPayment, mockSubmitTrustline, mockListAllAgents } = vi.hoisted(() => ({
  mockSubmitPayment: vi.fn(),
  mockSubmitTrustline: vi.fn(),
  mockListAllAgents: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listAllAgents: mockListAllAgents,
    submitPayment: mockSubmitPayment,
    submitTrustline: mockSubmitTrustline,
  },
}));

import Submit from '../Submit';

function renderSubmit() {
  return render(
    <MemoryRouter>
      <Submit />
    </MemoryRouter>
  );
}

describe('Submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllAgents.mockResolvedValue({
      agents: [{ id: 'agent-1', displayName: 'Test Agent' }],
      total: 1,
      truncated: false,
    });
  });

  test('shows View activity link after successful payment submit', async () => {
    mockSubmitPayment.mockResolvedValue({
      activityId: 'act-123',
      approvalId: 'appr-456',
      status: 'pending_approval',
    });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQ' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByText('View activity')).toBeInTheDocument();
    });

    expect(screen.getByText('View activity').closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-123'
    );
  });

  test('shows View activity link after successful trustline submit', async () => {
    mockSubmitTrustline.mockResolvedValue({
      activityId: 'act-789',
      status: 'pending',
    });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Intent Type'), { target: { value: 'trustline' } });
    fireEvent.change(screen.getByLabelText('Asset Code'), { target: { value: 'USDC' } });
    fireEvent.change(screen.getByLabelText('Issuer (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRS' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Add trustline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByText('View activity')).toBeInTheDocument();
    });

    expect(screen.getByText('View activity').closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-789'
    );
  });

  test('does not show View activity link when activityId is missing', async () => {
    mockSubmitPayment.mockResolvedValue({
      activityId: '',
      status: 'pending',
    });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQSS' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByText(/Intent submitted/)).toBeInTheDocument();
    });

    expect(screen.queryByText('View activity')).not.toBeInTheDocument();
  });

  test('renders error banner with role="alert" when submit fails', async () => {
    mockSubmitPayment.mockRejectedValue(new Error('Insufficient funds'));

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRS' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Insufficient funds');
    });
  });

  test('every form input has an associated label', async () => {
    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Intent Type')).toBeInTheDocument();
    expect(screen.getByLabelText('Asset')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toBeInTheDocument();
    expect(screen.getByLabelText('Destination (Stellar G...)')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
  });

  test('selecting Other and entering asset code keeps the value visible and submits correctly', async () => {
    mockSubmitPayment.mockResolvedValue({
      activityId: 'act-123',
      approvalId: 'appr-456',
      status: 'pending_approval',
    });

    renderSubmit();

    await waitFor(() => {
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'other' } });
    expect(screen.getByPlaceholderText('e.g. USDC')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('e.g. USDC'), { target: { value: 'USDC' } });
    expect(screen.getByPlaceholderText('e.g. USDC')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. USDC')).toHaveValue('USDC');

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Monthly payment' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Destination (Stellar G...)'), { target: { value: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Submit Intent' }));

    await waitFor(() => {
      expect(screen.getByText('View activity')).toBeInTheDocument();
    });

    expect(screen.getByText('View activity').closest('a')).toHaveAttribute(
      'href',
      '/agents/agent-1/activity/act-123'
    );

    expect(mockSubmitPayment).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ asset: 'USDC' })
    );
  });
});
