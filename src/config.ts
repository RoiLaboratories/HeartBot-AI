// Validate required environment variables
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
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
    token: process.env.TELEGRAM_BOT_TOKEN
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  },
  moralis: {
    apiKey: process.env.MORALIS_API_KEY,
    tokenFetchLimit: 10
  },
  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY
  },
  server: {
    port: process.env.PORT || 3000
  }
}; 