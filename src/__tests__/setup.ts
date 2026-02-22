// Common env vars for all tests.
// Individual tests may override or extend these as needed.
process.env.LINEAR_CLIENT_ID = 'test-client-id';
process.env.LINEAR_CLIENT_SECRET = 'test-client-secret';
process.env.LINEAR_REDIRECT_URI = 'http://localhost:3000/oauth/callback';
process.env.LINEAR_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.MANUS_API_KEY = 'test-manus-key';
process.env.INSTALLATION_STORE_SECRET = 'test-store-secret-at-least-16';
process.env.SERVICE_BASE_URL = 'https://test.example.com';
