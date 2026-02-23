import type { IssueDetails } from './linearClient';
import type { ManusAttachment } from './manusClient';
import { createFileRecord, uploadFileToManus } from './manusClient';

interface Base64Block {
  data: string;
  filename: string;
  mimeType?: string;
}

const BASE64_BLOCK_REGEX = /```manus-base64(?:\s+([^\n]*))?\n([\s\S]*?)```/g;

function parseBase64Blocks(description: string | null | undefined): Base64Block[] {
  if (!description) return [];

  const blocks: Base64Block[] = [];
  let match: RegExpExecArray | null = null;
  let index = 1;

  while ((match = BASE64_BLOCK_REGEX.exec(description)) !== null) {
    const header = match[1]?.trim() ?? '';
    const body = match[2]?.trim() ?? '';
    if (!body) continue;

    const meta: Record<string, string> = {};
    if (header) {
      for (const token of header.split(/\s+/)) {
        if (!token) continue;
        const [key, value] = token.split('=');
        if (key && value) {
          meta[key.toLowerCase()] = value;
        }
      }
    }

    const filename = meta.filename ?? `attachment-${index}`;
    const mimeType = meta.mime ?? meta.mimetype;
    const data = body.replace(/\s+/g, '');
    blocks.push({ data, filename, mimeType });
    index += 1;
  }

  return blocks;
}

function collectUrls(texts: string[]): string[] {
  const urls = new Set<string>();
  const urlRegex = /https?:\/\/[^\s)\]]+/g;

  for (const text of texts) {
    if (!text) continue;
    const matches = text.match(urlRegex);
    if (!matches) continue;
    for (const match of matches) {
      urls.add(match);
    }
  }

  return Array.from(urls);
}

async function uploadBase64AsFile(block: Base64Block): Promise<ManusAttachment> {
  const buffer = Buffer.from(block.data, 'base64');
  const file = await createFileRecord(block.filename);
  await uploadFileToManus(file.upload_url, buffer, block.mimeType);
  return { file_id: file.id };
}

export async function buildManusAttachments(
  details: IssueDetails | null,
): Promise<ManusAttachment[]> {
  if (!details) return [];

  const texts = [details.description ?? '', ...details.comments.map((c) => c.body ?? '')];
  const urls = collectUrls(texts);
  const base64Blocks = parseBase64Blocks(details.description ?? null);

  const attachments: ManusAttachment[] = urls.map((url) => ({ url }));
  for (const block of base64Blocks) {
    attachments.push(await uploadBase64AsFile(block));
  }

  return attachments;
}
