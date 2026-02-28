import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  postComment,
  updateComment,
  getIssueDetails,
  findStateIdByName,
  updateIssueState,
  getRepositorySuggestions,
} from '../../services/linearClient';

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
  variablesSubset?: Record<string, unknown>
) {
  expect(fetchMock).toHaveBeenCalledWith(
    LINEAR_URL,
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      }),
    })
  );

  if (variablesSubset) {
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.variables).toEqual(expect.objectContaining(variablesSubset));
  }
}

describe('linearClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('postComment', () => {
    it('returns comment id on success', async () => {
      globalThis.fetch = mockFetchJson({
        commentCreate: { success: true, comment: { id: 'comment-1' } },
      });

      const result = await postComment('issue-1', 'hello', TOKEN);
      expect(result).toBe('comment-1');
      expectGqlCall(globalThis.fetch, { issueId: 'issue-1', body: 'hello' });
    });

    it('includes parentId when provided', async () => {
      globalThis.fetch = mockFetchJson({
        commentCreate: { success: true, comment: { id: 'comment-2' } },
      });

      const result = await postComment('issue-1', 'reply', TOKEN, 'parent-1');
      expect(result).toBe('comment-2');
      expectGqlCall(globalThis.fetch, { parentId: 'parent-1' });
    });

    it('returns null when comment is not present', async () => {
      globalThis.fetch = mockFetchJson({
        commentCreate: { success: true },
      });

      const result = await postComment('issue-1', 'hello', TOKEN);
      expect(result).toBeNull();
    });
  });

  describe('updateComment', () => {
    it('completes without error on success', async () => {
      globalThis.fetch = mockFetchJson({
        commentUpdate: { success: true, comment: { id: 'comment-1' } },
      });

      await expect(updateComment('comment-1', 'updated body', TOKEN)).resolves.toBeUndefined();
      expectGqlCall(globalThis.fetch, { commentId: 'comment-1', body: 'updated body' });
    });
  });

  describe('getIssueDetails', () => {
    it('returns mapped issue data', async () => {
      globalThis.fetch = mockFetchJson({
        issue: {
          id: 'issue-1',
          title: 'Test Issue',
          description: 'A description',
          team: { id: 'team-1' },
          comments: {
            nodes: [
              { id: 'c1', body: 'comment body', user: { name: 'Alice' } },
              { id: 'c2', body: 'another comment', user: null },
            ],
          },
        },
      });

      const result = await getIssueDetails('issue-1', TOKEN, 10);
      expect(result).toEqual({
        id: 'issue-1',
        title: 'Test Issue',
        description: 'A description',
        teamId: 'team-1',
        comments: [
          { id: 'c1', body: 'comment body', authorName: 'Alice' },
          { id: 'c2', body: 'another comment', authorName: undefined },
        ],
      });
      expectGqlCall(globalThis.fetch, { issueId: 'issue-1', commentLimit: 10 });
    });

    it('throws "Issue not found" when issue is null', async () => {
      globalThis.fetch = mockFetchJson({ issue: null });

      await expect(getIssueDetails('missing-id', TOKEN)).rejects.toThrow(
        'Issue not found: missing-id'
      );
    });
  });

  describe('findStateIdByName', () => {
    it('finds a state by case-insensitive match', async () => {
      globalThis.fetch = mockFetchJson({
        workflowStates: {
          nodes: [
            { id: 'state-1', name: 'In Progress', type: 'started' },
            { id: 'state-2', name: 'Done', type: 'completed' },
          ],
        },
      });

      const result = await findStateIdByName('team-1', 'in progress', TOKEN);
      expect(result).toBe('state-1');
      expectGqlCall(globalThis.fetch, { teamId: 'team-1' });
    });

    it('returns null when no state matches', async () => {
      globalThis.fetch = mockFetchJson({
        workflowStates: {
          nodes: [{ id: 'state-1', name: 'In Progress', type: 'started' }],
        },
      });

      const result = await findStateIdByName('team-1', 'Nonexistent', TOKEN);
      expect(result).toBeNull();
    });
  });

  describe('updateIssueState', () => {
    it('completes without error on success', async () => {
      globalThis.fetch = mockFetchJson({
        issueUpdate: { success: true, issue: { id: 'issue-1', state: { name: 'Done' } } },
      });

      await expect(updateIssueState('issue-1', 'state-2', TOKEN)).resolves.toBeUndefined();
      expectGqlCall(globalThis.fetch, { issueId: 'issue-1', stateId: 'state-2' });
    });
  });

  describe('linearGql error handling', () => {
    it('throws on non-ok response', async () => {
      globalThis.fetch = mockFetchNotOk(500, 'Internal Server Error');

      await expect(postComment('issue-1', 'hello', TOKEN)).rejects.toThrow(
        'Linear API error (500): Internal Server Error'
      );
    });

    it('throws on GraphQL errors array', async () => {
      globalThis.fetch = mockFetchErrors([
        { message: 'Field not found' },
        { message: 'Unauthorized' },
      ]);

      await expect(postComment('issue-1', 'hello', TOKEN)).rejects.toThrow(
        'Linear GraphQL errors: Field not found, Unauthorized'
      );
    });
  });

  describe('getRepositorySuggestions', () => {
    it('returns ranked repository suggestions', async () => {
      globalThis.fetch = mockFetchJson({
        issueRepositorySuggestions: {
          suggestions: [
            { repositoryFullName: 'owner/repo1', hostname: 'github.com', confidence: 0.95 },
            { repositoryFullName: 'owner/repo2', hostname: 'github.com', confidence: 0.72 },
          ],
        },
      });

      const candidates = [
        { hostname: 'github.com', repositoryFullName: 'owner/repo1' },
        { hostname: 'github.com', repositoryFullName: 'owner/repo2' },
        { hostname: 'github.com', repositoryFullName: 'owner/repo3' },
      ];

      const result = await getRepositorySuggestions('issue-1', 'session-1', candidates, TOKEN);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        repositoryFullName: 'owner/repo1',
        hostname: 'github.com',
        confidence: 0.95,
      });

      expectGqlCall(globalThis.fetch, {
        issueId: 'issue-1',
        agentSessionId: 'session-1',
        candidateRepositories: candidates,
      });
    });

    it('returns empty array when no suggestions', async () => {
      globalThis.fetch = mockFetchJson({
        issueRepositorySuggestions: {
          suggestions: [],
        },
      });

      const result = await getRepositorySuggestions('issue-1', 'session-1', [], TOKEN);
      expect(result).toEqual([]);
    });

    it('sends candidate repositories in correct format', async () => {
      globalThis.fetch = mockFetchJson({
        issueRepositorySuggestions: { suggestions: [] },
      });

      await getRepositorySuggestions(
        'issue-1',
        'session-1',
        [{ hostname: 'github.com', repositoryFullName: 'owner/repo' }],
        TOKEN
      );

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.variables.candidateRepositories).toEqual([
        { hostname: 'github.com', repositoryFullName: 'owner/repo' },
      ]);
    });
  });
});
