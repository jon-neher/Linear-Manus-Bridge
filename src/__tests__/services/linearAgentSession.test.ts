import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAgentActivity,
  updateAgentSession,
} from '../../services/linearAgentSession';

const TOKEN = 'test-access-token';
const LINEAR_URL = 'https://api.linear.app/graphql';

function mockFetchJson(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve({ data }),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchErrors(errors: Array<{ message: string }>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ errors }),
    text: () => Promise.resolve(''),
  });
}

function mockFetchNotOk(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  });
}

function expectGqlCall(
  fetchMock: ReturnType<typeof vi.fn>,
  variablesSubset?: Record<string, unknown>,
) {
  expect(fetchMock).toHaveBeenCalledWith(
    LINEAR_URL,
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      }),
    }),
  );

  if (variablesSubset) {
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.variables).toEqual(expect.objectContaining(variablesSubset));
  }
}

describe('linearAgentSession', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('createAgentActivity', () => {
    it('returns activity id for a thought', async () => {
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true, agentActivity: { id: 'activity-1' } },
      });

      const result = await createAgentActivity(
        'session-1',
        { type: 'thought', body: 'Thinking…' },
        TOKEN,
      );
      expect(result).toBe('activity-1');
      expectGqlCall(globalThis.fetch, {
        input: { agentSessionId: 'session-1', content: { type: 'thought', body: 'Thinking…' } },
      });
    });

    it('includes select signal metadata when provided', async () => {
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true, agentActivity: { id: 'activity-5' } },
      });

      const result = await createAgentActivity(
        'session-1',
        { type: 'elicitation', body: 'Choose one' },
        TOKEN,
        {
          signal: 'select',
          signalMetadata: { options: [{ label: 'A', value: 'a' }] },
          ephemeral: true,
        },
      );

      expect(result).toBe('activity-5');
      expectGqlCall(globalThis.fetch, {
        input: {
          agentSessionId: 'session-1',
          content: { type: 'elicitation', body: 'Choose one' },
          signal: 'select',
          signalMetadata: { options: [{ label: 'A', value: 'a' }] },
          ephemeral: true,
        },
      });
    });

    it('returns activity id for an action', async () => {
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true, agentActivity: { id: 'activity-2' } },
      });

      const result = await createAgentActivity(
        'session-1',
        { type: 'action', action: 'Created task', parameter: 'task-1', result: 'Done' },
        TOKEN,
      );
      expect(result).toBe('activity-2');
    });

    it('returns activity id for a response', async () => {
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true, agentActivity: { id: 'activity-3' } },
      });

      const result = await createAgentActivity(
        'session-1',
        { type: 'response', body: 'Task completed' },
        TOKEN,
      );
      expect(result).toBe('activity-3');
    });

    it('returns activity id for an error', async () => {
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true, agentActivity: { id: 'activity-4' } },
      });

      const result = await createAgentActivity(
        'session-1',
        { type: 'error', body: 'Something went wrong' },
        TOKEN,
      );
      expect(result).toBe('activity-4');
    });

    it('returns null when agentActivity is missing from response', async () => {
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true },
      });

      const result = await createAgentActivity(
        'session-1',
        { type: 'thought', body: 'test' },
        TOKEN,
      );
      expect(result).toBeNull();
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = mockFetchNotOk(401, 'Unauthorized');

      await expect(
        createAgentActivity('session-1', { type: 'thought', body: 'test' }, TOKEN),
      ).rejects.toThrow('Linear API error (401): Unauthorized');
    });

    it('throws on GraphQL errors', async () => {
      globalThis.fetch = mockFetchErrors([{ message: 'Not authorized' }]);

      await expect(
        createAgentActivity('session-1', { type: 'thought', body: 'test' }, TOKEN),
      ).rejects.toThrow('Linear GraphQL errors: Not authorized');
    });
  });

  describe('updateAgentSession', () => {
    it('completes without error when setting externalUrls', async () => {
      globalThis.fetch = mockFetchJson({
        agentSessionUpdate: { success: true },
      });

      await expect(
        updateAgentSession(
          'session-1',
          { externalUrls: [{ label: 'View in Manus', url: 'https://manus.ai/task/1' }] },
          TOKEN,
        ),
      ).resolves.toBeUndefined();
      expectGqlCall(globalThis.fetch);
    });

    it('completes without error when setting plan steps', async () => {
      globalThis.fetch = mockFetchJson({
        agentSessionUpdate: { success: true },
      });

      await expect(
        updateAgentSession(
          'session-1',
          {
            plan: [
              { content: 'Step 1', status: 'completed' },
              { content: 'Step 2', status: 'inProgress' },
            ],
          },
          TOKEN,
        ),
      ).resolves.toBeUndefined();
    });
  });
});
