import { VercelRequest, VercelResponse } from '@vercel/node';
import { heartBot } from '../../src/index';

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
      res.status(200).json({ 
        status: 'ok', 
        message: 'Server is running',
        botRunning: heartBot.isRunning 
      });
      return;
    }

    // Initialize bot if not already running
    if (!heartBot.isRunning) {
      console.log('[DEBUG] Starting bot...');
      await heartBot.start();
      console.log('[DEBUG] Bot started successfully');
    }

    // Handle Telegram webhook updates
    try {
      const middleware = heartBot.telegram.getWebhookMiddleware();
      await middleware(req, res);
      return;
    } catch (error) {
      console.error('[DEBUG] Error handling webhook update:', error);
      res.status(500).json({ 
        status: 'error', 
        message: 'Error handling update',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return;
    }
  } catch (error) {
    console.error('[DEBUG] Error in webhook handler:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
} 