import { DexscreenerService } from './services/dexscreener';

async function testDexscreener() {
  const dexscreener = new DexscreenerService();
  
  // Test with a known token address (e.g., USDT)
  const tokenAddress = '0xdac17f958d2ee523a2206206994597c13d831ec7';
  
  console.log('Fetching token data...');
  const tokenData = await dexscreener.getTokenData(tokenAddress);
  
  if (tokenData) {
    console.log('Token data retrieved successfully:');
    console.log(JSON.stringify(tokenData, null, 2));
  } else {
    console.log('Failed to retrieve token data');
  }
}

testDexscreener().catch(console.error); 