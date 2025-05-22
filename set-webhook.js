require('dotenv').config();
const { Telegraf } = require('telegraf');

async function setWebhook() {
  try {
    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    
    // Get bot info to verify token
    const botInfo = await bot.telegram.getMe();
    console.log('Bot info:', botInfo);

    // Delete any existing webhook
    await bot.telegram.deleteWebhook();
    console.log('Deleted existing webhook');

    // Set new webhook
    const webhookUrl = process.env.VERCEL_URL.startsWith('http') 
      ? `${process.env.VERCEL_URL}/api/webhook`
      : `https://${process.env.VERCEL_URL}/api/webhook`;
      
    console.log('Setting webhook to:', webhookUrl);
    
    await bot.telegram.setWebhook(webhookUrl, {
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    
    console.log('Webhook set successfully to:', webhookUrl);
    
    // Get webhook info
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', webhookInfo);
    
    process.exit(0);
  } catch (error) {
    console.error('Error setting webhook:', error);
    process.exit(1);
  }
}

setWebhook(); 