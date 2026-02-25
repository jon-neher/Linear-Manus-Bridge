import type { IssueDetails } from './linearClient';
import type { ManusAttachment } from './manusClient';
import { createFileRecord, uploadFileToManus } from './manusClient';

interface Base64Block {
  data: string;
  filename: string;
  mimeType?: string;
}

const BASE64_BLOCK_REGEX = /```manus-base64(?:\s+([^\n]*))?\n([\s\S]*?)```/g;

const DEFAULT_MAX_URLS = 20;
const DEFAULT_MAX_BASE64_BYTES = 5 * 1024 * 1024;

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const MAX_URLS = parseLimit(process.env.MANUS_ATTACH_MAX_URLS, DEFAULT_MAX_URLS);
const MAX_BASE64_BYTES = parseLimit(
  process.env.MANUS_ATTACH_MAX_BASE64_BYTES,
  DEFAULT_MAX_BASE64_BYTES,
);

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
    const approxBytes = Math.floor((data.length * 3) / 4);
    if (approxBytes > MAX_BASE64_BYTES) {
      console.warn('[manusAttachments] Skipping base64 block over limit', {
        filename,
        sizeBytes: approxBytes,
        maxBytes: MAX_BASE64_BYTES,
      });
      continue;
    }
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
      if (urls.size >= MAX_URLS) {
        console.warn('[manusAttachments] URL limit reached', { maxUrls: MAX_URLS });
        return Array.from(urls);
      }
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
