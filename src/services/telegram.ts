import { Telegraf, Context, Markup } from 'telegraf';
import { config } from '../config';
import { TokenData } from '../types';
import { createClient } from '@supabase/supabase-js';
// import { DexscreenerService } from '../services/dexscreener';
import axios from 'axios';
import { HeartBot } from '../index';

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
  tradingStatus?: boolean;
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
    this.bot.command('fetch', this.handleFetch.bind(this));
    this.bot.command('stop', this.handleStop.bind(this));
    this.bot.command('test', this.handleTest.bind(this));

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

    // Liquidity callbacks
    this.bot.action('filter_liquidity', async (ctx) => await this.handleLiquidityStep(ctx));
    this.bot.action(/^set_min_liquidity:(\d+)$/, async (ctx) => await this.handleMinLiquidity(ctx));
    this.bot.action(/^set_max_liquidity:(\d+)$/, async (ctx) => await this.handleMaxLiquidity(ctx));
    this.bot.action('skip_liquidity', async (ctx) => await this.handleHoldersStep(ctx));

    // Holders callbacks
    this.bot.action('filter_holders', async (ctx) => await this.handleHoldersStep(ctx));
    this.bot.action(/^set_min_holders:(\d+)$/, async (ctx) => await this.handleMinHolders(ctx));
    this.bot.action(/^set_max_holders:(\d+)$/, async (ctx) => await this.handleMaxHolders(ctx));
    this.bot.action('skip_holders', async (ctx) => await this.handleDevTokensStep(ctx));

    // Dev tokens callbacks
    this.bot.action('filter_dev_tokens', async (ctx) => await this.handleDevTokensStep(ctx));
    this.bot.action(/^set_max_dev_tokens:(\d+)$/, async (ctx) => await this.handleMaxDevTokens(ctx));
    this.bot.action('skip_dev_tokens', async (ctx) => await this.handleContractAgeStep(ctx));

    // Contract age callbacks
    this.bot.action('filter_contract_age', async (ctx) => await this.handleContractAgeStep(ctx));
    this.bot.action(/^set_min_age:(\d+)$/, async (ctx) => await this.handleMinContractAge(ctx));
    this.bot.action('skip_contract_age', async (ctx) => await this.handleTradingStatusStep(ctx));

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
        { command: 'fetch', description: 'Start monitoring for new tokens' },
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
        "• /fetch - Start monitoring for new tokens\n" +
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

  private async handleMarketCapStep(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    await ctx.editMessageText(
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
  }

  private async handleMinMarketCap(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (value === 'custom_market_cap') {
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

    await ctx.editMessageText(
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
            Markup.button.callback('Back', 'filter_market_cap')
          ]
        ])
      }
    );
  }

  private async handleMaxMarketCap(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (value === 'custom') {
      await ctx.editMessageText(
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

    await ctx.editMessageText(
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
            Markup.button.callback('Back', 'filter_market_cap')
          ]
        ])
      }
    );
  }

  private async handleMinLiquidity(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (value === 'custom') {
      await ctx.editMessageText(
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

    await ctx.editMessageText(
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
            Markup.button.callback('Back', 'filter_liquidity')
          ]
        ])
      }
    );
  }

  private async handleMaxLiquidity(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (value === 'custom') {
      await ctx.editMessageText(
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

    await ctx.editMessageText(
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
            Markup.button.callback('Back', 'filter_liquidity')
          ]
        ])
      }
    );
  }

  private async handleMinHolders(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (value === 'custom') {
      await ctx.editMessageText(
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

    await ctx.editMessageText(
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
            Markup.button.callback('Back', 'filter_holders')
          ]
        ])
      }
    );
  }

  private async handleMaxHolders(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (value === 'custom') {
      await ctx.editMessageText(
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

    await ctx.editMessageText(
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
            Markup.button.callback('Back', 'filter_holders')
          ]
        ])
      }
    );
  }

  private async handleMaxDevTokens(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const match = ctx.match;
    if (!match) return;

    const value = match[1];

    if (value === 'custom') {
      await ctx.editMessageText(
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

    await ctx.editMessageText(
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
            Markup.button.callback('Back', 'filter_dev_tokens')
          ]
        ])
      }
    );
  }

  private async handleMinContractAge(ctx: CustomContext) {
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

    await ctx.editMessageText(
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
      state.tradingStatus = value === 'true';
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
    
    if (state.tradingStatus !== undefined) {
      message += `🔄 Trading Status: ${state.tradingStatus ? 'Trading' : 'Not Trading'}\n`;
    }

    message += '\nWould you like to save this filter?';

    await ctx.editMessageText(message, {
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
          trading_enabled: state.tradingStatus,
          is_active: true
        });

      if (error) {
        console.error('[DEBUG] Error saving filter:', error);
        throw error;
      }

      this.filterStates.delete(telegramId);
      await ctx.editMessageText('✅ Filter saved successfully! You will receive alerts for tokens matching your criteria.');
    } catch (error) {
      console.error('[DEBUG] Error saving filter:', error);
      await ctx.editMessageText('❌ Error saving filter. Please try again later.');
    }
  }

  private async handleFilterCancel(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    // Clear the filter state
    this.filterStates.delete(telegramId);

    await ctx.editMessageText('❌ Filter creation cancelled.');
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
      '• /fetch - Start monitoring for new tokens\n' +
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

  private async handleTest(ctx: CustomContext) {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    try {
      await ctx.reply('🔍 Testing token alerts...');

      // Get user's active filters
      const { data: filters, error } = await this.adminClient
        .from('Filter')
        .select('*')
        .eq('user_id', telegramId)
        .eq('is_active', true);

      if (error) {
        await ctx.reply('❌ Error fetching filters');
        return;
      }

      if (!filters || filters.length === 0) {
        await ctx.reply('❌ No active filters found. Use /setfilter to create one.');
        return;
      }

      // Add retry logic for Moralis API
      let retryCount = 0;
      const maxRetries = 3;
      const baseDelay = 2000;
      let tokens = [];

      while (retryCount < maxRetries) {
        try {
          // Get latest tokens directly from Moralis
          const response = await axios.get('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new', {
            headers: {
              'X-API-Key': config.moralis.apiKey,
              'Accept': 'application/json'
            },
            params: {
              limit: config.moralis.tokenFetchLimit
            },
            timeout: 10000 // 10 second timeout
          });

          console.log('[DEBUG] Moralis API Response Status:', response.status);
          console.log('[DEBUG] Response type:', typeof response.data);
          console.log('[DEBUG] Is Array?', Array.isArray(response.data));

          if (!response.data) {
            throw new Error('Empty response from Moralis API');
          }

          // Handle both array and object with data property
          tokens = Array.isArray(response.data) ? response.data : 
                  response.data.data ? response.data.data :
                  response.data.result ? response.data.result : [];

          if (!Array.isArray(tokens)) {
            throw new Error('Invalid response format from Moralis API');
          }

          // If we get here, the request was successful
          break;
        } catch (error: any) {
          retryCount++;
          
          if (error.response?.status === 429) {
            // Rate limit hit, wait for the specified time plus some buffer
            const retryAfter = (error.response.headers['retry-after'] || 1) * 1000;
            console.log(`[DEBUG] Rate limit hit, waiting ${retryAfter}ms before retry ${retryCount}/${maxRetries}`);
            await new Promise(resolve => setTimeout(resolve, retryAfter + 1000)); // Add 1 second buffer
            continue;
          }
          
          if (error.response?.status === 500) {
            console.error('[DEBUG] Moralis API server error:', error.response.data);
            await ctx.reply('⚠️ Moralis API is currently experiencing issues. Please try again in a few minutes.');
            return;
          }
          
          if (retryCount === maxRetries) {
            console.error('[DEBUG] Failed to fetch tokens after', maxRetries, 'attempts:', error);
            if (error.response) {
              await ctx.reply(`❌ Error fetching tokens: ${error.response.status} - ${error.response.statusText}\n\nPlease try again later.`);
            } else if (error.code === 'ECONNABORTED') {
              await ctx.reply('❌ Request timed out. Please try again later.');
            } else {
              await ctx.reply('❌ Error fetching tokens. Please try again later.');
            }
            return;
          }
          
          // For other errors, use exponential backoff
          const delay = baseDelay * Math.pow(2, retryCount - 1);
          console.log(`[DEBUG] Error fetching tokens, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      // Filter out invalid tokens
      const validTokens = tokens.filter((token: { tokenAddress?: string }) => token && token.tokenAddress);
      
      if (validTokens.length === 0) {
        await ctx.reply('❌ No valid tokens found in the response');
        return;
      }

      await ctx.reply(`Found ${validTokens.length} valid tokens from Moralis. Checking against your filters...`);

      let matchedTokens = 0;

      for (const token of validTokens) {
        console.log(`Processing token: ${token.tokenAddress}`);
        try {
          const finalTokenData = {
            address: token.tokenAddress,
            name: token.name || 'Unknown',
            symbol: token.symbol || 'Unknown',
            priceUsd: token.priceUsd,
            marketCap: token.marketCap,
            liquidity: token.liquidity,
            fdv: token.fdv,
            holdersCount: 0, // Not available from Moralis
            tradingEnabled: true, // Assume trading is enabled for new tokens
            contractAge: 0, // Not available from Moralis
            devTokensPercentage: 0 // Not available from Moralis
          };

          // Calculate marketCap if not provided
          if (!finalTokenData.marketCap && finalTokenData.priceUsd && finalTokenData.liquidity) {
            // Estimate marketCap as 2x liquidity for new tokens
            finalTokenData.marketCap = finalTokenData.liquidity * 2;
            console.log(`[DEBUG] Calculated marketCap for ${token.tokenAddress}: ${finalTokenData.marketCap}`);
          }

          // Validate token data
          if (!finalTokenData.liquidity) {
            console.log(`Invalid token data for ${token.tokenAddress}:`, finalTokenData);
            continue;
          }

          if (!finalTokenData.marketCap) {
            console.log(`Invalid token data for ${token.tokenAddress}:`, finalTokenData);
            continue;
          }

          for (const filter of filters) {
            // Skip filters that require Dexscreener data
            if (filter.min_holders || filter.max_holders || 
                filter.max_dev_tokens || filter.min_contract_age) {
              console.log(`Skipping filter for ${token.tokenAddress} - requires Dexscreener data`);
              continue;
            }

            const matches = this.matchesFilter(finalTokenData, filter);
            if (matches) {
              matchedTokens++;
              await this.sendTokenAlert(telegramId, finalTokenData);
              await ctx.reply(`✅ Sent alert for token ${token.tokenAddress}`);
            }
          }
        } catch (error) {
          console.error(`Error processing token ${token.tokenAddress}:`, error);
          continue;
        }
      }

      if (matchedTokens === 0) {
        await ctx.reply('❌ No tokens matched your filters');
      } else {
        await ctx.reply(`✅ Sent ${matchedTokens} token alerts`);
      }
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        await ctx.reply('❌ Moralis API request timed out. Please try again.');
      } else if (error.response) {
        await ctx.reply(`❌ Moralis API error: ${error.response.status} - ${error.response.statusText}`);
      } else {
        await ctx.reply('❌ Error testing token alerts: ' + error.message);
      }
      console.error('Error in test command:', error);
    }
  }

  private matchesFilter(token: TokenData, filter: any): boolean {
    console.log(`\nChecking token ${token.address} against filter for user ${filter.user_id}`);
    console.log('Token data:', {
      liquidity: token.liquidity,
      marketCap: token.marketCap,
      holdersCount: token.holdersCount,
      devTokensPercentage: token.devTokensPercentage,
      contractAge: token.contractAge,
      tradingEnabled: token.tradingEnabled
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

    // Holders filters
    if (filter.min_holders && token.holdersCount < filter.min_holders) {
      console.log(`❌ Holders ${token.holdersCount} < min ${filter.min_holders}`);
      return false;
    }
    if (filter.max_holders && token.holdersCount > filter.max_holders) {
      console.log(`❌ Holders ${token.holdersCount} > max ${filter.max_holders}`);
      return false;
    }

    // Dev tokens filter
    if (filter.max_dev_tokens && token.devTokensPercentage && token.devTokensPercentage > filter.max_dev_tokens) {
      console.log(`❌ Dev tokens ${token.devTokensPercentage}% > max ${filter.max_dev_tokens}%`);
      return false;
    }

    // Contract age filter
    if (filter.min_contract_age && token.contractAge < filter.min_contract_age) {
      console.log(`❌ Contract age ${token.contractAge} < min ${filter.min_contract_age}`);
      return false;
    }

    // Trading status filter
    if (filter.trading_enabled !== null && token.tradingEnabled !== filter.trading_enabled) {
      console.log(`❌ Trading status ${token.tradingEnabled} != required ${filter.trading_enabled}`);
      return false;
    }

    // If we get here, the token matches all specified filters
    console.log(`✅ Token ${token.address} matches all filters for user ${filter.user_id}`);
    return true;
  }

  private async handleFetch(ctx: Context) {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      await ctx.reply('❌ Error: Could not identify user');
      return;
    }

    try {
      // Enable monitoring for this user
      this.heartBot.enableMonitoring(userId);
      await ctx.reply('✅ Token monitoring started! You will receive alerts for new tokens that match your filters every 60 seconds.');
    } catch (error) {
      console.error('Error starting monitoring:', error);
      await ctx.reply('❌ Error starting token monitoring. Please try again later.');
    }
  }

  private async handleStop(ctx: Context) {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      await ctx.reply('❌ Error: Could not identify user');
      return;
    }

    try {
      // Disable monitoring for this user
      this.heartBot.disableMonitoring(userId);
      await ctx.reply('🛑 Token monitoring stopped. You will no longer receive automatic alerts.');
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