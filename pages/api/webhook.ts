import { VercelRequest, VercelResponse } from '@vercel/node';
import { heartBot } from '../../src/index';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    console.log('[DEBUG] Webhook request received:', {
      method: req.method,
      headers: req.headers,
      body: req.body
    });

    // Initialize bot if not already running
    if (!heartBot.isRunning) {
      console.log('[DEBUG] Starting bot...');
      await heartBot.start();
      console.log('[DEBUG] Bot started successfully');
    }

    // Handle Telegram webhook updates
    if (req.method === 'POST') {
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
    }

    // Return status for GET requests
    res.status(200).json({ 
      status: 'ok', 
      message: 'Bot is running',
      botRunning: heartBot.isRunning 
    });
  } catch (error) {
    console.error('[DEBUG] Error in webhook handler:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
} 