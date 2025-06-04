import axios from 'axios';
import { TokenData } from '../types';
import { config } from '../config';

export class PumpFunService {
  private readonly moralisBaseUrl = 'https://solana-gateway.moralis.io';
  private readonly birdeyeBaseUrl = 'https://public-api.birdeye.so';
  private lastCheckedTimestamp: number = 0;
  private lastSeenTokens: Map<string, Set<string>> = new Map();

  constructor() {}

  resetLastCheckedTimestamp() {
    console.log('[DEBUG] Resetting last checked timestamp and clearing token cache');
    this.lastCheckedTimestamp = Date.now() - (15 * 60 * 1000); // Start from 15 minutes ago
    this.lastSeenTokens.clear();
    console.log(`[DEBUG] New lastCheckedTimestamp: ${new Date(this.lastCheckedTimestamp).toISOString()}`);
  }

  async getNewTokens(userId: string): Promise<TokenData[]> {
    try {
      console.log('\n[DEBUG] ==== Fetching New Tokens ====');
      console.log(`[DEBUG] Fetching tokens for user ${userId}`);
      const currentTime = Date.now();
      console.log(`[DEBUG] Current time: ${new Date(currentTime).toISOString()}`);
      console.log(`[DEBUG] Last checked: ${new Date(this.lastCheckedTimestamp).toISOString()}`);
      
      const response = await axios.get('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new', {
        headers: {
          'X-API-Key': config.moralis.apiKey,
          'Accept': 'application/json'
        },
        params: {
          limit: config.moralis.tokenFetchLimit || 100
        },
        timeout: 30000
      });

      console.log(`[DEBUG] API Response status: ${response.status}`);
      if (response.status !== 200) {
        console.error(`[DEBUG] Unexpected API response status: ${response.status}`);
        return [];
      }

      if (!response.data) {
        console.error('[DEBUG] Empty API response data');
        return [];
      }

      // Log response structure
      console.log('[DEBUG] API Response structure:', {
        type: typeof response.data,
        isArray: Array.isArray(response.data),
        hasData: Boolean(response.data?.data),
        hasResult: Boolean(response.data?.result),
        keys: Object.keys(response.data)
      });

      // Handle various response formats
      const tokens = Array.isArray(response.data) ? response.data : 
                    response.data.data ? response.data.data :
                    response.data.result ? response.data.result : [];

      if (!Array.isArray(tokens)) {
        console.error('[DEBUG] Invalid response format from API:', response.data);
        return [];
      }

      console.log(`[DEBUG] Found ${tokens.length} total tokens from API`);
      if (tokens.length === 0) {
        console.log('[DEBUG] No tokens returned from API');
        return [];
      }

      // Sample the first token for debugging
      if (tokens.length > 0) {
        console.log('[DEBUG] First token from API:', {
          address: tokens[0].address || tokens[0].tokenAddress,
          name: tokens[0].name,
          timestamp: tokens[0].timestamp || tokens[0].createdAt
        });
      }

      // Initialize user's seen tokens set if not exists
      if (!this.lastSeenTokens.has(userId)) {
        this.lastSeenTokens.set(userId, new Set());
        console.log(`[DEBUG] Initialized new seen tokens set for user ${userId}`);
      }

      const seen = this.lastSeenTokens.get(userId)!;
      console.log(`[DEBUG] Current seen tokens count for user ${userId}: ${seen.size}`);
      const newTokens: TokenData[] = [];

      for (const token of tokens) {
        const tokenAddress = token.tokenAddress || token.address;
        if (!tokenAddress) {
          console.log('[DEBUG] Skipping token without address');
          continue;
        }

        // Log token timestamps for debugging
        const tokenTimestamp = token.timestamp || token.createdAt;
        if (tokenTimestamp) {
          console.log(`[DEBUG] Token ${tokenAddress} timestamp: ${new Date(tokenTimestamp).toISOString()}`);
          console.log(`[DEBUG] Is token new? ${tokenTimestamp > this.lastCheckedTimestamp}`);
        }

        // Skip recently seen tokens
        if (seen.has(tokenAddress)) {
          console.log(`[DEBUG] Skipping previously seen token: ${tokenAddress}`);
          continue;
        }

        // Add to seen set
        seen.add(tokenAddress);
        console.log(`[DEBUG] Added ${tokenAddress} to seen tokens`);

        try {
          // Parse numeric values with validation
          const priceUsd = parseFloat(token.priceUsd || '0');
          const liquidity = parseFloat(token.liquidity || '0');
          const fdv = token.fullyDilutedValuation ? parseFloat(token.fullyDilutedValuation) : 
                     (priceUsd && liquidity ? priceUsd * liquidity : liquidity * 2); // Estimate as 2x liquidity

          console.log(`[DEBUG] Parsed token values:`, {
            priceUsd,
            liquidity,
            fdv
          });

          // Create token data with fallbacks
          const tokenData: TokenData = {
            address: tokenAddress,
            name: token.name || 'Unknown',
            symbol: token.symbol || 'Unknown',
            priceUsd: priceUsd.toString(),
            marketCap: fdv,
            liquidity: liquidity,
            fdv: fdv,
            holdersCount: parseInt(token.holdersCount || '0'),
            tradingEnabled: token.tradingEnabled !== false, // Default to true unless explicitly false
            contractAge: tokenTimestamp ? this.calculateContractAge(tokenTimestamp) : 0,
            devTokensPercentage: parseFloat(token.devTokensPercentage || '0')
          };

          // Log complete token data
          console.log(`[DEBUG] Processed token data:`, tokenData);

          // Add token if it has minimum required data
          if (tokenData.liquidity > 0) {
            console.log(`[DEBUG] Adding new valid token: ${tokenData.address}`);
            newTokens.push(tokenData);
          } else {
            console.log(`[DEBUG] Skipping token with no liquidity: ${tokenData.address}`);
          }
        } catch (error) {
          console.error(`[DEBUG] Error processing token ${tokenAddress}:`, error);
          continue;
        }
      }

      // Update last checked timestamp
      console.log(`[DEBUG] Updating lastCheckedTimestamp from ${new Date(this.lastCheckedTimestamp).toISOString()} to ${new Date(currentTime).toISOString()}`);
      this.lastCheckedTimestamp = currentTime;

      // Cleanup old seen tokens after a shorter period (1 hour)
      const oldestAllowedTimestamp = currentTime - 3600000; // 1 hour
      if (this.lastCheckedTimestamp < oldestAllowedTimestamp) {
        console.log('[DEBUG] Clearing old seen tokens cache');
        this.lastSeenTokens.set(userId, new Set());
      }

      console.log(`[DEBUG] Returning ${newTokens.length} new tokens`);
      return newTokens;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          console.error('[DEBUG] Rate limit hit:', error.response.data);
        } else {
          console.error('[DEBUG] API Error:', {
            status: error.response?.status,
            data: error.response?.data
          });
        }
      } else {
        console.error('[DEBUG] Error in getNewTokens:', error);
      }
      throw error;
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