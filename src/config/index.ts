import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string(),
  SUPABASE_URL: z.string(),
  SUPABASE_ANON_KEY: z.string(),
  APIFY_TOKEN: z.string(),
  PORT: z.string().transform(Number),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
});

const env = envSchema.parse(process.env);

export const config = {
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN,
  },
  supabase: {
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
  },
  apify: {
    token: env.APIFY_TOKEN,
  },
  server: {
    port: env.PORT,
  },
  isDevelopment: env.NODE_ENV === 'development',
} as const; 