import { VercelRequest, VercelResponse } from '@vercel/node';
import { heartBot } from '../../src/index';

// Check required environment variables
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'MORALIS_API_KEY',
  'BIRDEYE_API_KEY',
  'WEBHOOK_DOMAIN'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  console.error('[DEBUG] Missing required environment variables:', missingEnvVars);
}

// Use permanent domain for webhook
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || 'heart-bot-ai.vercel.app';
const WEBHOOK_URL = `https://${WEBHOOK_DOMAIN}/api/webhook`;

// Initialize bot on module load
(async () => {
  try {
    if (!heartBot.isRunning) {
      console.log('[DEBUG] Initializing bot on module load...');
      console.log('[DEBUG] Environment check:', {
        NODE_ENV: process.env.NODE_ENV,
        webhookUrl: WEBHOOK_URL,
        hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
        hasSupabaseConfig: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
        hasMoralisKey: !!process.env.MORALIS_API_KEY,
        hasBirdeyeKey: !!process.env.BIRDEYE_API_KEY
      });
      
      await heartBot.start();
      console.log('[DEBUG] Bot initialized successfully');
    }
  } catch (error) {
    console.error('[DEBUG] Error initializing bot:', error);
    if (error instanceof Error) {
      console.error('[DEBUG] Error details:', {
        message: error.message,
        stack: error.stack
      });
    }
  }
})();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    console.log('[DEBUG] Webhook request received:', {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: req.body
    });

    // Handle favicon requests
    if (req.url === '/favicon.ico' || req.url === '/favicon.png') {
      res.status(204).end(); // No content
      return;
    }

    // Only handle POST requests for Telegram updates
    if (req.method !== 'POST') {
      console.log('[DEBUG] Non-POST request received:', req.method);
      res.status(200).json({ 
        status: 'ok', 
        message: 'Server is running',
        botRunning: heartBot.isRunning,
        webhookUrl: WEBHOOK_URL,
        environment: {
          NODE_ENV: process.env.NODE_ENV,
          hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
          hasSupabaseConfig: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
          hasMoralisKey: !!process.env.MORALIS_API_KEY,
          hasBirdeyeKey: !!process.env.BIRDEYE_API_KEY
        }
      });
      return;
    }

    // Check if we have a valid update
    if (!req.body || !req.body.update_id) {
      console.error('[DEBUG] Invalid update received:', req.body);
      res.status(400).json({ 
        status: 'error', 
        message: 'Invalid update format',
        body: req.body
      });
      return;
    }

    // Initialize bot if not already running
    if (!heartBot.isRunning) {
      console.log('[DEBUG] Starting bot...');
      try {
        await heartBot.start();
        console.log('[DEBUG] Bot started successfully');
      } catch (error) {
        console.error('[DEBUG] Error starting bot:', error);
        if (error instanceof Error) {
          console.error('[DEBUG] Error details:', {
            message: error.message,
            stack: error.stack
          });
        }
        res.status(500).json({ 
          status: 'error', 
          message: 'Failed to start bot',
          error: error instanceof Error ? error.message : 'Unknown error',
          environment: {
            NODE_ENV: process.env.NODE_ENV,
            hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
            hasSupabaseConfig: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
            hasMoralisKey: !!process.env.MORALIS_API_KEY,
            hasBirdeyeKey: !!process.env.BIRDEYE_API_KEY
          }
        });
        return;
      }
    }

    // Handle Telegram webhook updates
    try {
      console.log('[DEBUG] Processing update:', req.body);
      const middleware = heartBot.telegram.getWebhookMiddleware();
      await middleware(req, res);
      console.log('[DEBUG] Update processed successfully');
      return;
    } catch (error) {
      console.error('[DEBUG] Error handling webhook update:', error);
      if (error instanceof Error) {
        console.error('[DEBUG] Error details:', {
          message: error.message,
          stack: error.stack
        });
      }
      res.status(500).json({ 
        status: 'error', 
        message: 'Error handling update',
        error: error instanceof Error ? error.message : 'Unknown error',
        update: req.body
      });
      return;
    }
  } catch (error) {
    console.error('[DEBUG] Error in webhook handler:', error);
    if (error instanceof Error) {
      console.error('[DEBUG] Error details:', {
        message: error.message,
        stack: error.stack
      });
    }
    res.status(500).json({ 
      status: 'error', 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
} 