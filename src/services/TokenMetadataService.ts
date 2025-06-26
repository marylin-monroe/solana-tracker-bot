// src/services/TokenMetadataService.ts - 🔥 ИСПРАВЛЕНО: Добавлены LST токены + оптимизация
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

  private readonly CACHE_TTL = {
    TOKEN_METADATA: 60 * 60 * 1000,      // 1 час
    PRICE_DATA: 5 * 60 * 1000,           // 5 минут
    FDV_DATA: 15 * 60 * 1000,            // 15 минут
    BIRDEYE_DATA: 30 * 60 * 1000,        // 30 минут
    SUPPLY_DATA: 60 * 60 * 1000,         // 1 час
    JUPITER_UPDATE: 60 * 60 * 1000       // 1 час
  };

  // Кеши
  private priceCache = new Map<string, { price: number; timestamp: number }>();
  private supplyCache = new Map<string, { supply: number; decimals: number; timestamp: number }>();
  private fdvCache = new Map<string, { fdv: number; timestamp: number }>();
  private birdeyeCache = new Map<string, { data: any; timestamp: number }>();

  // 🔥 ИСПРАВЛЕНО: Добавлены LST токены в известные токены
  private readonly WELL_KNOWN_TOKENS = new Map<string, TokenMetadata>([
    // Базовые токены
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
    
    // 🔥 LST токены (Liquid Staking Tokens)
    ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', {
      symbol: 'mSOL', name: 'Marinade Staked SOL', decimals: 9,
      address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
    }],
    ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', {
      symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9,
      address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
    }],
    ['7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', {
      symbol: 'stSOL', name: 'Lido Staked SOL', decimals: 9,
      address: '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn'
    }],
    ['bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', {
      symbol: 'bSOL', name: 'BlazeStake Staked SOL', decimals: 9,
      address: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'
    }],
    ['he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', {
      symbol: 'hSOL', name: 'Helius Staked SOL', decimals: 9,
      address: 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A'
    }],
    
    // Популярные токены
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', {
      symbol: 'BONK', name: 'Bonk', decimals: 5,
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
    }],
    ['7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', {
      symbol: 'WIF', name: 'dogwifhat', decimals: 6,
      address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'
    }],
    ['WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', {
      symbol: 'WEN', name: 'Wen Token', decimals: 5,
      address: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk'
    }],
    ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', {
      symbol: 'JUP', name: 'Jupiter', decimals: 6,
      address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
    }],
    
    // Дополнительные стейблкоины
    ['A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', {
      symbol: 'UXD', name: 'UXD Stablecoin', decimals: 6,
      address: 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM'
    }],
    ['USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', {
      symbol: 'USDH', name: 'USDH', decimals: 6,
      address: 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX'
    }]
  ]);

  constructor() {
    this.logger = Logger.getInstance();
    this.logger.info('🏷️ TokenMetadataService FIXED: LST tokens added + optimized caching');
  }

  // 🎯 ГЛАВНЫЙ МЕТОД: Получение метаданных с правильными decimals
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

      // Пробуем RPC для получения decimals
      const rpcMetadata = await this.getTokenMetadataFromRPC(mintAddress);
      if (rpcMetadata) {
        const enriched = await this.enrichTokenMetadata(rpcMetadata);
        this.setCachedMetadata(mintAddress, enriched);
        return enriched;
      }

      // Пробуем внешние источники
      const sources = [this.getFromJupiter(mintAddress), this.getFromBirdeye(mintAddress)];
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

  // 🔥 RPC метаданные с правильными decimals
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
      // Проверяем кеш сначала
      const cached = this.birdeyeCache.get(`token_${mintAddress}`);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.BIRDEYE_DATA) {
        return cached.data as TokenMetadata;
      }

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://public-api.birdeye.so/public/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=50`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Smart-Money-Bot/1.0' },
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json() as any;
        if (data?.data?.tokens && Array.isArray(data.data.tokens)) {
          const token = data.data.tokens.find((t: BirdeyeTokenData) => t.address === mintAddress);
          if (token) {
            const decimals = typeof token.decimals === 'number' && token.decimals >= 0 ? token.decimals : 9;
            const result = {
              symbol: token.symbol || this.generateSymbolFromAddress(mintAddress),
              name: token.name || `Token ${mintAddress.slice(0, 8)}...`,
              decimals, logoURI: token.logoURI, address: mintAddress
            };
            
            // 🔥 КЕШИРУЕМ результат
            this.birdeyeCache.set(`token_${mintAddress}`, { data: result, timestamp: Date.now() });
            return result;
          }
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`Birdeye API error for ${mintAddress}:`, error);
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

  // 🔥 ИСПРАВЛЕНО: Цена токена БЕЗ рекурсии
  async getTokenPrice(tokenAddress: string): Promise<number | null> {
    try {
      if (!tokenAddress || tokenAddress === 'UNKNOWN') return null;

      const cached = this.priceCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.PRICE_DATA) return cached.price;

      // Стейблкоины
      if (tokenAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || 
          tokenAddress === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' ||
          tokenAddress === 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM' ||
          tokenAddress === 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX') {
        this.priceCache.set(tokenAddress, { price: 1.0, timestamp: Date.now() });
        return 1.0;
      }

      // 🔥 ИСПРАВЛЕНО: Для всех остальных токенов (включая SOL) идем в Birdeye
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 секунд таймаут

      const response = await fetch(`https://public-api.birdeye.so/public/price?address=${tokenAddress}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Smart-Money-Bot/1.0' },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

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
      this.logger.warn(`Price API error for ${tokenAddress}:`, error);
      return null;
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

  // 🔥 FDV с кешированием
  async getTokenFDV(mintAddress: string): Promise<number | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') return null;

      const cached = this.fdvCache.get(mintAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL.FDV_DATA) return cached.fdv;

      const [price, supply] = await Promise.all([this.getTokenPrice(mintAddress), this.getTokenSupply(mintAddress)]);
      if (price && supply && price > 0 && supply > 0) {
        const fdv = price * supply;
        this.fdvCache.set(mintAddress, { fdv, timestamp: Date.now() });
        this.logger.debug(`💎 FDV calculated for ${mintAddress}: ${fdv.toLocaleString()}`);
        return fdv;
      }
      return null;
    } catch (error) {
      this.logger.debug(`FDV error for ${mintAddress}:`, error);
      return null;
    }
  }

  // Расширенная информация о токене
  async getEnhancedTokenInfo(mintAddress: string): Promise<{ symbol: string; name: string; decimals: number; price: number | null; totalSupply: number | null; fdv: number | null; marketCap: number | null; } | null> {
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

  // 🔥 Кешированные Birdeye данные
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

  // Статистика и управление
  getCacheStats(): {
    totalCached: number;
    jupiterTokens: number;
    priceCacheSize: number;
    supplyCacheSize: number;
    fdvCacheSize: number;
    birdeyCacheSize: number;
    lastJupiterUpdate: Date | null;
  } {
    return {
      totalCached: this.cache.size,
      jupiterTokens: this.jupiterTokenList.size,
      priceCacheSize: this.priceCache.size,
      supplyCacheSize: this.supplyCache.size,
      fdvCacheSize: this.fdvCache.size,
      birdeyCacheSize: this.birdeyeCache.size,
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
  private isBirdeyePriceResponse(data: any): data is BirdeyePriceResponse {
    return data && typeof data === 'object' && data.data && typeof data.data === 'object' && typeof data.data.value === 'number';
  }

  private isJupiterTokenData(data: any): data is JupiterTokenData {
    return data && typeof data === 'object' && typeof data.address === 'string' && 
           typeof data.symbol === 'string' && typeof data.name === 'string' && typeof data.decimals === 'number';
  }
}