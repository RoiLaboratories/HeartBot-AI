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

      // Start Fastify server
      try {
        console.log('[DEBUG] Starting Fastify server...');
        const port = Number(process.env.PORT) || Number(config.server.port);
        await this.server.listen({ 
          port: port || 3000, 
          host: '0.0.0.0' 
        });
        console.log(`[DEBUG] Server listening on port ${port}`);
      } catch (err) {
        console.error('[DEBUG] Error starting server:', err);
        throw err;
      }

      // Reset last checked timestamp to ensure we get new tokens
      this.pumpFun.resetLastCheckedTimestamp();

      // Start token monitoring
      this.isRunning = true;
      console.log('[DEBUG] Starting token monitoring...');
      
      // Start the monitoring loop in the background
      setInterval(async () => {
        if (this.isRunning) {
          try {
            console.log('[DEBUG] Checking for new tokens...');
            const newTokens = await this.pumpFun.getNewTokens();
            console.log(`[DEBUG] Found ${newTokens.length} new tokens`);
            
            if (newTokens.length > 0) {
              console.log('[DEBUG] New tokens found:', newTokens.map(t => t.address).join(', '));
            }
            
            for (const token of newTokens) {
              try {
                console.log(`[DEBUG] Processing token: ${token.address}`);
                console.log('[DEBUG] Token data:', JSON.stringify(token, null, 2));

                // Get all active filters using admin client
                const { data: filters, error } = await this.adminClient
                  .from('Filter')
                  .select('*, User!inner(*)')
                  .eq('is_active', true);

                if (error) {
                  console.error('[DEBUG] Error fetching filters:', error);
                  continue;
                }

                console.log(`[DEBUG] Found ${filters.length} active filters to check`);

                // Check each filter
                for (const filter of filters) {
                  // Only send alerts to users who have monitoring enabled
                  if (!this.monitoringEnabled.get(filter.user_id)) {
                    console.log(`[DEBUG] Monitoring disabled for user ${filter.user_id}`);
                    continue;
                  }

                  console.log(`[DEBUG] Checking filter for user ${filter.user_id}:`, {
                    min_liquidity: filter.min_liquidity,
                    max_liquidity: filter.max_liquidity,
                    min_market_cap: filter.min_market_cap,
                    max_market_cap: filter.max_market_cap
                  });

                  const matches = this.matchesFilter(token, filter);
                  console.log(`[DEBUG] Filter match result for user ${filter.user_id}: ${matches}`);

                  if (matches) {
                    console.log(`[DEBUG] Token ${token.address} matches filter for user ${filter.user_id}`);
                    try {
                      // Send alert to user
                      await this.telegram.sendTokenAlert(filter.user_id, token);
                      console.log(`[DEBUG] Alert sent to user ${filter.user_id} for token ${token.address}`);
                    } catch (error) {
                      console.error(`[DEBUG] Error sending alert to user ${filter.user_id}:`, error);
                    }
                  } else {
                    console.log(`[DEBUG] Token ${token.address} did not match filter for user ${filter.user_id}`);
                  }
                }
              } catch (error) {
                console.error(`[DEBUG] Error processing token ${token.address}:`, error);
                continue;
              }
            }
          } catch (error) {
            console.error('[DEBUG] Error in monitoring interval:', error);
          }
        } else {
          console.log('[DEBUG] Monitoring is not running');
        }
      }, 30000); // Check every 30 seconds

    } catch (error) {
      console.error('[DEBUG] Error starting HeartBot:', error);
      await this.stop();
      process.exit(1);
    }
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
const heartBot = new HeartBot();
heartBot.start().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await heartBot.stop();
  process.exit(0);
});

// Export for Vercel
export default async function handler(req: any, res: any) {
  if (req.method === 'POST' && req.url === '/webhook') {
    try {
      console.log('[DEBUG] Webhook request received');
      console.log('[DEBUG] Request body:', JSON.stringify(req.body, null, 2));
      
      // Initialize bot if not already running
      if (!heartBot.isRunning) {
        console.log('[DEBUG] Starting bot...');
        // Set webhook URL first
        const webhookUrl = `https://${process.env.VERCEL_URL}/webhook`;
        console.log('[DEBUG] Setting webhook URL:', webhookUrl);
        await heartBot.telegram.setWebhook(webhookUrl);
        await heartBot.start();
      }
      
      console.log('[DEBUG] Getting webhook middleware...');
      const middleware = heartBot.getWebhookMiddleware();
      console.log('[DEBUG] Executing webhook middleware...');
      await middleware(req, res);
      console.log('[DEBUG] Webhook middleware executed successfully');
      res.status(200).send('OK');
    } catch (error) {
      console.error('[DEBUG] Webhook error:', error);
      res.status(200).send('OK'); // Always return 200 to Telegram
    }
  } else {
    res.status(200).json({ status: 'ok', message: 'Server is running' });
  }
} 