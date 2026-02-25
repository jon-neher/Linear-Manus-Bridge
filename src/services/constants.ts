// Linear API endpoints
export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
export const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';

// OAuth scopes for Manus agent integration
export const OAUTH_SCOPES = 'read,write,app:assignable,app:mentionable';

// Manus API
export const MANUS_API_BASE_URL = process.env.MANUS_API_BASE_URL ?? 'https://api.manus.ai';

// Manus profile options for agent sessions
export const PROFILE_OPTIONS = ['manus-1.6', 'manus-1.6-lite', 'manus-1.6-max'] as const;
export type ManusProfile = (typeof PROFILE_OPTIONS)[number];

// GitHub connector ID for Manus
export const GITHUB_CONNECTOR_ID = 'bbb0df76-66bd-4a24-ae4f-2aac4750d90b';

// Regex to disable GitHub connector via comment
export const CONNECTORS_NONE_REGEX = /\/manus\s+connectors\s*=\s*none\b/i;

// Token refresh buffer (5 minutes before expiry)
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Webhook signature timestamp tolerance
export const MAX_WEBHOOK_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes
export const PUBLIC_KEY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// OAuth state TTL
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Encryption
export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
