import axios from 'axios';
import { TokenData } from '../types';
import { config } from '../config';

export class PumpFunService {
  private readonly moralisBaseUrl = 'https://solana-gateway.moralis.io';
  private readonly birdeyeBaseUrl = 'https://public-api.birdeye.so';
  private lastCheckedTimestamp: number = 0;
  private lastSeenTokens: Map<string, Set<string>> = new Map();

  constructor() {
    // Initialize timestamp to 15 minutes ago to fetch recent tokens
    this.resetLastCheckedTimestamp();
  }

  resetLastCheckedTimestamp() {
    console.log('[DEBUG] Resetting last checked timestamp and clearing token cache');
    // Start from just 1 minute ago to catch very recent tokens
    this.lastCheckedTimestamp = Date.now() - (1 * 60 * 1000);
    this.lastSeenTokens.clear();
    console.log(`[DEBUG] New lastCheckedTimestamp: ${new Date(this.lastCheckedTimestamp).toISOString()}`);
  }

  async getNewTokens(userId: string): Promise<TokenData[]> {
    console.log('\n[DEBUG] ==== Fetching New Tokens ====');
    console.log(`[DEBUG] Fetching tokens for user ${userId}`);
    const currentTime = Date.now();
    console.log(`[DEBUG] Current time: ${new Date(currentTime).toISOString()}`);
    console.log(`[DEBUG] Last checked: ${new Date(this.lastCheckedTimestamp).toISOString()}`);
    
    let retryCount = 0;
    const maxRetries = 3;
    const baseTimeout = 45000; // 45 seconds base timeout
    const baseDelay = 2000; // Base delay for exponential backoff

    while (retryCount <= maxRetries) {
      try {
        console.log(`[DEBUG] Attempting to fetch tokens (attempt ${retryCount + 1}/${maxRetries + 1})`);
        const response = await axios.get('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new', {
          headers: {
            'X-API-Key': config.moralis.apiKey,
            'Accept': 'application/json'
          },
          params: {
            limit: config.moralis.tokenFetchLimit || 100,
            from_timestamp: Math.floor(this.lastCheckedTimestamp / 1000),
            to_timestamp: Math.floor(currentTime / 1000)
          },
          timeout: baseTimeout * (retryCount + 1) // Increase timeout with each retry
        });

        // If we get here, the request was successful
        console.log('\n[DEBUG] ==== API Response Details ====');
        console.log('[DEBUG] API Request Parameters:', {
          limit: config.moralis.tokenFetchLimit || 100,
          from_timestamp: new Date(this.lastCheckedTimestamp).toISOString(),
          to_timestamp: new Date(currentTime).toISOString()
        });
        console.log('[DEBUG] Response status:', response.status);
        
        // Process the response
        if (!response.data) {
          console.log('[DEBUG] No tokens returned from API');
          return [];
        }

        // Log raw response stats
        console.log('[DEBUG] Raw API response stats:', {
          status: response.status,
          hasData: !!response.data,
          dataType: typeof response.data,
          isArray: Array.isArray(response.data),
          dataLength: Array.isArray(response.data) ? response.data.length : 
                     Array.isArray(response.data?.data) ? response.data.data.length :
                     Array.isArray(response.data?.result) ? response.data.result.length : 0
        });

        // Initialize user's seen tokens set if not exists
        if (!this.lastSeenTokens.has(userId)) {
          this.lastSeenTokens.set(userId, new Set());
          console.log(`[DEBUG] Initialized new seen tokens set for user ${userId}`);
        }
        const seen = this.lastSeenTokens.get(userId)!;
        console.log(`[DEBUG] Current seen tokens for user ${userId}: ${seen.size}`);
        
        // Handle various response formats
        const rawTokens = Array.isArray(response.data) ? response.data : 
                         response.data?.data ? response.data.data :
                         response.data?.result ? response.data.result : [];

        if (!Array.isArray(rawTokens)) {
          console.log('[DEBUG] Invalid response format - expected array');
          return [];
        }

        // Transform raw tokens into TokenData format
        const tokens: TokenData[] = rawTokens.map(rawToken => {
          // Convert string values to numbers where needed
          const liquidity = typeof rawToken.liquidity === 'string' ? parseFloat(rawToken.liquidity) : rawToken.liquidity;
          const priceUsd = typeof rawToken.priceUsd === 'string' ? parseFloat(rawToken.priceUsd) : rawToken.priceUsd;
          
          // Calculate marketCap if not provided but we have price and liquidity
          let marketCap = rawToken.marketCap;
          if (!marketCap && priceUsd && liquidity) {
            marketCap = liquidity * 2; // Estimate as 2x liquidity for new tokens
          }

          // Convert to match TokenData interface exactly
          return {
            address: rawToken.address || rawToken.token_address || '',
            name: rawToken.name || rawToken.token_name || 'Unknown',
            symbol: rawToken.symbol || rawToken.token_symbol || 'UNKNOWN',
            priceUsd: priceUsd?.toString(),
            marketCap: marketCap || 0,
            liquidity: liquidity || 0,
            fdv: rawToken.fdv || (marketCap ? marketCap * 2 : 0),
            holdersCount: rawToken.holdersCount || 0,
            tradingEnabled: rawToken.tradingEnabled || false,
            contractAge: rawToken.contractAge || 0,
            devTokensPercentage: rawToken.devTokensPercentage
          };
        }).filter(token => {
          // Filter out invalid tokens
          if (!token.address) {
            console.log('[DEBUG] Skipping token - missing address');
            return false;
          }
          if (!token.liquidity || token.liquidity <= 0) {
            console.log(`[DEBUG] Skipping token ${token.address} - invalid liquidity`);
            return false;
          }
          if (!token.priceUsd || token.priceUsd <= 0) {
            console.log(`[DEBUG] Skipping token ${token.address} - invalid price`);
            return false;
          }
          return true;
        });

        // Log processed tokens for debugging
        console.log('[DEBUG] Processed tokens:', tokens.map(token => ({
          address: token.address,
          name: token.name,
          marketCap: token.marketCap,
          liquidity: token.liquidity,
          priceUsd: token.priceUsd
        })));

        return tokens;

      } catch (error: any) {
        const isTimeout = error.code === 'ECONNABORTED' || error.response?.status === 504;
        const isRateLimit = error.response?.status === 429;
        
        console.error(`[ERROR] API request failed (attempt ${retryCount + 1}/${maxRetries + 1}):`, {
          code: error.code,
          status: error.response?.status,
          message: error.message,
          isTimeout,
          isRateLimit
        });

        if (retryCount === maxRetries) {
          console.error('[ERROR] Max retries reached, giving up');
          throw error;
        }

        // Calculate delay with exponential backoff
        const delay = baseDelay * Math.pow(2, retryCount);
        console.log(`[DEBUG] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        retryCount++;
      }
    }

    // This should never be reached due to the throw in the catch block
    return [];
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