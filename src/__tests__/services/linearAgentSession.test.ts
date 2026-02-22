import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAgentActivity,
  updateAgentSession,
  type AgentActivityContent,
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

function parseFetchBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

function expectGqlAuth(fetchMock: ReturnType<typeof vi.fn>) {
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
    it('returns activity id on success', async () => {
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true, agentActivity: { id: 'activity-1' } },
      });

      const result = await createAgentActivity(
        'session-1',
        { type: 'thought', body: 'thinking...' },
        TOKEN,
      );
      expect(result).toBe('activity-1');
      expectGqlAuth(globalThis.fetch);
    });

    it('returns null when agentActivity is not present', async () => {
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true },
      });

      const result = await createAgentActivity(
        'session-1',
        { type: 'response', body: 'done' },
        TOKEN,
      );
      expect(result).toBeNull();
    });

    it('sends correct mutation variables with thought content', async () => {
      const content: AgentActivityContent = { type: 'thought', body: 'analyzing issue' };
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true, agentActivity: { id: 'a1' } },
      });

      await createAgentActivity('session-1', content, TOKEN);

      const body = parseFetchBody(globalThis.fetch);
      expect(body.variables).toEqual({
        input: {
          agentSessionId: 'session-1',
          content: { type: 'thought', body: 'analyzing issue' },
        },
      });
    });

    it('sends correct mutation variables with action content', async () => {
      const content: AgentActivityContent = {
        type: 'action',
        action: 'search',
        parameter: 'query',
        result: 'found 3 items',
      };
      globalThis.fetch = mockFetchJson({
        agentActivityCreate: { success: true, agentActivity: { id: 'a2' } },
      });

      await createAgentActivity('session-2', content, TOKEN);

      const body = parseFetchBody(globalThis.fetch);
      expect(body.variables).toEqual({
        input: {
          agentSessionId: 'session-2',
          content: {
            type: 'action',
            action: 'search',
            parameter: 'query',
            result: 'found 3 items',
          },
        },
      });
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = mockFetchNotOk(500, 'Server Error');

      await expect(
        createAgentActivity('session-1', { type: 'error', body: 'oops' }, TOKEN),
      ).rejects.toThrow('Linear API error (500): Server Error');
    });

    it('throws on GraphQL errors', async () => {
      globalThis.fetch = mockFetchErrors([{ message: 'Invalid input' }]);

      await expect(
        createAgentActivity('session-1', { type: 'thought', body: 'x' }, TOKEN),
      ).rejects.toThrow('Linear GraphQL errors: Invalid input');
    });
  });

  describe('updateAgentSession', () => {
    it('completes without error on success', async () => {
      globalThis.fetch = mockFetchJson({
        agentSessionUpdate: { success: true },
      });

      await expect(
        updateAgentSession(
          'session-1',
          { externalUrls: [{ label: 'PR', url: 'https://github.com/pr/1' }] },
          TOKEN,
        ),
      ).resolves.toBeUndefined();
      expectGqlAuth(globalThis.fetch);
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = mockFetchNotOk(403, 'Forbidden');

      await expect(
        updateAgentSession('session-1', { plan: [] }, TOKEN),
      ).rejects.toThrow('Linear API error (403): Forbidden');
    });

    it('throws on GraphQL errors', async () => {
      globalThis.fetch = mockFetchErrors([{ message: 'Not authorized' }]);

      await expect(
        updateAgentSession('session-1', {}, TOKEN),
      ).rejects.toThrow('Linear GraphQL errors: Not authorized');
    });
  });
});
