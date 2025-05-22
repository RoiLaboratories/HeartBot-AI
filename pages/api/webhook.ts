import { VercelRequest, VercelResponse } from '@vercel/node';
import { heartBot } from '../../src/index';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Initialize bot if not already running
    if (!heartBot.isRunning) {
      console.log('[DEBUG] Starting bot...');
      await heartBot.start();
    }

    // Handle webhook requests
    if (req.method === 'POST') {
      console.log('[DEBUG] Received webhook update:', JSON.stringify(req.body));
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
      }
      return;
    }

    // For GET requests, return status
    res.status(200).json({ 
      status: 'ok', 
      message: 'Webhook endpoint is running',
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