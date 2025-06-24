// src/services/TokenMetadataService.ts - 🔥 ЭТАП 4: ФИНАЛЬНАЯ ОПТИМИЗАЦИЯ TTL + БАТЧИНГ
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

interface BirdeyeTokenData {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  price?: number;
  marketCap?: number;
}

interface SolanaTokenListEntry {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  tags?: string[];
}

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee?: any;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot?: number;
  timeTaken?: number;
}

interface BirdeyeTokenListResponse {
  success: boolean;
  data: {
    tokens: BirdeyeTokenData[];
    total: number;
    totalPage: number;
    currentPage: number;
  };
}

interface BirdeyePriceResponse {
  success: boolean;
  data: {
    value: number;
    updateUnixTime: number;
    updateHumanTime: string;
    priceChange24h: number;
    marketCap?: number;
  };
}

interface SolanaTokenListResponse {
  name: string;
  logoURI: string;
  keywords: string[];
  tags: Record<string, any>;
  timestamp: string;
  tokens: SolanaTokenListEntry[];
  version: { major: number; minor: number; patch: number; };
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

interface EnhancedTokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  price: number | null;
  totalSupply: number | null;
  fdv: number | null;
  marketCap: number | null;
}

export class TokenMetadataService {
  private logger: Logger;
  private cache = new Map<string, { metadata: TokenMetadata; timestamp: number }>();
  private jupiterTokenList: Map<string, JupiterTokenData> = new Map();
  private lastJupiterUpdate = 0;

  // 🔥 ЭТАП 4: ОПТИМИЗИРОВАННЫЕ TTL для экономии API
  private readonly CACHE_TTL = {
    TOKEN_METADATA: 60 * 60 * 1000,      // 1 час (было 24 часа - слишком долго)
    PRICE_DATA: 5 * 60 * 1000,           // 5 минут ✅
    FDV_DATA: 15 * 60 * 1000,            // 15 минут (было 10)
    BIRDEYE_DATA: 30 * 60 * 1000,        // 30 минут (новый)
    SUPPLY_DATA: 60 * 60 * 1000,         // 1 час ✅
    JUPITER_UPDATE: 60 * 60 * 1000       // 1 час ✅
  };

  // Кеши
  private priceCache = new Map<string, { price: number; timestamp: number }>();
  private supplyCache = new Map<string, { supply: number; decimals: number; timestamp: number }>();
  private fdvCache = new Map<string, { fdv: number; timestamp: number }>();
  private birdeyeCache = new Map<string, { data: any; timestamp: number }>(); // 🔥 НОВЫЙ КЕШ

  // Известные токены
  private readonly WELL_KNOWN_TOKENS = new Map<string, TokenMetadata>([
    ['So11111111111111111111111111111111111111112', {
      symbol: 'SOL', name: 'Solana', decimals: 9,
      address: 'So11111111111111111111111111111111111111112', totalSupply: 588_000_000
    }],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      symbol: 'USDC', name: 'USD Coin', decimals: 6,
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    }],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', {
      symbol: 'USDT', name: 'Tether USD', decimals: 6,
      address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    }],
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', {
      symbol: 'BONK', name: 'Bonk', decimals: 5,
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
    }],
    ['7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', {
      symbol: 'WIF', name: 'dogwifhat', decimals: 6,
      address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'
    }]
  ]);

  constructor() {
    this.logger = Logger.getInstance();
    this.logger.info('🏷️ TokenMetadataService initialized with OPTIMIZED CACHING');
  }

  // 🎯 ГЛАВНЫЙ МЕТОД: Получение метаданных с decimals
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

      const rpcMetadata = await this.getTokenMetadataFromRPC(mintAddress);
      if (rpcMetadata) {
        const enriched = await this.enrichTokenMetadata(rpcMetadata);
        this.setCachedMetadata(mintAddress, enriched);
        return enriched;
      }

      const sources = [this.getFromJupiter(mintAddress), this.getFromBirdeye(mintAddress), this.getFromSolanaTokenList(mintAddress)];
      const results = await Promise.allSettled(sources);
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && typeof result.value.decimals === 'number') {
          this.setCachedMetadata(mintAddress, result.value);
          return result.value;
        }
      }

      const fallback = this.createFallbackMetadata(mintAddress);
      this.setCachedMetadata(mintAddress, fallback);
      return fallback;

    } catch (error) {
      this.logger.error(`Error getting token metadata for ${mintAddress}:`, error);
      return this.createFallbackMetadata(mintAddress);
    }
  }

  // 🔥 RPC метаданные с decimals
  private async getTokenMetadataFromRPC(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      const rpcUrl = process.env.QUICKNODE_HTTP_URL || process.env.ALCHEMY_HTTP_URL;
      if (!rpcUrl) return null;

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 8000);

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

  // Обогащение метаданных
  private async enrichTokenMetadata(baseMetadata: TokenMetadata): Promise<TokenMetadata> {
    try {
      const sources = [this.getFromJupiter(baseMetadata.address), this.getFromBirdeye(baseMetadata.address)];
      const results = await Promise.allSettled(sources);
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && 
            result.value.symbol !== this.generateSymbolFromAddress(baseMetadata.address)) {
          return { ...baseMetadata, symbol: result.value.symbol, name: result.value.name, logoURI: result.value.logoURI };
        }
      }
      return baseMetadata;
    } catch {
      return baseMetadata;
    }
  }

  // 🔥 SUPPLY с кешированием
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

      const rpcUrl = process.env.QUICKNODE_HTTP_URL || process.env.ALCHEMY_HTTP_URL;
      if (!rpcUrl) return null;

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 8000);

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mintAddress] }),
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json() as RPCResponse;
        if (data.result?.value) {
          const supply = parseFloat(data.result.value.uiAmountString || data.result.value.uiAmount);
          const decimals = data.result.value.decimals;
          if (supply > 0 && typeof decimals === 'number') {
            this.supplyCache.set(mintAddress, { supply, decimals, timestamp: Date.now() });
            return supply;
          }
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`Supply error for ${mintAddress}:`, error);
      return null;
    }
  }

  // 🔥 FDV с увеличенным кешированием
  async getTokenFDV(mintAddress: string): Promise<number | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') return null;

      const cached = this.fdvCache.get(mintAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.FDV_DATA) return cached.fdv;

      const [price, supply] = await Promise.all([this.getTokenPrice(mintAddress), this.getTokenSupply(mintAddress)]);
      if (price && supply && price > 0 && supply > 0) {
        const fdv = price * supply;
        this.fdvCache.set(mintAddress, { fdv, timestamp: Date.now() });
        this.logger.debug(`💎 FDV calculated for ${mintAddress}: $${fdv.toLocaleString()}`);
        return fdv;
      }
      return null;
    } catch (error) {
      this.logger.debug(`FDV error for ${mintAddress}:`, error);
      return null;
    }
  }

  // 🔥 ЭТАП 4: БАТЧИНГ FDV запросов (15 токенов за раз)
  async getBatchTokenFDV(mintAddresses: string[]): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    const BATCH_SIZE = 15; // 🔥 Увеличен с 3 до 15
    
    for (let i = 0; i < mintAddresses.length; i += BATCH_SIZE) {
      const batch = mintAddresses.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async address => {
        const fdv = await this.getTokenFDV(address);
        results.set(address, fdv);
      });
      
      await Promise.all(batchPromises);
      if (i + BATCH_SIZE < mintAddresses.length) await this.sleep(2000); // 2 сек пауза
    }
    return results;
  }

  // Расширенная информация о токене
  async getEnhancedTokenInfo(mintAddress: string): Promise<EnhancedTokenInfo | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') return null;

      const [metadata, price, supply] = await Promise.all([
        this.getTokenMetadata(mintAddress), this.getTokenPrice(mintAddress), this.getTokenSupply(mintAddress)
      ]);

      if (!metadata) return null;
      if (typeof metadata.decimals !== 'number' || metadata.decimals < 0) metadata.decimals = 9;

      let fdv: number | null = null, marketCap: number | null = null;
      if (price && supply && price > 0 && supply > 0) fdv = price * supply;

      try {
        const birdeyeData = await this.getBirdeyeMarketDataCached(mintAddress);
        marketCap = birdeyeData?.marketCap || null;
      } catch {}

      return { symbol: metadata.symbol, name: metadata.name, decimals: metadata.decimals, price, totalSupply: supply, fdv, marketCap };
    } catch (error) {
      this.logger.error(`Enhanced token info error for ${mintAddress}:`, error);
      return null;
    }
  }

  // 🔥 Jupiter API с кешированием
  private async getFromJupiter(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      await this.updateJupiterTokenList();
      const jupiterToken = this.jupiterTokenList.get(mintAddress);
      if (jupiterToken) {
        const decimals = typeof jupiterToken.decimals === 'number' && jupiterToken.decimals >= 0 ? jupiterToken.decimals : 9;
        return { symbol: jupiterToken.symbol, name: jupiterToken.name, decimals, logoURI: jupiterToken.logoURI, address: mintAddress };
      }
      return null;
    } catch (error) {
      this.logger.debug(`Jupiter API error for ${mintAddress}:`, error);
      return null;
    }
  }

  // 🔥 Birdeye API с кешированием
  private async getFromBirdeye(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://public-api.birdeye.so/public/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=50`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Smart-Money-Bot/1.0' },
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (this.isBirdeyeTokenListResponse(data)) {
          const token = data.data.tokens.find((t: BirdeyeTokenData) => t.address === mintAddress);
          if (token) {
            const decimals = typeof token.decimals === 'number' && token.decimals >= 0 ? token.decimals : 9;
            return {
              symbol: token.symbol || this.generateSymbolFromAddress(mintAddress),
              name: token.name || `Token ${mintAddress.slice(0, 8)}...`,
              decimals, logoURI: token.logoURI, address: mintAddress
            };
          }
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`Birdeye API error for ${mintAddress}:`, error);
      return null;
    }
  }

  // Solana Token List
  private async getFromSolanaTokenList(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10000);

      const response = await fetch('https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/src/tokens/solana.tokenlist.json', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Smart-Money-Bot/1.0' },
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (this.isSolanaTokenListResponse(data)) {
          const token = data.tokens.find((t: SolanaTokenListEntry) => t.address === mintAddress);
          if (token) {
            const decimals = typeof token.decimals === 'number' && token.decimals >= 0 ? token.decimals : 9;
            return { symbol: token.symbol, name: token.name, decimals, logoURI: token.logoURI, address: mintAddress };
          }
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`Solana Token List error for ${mintAddress}:`, error);
      return null;
    }
  }

  // Обновление Jupiter списка
  private async updateJupiterTokenList(): Promise<void> {
    try {
      const now = Date.now();
      if (now - this.lastJupiterUpdate < this.CACHE_TTL.JUPITER_UPDATE) return;

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 15000);

      const response = await fetch('https://token.jup.ag/all', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Smart-Money-Bot/1.0' },
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) {
          this.jupiterTokenList.clear();
          for (const token of data) {
            if (this.isJupiterTokenData(token) && typeof token.decimals === 'number' && 
                token.decimals >= 0 && token.decimals <= 18) {
              this.jupiterTokenList.set(token.address, token);
            }
          }
          this.lastJupiterUpdate = now;
          this.logger.info(`✅ Updated Jupiter list: ${this.jupiterTokenList.size} tokens`);
        }
      }
    } catch (error) {
      this.logger.error('Jupiter list update error:', error);
    }
  }

  // Цена токена
  async getTokenPrice(tokenAddress: string): Promise<number | null> {
    try {
      if (!tokenAddress || tokenAddress === 'UNKNOWN') return null;

      const cached = this.priceCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.PRICE_DATA) return cached.price;

      if (tokenAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || 
          tokenAddress === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
        this.priceCache.set(tokenAddress, { price: 1.0, timestamp: Date.now() });
        return 1.0;
      }

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://public-api.birdeye.so/public/price?address=${tokenAddress}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Smart-Money-Bot/1.0' },
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (this.isBirdeyePriceResponse(data) && data.data.value) {
          const price = data.data.value;
          this.priceCache.set(tokenAddress, { price, timestamp: Date.now() });
          return price;
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`Price error for ${tokenAddress}:`, error);
      return null;
    }
  }

  // 🔥 ЭТАП 4: Кешированные Birdeye данные
  private async getBirdeyeMarketDataCached(mintAddress: string): Promise<{ marketCap?: number } | null> {
    const cached = this.birdeyeCache.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.BIRDEYE_DATA) return cached.data;

    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://public-api.birdeye.so/public/price?address=${mintAddress}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Smart-Money-Bot/1.0' },
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (this.isBirdeyePriceResponse(data)) {
          const result = { marketCap: data.data.marketCap };
          this.birdeyeCache.set(mintAddress, { data: result, timestamp: Date.now() });
          return result;
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`Birdeye market data error for ${mintAddress}:`, error);
      return null;
    }
  }

  // Пакетные методы
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

  // Утилиты
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
      decimals: 9, address: mintAddress
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

  // Поиск и валидация
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

  async getTokenMetadataWithPrice(mintAddress: string): Promise<TokenMetadata & { price?: number; marketCap?: number } | null> {
    try {
      const basicMetadata = await this.getTokenMetadata(mintAddress);
      if (!basicMetadata) return null;

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://public-api.birdeye.so/public/price?address=${mintAddress}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Smart-Money-Bot/1.0' },
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (this.isBirdeyePriceResponse(data)) {
          return { ...basicMetadata, price: data.data.value || undefined, marketCap: data.data.marketCap || undefined };
        }
      }
      return basicMetadata;
    } catch (error) {
      this.logger.debug(`Price data error for ${mintAddress}:`, error);
      return await this.getTokenMetadata(mintAddress);
    }
  }

  // Статистика и управление
  getCacheStats(): {
    totalCached: number;
    jupiterTokens: number;
    priceCacheSize: number;
    supplyCacheSize: number;
    fdvCacheSize: number;
    birdeyCacheSize: number;
    cacheHitRate: number;
    lastJupiterUpdate: Date | null;
  } {
    return {
      totalCached: this.cache.size,
      jupiterTokens: this.jupiterTokenList.size,
      priceCacheSize: this.priceCache.size,
      supplyCacheSize: this.supplyCache.size,
      fdvCacheSize: this.fdvCache.size,
      birdeyCacheSize: this.birdeyeCache.size,
      cacheHitRate: 0,
      lastJupiterUpdate: this.lastJupiterUpdate ? new Date(this.lastJupiterUpdate) : null
    };
  }

  clearCache(): void {
    this.cache.clear();
    this.priceCache.clear();
    this.supplyCache.clear();
    this.fdvCache.clear();
    this.birdeyeCache.clear();
    this.logger.info('🧹 All caches cleared');
  }

  async forceUpdateJupiterList(): Promise<void> {
    this.lastJupiterUpdate = 0;
    await this.updateJupiterTokenList();
  }

  // Type Guards
  private isJupiterQuoteResponse(data: any): data is JupiterQuoteResponse {
    return data && typeof data === 'object' && typeof data.inputMint === 'string' && typeof data.outputMint === 'string';
  }

  private isBirdeyeTokenListResponse(data: any): data is BirdeyeTokenListResponse {
    return data && typeof data === 'object' && data.data && typeof data.data === 'object' && Array.isArray(data.data.tokens);
  }

  private isBirdeyePriceResponse(data: any): data is BirdeyePriceResponse {
    return data && typeof data === 'object' && data.data && typeof data.data === 'object' && typeof data.data.value === 'number';
  }

  private isSolanaTokenListResponse(data: any): data is SolanaTokenListResponse {
    return data && typeof data === 'object' && Array.isArray(data.tokens);
  }

  private isJupiterTokenData(data: any): data is JupiterTokenData {
    return data && typeof data === 'object' && typeof data.address === 'string' && 
           typeof data.symbol === 'string' && typeof data.name === 'string' && typeof data.decimals === 'number';
  }
}