// Validate required environment variables
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'APIFY_API_TOKEN',
  'MORALIS_API_KEY',
  'BIRDEYE_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
  apify: {
    token: process.env.APIFY_API_TOKEN || '',
  },
  moralis: {
    apiKey: process.env.MORALIS_API_KEY || '',
    tokenFetchLimit: parseInt(process.env.MORALIS_TOKEN_FETCH_LIMIT || '10'), // Default to 10 tokens
  },
  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY || '',
  },
  server: {
    port: parseInt(process.env.PORT || '3000'),
  },
}; 