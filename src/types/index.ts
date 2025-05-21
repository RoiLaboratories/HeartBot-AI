export interface TokenFilter {
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

export interface TokenData {
  address: string;
  name: string;
  symbol: string;
  marketCap: number;
  liquidity: number;
  fdv: number;
  holdersCount: number;
  tradingEnabled: boolean;
  contractAge: number;
  devTokensPercentage?: number;
}

export interface DexscreenerTokenData {
  pairs: Array<{
    priceUsd: string;
    liquidity: {
      usd: string;
    };
    volume: {
      h24: string;
    };
    fdv: string;
  }>;
}

export interface UserContext {
  userId: string;
  telegramId: string;
  username?: string;
} 