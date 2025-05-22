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

    // Handle webhook requests
    if (req.method === 'POST') {
      console.log('[DEBUG] Processing webhook update');
      try {
        const middleware = heartBot.telegram.getWebhookMiddleware();
        console.log('[DEBUG] Got webhook middleware, processing update');
        await middleware(req, res);
        console.log('[DEBUG] Webhook update processed successfully');
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
    console.log('[DEBUG] Handling GET request');
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