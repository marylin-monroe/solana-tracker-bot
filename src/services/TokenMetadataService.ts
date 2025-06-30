// src/services/TokenMetadataService.ts - 🔥 COINGECKO DEMO API + 8 MIN CACHE
import { Logger } from '../utils/Logger';

interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  address: string;
  totalSupply?: number;
}

interface JupiterTokenData {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  tags?: string[];
}

interface TokenSupplyResponse {
  context: { slot: number; };
  value: {
    amount: string;
    decimals: number;
    uiAmount: number;
    uiAmountString: string;
  };
}

interface RPCResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: { code: number; message: string; };
}

export class TokenMetadataService {
  private logger: Logger;
  private cache = new Map<string, { metadata: TokenMetadata; timestamp: number }>();
  private jupiterTokenList: Map<string, JupiterTokenData> = new Map();
  private lastJupiterUpdate = 0;

  // 🔥 COINGECKO DEMO API KEY
  private readonly COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || 'CG-41xRapEt2rbCfioV37PGuboh';

  private readonly CACHE_TTL = {
    TOKEN_METADATA: 60 * 60 * 1000,      // 1 час
    PRICE_DATA: 60 * 60 * 1000,           // 🔥 60 минут (вместо 5)
    FDV_DATA: 15 * 60 * 1000,            // 15 минут
    SUPPLY_DATA: 60 * 60 * 1000,         // 1 час
    JUPITER_UPDATE: 60 * 60 * 1000       // 1 час
  };

  // Кеши
  private priceCache = new Map<string, { price: number; timestamp: number }>();
  private supplyCache = new Map<string, { supply: number; decimals: number; timestamp: number }>();
  private fdvCache = new Map<string, { fdv: number; timestamp: number }>();

  // 🔥🔥🔥 ТОЛЬКО ОСНОВНЫЕ ТОКЕНЫ ДЛЯ СВАПОВ (10 ТОКЕНОВ) 🔥🔥🔥
  private readonly WELL_KNOWN_TOKENS = new Map<string, TokenMetadata>([
    // Основные платежные токены
    ['So11111111111111111111111111111111111111112', {
      symbol: 'SOL', name: 'Solana', decimals: 9,
      address: 'So11111111111111111111111111111111111111112', totalSupply: 588_000_000
    }],
    ['So11111111111111111111111111111111111111111', {
      symbol: 'WSOL', name: 'Wrapped SOL', decimals: 9,
      address: 'So11111111111111111111111111111111111111111'
    }],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      symbol: 'USDC', name: 'USD Coin', decimals: 6,
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    }],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', {
      symbol: 'USDT', name: 'Tether USD', decimals: 6,
      address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    }],
    
    // Популярные торговые токены
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', {
      symbol: 'BONK', name: 'Bonk', decimals: 5,
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
    }],
    ['EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', {
      symbol: 'WIF', name: 'dogwifhat', decimals: 6,
      address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'
    }],
    ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', {
      symbol: 'JUP', name: 'Jupiter', decimals: 6,
      address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
    }],
    ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', {
      symbol: 'RAY', name: 'Raydium', decimals: 6,
      address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'
    }],
    
    // LST токены (самые популярные)
    ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', {
      symbol: 'mSOL', name: 'Marinade Staked SOL', decimals: 9,
      address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
    }],
    ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', {
      symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9,
      address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
    }]
  ]);

  // 🔥🔥🔥 COINGECKO МАППИНГ ДЛЯ ЦЕН 🔥🔥🔥
  private readonly COINGECKO_TOKEN_MAP = new Map<string, string>([
    // SOL и WSOL - одинаковая цена
    ['So11111111111111111111111111111111111111112', 'solana'],
    ['So11111111111111111111111111111111111111111', 'solana'],
    
    // Стейблкоины
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'usd-coin'],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'tether'],
    
    // Популярные токены
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'bonk'],
    ['EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'dogwifcoin'],
    ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'jupiter-exchange-solana'],
    ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'raydium'],
    
    // LST токены
    ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'marinade-staked-sol'],
    ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 'jito-staked-sol']
  ]);

  constructor() {
    this.logger = Logger.getInstance();
    this.logger.info('🏷️ TokenMetadataService ENHANCED: 🔥 CoinGecko Demo API (8min cache) + основные токены');
    this.logger.info(`💰 Loaded ${this.WELL_KNOWN_TOKENS.size} payment tokens for calculation`);
    this.logger.info(`🔑 Using CoinGecko Demo API (30 req/min, 10k/month) - Key from ENV: ${this.COINGECKO_API_KEY ? 'LOADED' : 'MISSING'}`);
  }

  // 🔥🔥🔥 ЕДИНЫЙ РАСЧЕТНЫЙ ЦЕНТР - БЕЗ ИЗМЕНЕНИЙ 🔥🔥🔥
  public async calculateSwapUSDValue(
    inputMint: string,
    inputAmountRaw: number,
    outputMint: string,
    outputAmountRaw: number
  ): Promise<{ 
    amountUSD: number; 
    paymentToken: string;
    paymentTokenAmount: number;
    paymentTokenPrice: number;
    swapType: 'buy' | 'sell'; 
    tokenAddress: string;
  } | null> {
    
    this.logger.debug(`[calculateSwapUSDValue] Processing swap: ${inputMint.slice(0,8)}... → ${outputMint.slice(0,8)}...`);
    
    const PAYMENT_ASSETS = new Set(this.WELL_KNOWN_TOKENS.keys());

    const inputIsPayment = PAYMENT_ASSETS.has(inputMint);
    const outputIsPayment = PAYMENT_ASSETS.has(outputMint);

    this.logger.debug(`[calculateSwapUSDValue] Input is payment: ${inputIsPayment}, Output is payment: ${outputIsPayment}`);

    // Фильтруем бесполезные свапы (деньги<->деньги или щиткоин<->щиткоин)
    if ((inputIsPayment && outputIsPayment) || (!inputIsPayment && !outputIsPayment)) {
      this.logger.debug(`[calculateSwapUSDValue] Filtered out: payment→payment or alt→alt`);
      return null;
    }

    const paymentToken = inputIsPayment ? inputMint : outputMint;
    const tokenAddress = inputIsPayment ? outputMint : inputMint;
    const swapType = inputIsPayment ? 'buy' : 'sell';
    const paymentAmountRaw = inputIsPayment ? inputAmountRaw : outputAmountRaw;

    this.logger.debug(`[calculateSwapUSDValue] Detected ${swapType}: payment token ${paymentToken.slice(0,8)}..., target token ${tokenAddress.slice(0,8)}...`);

    // Получаем цену и decimals ТОЛЬКО для платежного токена
    const decimals = await this.getDecimals(paymentToken);
    const price = await this.getTokenPrice(paymentToken);

    // ГЛАВНАЯ ЗАЩИТА: нет цены/decimals "денег" - нет расчета
    if (decimals === null || price === null) {
      this.logger.warn(`[calculateSwapUSDValue] Cannot calculate value: Unknown price/decimals for PAYMENT token ${paymentToken}`);
      return null;
    }

    const paymentTokenAmount = paymentAmountRaw / Math.pow(10, decimals);
    const amountUSD = paymentTokenAmount * price;

    this.logger.info(`🔥 [ЕДИНЫЙ РАСЧЕТНЫЙ ЦЕНТР] ${swapType.toUpperCase()}: $${amountUSD.toFixed(2)} (${paymentTokenAmount.toFixed(4)} ${this.getTokenSymbol(paymentToken)} @ $${price})`);

    return { 
      amountUSD, 
      paymentToken, 
      paymentTokenAmount: paymentTokenAmount,
      paymentTokenPrice: price, 
      swapType: inputIsPayment ? 'buy' : 'sell',
      tokenAddress: inputIsPayment ? outputMint : inputMint
    };
  }

  // 🔥🔥🔥 НОВЫЙ ГЛАВНЫЙ МЕТОД: getTokenPrice С COINGECKO DEMO API 🔥🔥🔥
  async getTokenPrice(tokenAddress: string): Promise<number | null> {
    try {
      if (!tokenAddress || tokenAddress === 'UNKNOWN') return null;

      // Проверяем кеш (8 минут)
      const cached = this.priceCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.PRICE_DATA) return cached.price;
      
      // USD токены - сразу 1.0
      const wellKnownToken = this.WELL_KNOWN_TOKENS.get(tokenAddress);
      if (wellKnownToken?.symbol.includes('USD')) {
        this.priceCache.set(tokenAddress, { price: 1.0, timestamp: Date.now() });
        return 1.0;
      }

      // 🔥 ПРОВЕРЯЕМ COINGECKO МАППИНГ
      const coingeckoId = this.COINGECKO_TOKEN_MAP.get(tokenAddress);
      if (coingeckoId) {
        const price = await this.getTokenPriceFromCoinGecko(coingeckoId);
        if (price) {
          this.priceCache.set(tokenAddress, { price, timestamp: Date.now() });
          this.logger.info(`✅ ${tokenAddress.slice(0,8)}... price from CoinGecko Demo API: $${price}`);
          return price;
        }
      }

      // 🔥 ДЛЯ НЕИЗВЕСТНЫХ ТОКЕНОВ - возвращаем null
      this.logger.warn(`❌ No price mapping for ${tokenAddress.slice(0,8)}... (not in supported tokens)`);
      return null;

    } catch (error) {
      this.logger.warn(`Price API error for ${tokenAddress}:`, error);
      return null;
    }
  }

  // 🔥🔥🔥 COINGECKO DEMO API МЕТОД (БЕЗ БРАУЗЕРНЫХ ЗАГОЛОВКОВ) 🔥🔥🔥
  private async getTokenPriceFromCoinGecko(coingeckoId: string): Promise<number | null> {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10000);

      // 🔥 DEMO API URL С КЛЮЧОМ
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd&x_cg_demo_api_key=${this.COINGECKO_API_KEY}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { 
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (data?.[coingeckoId]?.usd && typeof data[coingeckoId].usd === 'number') {
          return data[coingeckoId].usd;
        }
      }

      this.logger.debug(`CoinGecko Demo API failed for ${coingeckoId}, status: ${response.status}`);
      return null;

    } catch (error) {
      this.logger.debug(`CoinGecko Demo API error for ${coingeckoId}:`, error);
      return null;
    }
  }

  // 🔥 УНИВЕРСАЛЬНЫЙ МЕТОД ПОЛУЧЕНИЯ СИМВОЛА ТОКЕНА
  public getTokenSymbol(tokenMint: string): string {
    const wellKnown = this.WELL_KNOWN_TOKENS.get(tokenMint);
    if (wellKnown) return wellKnown.symbol;
    
    // Фоллбэк на первые 6 символов адреса
    return (!tokenMint || tokenMint.length < 6) ? 'UNKNOWN' : tokenMint.slice(0, 6).toUpperCase();
  }

  // 🔥 ПОЛУЧЕНИЕ DECIMALS
  async getDecimals(mintAddress: string): Promise<number | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') return null;

      // 1. Проверяем кеш
      const cached = this.getCachedMetadata(mintAddress);
      if (cached?.decimals !== undefined && cached.decimals >= 0) {
        this.logger.debug(`[getDecimals] Cache hit for ${mintAddress}: ${cached.decimals}`);
        return cached.decimals;
      }

      // 2. Проверяем WELL_KNOWN_TOKENS
      const wellKnown = this.WELL_KNOWN_TOKENS.get(mintAddress);
      if (wellKnown?.decimals !== undefined) {
        this.logger.debug(`[getDecimals] Well-known token ${mintAddress}: ${wellKnown.decimals}`);
        return wellKnown.decimals;
      }

      // 3. Пробуем RPC
      const rpcMetadata = await this.getTokenMetadataFromRPC(mintAddress);
      if (rpcMetadata?.decimals !== undefined && rpcMetadata.decimals >= 0) {
        this.logger.debug(`[getDecimals] RPC metadata for ${mintAddress}: ${rpcMetadata.decimals}`);
        this.setCachedMetadata(mintAddress, rpcMetadata);
        return rpcMetadata.decimals;
      }

      // 4. Пробуем Jupiter (ОСТАВЛЯЕМ, но без обновлений)
      const jupiterToken = this.jupiterTokenList.get(mintAddress);
      if (jupiterToken && typeof jupiterToken.decimals === 'number' && jupiterToken.decimals >= 0) {
        this.logger.debug(`[getDecimals] Jupiter token for ${mintAddress}: ${jupiterToken.decimals}`);
        return jupiterToken.decimals;
      }

      // 5. Фоллбэк
      const fallbackDecimals = this.getFallbackDecimals(mintAddress);
      this.logger.debug(`[getDecimals] Fallback for ${mintAddress}: ${fallbackDecimals}`);
      return fallbackDecimals;

    } catch (error) {
      this.logger.error(`[getDecimals] Error for ${mintAddress}:`, error);
      return this.getFallbackDecimals(mintAddress);
    }
  }

  // 🔥 ФОЛЛБЭК DECIMALS
  private getFallbackDecimals(mintAddress: string): number {
    // Стейблкоины обычно 6 decimals
    if (mintAddress.includes('USD') || 
        mintAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || // USDC
        mintAddress === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {  // USDT
      return 6;
    }
    
    // SOL и большинство токенов - 9 decimals
    return 9;
  }

  // 🎯 ПОЛУЧЕНИЕ МЕТАДАННЫХ
  async getTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') return null;

      const cached = this.getCachedMetadata(mintAddress);
      if (cached && typeof cached.decimals === 'number' && cached.decimals >= 0) return cached;

      const wellKnown = this.WELL_KNOWN_TOKENS.get(mintAddress);
      if (wellKnown) {
        this.setCachedMetadata(mintAddress, wellKnown);
        return wellKnown;
      }

      // Пробуем RPC
      const rpcMetadata = await this.getTokenMetadataFromRPC(mintAddress);
      if (rpcMetadata) {
        const enriched = await this.enrichTokenMetadata(rpcMetadata);
        this.setCachedMetadata(mintAddress, enriched);
        return enriched;
      }

      // Пробуем Jupiter (УПРОЩЕННО)
      const jupiterToken = this.jupiterTokenList.get(mintAddress);
      if (jupiterToken) {
        const metadata: TokenMetadata = {
          symbol: jupiterToken.symbol,
          name: jupiterToken.name,
          decimals: jupiterToken.decimals,
          logoURI: jupiterToken.logoURI,
          address: mintAddress
        };
        this.setCachedMetadata(mintAddress, metadata);
        return metadata;
      }

      // Фоллбэк
      const fallback = this.createFallbackMetadata(mintAddress);
      this.setCachedMetadata(mintAddress, fallback);
      return fallback;

    } catch (error) {
      this.logger.error(`Error getting token metadata for ${mintAddress}:`, error);
      return this.createFallbackMetadata(mintAddress);
    }
  }

  // Обогащение метаданных (УПРОЩЕННО - только Jupiter)
  private async enrichTokenMetadata(baseMetadata: TokenMetadata): Promise<TokenMetadata> {
    try {
      const jupiterToken = this.jupiterTokenList.get(baseMetadata.address);
      if (jupiterToken && jupiterToken.symbol !== this.generateSymbolFromAddress(baseMetadata.address)) {
        return { ...baseMetadata, symbol: jupiterToken.symbol, name: jupiterToken.name, logoURI: jupiterToken.logoURI };
      }
      return baseMetadata;
    } catch {
      return baseMetadata;
    }
  }

  // 🔥 RPC МЕТАДАННЫЕ
  private async getTokenMetadataFromRPC(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      const rpcUrl = process.env.QUICKNODE_HTTP_URL || process.env.ALCHEMY_HTTP_URL;
      if (!rpcUrl) return null;

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 15000);

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
          params: [mintAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }]
        }),
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json() as RPCResponse;
        const info = data.result?.value?.data?.parsed?.info;
        if (info) {
          const decimals = this.safeGetNumberValue(info.decimals, 9);
          if (decimals >= 0 && decimals <= 18) {
            return {
              symbol: this.generateSymbolFromAddress(mintAddress),
              name: `Token ${mintAddress.slice(0, 8)}...`,
              decimals, address: mintAddress,
              totalSupply: this.safeGetNumberValue(info.supply, undefined)
            };
          }
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`RPC metadata error for ${mintAddress}:`, error);
      return null;
    }
  }

  // 🔥 SUPPLY (УПРОЩЕННО)
  async getTokenSupply(mintAddress: string): Promise<number | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') return null;

      const cached = this.supplyCache.get(mintAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.SUPPLY_DATA) return cached.supply;

      const wellKnown = this.WELL_KNOWN_TOKENS.get(mintAddress);
      if (wellKnown?.totalSupply) {
        this.supplyCache.set(mintAddress, { supply: wellKnown.totalSupply, decimals: wellKnown.decimals, timestamp: Date.now() });
        return wellKnown.totalSupply;
      }

      // Для остальных токенов - не делаем RPC запросы (экономим)
      return null;
    } catch (error) {
      this.logger.debug(`Supply error for ${mintAddress}:`, error);
      return null;
    }
  }

  // 🔥 FDV (УПРОЩЕННО)
  async getTokenFDV(mintAddress: string): Promise<number | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') return null;

      const cached = this.fdvCache.get(mintAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.FDV_DATA) return cached.fdv;

      const [price, supply] = await Promise.all([this.getTokenPrice(mintAddress), this.getTokenSupply(mintAddress)]);
      if (price && supply && price > 0 && supply > 0) {
        const fdv = price * supply;
        this.fdvCache.set(mintAddress, { fdv, timestamp: Date.now() });
        return fdv;
      }
      return null;
    } catch (error) {
      this.logger.debug(`FDV error for ${mintAddress}:`, error);
      return null;
    }
  }

  // 🔥 РАСШИРЕННАЯ ИНФОРМАЦИЯ (УПРОЩЕННО)
  async getEnhancedTokenInfo(mintAddress: string): Promise<{ symbol: string; name: string; decimals: number; price: number | null; totalSupply: number | null; fdv: number | null; marketCap: number | null; } | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') return null;

      const [metadata, price, supply] = await Promise.all([
        this.getTokenMetadata(mintAddress), this.getTokenPrice(mintAddress), this.getTokenSupply(mintAddress)
      ]);

      if (!metadata) return null;
      if (typeof metadata.decimals !== 'number' || metadata.decimals < 0) metadata.decimals = 9;

      let fdv: number | null = null;
      if (price && supply && price > 0 && supply > 0) fdv = price * supply;

      return { symbol: metadata.symbol, name: metadata.name, decimals: metadata.decimals, price, totalSupply: supply, fdv, marketCap: null };
    } catch (error) {
      this.logger.error(`Enhanced token info error for ${mintAddress}:`, error);
      return null;
    }
  }

  // 🔥 BATCH МЕТОДЫ (УПРОЩЕННО)
  async getBatchTokenMetadata(mintAddresses: string[]): Promise<Map<string, TokenMetadata | null>> {
    const results = new Map<string, TokenMetadata | null>();
    const BATCH_SIZE = 10;
    
    for (let i = 0; i < mintAddresses.length; i += BATCH_SIZE) {
      const batch = mintAddresses.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async address => {
        const metadata = await this.getTokenMetadata(address);
        results.set(address, metadata);
      });
      
      await Promise.all(batchPromises);
      if (i + BATCH_SIZE < mintAddresses.length) await this.sleep(100);
    }
    return results;
  }

  async getBatchTokenPrices(tokenAddresses: string[]): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < tokenAddresses.length; i += BATCH_SIZE) {
      const batch = tokenAddresses.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async address => {
        const price = await this.getTokenPrice(address);
        results.set(address, price);
      });
      
      await Promise.all(batchPromises);
      if (i + BATCH_SIZE < tokenAddresses.length) await this.sleep(200);
    }
    return results;
  }

  async getBatchTokenDecimals(mintAddresses: string[]): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    const BATCH_SIZE = 10;
    
    for (let i = 0; i < mintAddresses.length; i += BATCH_SIZE) {
      const batch = mintAddresses.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async address => {
        const decimals = await this.getDecimals(address);
        results.set(address, decimals);
      });
      
      await Promise.all(batchPromises);
      if (i + BATCH_SIZE < mintAddresses.length) await this.sleep(100);
    }
    return results;
  }

  // УТИЛИТЫ
  private getCachedMetadata(mintAddress: string): TokenMetadata | null {
    const cached = this.cache.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.TOKEN_METADATA) return cached.metadata;
    if (cached) this.cache.delete(mintAddress);
    return null;
  }

  private setCachedMetadata(mintAddress: string, metadata: TokenMetadata): void {
    this.cache.set(mintAddress, { metadata, timestamp: Date.now() });
  }

  private createFallbackMetadata(mintAddress: string): TokenMetadata {
    return {
      symbol: this.generateSymbolFromAddress(mintAddress),
      name: `Token ${mintAddress.slice(0, 8)}...`,
      decimals: this.getFallbackDecimals(mintAddress),
      address: mintAddress
    };
  }

  private generateSymbolFromAddress(address: string): string {
    return (!address || address.length < 6) ? 'UNKNOWN' : address.slice(0, 6).toUpperCase();
  }

  private safeGetNumberValue(value: any, defaultValue: number = 0): number {
    if (typeof value === 'number' && !isNaN(value) && isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && isFinite(parsed)) return parsed;
    }
    return defaultValue;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // МЕТОДЫ ДЛЯ СОВМЕСТИМОСТИ
  findTokenBySymbol(symbol: string): TokenMetadata | null {
    for (const [, metadata] of this.WELL_KNOWN_TOKENS) {
      if (metadata.symbol.toLowerCase() === symbol.toLowerCase()) return metadata;
    }
    for (const [, cached] of this.cache) {
      if (cached.metadata.symbol.toLowerCase() === symbol.toLowerCase()) return cached.metadata;
    }
    for (const [, token] of this.jupiterTokenList) {
      if (token.symbol.toLowerCase() === symbol.toLowerCase()) {
        return { symbol: token.symbol, name: token.name, decimals: token.decimals, logoURI: token.logoURI, address: token.address };
      }
    }
    return null;
  }

  isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }

  getPopularTokens(): TokenMetadata[] {
    return Array.from(this.WELL_KNOWN_TOKENS.values());
  }

  // СТАТИСТИКА
  getCacheStats(): {
    totalCached: number;
    jupiterTokens: number;
    priceCacheSize: number;
    supplyCacheSize: number;
    fdvCacheSize: number;
    wellKnownTokens: number;
  } {
    return {
      totalCached: this.cache.size,
      jupiterTokens: this.jupiterTokenList.size,
      priceCacheSize: this.priceCache.size,
      supplyCacheSize: this.supplyCache.size,
      fdvCacheSize: this.fdvCache.size,
      wellKnownTokens: this.WELL_KNOWN_TOKENS.size
    };
  }

  clearCache(): void {
    this.cache.clear();
    this.priceCache.clear();
    this.supplyCache.clear();
    this.fdvCache.clear();
    this.logger.info('🧹 All caches cleared');
  }

  // ПУСТЫЕ МЕТОДЫ ДЛЯ СОВМЕСТИМОСТИ (НЕ ОБНОВЛЯЕМ JUPITER)
  async forceUpdateJupiterList(): Promise<void> {
    this.logger.info('🔄 Jupiter list update disabled (using CoinGecko Demo API)');
  }
}