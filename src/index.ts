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
  private initializationPromise: Promise<void> | null = null;
  private monitoringIntervalId: NodeJS.Timeout | undefined;

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
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        console.log('[DEBUG] Starting HeartBot...');
        
        // Skip Fastify server in Vercel environment
        if (process.env.VERCEL) {
          console.log('[DEBUG] Running in Vercel environment, skipping Fastify server');
        } else if (process.env.NODE_ENV === 'production' && !this.serverStarted) {
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
        
        // Start Telegram bot
        try {
          await this.telegram.start();
          console.log('[DEBUG] Telegram bot started');
          // Set running state after successful start
          this.isRunning = true;
          
          // Start token monitoring in the background
          console.log('[DEBUG] Starting token monitoring...');
          this.startTokenMonitoring();
          console.log('[DEBUG] Token monitoring started');
        } catch (error: any) {
          if (error.response?.error_code === 429) {
            console.log('[DEBUG] Rate limit hit while starting bot, will retry on next request');
            // Don't throw, just log and continue
          } else {
            throw error;
          }
        }

        console.log('[DEBUG] HeartBot started successfully');
      } catch (error) {
        console.error('[DEBUG] Error starting HeartBot:', error);
        this.isRunning = false;
        this.initializationPromise = null;
        await this.stop();
        throw error;
      }
    })();

    return this.initializationPromise;
  }

  private startTokenMonitoring() {
    console.log('[DEBUG] Starting token monitoring system...');
    
    // Clear any existing interval
    this.cleanup();
    
    // Reset last checked timestamp to ensure we get new tokens
    this.pumpFun.resetLastCheckedTimestamp();

    // Start the monitoring loop in the background
    const intervalId = setInterval(async () => {
      console.log('[DEBUG] Monitoring cycle started');
      console.log('[DEBUG] Bot running status:', this.isRunning);
      
      if (!this.isRunning) {
        console.log('[DEBUG] Monitoring is not running, skipping cycle');
        return;
      }

      // Log active monitoring users
      const activeUsers = Array.from(this.monitoringEnabled.entries())
        .filter(([_, enabled]) => enabled)
        .map(([userId]) => userId);
      console.log('[DEBUG] Active monitoring users:', activeUsers);

      if (activeUsers.length === 0) {
        console.log('[DEBUG] No users have monitoring enabled, skipping cycle');
        return;
      }

      try {
        console.log('[DEBUG] Starting token check cycle...');
        
        // Get new tokens with retry logic
        let newTokens: TokenData[] = [];
        let retryCount = 0;
        const maxRetries = 3;
        const baseDelay = 2000;

        while (retryCount < maxRetries) {
          try {
            console.log('[DEBUG] Attempting to fetch new tokens...');
            newTokens = await this.pumpFun.getNewTokens();
            console.log(`[DEBUG] Successfully fetched ${newTokens.length} new tokens`);
            break; // Success, exit retry loop
          } catch (error: any) {
            retryCount++;
            
            if (error.response?.status === 429) {
              // Rate limit hit, wait for the specified time plus some buffer
              const retryAfter = (error.response.headers['retry-after'] || 1) * 1000;
              console.log(`[DEBUG] Rate limit hit, waiting ${retryAfter}ms before retry ${retryCount}/${maxRetries}`);
              await new Promise(resolve => setTimeout(resolve, retryAfter + 1000)); // Add 1 second buffer
              continue;
            }
            
            if (retryCount === maxRetries) {
              console.error('[DEBUG] Failed to fetch tokens after', maxRetries, 'attempts:', error);
              return; // Skip this cycle
            }
            
            // For other errors, use exponential backoff
            const delay = baseDelay * Math.pow(2, retryCount - 1);
            console.log(`[DEBUG] Error fetching tokens, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        
        if (newTokens.length === 0) {
          console.log('[DEBUG] No new tokens found in this cycle');
          return;
        }

        console.log(`[DEBUG] Processing ${newTokens.length} new tokens`);
        
        // Get all active filters
        let filters;
        try {
          const { data, error } = await this.adminClient
            .from('Filter')
            .select('*, User!inner(*)')
            .eq('is_active', true);

          if (error) {
            console.error('[DEBUG] Error fetching filters:', error);
            return;
          }

          filters = data;
        } catch (error) {
          console.error('[DEBUG] Error fetching filters:', error);
          return;
        }

        if (!filters || filters.length === 0) {
          console.log('[DEBUG] No active filters found');
          return;
        }

        console.log(`[DEBUG] Found ${filters.length} active filters to check`);

        // Process each token
        for (const token of newTokens) {
          try {
            console.log(`[DEBUG] Processing token: ${token.address}`);

            // Validate token data
            if (!token.liquidity || !token.marketCap) {
              console.log(`[DEBUG] Skipping invalid token data for ${token.address}`);
              continue;
            }

            // Check each filter
            for (const filter of filters) {
              try {
                // Only send alerts to users who have monitoring enabled
                if (!this.monitoringEnabled.get(filter.user_id)) {
                  console.log(`[DEBUG] Monitoring disabled for user ${filter.user_id}`);
                  continue;
                }

                // Skip filters that require Dexscreener data
                if (filter.min_holders || filter.max_holders || 
                    filter.max_dev_tokens || filter.min_contract_age) {
                  console.log(`[DEBUG] Skipping filter for ${token.address} - requires Dexscreener data`);
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
    }, 60000); // Check every 60 seconds instead of 30 to avoid rate limits

    // Store interval ID for cleanup
    this.monitoringIntervalId = intervalId;
    console.log('[DEBUG] Token monitoring system started successfully');
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
    try {
      console.log('[DEBUG] Stopping HeartBot...');
      
      // Stop Telegram bot
      if (this.telegram) {
        await this.telegram.stop();
      }
      
      // Stop Fastify server if running
      if (this.serverStarted) {
        await this.server.close();
        this.serverStarted = false;
      }
      
      // Cleanup monitoring
      this.cleanup();
      
      this.isRunning = false;
      this.initializationPromise = null;
      console.log('[DEBUG] HeartBot stopped successfully');
    } catch (error) {
      console.error('[DEBUG] Error stopping HeartBot:', error);
      throw error;
    }
  }

  // Add methods to control monitoring
  enableMonitoring(userId: string) {
    console.log(`[DEBUG] Enabling monitoring for user ${userId}`);
    this.monitoringEnabled.set(userId, true);
    console.log(`[DEBUG] Current monitoring state:`, Array.from(this.monitoringEnabled.entries()));
    
    // Ensure monitoring is running
    if (!this.monitoringIntervalId) {
      console.log('[DEBUG] Monitoring interval not found, restarting monitoring...');
      this.startTokenMonitoring();
    }
    
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

  // Add cleanup method
  private cleanup() {
    if (this.monitoringIntervalId) {
      clearInterval(this.monitoringIntervalId);
      this.monitoringIntervalId = undefined;
    }
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