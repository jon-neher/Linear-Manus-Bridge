import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const ALGORITHM = 'aes-256-gcm';

function getDataDir(): string {
  const dir = process.env.DATA_DIR ?? process.cwd();
  mkdirSync(dir, { recursive: true });
  return dir;
}

const STORE_PATH = join(getDataDir(), '.installations.enc');

export interface InstallationRecord {
  workspaceId: string;
  workspaceName: string;
  appInstallationId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

function getEncryptionKey(): Buffer {
  const secret = process.env.INSTALLATION_STORE_SECRET;
  if (!secret) {
    throw new Error('INSTALLATION_STORE_SECRET environment variable is required');
  }
  return scryptSync(secret, 'linear-manus-bridge', 32);
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

function loadStore(): Map<string, InstallationRecord> {
  if (!existsSync(STORE_PATH)) {
    return new Map();
  }
  try {
    const raw = readFileSync(STORE_PATH, 'utf8');
    const decrypted = decrypt(raw);
    const entries: [string, InstallationRecord][] = JSON.parse(decrypted);
    return new Map(entries);
  } catch {
    console.error('Failed to load installation store; starting fresh');
    return new Map();
  }
}

function persistStore(store: Map<string, InstallationRecord>): void {
  const serialized = JSON.stringify(Array.from(store.entries()));
  const encrypted = encrypt(serialized);
  writeFileSync(STORE_PATH, encrypted, 'utf8');
}

// Keyed by workspaceId for primary access
let store: Map<string, InstallationRecord> | null = null;

function getStore(): Map<string, InstallationRecord> {
  if (!store) {
    store = loadStore();
  }
  return store;
}

export function saveInstallation(record: InstallationRecord): void {
  const s = getStore();
  s.set(record.workspaceId, { ...record });
  persistStore(s);
}

export function getInstallationByWorkspace(workspaceId: string): InstallationRecord | undefined {
  return getStore().get(workspaceId);
}

export function getInstallationByAppId(appInstallationId: string): InstallationRecord | undefined {
  for (const record of getStore().values()) {
    if (record.appInstallationId === appInstallationId) {
      return record;
    }
  }
  return undefined;
}

export function markInstallationInactive(workspaceId: string): void {
  const s = getStore();
  const record = s.get(workspaceId);
  if (record) {
    record.active = false;
    record.updatedAt = Date.now();
    s.set(workspaceId, record);
    persistStore(s);
  }
}

export function updateInstallationTokens(
  workspaceId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
): void {
  const s = getStore();
  const record = s.get(workspaceId);
  if (record) {
    record.accessToken = accessToken;
    record.refreshToken = refreshToken;
    record.expiresAt = expiresAt;
    record.updatedAt = Date.now();
    s.set(workspaceId, record);
    persistStore(s);
  }
}

export function getAllActiveInstallations(): InstallationRecord[] {
  const results: InstallationRecord[] = [];
  for (const record of getStore().values()) {
    if (record.active) {
      results.push({ ...record });
    }
  }
  return results;
}
