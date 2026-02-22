import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('buildIssuePrompt', () => {
  let buildIssuePrompt: typeof import('../../services/manus').buildIssuePrompt;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../services/manus');
    buildIssuePrompt = mod.buildIssuePrompt;
  });

  it('uses teamKey-number format when both are present', () => {
    const prompt = buildIssuePrompt({
      id: 'id-1',
      title: 'Fix bug',
      teamKey: 'ENG',
      number: 42,
    });
    expect(prompt).toContain('ENG-42');
    expect(prompt).not.toContain('id-1');
  });

  it('falls back to issue id when teamKey is missing', () => {
    const prompt = buildIssuePrompt({
      id: 'id-1',
      title: 'Fix bug',
      number: 42,
    });
    expect(prompt).toContain('id-1');
  });

  it('includes the description when provided', () => {
    const prompt = buildIssuePrompt({
      id: 'id-1',
      title: 'Fix bug',
      description: 'Detailed description here',
    });
    expect(prompt).toContain('Description:');
    expect(prompt).toContain('Detailed description here');
  });

  it('omits description section when description is null', () => {
    const prompt = buildIssuePrompt({
      id: 'id-1',
      title: 'Fix bug',
      description: null,
    });
    expect(prompt).not.toContain('Description:');
  });

  it('omits description section when description is undefined', () => {
    const prompt = buildIssuePrompt({
      id: 'id-1',
      title: 'Fix bug',
    });
    expect(prompt).not.toContain('Description:');
  });
});

describe('submitManusTask', () => {
  let submitManusTask: typeof import('../../services/manus').submitManusTask;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../services/manus');
    submitManusTask = mod.submitManusTask;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns taskId and status on success', async () => {
    const mockResponse = { taskId: 'manus-1', status: 'queued' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }),
    );

    const result = await submitManusTask({ prompt: 'do something' });
    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('throws when MANUS_API_KEY is not configured', async () => {
    const original = process.env.MANUS_API_KEY;
    delete process.env.MANUS_API_KEY;

    await expect(submitManusTask({ prompt: 'test' })).rejects.toThrow(
      'MANUS_API_KEY is not configured',
    );

    process.env.MANUS_API_KEY = original;
  });

  it('throws with status code on API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      }),
    );

    await expect(submitManusTask({ prompt: 'test' })).rejects.toThrow('500');
  });
});
