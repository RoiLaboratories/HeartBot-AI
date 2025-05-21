export interface TokenData {
  address: string;
  name: string;
  symbol: string;
  priceUsd?: string;
  marketCap: number;
  liquidity: number;
  fdv: number;
  holdersCount: number;
  tradingEnabled: boolean;
  contractAge: number;
  devTokensPercentage?: number;
} 