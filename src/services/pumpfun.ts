import axios from 'axios';
import { TokenData } from '../types';
import { config } from '../config';

export class PumpFunService {
  private readonly moralisBaseUrl = 'https://solana-gateway.moralis.io';
  private readonly birdeyeBaseUrl = 'https://public-api.birdeye.so';
  private lastCheckedTimestamp: number = 0;

  constructor() {}

  resetLastCheckedTimestamp() {
    console.log('Resetting last checked timestamp...');
    this.lastCheckedTimestamp = 0;
  }
  private lastSeenTokens: Record<string, Set<string>> = {};
  async getNewTokens(userId: string): Promise<TokenData[]> {
    try {
      console.log('[DEBUG] Fetching new tokens from Moralis...');
      const response = await axios.get('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new', {
        headers: {
          'X-API-Key': config.moralis.apiKey,
          'Accept': 'application/json'
        },
        params: {
          limit: config.moralis.tokenFetchLimit // Use the configured limit
        },
        timeout: 30000 // Increased timeout to 30 seconds
      });
        // Add timestamp tracking
      const currentTime = Date.now();
      console.log(`[DEBUG] Last checked: ${this.lastCheckedTimestamp}, Current: ${currentTime}`);
      console.log('[DEBUG] Moralis API Response:', JSON.stringify(response.data, null, 2));

      // Handle both array and object with data property
      const tokens = Array.isArray(response.data) ? response.data : 
                    response.data.data ? response.data.data :
                    response.data.result ? response.data.result : [];

      if (!Array.isArray(tokens)) {
        console.error('[DEBUG] Invalid response format from Moralis API:', response.data);
        return [];
      }

      console.log(`[DEBUG] Found ${tokens.length} tokens from Moralis`);

       if (!this.lastSeenTokens[userId]) {
       this.lastSeenTokens[userId] = new Set();
    }

     const seen = this.lastSeenTokens[userId];

      const newTokens: TokenData[] = [];

      for (const token of tokens) {

         if (!token?.address) continue;
         if (seen.has(token.address)) {
        continue; // skip already seen
      }

      seen.add(token.address); // mark as seen

        try {
          // Skip tokens without required data
          if (!token.tokenAddress || !token.name || !token.symbol) {
            console.log(`[DEBUG] Skipping invalid token: ${JSON.stringify(token)}`);
            continue;
          }

          // Skip tokens without price or liquidity data
          if (!token.priceUsd || !token.liquidity) {
            console.log(`[DEBUG] Skipping token without price/liquidity: ${token.tokenAddress}`);
            continue;
          }

          // Parse numeric values
          const priceUsd = parseFloat(token.priceUsd);
          const liquidity = parseFloat(token.liquidity);
          const fdv = token.fullyDilutedValuation ? parseFloat(token.fullyDilutedValuation) : 
                     (priceUsd && liquidity ? priceUsd * liquidity : 0);

          // Skip if any required numeric values are invalid
          if (isNaN(priceUsd) || isNaN(liquidity) || isNaN(fdv)) {
            console.log(`[DEBUG] Skipping token with invalid numeric values: ${token.tokenAddress}`);
            continue;
          }

          // Create token data
          const tokenData: TokenData = {
            address: token.tokenAddress,
            name: token.name,
            symbol: token.symbol,
            priceUsd: priceUsd.toString(),
            marketCap: fdv,
            liquidity: liquidity,
            fdv: fdv,
            holdersCount: 0,
            tradingEnabled: true,
            contractAge: 0,
            devTokensPercentage: 0
          };

          console.log(`[DEBUG] Processed new token: ${tokenData.address}`);
          newTokens.push(tokenData);
        } catch (error) {
          console.error(`[DEBUG] Error processing token ${token.tokenAddress}:`, error);
          continue;
        }
      }

      console.log(`[DEBUG] Found ${newTokens.length} valid new tokens`);
      return newTokens;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        console.error('[DEBUG] Moralis API request timed out');
        throw new Error('Moralis API request timed out');
      } else if (error.response) {
        console.error(`[DEBUG] Moralis API error: ${error.response.status} - ${error.response.statusText}`);
        throw error; // Let the monitoring system handle retries
      } else {
        console.error('[DEBUG] Error fetching tokens:', error);
        throw error;
      }
    }
  }

  private async getMoralisTokens(retryCount = 0): Promise<TokenData[]> {
    try {
      const response = await axios.get(`${this.moralisBaseUrl}/token/mainnet/exchange/pumpfun/new`, {
        headers: {
          'X-API-Key': config.moralis.apiKey,
          'Accept': 'application/json'
        },
        params: {
          limit: config.moralis.tokenFetchLimit
        },
        timeout: 10000 // 10 second timeout
      });

      console.log(`Fetching up to ${config.moralis.tokenFetchLimit} tokens from Moralis...`);
      console.log('Moralis API Response:', JSON.stringify(response.data, null, 2));

      if (!response.data) {
        console.warn('Empty response from Moralis API');
        return [];
      }

      // Handle both array and object with data property
      const tokens = Array.isArray(response.data) ? response.data : 
                    response.data.data ? response.data.data :
                    response.data.result ? response.data.result : [];

      if (!Array.isArray(tokens)) {
        console.warn('Invalid token data format from Moralis API:', tokens);
        return [];
      }

      console.log(`Found ${tokens.length} tokens from Moralis`);

      const enrichedTokens = tokens
        .filter((token: any) => {
          const isNew = this.isNewToken(token);
          if (!isNew) {
            console.log(`Skipping old token: ${token.address}`);
          }
          return isNew;
        })
        .map((token: any) => {
          try {
            console.log(`Processing token: ${token.address}`);
            const tokenData: TokenData = {
              address: token.address,
              name: token.name,
              symbol: token.symbol,
              priceUsd: token.priceUsd,
              marketCap: token.fullyDilutedValuation ? parseFloat(token.fullyDilutedValuation) : 
                        (token.priceUsd && token.liquidity ? parseFloat(token.priceUsd) * parseFloat(token.liquidity) : 0),
              liquidity: parseFloat(token.liquidity) || 0,
              fdv: token.fullyDilutedValuation ? parseFloat(token.fullyDilutedValuation) : 
                   (token.priceUsd && token.liquidity ? parseFloat(token.priceUsd) * parseFloat(token.liquidity) : 0),
              holdersCount: 0,
              tradingEnabled: true,
              contractAge: 0,
              devTokensPercentage: 0
            };

            console.log(`Processed token data for ${token.address}:`, tokenData);
            return tokenData;
          } catch (error) {
            console.error(`Error processing token ${token.address}:`, error);
            return null;
          }
        })
        .filter((token): token is TokenData => token !== null);

      return enrichedTokens;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 500 && retryCount < 3) {
          console.log(`Retrying Moralis API call (attempt ${retryCount + 1}/3)...`);
          await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1))); // Exponential backoff
          return this.getMoralisTokens(retryCount + 1);
        }
        
        if (error.response?.status === 404) {
          console.error('Moralis API endpoint not found. Please check the API documentation.');
        } else if (error.response?.status === 401) {
          console.error('Invalid Moralis API key. Please check your API key.');
        } else {
          console.error('Error fetching tokens from Moralis:', error.message);
          if (error.response?.data) {
            console.error('Response data:', error.response.data);
          }
        }
      } else {
        console.error('Unexpected error in getMoralisTokens:', error);
      }
      return [];
    }
  }

  private async getBirdeyeTokens(): Promise<TokenData[]> {
    try {
      const response = await axios.get(`${this.birdeyeBaseUrl}/public/tokenlist/solana`, {
        headers: {
          'X-API-KEY': config.birdeye.apiKey,
          'Accept': 'application/json'
        },
        params: {
          sort_by: 'created_at',
          sort_type: 'desc',
          limit: 100,
          offset: 0
        }
      });

      if (!response.data || !Array.isArray(response.data.data)) {
        console.warn('Invalid response format from Birdeye API');
        return [];
      }

      return response.data.data
        .filter((token: any) => this.isNewToken(token))
        .map((token: any) => ({
          address: token.address,
          name: token.name,
          symbol: token.symbol,
          priceUsd: token.price || '0',
          marketCap: token.marketCap || 0,
          liquidity: token.liquidity || 0,
          fdv: token.fdv || 0,
          holdersCount: 0,
          tradingEnabled: true,
          contractAge: 0,
          devTokensPercentage: 0
        }));
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          console.error('Birdeye API endpoint not found. Please check the API documentation.');
        } else if (error.response?.status === 401) {
          console.error('Invalid Birdeye API key. Please check your API key.');
        } else {
          console.error('Error fetching tokens from Birdeye:', error.message);
        }
      } else {
        console.error('Unexpected error in getBirdeyeTokens:', error);
      }
      return [];
    }
  }

  private isNewToken(token: any): boolean {
    const tokenTimestamp = token.timestamp || token.createdAt;
    return tokenTimestamp > this.lastCheckedTimestamp;
  }

  private filterUniqueTokens(tokens: TokenData[]): TokenData[] {
    const uniqueTokens = new Map<string, TokenData>();
    tokens.forEach(token => {
      if (!uniqueTokens.has(token.address)) {
        uniqueTokens.set(token.address, token);
      }
    });
    return Array.from(uniqueTokens.values());
  }

  private calculateContractAge(launchTimestamp: number): number {
    const now = Date.now();
    return Math.floor((now - launchTimestamp) / (1000 * 60)); // Convert to minutes
  }
} 