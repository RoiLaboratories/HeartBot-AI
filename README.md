# HeartBot AI

A Telegram bot for monitoring new token launches on Pump.fun in real-time. The bot allows users to set custom filters for token monitoring and sends alerts when matching tokens are found.

## Features

- Real-time monitoring of new token launches on Pump.fun
- Customizable filters for:
  - Market cap (min/max)
  - Liquidity (min/max)
  - Number of holders (min/max)
  - Developer token percentage
  - Contract age
  - Trading status
- Token data enrichment using Dexscreener API
- Detailed Telegram alerts with token information and relevant links
- PostgreSQL database for storing user profiles and filter settings
- Fast and responsive architecture using Fastify

## Prerequisites

- Node.js (v16 or higher)
- PostgreSQL database
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Dexscreener API key

## Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/heartbot-ai.git
cd heartbot-ai
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the project root with the following variables:
```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
DATABASE_URL="postgresql://user:password@localhost:5432/heartbot?schema=public"
DEXSCREENER_API_KEY=your_dexscreener_api_key
PORT=3000
NODE_ENV=development
```

4. Initialize the database:
```bash
npm run prisma:generate
npm run prisma:migrate
```

5. Build and start the application:
```bash
# For development
npm run dev

# For production
npm run build
npm start
```

## Usage

1. Start a chat with your bot on Telegram
2. Use the following commands:
   - `/start` - Initialize the bot
   - `/setfilter` - Configure your token alert filters
   - `/myfilters` - View your current filters
   - `/help` - Show available commands

## Filter Format

When setting filters using `/setfilter`, use the following format:
```
/setfilter minMarketCap maxMarketCap minLiquidity maxLiquidity minHolders maxHolders maxDevTokens minContractAge tradingEnabled
```

Example:
```
/setfilter 100000 1000000 50000 500000 10 1000 5 30 true
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the ISC License. 