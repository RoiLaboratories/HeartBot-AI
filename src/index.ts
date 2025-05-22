import 'dotenv/config';
import fastify, { FastifyInstance } from 'fastify';
import { config } from './config';
import { TelegramService } from './services/telegram';
import { PumpFunService } from './services/pumpfun';
import { TokenData } from './types';
import { createClient } from '@supabase/supabase-js';

export class HeartBot {
  public telegram: TelegramService;
  private pumpFun: PumpFunService;
  private server: FastifyInstance;
  public isRunning: boolean = false;
  private adminClient;
  private monitoringEnabled: Map<string, boolean> = new Map();
  private serverStarted: boolean = false;

  constructor() {
    this.pumpFun = new PumpFunService();
    this.server = fastify();
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('Missing required Supabase configuration');
    }
    this.adminClient = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey
    );
    this.telegram = new TelegramService(this);

    // Add test route
    this.server.get('/', async (request, reply) => {
      return { status: 'ok', message: 'Server is running' };
    });

    // Set up webhook endpoint in production
    if (process.env.NODE_ENV === 'production') {
      this.server.post('/webhook', async (request, reply) => {
        const middleware = this.telegram.getWebhookMiddleware();
        await middleware(request.raw, reply.raw);
      });
    }
  }

  async start() {
    try {
      console.log('[DEBUG] Starting HeartBot...');
      
      // Start Telegram bot
      await this.telegram.start();
      console.log('[DEBUG] Telegram bot started');

      // Start Fastify server only if not already started
      if (!this.serverStarted) {
        try {
          console.log('[DEBUG] Starting Fastify server...');
          const port = Number(process.env.PORT) || Number(config.server.port);
          await this.server.listen({ 
            port: port || 3000, 
            host: '0.0.0.0' 
          });
          this.serverStarted = true;
          console.log(`[DEBUG] Server listening on port ${port}`);
        } catch (err: any) {
          if (err.code === 'FST_ERR_REOPENED_SERVER') {
            console.log('[DEBUG] Server already running');
            this.serverStarted = true;
          } else {
            console.error('[DEBUG] Error starting server:', err);
            throw err;
          }
        }
      }

      // Set running state
      this.isRunning = true;
      console.log('[DEBUG] HeartBot started successfully');

      // Start token monitoring in the background
      this.startTokenMonitoring();
    } catch (error) {
      console.error('[DEBUG] Error starting HeartBot:', error);
      await this.stop();
      process.exit(1);
    }
  }

  private startTokenMonitoring() {
    // Reset last checked timestamp to ensure we get new tokens
    this.pumpFun.resetLastCheckedTimestamp();

    // Start the monitoring loop in the background
    setInterval(async () => {
      if (!this.isRunning) {
        console.log('[DEBUG] Monitoring is not running');
        return;
      }

      try {
        console.log('[DEBUG] Starting token check cycle...');
        const newTokens = await this.pumpFun.getNewTokens();
        
        if (newTokens.length === 0) {
          console.log('[DEBUG] No new tokens found in this cycle');
          return;
        }

        console.log(`[DEBUG] Processing ${newTokens.length} new tokens`);
        
        for (const token of newTokens) {
          try {
            console.log(`[DEBUG] Processing token: ${token.address}`);

            // Get all active filters using admin client
            const { data: filters, error } = await this.adminClient
              .from('Filter')
              .select('*, User!inner(*)')
              .eq('is_active', true);

            if (error) {
              console.error('[DEBUG] Error fetching filters:', error);
              continue;
            }

            if (!filters || filters.length === 0) {
              console.log('[DEBUG] No active filters found');
              continue;
            }

            console.log(`[DEBUG] Found ${filters.length} active filters to check`);

            // Check each filter
            for (const filter of filters) {
              try {
                // Only send alerts to users who have monitoring enabled
                if (!this.monitoringEnabled.get(filter.user_id)) {
                  console.log(`[DEBUG] Monitoring disabled for user ${filter.user_id}`);
                  continue;
                }

                const matches = this.matchesFilter(token, filter);
                if (matches) {
                  console.log(`[DEBUG] Token ${token.address} matches filter for user ${filter.user_id}`);
                  await this.telegram.sendTokenAlert(filter.user_id, token);
                  console.log(`[DEBUG] Alert sent to user ${filter.user_id} for token ${token.address}`);
                }
              } catch (error) {
                console.error(`[DEBUG] Error processing filter for user ${filter.user_id}:`, error);
                continue;
              }
            }
          } catch (error) {
            console.error(`[DEBUG] Error processing token ${token.address}:`, error);
            continue;
          }
        }
      } catch (error) {
        console.error('[DEBUG] Error in monitoring cycle:', error);
        // Don't throw the error, just log it and continue
      }
    }, 30000); // Check every 30 seconds
  }

  private matchesFilter(token: TokenData, filter: any): boolean {
    console.log(`\nChecking token ${token.address} against filter for user ${filter.user_id}`);
    console.log('Token data:', {
      liquidity: token.liquidity,
      marketCap: token.marketCap
    });

    // Market cap filters
    if (filter.min_market_cap && token.marketCap < filter.min_market_cap) {
      console.log(`❌ Market cap ${token.marketCap} < min ${filter.min_market_cap}`);
      return false;
    }
    if (filter.max_market_cap && token.marketCap > filter.max_market_cap) {
      console.log(`❌ Market cap ${token.marketCap} > max ${filter.max_market_cap}`);
      return false;
    }

    // Liquidity filters
    if (filter.min_liquidity && token.liquidity < filter.min_liquidity) {
      console.log(`❌ Liquidity ${token.liquidity} < min ${filter.min_liquidity}`);
      return false;
    }
    if (filter.max_liquidity && token.liquidity > filter.max_liquidity) {
      console.log(`❌ Liquidity ${token.liquidity} > max ${filter.max_liquidity}`);
      return false;
    }

    // If we get here, the token matches all specified filters
    console.log(`✅ Token ${token.address} matches all filters for user ${filter.user_id}`);
    return true;
  }

  async stop() {
    this.isRunning = false;
    await this.telegram.stop();
    await this.server.close();
  }

  // Add methods to control monitoring
  enableMonitoring(userId: string) {
    console.log(`[DEBUG] Enabling monitoring for user ${userId}`);
    this.monitoringEnabled.set(userId, true);
    console.log(`[DEBUG] Current monitoring state:`, Array.from(this.monitoringEnabled.entries()));
    // Reset last checked timestamp to ensure we get new tokens
    this.pumpFun.resetLastCheckedTimestamp();
  }

  disableMonitoring(userId: string) {
    console.log(`[DEBUG] Disabling monitoring for user ${userId}`);
    this.monitoringEnabled.set(userId, false);
    console.log(`[DEBUG] Current monitoring state:`, Array.from(this.monitoringEnabled.entries()));
  }

  isMonitoringEnabled(userId: string): boolean {
    const enabled = this.monitoringEnabled.get(userId) || false;
    console.log(`[DEBUG] Checking monitoring status for user ${userId}: ${enabled}`);
    return enabled;
  }

  getWebhookMiddleware() {
    return this.telegram.getWebhookMiddleware();
  }
}

// Start the application
export const heartBot = new HeartBot();

// Export for Vercel
export default async function handler(req: any, res: any) {
  try {
    // Initialize bot if not already running
    if (!heartBot.isRunning) {
      console.log('[DEBUG] Starting bot...');
      await heartBot.start();
    }

    // Handle webhook requests in production
    if (process.env.NODE_ENV === 'production' && req.method === 'POST') {
      console.log('[DEBUG] Received webhook update:', JSON.stringify(req.body));
      try {
        // Use webhook middleware for proper request handling
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
      message: 'Server is running',
      botRunning: heartBot.isRunning 
    });
  } catch (error) {
    console.error('[DEBUG] Error in handler:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
} 