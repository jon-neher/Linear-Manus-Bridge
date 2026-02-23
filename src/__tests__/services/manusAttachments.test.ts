import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../services/manusClient', () => ({
  createFileRecord: vi.fn(),
  uploadFileToManus: vi.fn(),
}));

describe('manusAttachments', () => {
  let buildManusAttachments: typeof import('../../services/manusAttachments').buildManusAttachments;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../services/manusAttachments');
    buildManusAttachments = mod.buildManusAttachments;
  });

  it('extracts URLs and base64 blocks', async () => {
    const { createFileRecord, uploadFileToManus } = await import('../../services/manusClient');
    (createFileRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'file-1',
      upload_url: 'https://upload',
    });
    (uploadFileToManus as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const attachments = await buildManusAttachments({
      id: 'issue-1',
      title: 'Test',
      description: 'See https://example.com\n```manus-base64 filename=data.txt mime=text/plain\nZGF0YQ==\n```',
      teamId: 'team-1',
      comments: [{ id: 'c1', body: 'More info at https://example.org' }],
    });

    expect(attachments).toEqual([
      { url: 'https://example.com' },
      { url: 'https://example.org' },
      { file_id: 'file-1' },
    ]);
    expect(createFileRecord).toHaveBeenCalledWith('data.txt');
    expect(uploadFileToManus).toHaveBeenCalled();
  });
});
