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

  async getNewTokens(): Promise<TokenData[]> {
    try {
      console.log('Fetching up to 1 tokens from Moralis...');
      const response = await axios.get('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new', {
        headers: {
          'X-API-Key': config.moralis.apiKey,
          'Accept': 'application/json'
        },
        params: {
          limit: 1
        },
        timeout: 10000 // 10 second timeout
      });

      console.log('Moralis API Response:', JSON.stringify(response.data, null, 2));

      if (!response.data || !response.data.result) {
        console.log('No tokens found in Moralis response');
        return [];
      }

      const tokens = response.data.result;
      console.log(`Found ${tokens.length} tokens from Moralis`);

      const newTokens: TokenData[] = [];

      for (const token of tokens) {
        // Skip tokens without required data
        if (!token.tokenAddress || !token.name || !token.symbol) {
          console.log(`Skipping invalid token: ${JSON.stringify(token)}`);
          continue;
        }

        // Skip tokens without price or liquidity data
        if (!token.priceUsd || !token.liquidity) {
          console.log(`Skipping token without price/liquidity: ${token.tokenAddress}`);
          continue;
        }

        // Create token data
        const tokenData: TokenData = {
          address: token.tokenAddress,
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

        console.log(`Processing new token: ${tokenData.address}`);
        newTokens.push(tokenData);
      }

      console.log(`[DEBUG] Found ${newTokens.length} new tokens`);
      return newTokens;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        console.error('Moralis API request timed out');
      } else if (error.response) {
        console.error(`Moralis API error: ${error.response.status} - ${error.response.statusText}`);
      } else {
        console.error('Error fetching tokens:', error);
      }
      return [];
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