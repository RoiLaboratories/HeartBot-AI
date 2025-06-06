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
  public monitoringIntervalId: NodeJS.Timeout | undefined;
  private isInitialized: boolean = false;

  constructor() {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('Missing required Supabase configuration');
    }
    
    this.pumpFun = new PumpFunService();
    this.server = fastify();
    this.adminClient = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey
    );
    this.isRunning = false;
    this.telegram = new TelegramService(this);
    
    // Initialize monitoring state
    this.monitoringEnabled.clear();
    if (this.monitoringIntervalId) {
      clearInterval(this.monitoringIntervalId);
      this.monitoringIntervalId = undefined;
    }

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

  // public getMonitoringIntervalId(): NodeJS.Timeout | undefined {
  //   return this.monitoringIntervalId;
  // }
 
  getActiveMonitoringCount(): number {
    return Array.from(this.monitoringEnabled.values()).filter(enabled => enabled).length;
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
          
          // Clear any existing state
          this.monitoringEnabled.clear();
          if (this.monitoringIntervalId) {
            clearInterval(this.monitoringIntervalId);
            this.monitoringIntervalId = undefined;
          }
          this.isRunning = false;
          this.isInitialized = true;
          
          // Don't start token monitoring yet - it will start when users request it
          console.log('[DEBUG] Bot ready to monitor tokens when requested with /fetch');
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
        this.isInitialized = false;
        this.initializationPromise = null;
        await this.stop();
        throw error;
      }
    })();

    return this.initializationPromise;
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

  public startMonitoringLoop() {
    if (!this.isInitialized) {
      console.log('[DEBUG] Bot not fully initialized, cannot start monitoring');
      return;
    }
    this.startTokenMonitoring();
  }

  private startTokenMonitoring() {
    console.log('[DEBUG] Starting token monitoring system...');
    
    // Clear any existing interval
    this.cleanup();
    
    // Reset last checked timestamp to ensure we get new tokens
    this.pumpFun.resetLastCheckedTimestamp();

    if (this.monitoringIntervalId) {
      console.log('[DEBUG] Monitoring loop already running, skipping start');
      return;
    }

    // Check if we have any active users before starting
    const activeUsers = Array.from(this.monitoringEnabled.entries())
      .filter(([_, enabled]) => enabled)
      .map(([userId]) => userId);

    if (activeUsers.length === 0) {
      console.log('[DEBUG] No active users to monitor, not starting loop');
      return;
    }

    console.log('[HeartBot] Starting monitoring loop...');
    this.isRunning = true;

    // Start the monitoring loop in the background
    this.monitoringIntervalId = setInterval(async () => {
      console.log('\n[DEBUG] ===== New Monitoring Cycle Started =====');
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
            newTokens = await this.pumpFun.getNewTokens(activeUsers[0]); // Use first active user's ID
            console.log(`[DEBUG] Successfully fetched ${newTokens.length} new tokens`);
            if (newTokens.length > 0) {
              console.log('[DEBUG] First token sample:', {
                address: newTokens[0].address,
                name: newTokens[0].name,
                marketCap: newTokens[0].marketCap,
                liquidity: newTokens[0].liquidity,
                priceUsd: newTokens[0].priceUsd
              });
            }
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
          console.log(`[DEBUG] Found ${filters.length} active filters`);
          
          // Log filter details for debugging
          filters.forEach((filter: any, index: number) => {
            console.log(`[DEBUG] Filter ${index + 1}:`, {
              user_id: filter.user_id,
              min_market_cap: filter.min_market_cap,
              max_market_cap: filter.max_market_cap,
              min_liquidity: filter.min_liquidity,
              max_liquidity: filter.max_liquidity,
              is_active: filter.is_active
            });
          });
        } catch (error) {
          console.error('[DEBUG] Error fetching filters:', error);
          return;
        }

        if (!filters || filters.length === 0) {
          console.log('[DEBUG] No active filters found');
          return;
        }

        // Process each token
        for (const token of newTokens) {
          try {
            console.log(`\n[DEBUG] Processing token: ${token.address}`);
            console.log('[DEBUG] Token details:', {
              name: token.name,
              marketCap: token.marketCap,
              liquidity: token.liquidity,
              priceUsd: token.priceUsd
            });

            // Calculate marketCap if not provided
            if (!token.marketCap && token.priceUsd && token.liquidity) {
              // Estimate marketCap as 2x liquidity for new tokens
              token.marketCap = token.liquidity * 2;
              console.log(`[DEBUG] Calculated marketCap for ${token.address}: ${token.marketCap}`);
            }

            // Validate token data
            if (!token.liquidity) {
              console.log(`[DEBUG] Skipping token ${token.address} - missing liquidity data`);
              continue;
            }

            if (!token.marketCap) {
              console.log(`[DEBUG] Skipping token ${token.address} - missing marketCap data and unable to calculate`);
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

                console.log(`[DEBUG] Checking token ${token.address} against filter for user ${filter.user_id}`);
                console.log('[DEBUG] Token data:', {
                  liquidity: token.liquidity,
                  marketCap: token.marketCap,
                  holdersCount: token.holdersCount,
                  devTokensPercentage: token.devTokensPercentage,
                  contractAge: token.contractAge,
                  tradingEnabled: token.tradingEnabled
                });
                console.log('[DEBUG] Filter criteria:', {
                  min_market_cap: filter.min_market_cap,
                  max_market_cap: filter.max_market_cap,
                  min_liquidity: filter.min_liquidity,
                  max_liquidity: filter.max_liquidity,
                  trading_enabled: filter.trading_enabled
                });

                if (this.telegram.matchesFilter(token, filter)) {
                  console.log(`[DEBUG] Token ${token.address} matches filter for user ${filter.user_id}`);
                  await this.telegram.sendTokenAlert(filter.user_id, token);
                  console.log(`[DEBUG] Alert sent to user ${filter.user_id} for token ${token.address}`);
                } else {
                  console.log(`[DEBUG] Token ${token.address} does not match filter for user ${filter.user_id}`);
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
      console.log('[DEBUG] ===== Monitoring Cycle Completed =====\n');
    }, 60000); // Check every 60 seconds
    
    console.log('[DEBUG] Token monitoring system started successfully');
  }
  
  // Removed private matchesFilter method as it's now handled by TelegramService

  // Add methods to control monitoring
  enableMonitoring(userId: string) {
    // Check if monitoring was already enabled for this user
    if (this.monitoringEnabled.get(userId)) {
      console.log(`[DEBUG] Monitoring was already enabled for user ${userId}`);
      return;
    }

    console.log(`[DEBUG] Enabling monitoring for user ${userId}`);
    this.monitoringEnabled.set(userId, true);
    console.log(`[DEBUG] Current monitoring state:`, Array.from(this.monitoringEnabled.entries()));
    
    // Start monitoring loop if it's not running
    if (!this.monitoringIntervalId) {
      console.log('[DEBUG] Starting monitoring loop...');
      this.startMonitoringLoop();
    } else {
      console.log('[DEBUG] Monitoring loop already running');
    }
  }

  disableMonitoring(userId: string) {
    console.log(`[DEBUG] Disabling monitoring for user ${userId}`);
    this.monitoringEnabled.set(userId, false);
    console.log(`[DEBUG] Current monitoring state:`, Array.from(this.monitoringEnabled.entries()));
    
    // Check if there are any active users left
    const activeUsers = Array.from(this.monitoringEnabled.values()).filter(enabled => enabled);
    if (activeUsers.length === 0 && this.monitoringIntervalId) {
      console.log('[DEBUG] No active users left, stopping monitoring loop');
      clearInterval(this.monitoringIntervalId);
      this.monitoringIntervalId = undefined;
      this.isRunning = false;
      this.pumpFun.resetLastCheckedTimestamp();
    }
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
        // Handle update directly
        await heartBot.telegram.handleUpdate(req.body);
        res.status(200).json({ status: 'ok' });
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