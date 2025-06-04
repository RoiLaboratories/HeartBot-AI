import { Telegraf, Context, Markup } from 'telegraf';
import { CallbackQuery } from 'telegraf/typings/core/types/typegram';
import dotenv from 'dotenv';
import { config } from '../config';
import { TokenData } from '../types';
import { createClient } from '@supabase/supabase-js';
// import { DexscreenerService } from '../services/dexscreener';
import axios from 'axios';
import { HeartBot } from '../index';
dotenv.config();

interface FilterState {
  minMarketCap?: number;
  maxMarketCap?: number;
  minLiquidity?: number;
  maxLiquidity?: number;
  minHolders?: number;
  maxHolders?: number;
  maxDevTokens?: number;
  minContractAge?: number;
  tradingEnabled?: boolean;
}

interface Filter {
  filter_id: string;
  user_id: string;
  min_market_cap?: number;
  max_market_cap?: number;
  min_liquidity?: number;
  max_liquidity?: number;
  min_holders?: number;
  max_holders?: number;
  max_dev_tokens?: number;
  min_contract_age?: number;
  trading_status?: boolean;
  is_active: boolean;
}

interface CustomContext extends Context {
  match?: RegExpMatchArray;
}

export class TelegramService {
  private static instance: TelegramService | null = null;
  private isPolling: boolean = false;
  private bot: Telegraf<CustomContext> = null!;
  private adminClient: ReturnType<typeof createClient> = null!;
  private filterStates: Map<string, FilterState> = new Map();
  private customInputHandlers: Map<string, (ctx: CustomContext) => Promise<void>> = new Map();
  private heartBot: HeartBot = null!;
  

  private async handleDebugStatus(ctx: Context) {
    const userId = ctx.from?.id.toString();
    if (!userId) return;
    
    const isMonitoring = this.heartBot.isMonitoringEnabled(userId);
    const isRunning = this.heartBot.isRunning;
    const intervalExists = !!this.heartBot.monitoringIntervalId; // Direct property access
    
    await ctx.reply(`🔍 Debug Status:
🤖 Bot running: ${isRunning}
⏰ Interval exists: ${intervalExists} 
👤 Your monitoring: ${isMonitoring}
📊 Total monitoring users: ${this.heartBot.getActiveMonitoringCount()}`);
}

  constructor(heartBot: HeartBot) {
    if (TelegramService.instance) {
      return TelegramService.instance;
    }

    if (!config.telegram.token) {
      throw new Error('Missing required Telegram bot token');
    }
    console.log('[DEBUG] Initializing Telegram bot with token:', config.telegram.token ? 'Token exists' : 'No token found');
    
    // Ensure token is properly formatted
    const token = config.telegram.token.trim();
    if (!token.match(/^\d+:[A-Za-z0-9_-]+$/)) {
      throw new Error('Invalid bot token format');
    }
    
    // Initialize properties
    this.bot = new Telegraf<CustomContext>(token);
    this.heartBot = heartBot;
    
    // Create a service role client for admin operations
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('Missing required Supabase configuration');
    }
    this.adminClient = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey
    );
    
    // Setup all handlers
    this.setupAllHandlers();

    // Store instance
    TelegramService.instance = this;

    // Verify token immediately
    this.verifyToken();
  }

  private async verifyToken() {
    try {
      const botInfo = await this.bot.telegram.getMe();
      console.log('[DEBUG] Bot token verified successfully:', botInfo);
    } catch (error) {
      console.error('[DEBUG] Failed to verify bot token:', error);
      throw new Error('Invalid bot token or network error');
    }
  }

  private setupAllHandlers() {
    // Basic commands
    this.bot.command('start', this.handleStart.bind(this));
    this.bot.command('help', this.handleHelp.bind(this));
    this.bot.command('ping', async (ctx) => {
      await ctx.reply('Pong! Bot is working.');
    });

    // Filter commands
    this.bot.command('setfilter', this.handleSetFilter.bind(this));
    this.bot.command('myfilters', this.handleMyFilters.bind(this));
    this.bot.command('deletefilter', this.handleDeleteFilter.bind(this));
    
    // Monitoring commands
    // this.bot.command('fetch', this.handleFetch.bind(this));
    this.bot.command('stop', this.handleStop.bind(this));
    this.bot.command('fetch', this.handleFetch.bind(this));
    this.bot.command('debug', this.handleDebugStatus.bind(this)); // ADD THIS LINE


    // Setup callbacks
    this.setupCallbacks();
    
    // Setup custom input handling
    this.setupCustomInputMiddleware();
    
    // Global error handler
    this.bot.catch((err, ctx) => {
      console.error('[DEBUG] Bot error:', err);
      ctx.reply('❌ An error occurred. Please try again later.').catch(console.error);
    });
  }

  private setupCallbacks() {
    // Market cap callbacks
    this.bot.action('filter_market_cap', async (ctx) => await this.handleMarketCapStep(ctx));
    this.bot.action(/^set_min_market_cap:(\d+)$/, async (ctx) => await this.handleMinMarketCap(ctx));
    this.bot.action(/^set_max_market_cap:(\d+)$/, async (ctx) => await this.handleMaxMarketCap(ctx));
    this.bot.action('skip_market_cap', async (ctx) => await this.handleLiquidityStep(ctx));
    this.bot.action('custom_market_cap', this.handleMinMarketCap.bind(this));
    this.bot.action('custom_max_market_cap', this.handleMaxMarketCap.bind(this));


    // Liquidity callbacks
    this.bot.action('filter_liquidity', async (ctx) => await this.handleLiquidityStep(ctx));
    this.bot.action(/^set_min_liquidity:(\d+)$/, async (ctx) => await this.handleMinLiquidity(ctx));
    this.bot.action(/^set_max_liquidity:(\d+)$/, async (ctx) => await this.handleMaxLiquidity(ctx));
    this.bot.action('skip_liquidity', async (ctx) => await this.handleHoldersStep(ctx));
    this.bot.action('custom_liquidity', this.handleMinLiquidity.bind(this));
    this.bot.action('custom_max_liquidity', this.handleMaxLiquidity.bind(this));
    // Holders callbacks
    this.bot.action('filter_holders', async (ctx) => await this.handleHoldersStep(ctx));
    this.bot.action(/^set_min_holders:(\d+)$/, async (ctx) => await this.handleMinHolders(ctx));
    this.bot.action(/^set_max_holders:(\d+)$/, async (ctx) => await this.handleMaxHolders(ctx));
    this.bot.action('skip_holders', async (ctx) => await this.handleDevTokensStep(ctx));
    this.bot.action('custom_holders', this.handleMinHolders.bind(this));
    this.bot.action('custom_max_holders', this.handleMaxHolders.bind(this));

    // Dev tokens callbacks
    this.bot.action('filter_dev_tokens', async (ctx) => await this.handleDevTokensStep(ctx));
    this.bot.action(/^set_max_dev_tokens:(\d+)$/, async (ctx) => await this.handleMaxDevTokens(ctx));
    this.bot.action('skip_dev_tokens', async (ctx) => await this.handleContractAgeStep(ctx));
    this.bot.action('custom_dev_tokens', this.handleMaxDevTokens.bind(this));

    // Contract age callbacks
    this.bot.action('filter_contract_age', async (ctx) => await this.handleContractAgeStep(ctx));
    this.bot.action(/^set_min_age:(\d+)$/, async (ctx) => await this.handleMinContractAge(ctx));
    this.bot.action('skip_contract_age', async (ctx) => await this.handleTradingStatusStep(ctx));
    // this.bot.action('custom_contract_age', this.handleMinContractAge.bind(this));

    // Trading status callbacks
    this.bot.action('filter_trading_status', async (ctx) => await this.handleTradingStatusStep(ctx));
    this.bot.action(/^set_trading_status:(.+)$/, async (ctx) => await this.handleTradingStatus(ctx));
    this.bot.action('skip_trading_status', async (ctx) => await this.handleFilterReview(ctx));

    // Filter review callbacks
    this.bot.action('save_filter', async (ctx) => await this.handleFilterSave(ctx));
    this.bot.action('start_filter', async (ctx) => await this.handleSetFilter(ctx));
  }
  private setupCustomInputMiddleware() {
    this.bot.on('text', async (ctx) => {
      const telegramId = ctx.from?.id.toString();
      if (!telegramId) return;

      const handler = this.customInputHandlers.get(telegramId);
      if (handler) {
        await handler(ctx);
        this.customInputHandlers.delete(telegramId);
      }
    });
  }

  private async setupMenu() {
    try {
      // Set commands
      const commands = [
        { command: 'start', description: 'Start the bot' },
        { command: 'setfilter', description: 'Set your token alert filters' },
        { command: 'myfilters', description: 'View your current filters' },
        { command: 'deletefilter', description: 'Delete a filter' },
        { command: 'fetch', description: 'Start fetching new tokens' },
        { command: 'stop', description: 'Stop monitoring for new tokens' },
        { command: 'help', description: 'Show help message' }
      ];

      // Set commands for the bot
      await this.bot.telegram.setMyCommands(commands);

      // Set bot description
      await this.bot.telegram.setMyDescription(
        '🤖 HeartBot AI - Your Solana Token Launch Monitor\n\n' +
        'Get instant alerts for new token launches on Pump.fun that match your criteria. ' +
        'Set custom filters for market cap, liquidity, holders, and more. ' +
        'Never miss a promising token launch again!'
      );

      // Set bot short description
      await this.bot.telegram.setMyShortDescription(
        'Get instant alerts for new Solana token launches on Pump.fun'
      );

      console.log('Menu setup completed successfully');
    } catch (error) {
      console.error('Error setting up menu:', error);
      throw error;
    }
  }

  private async handleStart(ctx: CustomContext) {
    console.log('[DEBUG] Start command received');
    const telegramId = ctx.from?.id.toString();
    if (!telegramId || !ctx.from) {
      console.log('[DEBUG] No telegram ID or from data found');
      return;
    }

    try {
      console.log('[DEBUG] Checking if user exists:', telegramId);
      // Check if user exists
      const { data: existingUser, error: fetchError } = await this.adminClient
        .from('User')
        .select('telegram_id')
        .eq('telegram_id', telegramId)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 is "not found" error
        console.error('[DEBUG] Error fetching user:', fetchError);
        throw fetchError;
      }

      if (!existingUser) {
        console.log('[DEBUG] Creating new user:', telegramId);
        // Insert new user
        const { error: insertError } = await this.adminClient
          .from('User')
          .insert({
            telegram_id: telegramId,
            username: ctx.from.username || null
          });

        if (insertError) {
          console.error('[DEBUG] Error inserting user:', insertError);
          throw insertError;
        }
      } else {
        console.log('[DEBUG] Updating existing user:', telegramId);
        // Update existing user's username if it changed
        const { error: updateError } = await this.adminClient
          .from('User')
          .update({ username: ctx.from.username || null })
          .eq('telegram_id', telegramId);

        if (updateError) {
          console.error('[DEBUG] Error updating user:', updateError);
          throw updateError;
        }
      }

      console.log('[DEBUG] Sending welcome message to user:', telegramId);
      await ctx.reply(
        "🌟 <b>Welcome to HeartBot AI!</b> 🌟\n\n" +
        "I'm your personal Solana token launch monitor on Pump.fun.\n\n" +
        "🎯 <b>What I Can Do:</b>\n" +
        "• Monitor new token launches on Pump.fun in real-time\n" +
        "• Alert you when tokens match your custom criteria\n" +
        "• Track market cap, liquidity, holders, and more\n" +
        "• Provide instant links to view tokens on Pump.fun and Dexscreener\n\n" +
        "⚙️ <b>How to Use:</b>\n" +
        "1. Set up your filters using /setfilter\n" +
        "2. View your active filters with /myfilters\n" +
        "3. Get instant alerts when matching tokens launch\n" +
        "4. Manage your filters anytime\n\n" +
        "📊 <b>Available Commands:</b>\n" +
        "• /setfilter - Configure your alert filters\n" +
        "• /myfilters - View your current filters\n" +
        "• /deletefilter - Delete a filter\n" +
        "• /fetch - Start fetching new tokens\n" +
        "• /stop - Stop monitoring for new tokens\n" +
        "• /help - Show all commands\n\n" +
        "🚀 <i>Get started by setting up your first filter!</i>",
        { parse_mode: 'HTML' }
      );
      console.log('[DEBUG] Welcome message sent successfully');
    } catch (error) {
      console.error('[DEBUG] Error in handleStart:', error);
      await ctx.reply('❌ Error starting the bot. Please try again later.');
    }
  }

  private async handleSetFilter(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    // Initialize new filter state
    this.filterStates.set(telegramId, {});

    await ctx.reply(
      '🎯 <b>Let\'s Set Up Your Token Filter</b>\n\n' +
      'I\'ll guide you through setting up your filter step by step.\n\n' +
      'First, let\'s set up the market cap range:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('Set Market Cap', 'filter_market_cap'),
            Markup.button.callback('Skip', 'skip_market_cap')
          ]
        ])
      }
    );
  }

 private async safeEditOrReply(ctx: CustomContext, text: string, options: any) {
        try {
            return await ctx.editMessageText(text, options);
        } catch (error: any) {
            if (error.description?.includes("message can't be edited")) {
                return await ctx.reply(text, options);
            }
            throw error;
        }
    }

  private async handleMarketCapStep(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    try {
         await this.safeEditOrReply(ctx,
            '💰 <b>Set Market Cap Range</b>\n\n' +
            'Choose minimum market cap:',
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback('$10K', 'set_min_market_cap:10000'),
                        Markup.button.callback('$50K', 'set_min_market_cap:50000'),
                        Markup.button.callback('$100K', 'set_min_market_cap:100000')
                    ],
                    [
                        Markup.button.callback('$500K', 'set_min_market_cap:500000'),
                        Markup.button.callback('$1M', 'set_min_market_cap:1000000')
                    ],
                    [
                        Markup.button.callback('Skip', 'skip_market_cap'),
                        Markup.button.callback('Custom', 'custom_market_cap'),
                        Markup.button.callback('Back', 'start_filter')
                    ]
                ])
            }
        );
    } catch (error: any) {
        if (error.description?.includes("message can't be edited")) {
            // Send new message instead of editing
            await ctx.reply(
                '💰 <b>Set Market Cap Range</b>\n\n' +
                'Choose minimum market cap:',
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback('$10K', 'set_min_market_cap:10000'),
                            Markup.button.callback('$50K', 'set_min_market_cap:50000'),
                            Markup.button.callback('$100K', 'set_min_market_cap:100000')
                        ],
                        [
                            Markup.button.callback('$500K', 'set_min_market_cap:500000'),
                            Markup.button.callback('$1M', 'set_min_market_cap:1000000')
                        ],
                        [
                            Markup.button.callback('Skip', 'skip_market_cap'),
                            Markup.button.callback('Custom', 'custom_market_cap'),
                            Markup.button.callback('Back', 'start_filter')
                        ]
                    ])
                }
            );
        } else {
            throw error; // Re-throw other errors
        }
    }
}

  private async handleMinMarketCap(ctx: CustomContext) {
      const cb = ctx.callbackQuery as CallbackQuery.DataQuery;

    if (!cb || typeof cb.data !== 'string') {
    return ctx.reply('❌ Invalid callback query.');
  }

  const callbackData = cb.data;
  
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (callbackData === 'custom_market_cap') {
      await ctx.answerCbQuery(); 
      await ctx.editMessageText(
        '💰 <b>Enter Minimum Market Cap</b>\n\n' +
        'Please enter the minimum market cap in USD:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Back', 'filter_market_cap')]
          ])
        }
      );

      this.customInputHandlers.set(telegramId, async (msgCtx) => {
        if (!msgCtx.message || !('text' in msgCtx.message)) return;
        const value = parseInt(msgCtx.message.text);
        if (!isNaN(value) && value > 0) {
          const state = this.filterStates.get(telegramId);
          if (state) {
            state.minMarketCap = value;
            this.filterStates.set(telegramId, state);
            await this.handleMaxMarketCapStep(msgCtx);
          }
        } else {
          await msgCtx.reply('❌ Please enter a valid number greater than 0.');
        }
      });
      return;
    }

    const state = this.filterStates.get(telegramId);
    if (state) {
      state.minMarketCap = parseInt(value);
      this.filterStates.set(telegramId, state);
      await this.handleMaxMarketCapStep(ctx);
    }
  }

  private async handleMaxMarketCapStep(ctx: CustomContext) {
    
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

     await this.safeEditOrReply(ctx,
      '💰 <b>Set Maximum Market Cap</b>\n\n' +
      'Choose maximum market cap:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('$100K', 'set_max_market_cap:100000'),
            Markup.button.callback('$500K', 'set_max_market_cap:500000'),
            Markup.button.callback('$1M', 'set_max_market_cap:1000000')
          ],
          [
            Markup.button.callback('$5M', 'set_max_market_cap:5000000'),
            Markup.button.callback('$10M', 'set_max_market_cap:10000000')
          ],
          [
            Markup.button.callback('Skip', 'skip_market_cap'),
            Markup.button.callback('Custom', 'custom_max_market_cap'), 
            Markup.button.callback('Back', 'filter_market_cap')
          ]
        ])
      }
    );
  }

  private async handleMaxMarketCap(ctx: CustomContext) {
    const cb = ctx.callbackQuery as CallbackQuery.DataQuery;

    if (!cb || typeof cb.data !== 'string') {
    return ctx.reply('❌ Invalid callback query.');
  }

  const callbackData = cb.data;

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (callbackData === 'custom_max_market_cap') {
     await this.safeEditOrReply(ctx,
        '💰 <b>Enter Maximum Market Cap</b>\n\n' +
        'Please enter the maximum market cap in USD:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Back', 'filter_market_cap')]
          ])
        }
      );

      this.customInputHandlers.set(telegramId, async (msgCtx) => {
        if (!msgCtx.message || !('text' in msgCtx.message)) return;
        const value = parseInt(msgCtx.message.text);
        if (!isNaN(value) && value > 0) {
          const state = this.filterStates.get(telegramId);
          if (state) {
            state.maxMarketCap = value;
            this.filterStates.set(telegramId, state);
            await this.handleLiquidityStep(msgCtx);
          }
        } else {
          await msgCtx.reply('❌ Please enter a valid number greater than 0.');
        }
      });
      return;
    }

    const state = this.filterStates.get(telegramId);
    if (state) {
      state.maxMarketCap = parseInt(value);
      this.filterStates.set(telegramId, state);
      await this.handleLiquidityStep(ctx);
    }
  }

  private async handleLiquidityStep(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

     await this.safeEditOrReply(ctx,
      '💧 <b>Set Liquidity Range</b>\n\n' +
      'Choose minimum liquidity:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('$5K', 'set_min_liquidity:5000'),
            Markup.button.callback('$10K', 'set_min_liquidity:10000'),
            Markup.button.callback('$50K', 'set_min_liquidity:50000')
          ],
          [
            Markup.button.callback('$100K', 'set_min_liquidity:100000'),
            Markup.button.callback('$500K', 'set_min_liquidity:500000')
          ],
          [
            Markup.button.callback('Skip', 'skip_liquidity'),
            Markup.button.callback('Custom', 'custom_liquidity'),
            Markup.button.callback('Back', 'filter_market_cap')
          ]
        ])
      }
    );
  }

  private async handleMinLiquidity(ctx: CustomContext) {
    const cb = ctx.callbackQuery as CallbackQuery.DataQuery;

    if (!cb || typeof cb.data !== 'string') {
    return ctx.reply('❌ Invalid callback query.');
  }

  const callbackData = cb.data;

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (callbackData === 'custom_liquidity') {
      await this.safeEditOrReply(ctx,
        '💧 <b>Enter Minimum Liquidity</b>\n\n' +
        'Please enter the minimum liquidity in USD:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Back', 'filter_liquidity')]
          ])
        }
      );

      this.customInputHandlers.set(telegramId, async (msgCtx) => {
        if (!msgCtx.message || !('text' in msgCtx.message)) return;
        const value = parseInt(msgCtx.message.text);
        if (!isNaN(value) && value > 0) {
          const state = this.filterStates.get(telegramId);
          if (state) {
            state.minLiquidity = value;
            this.filterStates.set(telegramId, state);
            await this.handleMaxLiquidityStep(msgCtx);
          }
        } else {
          await msgCtx.reply('❌ Please enter a valid number greater than 0.');
        }
      });
      return;
    }

    const state = this.filterStates.get(telegramId);
    if (state) {
      state.minLiquidity = parseInt(value);
      this.filterStates.set(telegramId, state);
      await this.handleMaxLiquidityStep(ctx);
    }
  }

  private async handleMaxLiquidityStep(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    await this.safeEditOrReply(ctx,
      '💧 <b>Set Maximum Liquidity</b>\n\n' +
      'Choose maximum liquidity:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('$100K', 'set_max_liquidity:100000'),
            Markup.button.callback('$500K', 'set_max_liquidity:500000'),
            Markup.button.callback('$1M', 'set_max_liquidity:1000000')
          ],
          [
            Markup.button.callback('$5M', 'set_max_liquidity:5000000'),
            Markup.button.callback('$10M', 'set_max_liquidity:10000000')
          ],
          [
            Markup.button.callback('Skip', 'skip_liquidity'),
            Markup.button.callback('Custom', 'custom_max_liquidity'),
            Markup.button.callback('Back', 'filter_liquidity')
          ]
        ])
      }
    );
  }

  private async handleMaxLiquidity(ctx: CustomContext) {
    const cb = ctx.callbackQuery as CallbackQuery.DataQuery;

    if (!cb || typeof cb.data !== 'string') {
    return ctx.reply('❌ Invalid callback query.');
  }

  const callbackData = cb.data;

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (callbackData === 'custom_max_liquidity') {
      await this.safeEditOrReply(ctx,
        '💧 <b>Enter Maximum Liquidity</b>\n\n' +
        'Please enter the maximum liquidity in USD:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Back', 'filter_liquidity')]
          ])
        }
      );

      this.customInputHandlers.set(telegramId, async (msgCtx) => {
        if (!msgCtx.message || !('text' in msgCtx.message)) return;
        const value = parseInt(msgCtx.message.text);
        if (!isNaN(value) && value > 0) {
          const state = this.filterStates.get(telegramId);
          if (state) {
            state.maxLiquidity = value;
            this.filterStates.set(telegramId, state);
            await this.handleHoldersStep(msgCtx);
          }
        } else {
          await msgCtx.reply('❌ Please enter a valid number greater than 0.');
        }
      });
      return;
    }

    const state = this.filterStates.get(telegramId);
    if (state) {
      state.maxLiquidity = parseInt(value);
      this.filterStates.set(telegramId, state);
      await this.handleHoldersStep(ctx);
    }
  }

  private async handleHoldersStep(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    await this.safeEditOrReply(ctx,
      '👥 <b>Set Holders Range</b>\n\n' +
      'Choose minimum number of holders:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('10', 'set_min_holders:10'),
            Markup.button.callback('50', 'set_min_holders:50'),
            Markup.button.callback('100', 'set_min_holders:100')
          ],
          [
            Markup.button.callback('500', 'set_min_holders:500'),
            Markup.button.callback('1000', 'set_min_holders:1000')
          ],
          [
            Markup.button.callback('Skip', 'skip_holders'),
            Markup.button.callback('Custom', 'custom_holders'),
            Markup.button.callback('Back', 'filter_liquidity')
          ]
        ])
      }
    );
  }

  private async handleMinHolders(ctx: CustomContext) {
    const cb = ctx.callbackQuery as CallbackQuery.DataQuery;

    if (!cb || typeof cb.data !== 'string') {
    return ctx.reply('❌ Invalid callback query.');
  }

  const callbackData = cb.data;

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (callbackData === 'custom_holders') {
       await this.safeEditOrReply(ctx,
        '👥 <b>Enter Minimum Holders</b>\n\n' +
        'Please enter the minimum number of holders:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Back', 'filter_holders')]
          ])
        }
      );

      this.customInputHandlers.set(telegramId, async (msgCtx) => {
        if (!msgCtx.message || !('text' in msgCtx.message)) return;
        const value = parseInt(msgCtx.message.text);
        if (!isNaN(value) && value > 0) {
          const state = this.filterStates.get(telegramId);
          if (state) {
            state.minHolders = value;
            this.filterStates.set(telegramId, state);
            await this.handleMaxHoldersStep(msgCtx);
          }
        } else {
          await msgCtx.reply('❌ Please enter a valid number greater than 0.');
        }
      });
      return;
    }

    const state = this.filterStates.get(telegramId);
    if (state) {
      state.minHolders = parseInt(value);
      this.filterStates.set(telegramId, state);
      await this.handleMaxHoldersStep(ctx);
    }
  }

  private async handleMaxHoldersStep(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const state = this.filterStates.get(telegramId);
    const minHolders = state?.minHolders || 0;

    await this.safeEditOrReply(ctx,
      '👥 <b>Set Maximum Holders</b>\n\n' +
      `Minimum: ${minHolders}\n` +
      'Choose the maximum number of holders:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('100', 'set_max_holders:100'),
            Markup.button.callback('500', 'set_max_holders:500'),
            Markup.button.callback('1000', 'set_max_holders:1000')
          ],
          [
            Markup.button.callback('5000', 'set_max_holders:5000'),
            Markup.button.callback('10000', 'set_max_holders:10000')
          ],
          [
            Markup.button.callback('Skip', 'skip_holders'),
            Markup.button.callback('Custom', 'custom_max_holders'),
            Markup.button.callback('Back', 'filter_holders')
          ]
        ])
      }
    );
  }

  private async handleMaxHolders(ctx: CustomContext) {
     const cb = ctx.callbackQuery as CallbackQuery.DataQuery;

    if (!cb || typeof cb.data !== 'string') {
    return ctx.reply('❌ Invalid callback query.');
  }

  const callbackData = cb.data;

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (callbackData === 'custom_max_holders') {
      await this.safeEditOrReply(ctx,
        '👥 <b>Enter Maximum Holders</b>\n\n' +
        'Please enter the maximum number of holders:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Back', 'filter_holders')]
          ])
        }
      );

      this.customInputHandlers.set(telegramId, async (msgCtx) => {
        if (!msgCtx.message || !('text' in msgCtx.message)) return;
        const value = parseInt(msgCtx.message.text);
        if (!isNaN(value) && value > 0) {
          const state = this.filterStates.get(telegramId);
          if (state) {
            state.maxHolders = value;
            this.filterStates.set(telegramId, state);
            await this.handleDevTokensStep(msgCtx);
          }
        } else {
          await msgCtx.reply('❌ Please enter a valid number greater than 0.');
        }
      });
      return;
    }

    const state = this.filterStates.get(telegramId);
    if (state) {
      state.maxHolders = parseInt(value);
      this.filterStates.set(telegramId, state);
      await this.handleDevTokensStep(ctx);
    }
  }

  private async handleDevTokensStep(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

     await this.safeEditOrReply(ctx,
      '🔒 <b>Set Maximum Dev Tokens</b>\n\n' +
      'Choose maximum percentage of tokens held by developers:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('5%', 'set_max_dev_tokens:5'),
            Markup.button.callback('10%', 'set_max_dev_tokens:10'),
            Markup.button.callback('20%', 'set_max_dev_tokens:20')
          ],
          [
            Markup.button.callback('30%', 'set_max_dev_tokens:30'),
            Markup.button.callback('50%', 'set_max_dev_tokens:50')
          ],
          [
            Markup.button.callback('Skip', 'skip_dev_tokens'),
            Markup.button.callback('Custom', 'custom_dev_tokens'),
            Markup.button.callback('Back', 'filter_holders')
          ]
        ])
      }
    );
  }

  private async handleMaxDevTokens(ctx: CustomContext) {
    const cb = ctx.callbackQuery as CallbackQuery.DataQuery;

    if (!cb || typeof cb.data !== 'string') {
    return ctx.reply('❌ Invalid callback query.');
  }

  const callbackData = cb.data;

    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (callbackData === 'custom_dev_tokens') {
       await this.safeEditOrReply(ctx,
        '🔒 <b>Enter Maximum Dev Tokens</b>\n\n' +
        'Please enter the maximum percentage of tokens held by developers:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Back', 'filter_dev_tokens')]
          ])
        }
      );

      this.customInputHandlers.set(telegramId, async (msgCtx) => {
        if (!msgCtx.message || !('text' in msgCtx.message)) return;
        const value = parseFloat(msgCtx.message.text);
        if (!isNaN(value) && value > 0 && value <= 100) {
          const state = this.filterStates.get(telegramId);
          if (state) {
            state.maxDevTokens = value;
            this.filterStates.set(telegramId, state);
            await this.handleContractAgeStep(msgCtx);
          }
        } else {
          await msgCtx.reply('❌ Please enter a valid percentage between 0 and 100.');
        }
      });
      return;
    }

    const state = this.filterStates.get(telegramId);
    if (state) {
      state.maxDevTokens = parseFloat(value);
      this.filterStates.set(telegramId, state);
      await this.handleContractAgeStep(ctx);
    }
  }

  private async handleContractAgeStep(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

     await this.safeEditOrReply(ctx,
      '⏰ <b>Set Minimum Contract Age</b>\n\n' +
      'Choose minimum age of the contract in hours:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('1h', 'set_min_age:1'),
            Markup.button.callback('6h', 'set_min_age:6'),
            Markup.button.callback('12h', 'set_min_age:12')
          ],
          [
            Markup.button.callback('24h', 'set_min_age:24'),
            Markup.button.callback('48h', 'set_min_age:48')
          ],
          [
            Markup.button.callback('Skip', 'skip_contract_age'),
            //Markup.button.callback('Custom', 'custom_contract_age'),
            Markup.button.callback('Back', 'filter_dev_tokens')
          ]
        ])
      }
    );
  }

  private async handleMinContractAge(ctx: CustomContext) {
    {/*
    const cb = ctx.callbackQuery as CallbackQuery.DataQuery;

    if (!cb || typeof cb.data !== 'string') {
    return ctx.reply('❌ Invalid callback query.');
  }

  const callbackData = cb.data;
    */}
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    const state = this.filterStates.get(telegramId);
    if (state) {
      state.minContractAge = parseInt(value);
      this.filterStates.set(telegramId, state);
      await this.handleTradingStatusStep(ctx);
    }
  }

  private async handleTradingStatusStep(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

     await this.safeEditOrReply(ctx,
      '🔄 <b>Set Trading Status</b>\n\n' +
      'Choose trading status:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('Trading', 'set_trading_status:true'),
            Markup.button.callback('Not Trading', 'set_trading_status:false')
          ],
          [Markup.button.callback('Back', 'filter_contract_age')]
        ])
      }
    );
  }

  private async handleTradingStatus(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    const state = this.filterStates.get(telegramId);
    if (state) {
      state.tradingEnabled = value === 'true';
      this.filterStates.set(telegramId, state);
      await this.handleFilterReview(ctx);
    }
  }

  private async handleFilterReview(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const state = this.filterStates.get(telegramId);
    if (!state) return;

    let message = '📋 <b>Filter Review</b>\n\n';
    
    if (state.minMarketCap || state.maxMarketCap) {
      message += `💰 Market Cap: ${state.minMarketCap || 0} - ${state.maxMarketCap || '∞'} USD\n`;
    }
    
    if (state.minLiquidity || state.maxLiquidity) {
      message += `💧 Liquidity: ${state.minLiquidity || 0} - ${state.maxLiquidity || '∞'} USD\n`;
    }
    
    if (state.minHolders || state.maxHolders) {
      message += `👥 Holders: ${state.minHolders || 0} - ${state.maxHolders || '∞'}\n`;
    }
    
    if (state.maxDevTokens) {
      message += `🔒 Max Dev Tokens: ${state.maxDevTokens}%\n`;
    }
    
    if (state.minContractAge) {
      message += `⏰ Min Contract Age: ${state.minContractAge} hours\n`;
    }
    
    if (state.tradingEnabled !== undefined) {
      message += `🔄 Trading Status: ${state.tradingEnabled ? 'Trading' : 'Not Trading'}\n`;
    }

    message += '\nWould you like to save this filter?';

    await this.safeEditOrReply(ctx, message, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('Save Filter', 'save_filter'),
          Markup.button.callback('Start Over', 'start_filter')
        ]
      ])
    });
  }

  private async handleFilterSave(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const state = this.filterStates.get(telegramId);
    if (!state) return;

    try {
      const { data: user } = await this.adminClient
        .from('User')
        .select('telegram_id')
        .eq('telegram_id', telegramId)
        .single();

      if (!user) {
        await ctx.reply('❌ Error: User not found. Please start the bot with /start first.');
        return;
      }

      console.log('[DEBUG] Saving filter with state:', state);

      const { error } = await this.adminClient
        .from('Filter')
        .insert({
          user_id: telegramId,
          min_market_cap: state.minMarketCap,
          max_market_cap: state.maxMarketCap,
          min_liquidity: state.minLiquidity,
          max_liquidity: state.maxLiquidity,
          min_holders: state.minHolders,
          max_holders: state.maxHolders,
          max_dev_tokens: state.maxDevTokens,
          min_contract_age: state.minContractAge,
          trading_enabled: state.tradingEnabled,
          is_active: true
        });

      if (error) {
        console.error('[DEBUG] Error saving filter:', error);
        throw error;
      }

      this.filterStates.delete(telegramId);
      await this.safeEditOrReply(ctx, '✅ Filter saved successfully! You will receive alerts for tokens matching your criteria.', { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[DEBUG] Error saving filter:', error);
      await this.safeEditOrReply(ctx, '❌ Error saving filter. Please try again later.', { parse_mode: 'HTML' });
    }
  }  private async handleFilterCancel(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    // Clear the filter state
    this.filterStates.delete(telegramId);

    await this.safeEditOrReply(ctx, '❌ Filter creation cancelled.',  { parse_mode: 'HTML' });
  }

  
  async sendTokenAlert(userId: string, token: TokenData) {
    const message = this.formatTokenAlert(token);
    await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' });

    // Log the alert in Supabase using admin client
    const { error } = await this.adminClient
      .from('TokenAlert')
      .insert({
        user_id: userId,
        token_address: token.address,
        token_name: token.name,
        token_symbol: token.symbol,
        market_cap: token.marketCap,
        liquidity: token.liquidity,
        fdv: token.fdv,
        holders_count: token.holdersCount,
        trading_enabled: token.tradingEnabled,
        contract_age: token.contractAge,
        dev_tokens_percentage: token.devTokensPercentage
      });

    if (error) {
      console.error('Error logging token alert:', error);

      // console.log(`[DEBUG] Sending alert to ${userId} for token ${token.name}`);

    }
  }

  private formatTokenAlert(token: TokenData): string {
    const priceUsd = token.priceUsd ? `$${parseFloat(token.priceUsd).toFixed(8)}` : 'N/A';
    const liquidity = token.liquidity ? `$${token.liquidity.toLocaleString()}` : 'N/A';
    const marketCap = token.marketCap ? `$${token.marketCap.toLocaleString()}` : 'N/A';
    const fdv = token.fdv ? `$${token.fdv.toLocaleString()}` : 'N/A';
    const contractAge = token.contractAge ? `${Math.floor(token.contractAge / 60)} hours` : 'N/A';

    return `
🚨 <b>New Token Alert!</b>

<b>Token Info:</b>
📝 Name: ${token.name} (${token.symbol})
🔗 Address: <code>${token.address}</code>

<b>Market Data:</b>
💰 Price: ${priceUsd}
💎 Market Cap: ${marketCap}
💧 Liquidity: ${liquidity}
📊 FDV: ${fdv}
⏱️ Contract Age: ${contractAge}
🔄 Trading: ${token.tradingEnabled ? 'Enabled' : 'Disabled'}
🔒 Dev Tokens: ${token.devTokensPercentage ? `${token.devTokensPercentage}%` : 'N/A'}

<b>Quick Links:</b>
<a href="https://pump.fun/token/${token.address}">View on Pump.fun</a>
<a href="https://dexscreener.com/solana/${token.address}">View on Dexscreener</a>
    `.trim();
  }

  public async start() {
    if (this.isPolling) {
      console.log('[DEBUG] Bot is already polling');
      return;
    }

    console.log('[DEBUG] Starting Telegram bot...');
    try {
      // Verify bot token is valid
      const botInfo = await this.bot.telegram.getMe();
      console.log('[DEBUG] Bot token verified, bot info:', botInfo);
      
      // Setup menu
      await this.setupMenu();
      console.log('[DEBUG] Menu setup completed');

      if (process.env.NODE_ENV === 'production') {
        // In production, use webhooks
        console.log('[DEBUG] Setting up webhook mode');
        
        // Use permanent domain for webhook
        const webhookDomain = process.env.WEBHOOK_DOMAIN || 'heart-bot-ai.vercel.app';
        const webhookUrl = `https://${webhookDomain}/api/webhook`;
        console.log('[DEBUG] Setting up webhook with URL:', webhookUrl);
        
        // Add retry logic for webhook setup
        let retryCount = 0;
        const maxRetries = 3;
        const baseDelay = 2000;

        while (retryCount < maxRetries) {
          try {
            // Delete any existing webhook first
            await this.bot.telegram.deleteWebhook();
            console.log('[DEBUG] Deleted existing webhook');
            
            // Set new webhook
            const webhookResult = await this.bot.telegram.setWebhook(webhookUrl, {
              allowed_updates: ['message', 'callback_query'],
              drop_pending_updates: true,
              max_connections: 1 // Limit connections for serverless environment
            });
            console.log('[DEBUG] Webhook setup result:', webhookResult);
            
            // Verify webhook is set correctly
            const webhookInfo = await this.bot.telegram.getWebhookInfo();
            console.log('[DEBUG] Current webhook info:', webhookInfo);
            
            if (webhookInfo.url !== webhookUrl) {
              throw new Error(`Webhook URL mismatch. Expected: ${webhookUrl}, Got: ${webhookInfo.url}`);
            }

            if (webhookInfo.last_error_date) {
              console.error('[DEBUG] Webhook has errors:', {
                lastErrorDate: new Date(webhookInfo.last_error_date * 1000),
                lastErrorMessage: webhookInfo.last_error_message
              });
            }
            
            // Set running state even in webhook mode
            this.isPolling = true;
            console.log('[DEBUG] Telegram bot started using webhook mode');
            
            break; // Success, exit the retry loop
          } catch (error: any) {
            retryCount++;
            
            if (error.response?.error_code === 429) {
              // Rate limit hit, wait for the specified time plus some buffer
              const retryAfter = (error.response.parameters?.retry_after || 1) * 1000;
              console.log(`[DEBUG] Rate limit hit, waiting ${retryAfter}ms before retry ${retryCount}/${maxRetries}`);
              await new Promise(resolve => setTimeout(resolve, retryAfter + 1000)); // Add 1 second buffer
              continue;
            }
            
            if (retryCount === maxRetries) {
              console.error('[DEBUG] Failed to set webhook after', maxRetries, 'attempts:', error);
              throw error;
            }
            
            // For other errors, use exponential backoff
            const delay = baseDelay * Math.pow(2, retryCount - 1);
            console.log(`[DEBUG] Error setting webhook, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      } else {
        // In development, use long polling
        console.log('[DEBUG] Starting long polling mode');
        this.isPolling = true;
        await this.bot.launch({
          allowedUpdates: ['message', 'callback_query'],
          dropPendingUpdates: true
        });
        console.log('[DEBUG] Telegram bot started using long polling');
        
        // Enable graceful stop
        process.once('SIGINT', () => this.stop());
        process.once('SIGTERM', () => this.stop());
      }
    } catch (error) {
      this.isPolling = false;
      console.error('[DEBUG] Error in start method:', error);
      throw error;
    }
  }

  public stop() {
    if (!this.isPolling) {
      return;
    }
    this.bot.stop();
    this.isPolling = false;
    console.log('Telegram bot stopped');
  }

  public async handleUpdate(update: any) {
    try {
      console.log('[DEBUG] Handling update:', JSON.stringify(update));
      await this.bot.handleUpdate(update);
      console.log('[DEBUG] Update handled successfully');
    } catch (error) {
      console.error('[DEBUG] Error handling update:', error);
      throw error;
    }
  }

  public getWebhookMiddleware() {
    console.log('[DEBUG] Creating webhook middleware');
    try {
      const middleware = this.bot.webhookCallback('/api/webhook');
      console.log('[DEBUG] Webhook middleware created successfully');
      return middleware;
    } catch (error) {
      console.error('[DEBUG] Error creating webhook middleware:', error);
      throw error;
    }
  }

  private async handleMyFilters(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    try {
      // Get user's filters from database
      const { data: filters, error } = await this.adminClient
        .from('Filter')
        .select('*')
        .eq('user_id', telegramId)
        .eq('is_active', true);

      if (error) throw error;

      if (!filters || filters.length === 0) {
        await ctx.reply(
          '📋 <b>Your Active Filters</b>\n\n' +
          'You don\'t have any active filters yet.\n\n' +
          'Use /setfilter to create your first filter!',
          { parse_mode: 'HTML' }
        );
        return;
      }

      let message = '📋 <b>Your Active Filters</b>\n\n';
      
      for (const [index, filter] of filters.entries()) {
        message += `<b>Filter #${index + 1}</b>\n`;
        
        if (filter.min_market_cap || filter.max_market_cap) {
          message += `💰 Market Cap: ${filter.min_market_cap || 0} - ${filter.max_market_cap || '∞'} USD\n`;
        }
        
        if (filter.min_liquidity || filter.max_liquidity) {
          message += `💧 Liquidity: ${filter.min_liquidity || 0} - ${filter.max_liquidity || '∞'} USD\n`;
        }
        
        if (filter.min_holders || filter.max_holders) {
          message += `👥 Holders: ${filter.min_holders || 0} - ${filter.max_holders || '∞'}\n`;
        }
        
        if (filter.max_dev_tokens) {
          message += `🔒 Max Dev Tokens: ${filter.max_dev_tokens}%\n`;
        }
        
        if (filter.min_contract_age) {
          message += `⏰ Min Contract Age: ${filter.min_contract_age} hours\n`;
        }
        
        if (filter.trading_enabled !== null) {
          message += `🔄 Trading Status: ${filter.trading_enabled ? 'Trading' : 'Not Trading'}\n`;
        }

        message += `\nTo delete this filter, use:\n<code>/deletefilter ${filter.id}</code>\n\n`;
      }

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Error fetching filters:', error);
      await ctx.reply('❌ Error fetching your filters. Please try again later.');
    }
  }

  private async handleDeleteFilter(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('❌ Invalid command format. Please use /deletefilter [id]');
      return;
    }

    const filterId = ctx.message.text.split(' ')[1];
    if (!filterId) {
      await ctx.reply(
        '❌ Please specify a filter ID to delete.\n\n' +
        'Use /myfilters to see your active filters and their IDs.'
      );
      return;
    }

    try {
      // Verify the filter belongs to the user and delete it
      const { error } = await this.adminClient
        .from('Filter')
        .update({ is_active: false })
        .eq('id', filterId)
        .eq('user_id', telegramId);

      if (error) throw error;

      await ctx.reply('✅ Filter deleted successfully!');
    } catch (error) {
      console.error('Error deleting filter:', error);
      await ctx.reply('❌ Error deleting filter. Please try again later.');
    }
  }

  private async handleHelp(ctx: CustomContext) {
    await ctx.reply(
      '🤖 <b>HeartBot AI Help</b>\n\n' +
      '<b>Available Commands:</b>\n' +
      '• /start - Start the bot and get welcome message\n' +
      '• /setfilter - Set up a new token alert filter\n' +
      '• /myfilters - View your active filters\n' +
      '• /deletefilter [id] - Delete a specific filter\n' +
      '• /fetch - Start fetching new tokens\n' +
      '• /stop - Stop monitoring for new tokens\n' +
      '• /help - Show this help message\n\n' +
      '<b>Filter Criteria:</b>\n' +
      '• Market Cap - Set minimum and maximum market cap\n' +
      '• Liquidity - Set minimum and maximum liquidity\n' +
      '• Holders - Set minimum and maximum number of holders\n' +
      '• Dev Tokens - Set maximum percentage of tokens held by developers\n' +
      '• Contract Age - Set minimum age of the contract\n' +
      '• Trading Status - Choose between trading and not trading tokens\n\n' +
      '<b>Tips:</b>\n' +
      '• You can skip any filter criteria by clicking "Skip"\n' +
      '• Use "Custom" to enter your own values\n' +
      '• Review your filter before saving\n' +
      '• You can have multiple active filters\n' +
      '• Use /fetch to start receiving alerts\n' +
      '• Use /stop to stop receiving alerts\n\n' +
      'Need more help? Contact @support',
      { parse_mode: 'HTML' }
    );
  }

  private async handleFetch(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    try {
      // Get user's active filters
      const { data: filters, error } = await this.adminClient
        .from('Filter')
        .select('*')
        .eq('user_id', telegramId)
        .eq('is_active', true);

      if (error) {
        console.error('[DEBUG] Error fetching filters:', error);
        await ctx.reply('❌ Error fetching filters');
        return;
      }

      if (!filters || filters.length === 0) {
        await ctx.reply('❌ No active filters found. Use /setfilter to create one.');
        return;
      }

      // Enable monitoring for this user
      this.heartBot.enableMonitoring(telegramId);
      
      // Start monitoring and send confirmation
      await ctx.reply('✅ Token monitoring started! You will receive alerts when new tokens match your filters.\n\nUse /stop to disable monitoring.');

      // Optionally check current filters
      const filterDescriptions = filters.map((filter, index) => {
        const parts = [];
        if (filter.min_market_cap) parts.push(`Min MC: $${filter.min_market_cap}`);
        if (filter.max_market_cap) parts.push(`Max MC: $${filter.max_market_cap}`);
        if (filter.min_liquidity) parts.push(`Min Liq: $${filter.min_liquidity}`);
        if (filter.max_liquidity) parts.push(`Max Liq: $${filter.max_liquidity}`);
        return `Filter ${index + 1}:\n${parts.join('\n')}`;
      });

      if (filterDescriptions.length > 0) {
        await ctx.reply('Your active filters:\n\n' + filterDescriptions.join('\n\n'));
      }

    } catch (error) {
      console.error('[DEBUG] Error in handleFetch:', error);
      await ctx.reply('❌ Error starting token monitoring. Please try again.');
    }
  }

  public matchesFilter(token: TokenData, filter: any): boolean {
    console.log(`[DEBUG] Checking token ${token.address} against filter:`, filter);

    // Market cap check
    if (filter.min_market_cap && token.marketCap !== undefined) {
      if (token.marketCap < filter.min_market_cap) {
        console.log(`[DEBUG] Failed min market cap check: ${token.marketCap} < ${filter.min_market_cap}`);
        return false;
      }
    }
    
    if (filter.max_market_cap && token.marketCap !== undefined) {
      if (token.marketCap > filter.max_market_cap) {
        console.log(`[DEBUG] Failed max market cap check: ${token.marketCap} > ${filter.max_market_cap}`);
        return false;
      }
    }

    // Liquidity check
    if (filter.min_liquidity && token.liquidity !== undefined) {
      if (token.liquidity < filter.min_liquidity) {
        console.log(`[DEBUG] Failed min liquidity check: ${token.liquidity} < ${filter.min_liquidity}`);
        return false;
      }
    }
    
    if (filter.max_liquidity && token.liquidity !== undefined) {
      if (token.liquidity > filter.max_liquidity) {
        console.log(`[DEBUG] Failed max liquidity check: ${token.liquidity} > ${filter.max_liquidity}`);
        return false;
      }
    }

    // Holders check - skip if data not available
    if ((filter.min_holders || filter.max_holders) && token.holdersCount === undefined) {
      console.log('[DEBUG] Skipping holder checks - data not available');
      return true; // Skip check instead of failing
    }

    if (filter.min_holders && token.holdersCount !== undefined) {
      if (token.holdersCount < filter.min_holders) {
        console.log(`[DEBUG] Failed min holders check: ${token.holdersCount} < ${filter.min_holders}`);
        return false;
      }
    }

    if (filter.max_holders && token.holdersCount !== undefined) {
      if (token.holdersCount > filter.max_holders) {
        console.log(`[DEBUG] Failed max holders check: ${token.holdersCount} > ${filter.max_holders}`);
        return false;
      }
    }

    // Dev tokens check - skip if not available
    if (filter.max_dev_tokens && token.devTokensPercentage === undefined) {
      console.log('[DEBUG] Skipping dev tokens check - data not available');
      return true; // Skip check instead of failing
    }

    if (filter.max_dev_tokens && token.devTokensPercentage !== undefined) {
      if (token.devTokensPercentage > filter.max_dev_tokens) {
        console.log(`[DEBUG] Failed max dev tokens check: ${token.devTokensPercentage} > ${filter.max_dev_tokens}`);
        return false;
      }
    }

    // Contract age check - skip if not available
    if (filter.min_contract_age && token.contractAge === undefined) {
      console.log('[DEBUG] Skipping contract age check - data not available');
      return true; // Skip check instead of failing
    }

    if (filter.min_contract_age && token.contractAge !== undefined) {
      if (token.contractAge < filter.min_contract_age) {
        console.log(`[DEBUG] Failed min contract age check: ${token.contractAge} < ${filter.min_contract_age}`);
        return false;
      }
    }

    // Trading status check
    if (filter.trading_enabled !== undefined && token.tradingEnabled !== undefined) {
      if (token.tradingEnabled !== filter.trading_enabled) {
        console.log(`[DEBUG] Failed trading status check: ${token.tradingEnabled} !== ${filter.trading_enabled}`);
        return false;
      }
    }

    // All checks passed
    console.log(`[DEBUG] Token ${token.address} matched all filter criteria`);
    return true;
  }

//  private async handleFetch(ctx: Context) {
//   const userId = ctx.from?.id.toString();
//   if (!userId) {
//     await ctx.reply('❌ Error: Could not identify user');
//     return;
//   }

//   try {
//     // Enable monitoring for this user
//     this.heartBot.enableMonitoring(userId);

//     // Optionally start the monitoring loop (only starts if not already running)
//     this.heartBot.startMonitoringLoop();

//     await ctx.reply('✅ Token monitoring started! You will receive alerts when new tokens match your filters.');

//     // Optional: Send a test alert to confirm
//     const testToken: TokenData = {
//       address: '0x123',
//       name: 'TestToken',
//       symbol: 'TTK',
//       marketCap: 50000,
//       liquidity: 10000,
//       fdv: 100000,
//       holdersCount: 120,
//       tradingEnabled: true,
//       contractAge: 1,
//       devTokensPercentage: 5,
//     };

//      console.log(`[DEBUG] Preparing to send token alert to user ${userId}`);
//     await this.sendTokenAlert(userId, testToken);
//   } catch (error) {
//     console.error('[handleFetch] Error starting monitoring:', error);
//     await ctx.reply('❌ Error starting token monitoring. Please try again later.');
//   }
// }

    
  private async handleStop(ctx: Context) {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      await ctx.reply('❌ Error: Could not identify user');
      return;
    }

    try {
      // Disable monitoring for this user
      this.heartBot.disableMonitoring(userId);
      await ctx.reply('🛑 Token fetching stopped. You will no longer receive new token alerts.');
    } catch (error) {
      console.error('Error stopping monitoring:', error);
      await ctx.reply('❌ Error stopping token monitoring. Please try again later.');
    }
  }

  public async setWebhook(url: string) {
    await this.bot.telegram.setWebhook(url);
  }

  public async getWebhookInfo() {
    return await this.bot.telegram.getWebhookInfo();
  }
}