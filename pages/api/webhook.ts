import { VercelRequest, VercelResponse } from '@vercel/node';
import { heartBot } from '../../src/index';
import crypto from 'crypto';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    console.log('[DEBUG] Webhook request received:', {
      method: req.method,
      headers: req.headers,
      body: req.body
    });

    // Verify request method
    if (req.method !== 'POST' && req.method !== 'GET') {
      console.log('[DEBUG] Invalid request method:', req.method);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // For GET requests, return status
    if (req.method === 'GET') {
      console.log('[DEBUG] Handling GET request');
      return res.status(200).json({ 
        status: 'ok', 
        message: 'Webhook endpoint is running',
        botRunning: heartBot.isRunning 
      });
    }

    // Initialize bot if not already running
    if (!heartBot.isRunning) {
      console.log('[DEBUG] Starting bot...');
      await heartBot.start();
      console.log('[DEBUG] Bot started successfully');
    }

    // Handle webhook requests
    console.log('[DEBUG] Processing webhook update');
    try {
      const middleware = heartBot.telegram.getWebhookMiddleware();
      console.log('[DEBUG] Got webhook middleware, processing update');
      
      // Add error handling for the middleware
      try {
        await middleware(req, res);
        console.log('[DEBUG] Webhook update processed successfully');
      } catch (error) {
        console.error('[DEBUG] Error in webhook middleware:', error);
        // Don't send error response if headers are already sent
        if (!res.headersSent) {
          res.status(500).json({ 
            status: 'error', 
            message: 'Error processing update',
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    } catch (error) {
      console.error('[DEBUG] Error getting webhook middleware:', error);
      res.status(500).json({ 
        status: 'error', 
        message: 'Error setting up webhook handler',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  } catch (error) {
    console.error('[DEBUG] Error in webhook handler:', error);
    // Don't send error response if headers are already sent
    if (!res.headersSent) {
      res.status(500).json({ 
        status: 'error', 
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
} 