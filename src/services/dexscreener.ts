import { ApifyClient } from 'apify-client';
import { config } from '../config';
import { TokenData } from '../types';

interface PageFunctionContext {
  $: any;
  log: any;
  request: {
    json: () => Promise<any>;
  };
}

interface DexscreenerTokenData {
  name: string;
  symbol: string;
  marketCap: string;
  liquidity: string;
  fdv: string;
  holders: string;
  tradingEnabled: boolean;
  contractAge: string;
  devTokensPercentage: string;
}

export class DexscreenerService {
  private client: ApifyClient;

  constructor() {
    this.client = new ApifyClient({
      token: config.apify.token,
    });
  }

  async getTokenData(address: string): Promise<TokenData | null> {
    try {
      console.log(`Fetching Dexscreener data for token ${address}...`);
      
      // Run the Dexscreener scraper
      const run = await this.client.actor("GWfH8uzlNFz2fEjKj").call({
        chainName: "solana",
        startUrls: [{ url: `https://dexscreener.com/solana/${address}` }],
        maxItems: 1,
        maxConcurrency: 1,
        maxRequestRetries: 3,
        pageFunction: async function pageFunction(context: PageFunctionContext) {
          const $ = context.$;
          const log = context.log;
          
          try {
            // Extract data from the page
            const name = $('h1').first().text().trim();
            const symbol = $('h2').first().text().trim();
            
            // Get market data
            const marketCap = $('div:contains("Market Cap")').next().text().trim();
            const liquidity = $('div:contains("Liquidity")').next().text().trim();
            const fdv = $('div:contains("FDV")').next().text().trim();
            
            // Get holders data
            const holders = $('div:contains("Holders")').next().text().trim();
            
            // Get trading status
            const tradingEnabled = !$('div:contains("Trading Disabled")').length;
            
            // Get contract age
            const contractAge = $('div:contains("Contract Age")').next().text().trim();
            
            // Get dev tokens percentage
            const devTokensPercentage = $('div:contains("Dev Tokens")').next().text().trim();
            
            const tokenData: DexscreenerTokenData = {
              name,
              symbol,
              marketCap: marketCap.replace(/[^0-9.]/g, ''),
              liquidity: liquidity.replace(/[^0-9.]/g, ''),
              fdv: fdv.replace(/[^0-9.]/g, ''),
              holders: holders.replace(/[^0-9]/g, ''),
              tradingEnabled,
              contractAge: contractAge.replace(/[^0-9]/g, ''),
              devTokensPercentage: devTokensPercentage.replace(/[^0-9.]/g, '')
            };
            
            return tokenData;
          } catch (error) {
            log.error('Error in pageFunction:', error);
            return null;
          }
        }
      });

      // Get the results
      const { items } = await this.client.dataset(run.defaultDatasetId).listItems();
      
      if (!items || items.length === 0) {
        console.log(`No Dexscreener data found for token ${address}`);
        return null;
      }

      const tokenData = items[0] as unknown as DexscreenerTokenData;
      if (!tokenData) {
        console.log(`Invalid Dexscreener data for token ${address}`);
        return null;
      }

      console.log(`Successfully fetched Dexscreener data for token ${address}:`, tokenData);
      
      return {
        address,
        name: tokenData.name || '',
        symbol: tokenData.symbol || '',
        marketCap: parseFloat(tokenData.marketCap) || 0,
        liquidity: parseFloat(tokenData.liquidity) || 0,
        fdv: parseFloat(tokenData.fdv) || 0,
        holdersCount: parseInt(tokenData.holders) || 0,
        tradingEnabled: tokenData.tradingEnabled || false,
        contractAge: parseInt(tokenData.contractAge) || 0,
        devTokensPercentage: parseFloat(tokenData.devTokensPercentage) || 0
      };
    } catch (error) {
      console.error(`Error fetching token data from Dexscreener for ${address}:`, error);
      return null;
    }
  }
} 