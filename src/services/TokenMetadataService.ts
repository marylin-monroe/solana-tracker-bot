// src/services/TokenMetadataService.ts - ПОЛНЫЙ ФАЙЛ с добавленным getTokenPrice()
import { Logger } from '../utils/Logger';

interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  address: string;
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

// API Response interfaces
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
  version: {
    major: number;
    minor: number;
    patch: number;
  };
}

export class TokenMetadataService {
  private logger: Logger;
  private cache = new Map<string, { metadata: TokenMetadata; timestamp: number }>();
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 часа
  private jupiterTokenList: Map<string, JupiterTokenData> = new Map();
  private lastJupiterUpdate = 0;
  private readonly JUPITER_UPDATE_INTERVAL = 60 * 60 * 1000; // 1 час

  // 🆕 КЕШ ДЛЯ ЦЕН ТОКЕНОВ
  private priceCache = new Map<string, { price: number; timestamp: number }>();
  private readonly PRICE_CACHE_DURATION = 5 * 60 * 1000; // 5 минут

  // Известные токены для быстрого доступа
  private readonly WELL_KNOWN_TOKENS = new Map<string, TokenMetadata>([
    ['So11111111111111111111111111111111111111112', {
      symbol: 'SOL',
      name: 'Solana',
      decimals: 9,
      address: 'So11111111111111111111111111111111111111112'
    }],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    }],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    }],
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', {
      symbol: 'BONK',
      name: 'Bonk',
      decimals: 5,
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
    }],
    ['7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', {
      symbol: 'WIF',
      name: 'dogwifhat',
      decimals: 6,
      address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'
    }]
  ]);

  constructor() {
    this.logger = Logger.getInstance();
    this.logger.info('🏷️ TokenMetadataService initialized (Jupiter + Birdeye APIs, NO HELIUS)');
  }

  /**
   * 🎯 ОСНОВНОЙ МЕТОД: Получение метаданных токена
   */
  async getTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') {
        return null;
      }

      // 1. Проверяем кеш
      const cached = this.getCachedMetadata(mintAddress);
      if (cached) {
        return cached;
      }

      // 2. Проверяем известные токены
      const wellKnown = this.WELL_KNOWN_TOKENS.get(mintAddress);
      if (wellKnown) {
        this.setCachedMetadata(mintAddress, wellKnown);
        return wellKnown;
      }

      // 3. Получаем из Jupiter
      const jupiterData = await this.getFromJupiter(mintAddress);
      if (jupiterData) {
        this.setCachedMetadata(mintAddress, jupiterData);
        return jupiterData;
      }

      // 4. Получаем из Birdeye
      const birdeyeData = await this.getFromBirdeye(mintAddress);
      if (birdeyeData) {
        this.setCachedMetadata(mintAddress, birdeyeData);
        return birdeyeData;
      }

      // 5. Получаем из Solana Token List
      const tokenListData = await this.getFromSolanaTokenList(mintAddress);
      if (tokenListData) {
        this.setCachedMetadata(mintAddress, tokenListData);
        return tokenListData;
      }

      // 6. Fallback: создаем базовые метаданные
      const fallbackMetadata = this.createFallbackMetadata(mintAddress);
      this.setCachedMetadata(mintAddress, fallbackMetadata);
      return fallbackMetadata;

    } catch (error) {
      this.logger.error(`Error getting token metadata for ${mintAddress}:`, error);
      
      // При ошибке возвращаем fallback
      const fallbackMetadata = this.createFallbackMetadata(mintAddress);
      return fallbackMetadata;
    }
  }

  /**
   * 🔍 ПОЛУЧЕНИЕ ИЗ JUPITER API
   */
  private async getFromJupiter(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      // Обновляем список токенов Jupiter если нужно
      await this.updateJupiterTokenList();

      // Ищем в кешированном списке
      const jupiterToken = this.jupiterTokenList.get(mintAddress);
      if (jupiterToken) {
        return {
          symbol: jupiterToken.symbol,
          name: jupiterToken.name,
          decimals: jupiterToken.decimals,
          logoURI: jupiterToken.logoURI,
          address: mintAddress
        };
      }

      // Пытаемся получить через Quote API (может дать базовую информацию)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=So11111111111111111111111111111111111111112&amount=1000000`, {
        method: 'GET',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Smart-Money-Bot/1.0'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        
        // Type guard для проверки структуры ответа
        if (this.isJupiterQuoteResponse(data) && data.inputMint === mintAddress) {
          return {
            symbol: this.generateSymbolFromAddress(mintAddress),
            name: `Token ${mintAddress.slice(0, 8)}...`,
            decimals: 9, // Предполагаем стандартные 9 decimals
            address: mintAddress
          };
        }
      }

      return null;

    } catch (error) {
      this.logger.debug(`Jupiter API error for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 🔍 ПОЛУЧЕНИЕ ИЗ BIRDEYE API
   */
  private async getFromBirdeye(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://public-api.birdeye.so/public/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=50`, {
        method: 'GET',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Smart-Money-Bot/1.0'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        
        if (this.isBirdeyeTokenListResponse(data)) {
          const token = data.data.tokens.find((t: BirdeyeTokenData) => t.address === mintAddress);
          
          if (token) {
            return {
              symbol: token.symbol || this.generateSymbolFromAddress(mintAddress),
              name: token.name || `Token ${mintAddress.slice(0, 8)}...`,
              decimals: token.decimals || 9,
              logoURI: token.logoURI,
              address: mintAddress
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

  /**
   * 🔍 ПОЛУЧЕНИЕ ИЗ SOLANA TOKEN LIST
   */
  private async getFromSolanaTokenList(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch('https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/src/tokens/solana.tokenlist.json', {
        method: 'GET',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Smart-Money-Bot/1.0'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        
        if (this.isSolanaTokenListResponse(data)) {
          const token = data.tokens.find((t: SolanaTokenListEntry) => t.address === mintAddress);
          
          if (token) {
            return {
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              logoURI: token.logoURI,
              address: mintAddress
            };
          }
        }
      }

      return null;

    } catch (error) {
      this.logger.debug(`Solana Token List error for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 🔄 ОБНОВЛЕНИЕ СПИСКА ТОКЕНОВ JUPITER
   */
  private async updateJupiterTokenList(): Promise<void> {
    try {
      const now = Date.now();
      
      // Проверяем, нужно ли обновление
      if (now - this.lastJupiterUpdate < this.JUPITER_UPDATE_INTERVAL) {
        return;
      }

      this.logger.debug('🔄 Updating Jupiter token list...');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch('https://token.jup.ag/all', {
        method: 'GET',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Smart-Money-Bot/1.0'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        
        // Type guard для проверки массива токенов
        if (Array.isArray(data)) {
          const tokens: JupiterTokenData[] = data;
          
          // Очищаем старый список
          this.jupiterTokenList.clear();
          
          // Заполняем новыми данными
          for (const token of tokens) {
            if (this.isJupiterTokenData(token)) {
              this.jupiterTokenList.set(token.address, token);
            }
          }
          
          this.lastJupiterUpdate = now;
          this.logger.info(`✅ Updated Jupiter token list: ${tokens.length} tokens`);
        } else {
          this.logger.warn('⚠️ Jupiter API returned unexpected data format');
        }
      } else {
        this.logger.warn(`⚠️ Failed to update Jupiter token list: ${response.status}`);
      }

    } catch (error) {
      this.logger.error('Error updating Jupiter token list:', error);
    }
  }

  /**
   * 🔍 ПРОВЕРКА КЕША
   */
  private getCachedMetadata(mintAddress: string): TokenMetadata | null {
    const cached = this.cache.get(mintAddress);
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached.metadata;
    }
    
    if (cached) {
      this.cache.delete(mintAddress); // Удаляем устаревшую запись
    }
    
    return null;
  }

  /**
   * 💾 СОХРАНЕНИЕ В КЕШ
   */
  private setCachedMetadata(mintAddress: string, metadata: TokenMetadata): void {
    this.cache.set(mintAddress, {
      metadata,
      timestamp: Date.now()
    });
  }

  /**
   * 🆘 СОЗДАНИЕ FALLBACK МЕТАДАННЫХ
   */
  private createFallbackMetadata(mintAddress: string): TokenMetadata {
    return {
      symbol: this.generateSymbolFromAddress(mintAddress),
      name: `Token ${mintAddress.slice(0, 8)}...`,
      decimals: 9, // Стандартное значение для Solana
      address: mintAddress
    };
  }

  /**
   * 🔤 ГЕНЕРАЦИЯ СИМВОЛА ИЗ АДРЕСА
   */
  private generateSymbolFromAddress(address: string): string {
    if (!address || address.length < 6) {
      return 'UNKNOWN';
    }
    
    // Используем первые 6 символов адреса как символ
    return address.slice(0, 6).toUpperCase();
  }

  /**
   * 📊 ПОЛУЧЕНИЕ СТАТИСТИКИ КЕША
   */
  getCacheStats(): {
    totalCached: number;
    jupiterTokens: number;
    cacheHitRate: number;
    lastJupiterUpdate: Date | null;
    priceCacheSize: number;
  } {
    return {
      totalCached: this.cache.size,
      jupiterTokens: this.jupiterTokenList.size,
      cacheHitRate: 0, // Можно добавить отслеживание hit rate
      lastJupiterUpdate: this.lastJupiterUpdate ? new Date(this.lastJupiterUpdate) : null,
      priceCacheSize: this.priceCache.size
    };
  }

  /**
   * 🧹 ОЧИСТКА КЕША
   */
  clearCache(): void {
    this.cache.clear();
    this.priceCache.clear();
    this.logger.info('🧹 Token metadata cache cleared');
  }

  /**
   * 🔄 ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ JUPITER СПИСКА
   */
  async forceUpdateJupiterList(): Promise<void> {
    this.lastJupiterUpdate = 0; // Сбрасываем время последнего обновления
    await this.updateJupiterTokenList();
  }

  /**
   * 🎯 ПАКЕТНОЕ ПОЛУЧЕНИЕ МЕТАДАННЫХ
   */
  async getBatchTokenMetadata(mintAddresses: string[]): Promise<Map<string, TokenMetadata | null>> {
    const results = new Map<string, TokenMetadata | null>();
    
    // Обрабатываем пакетами по 10 токенов
    const batchSize = 10;
    for (let i = 0; i < mintAddresses.length; i += batchSize) {
      const batch = mintAddresses.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (address) => {
        const metadata = await this.getTokenMetadata(address);
        results.set(address, metadata);
      });
      
      await Promise.all(batchPromises);
      
      // Небольшая пауза между пакетами для соблюдения rate limits
      if (i + batchSize < mintAddresses.length) {
        await this.sleep(100);
      }
    }
    
    return results;
  }

  /**
   * 🔍 ПОИСК ТОКЕНА ПО СИМВОЛУ
   */
  findTokenBySymbol(symbol: string): TokenMetadata | null {
    // Ищем в известных токенах
    for (const [address, metadata] of this.WELL_KNOWN_TOKENS) {
      if (metadata.symbol.toLowerCase() === symbol.toLowerCase()) {
        return metadata;
      }
    }
    
    // Ищем в кешированных метаданных
    for (const [address, cached] of this.cache) {
      if (cached.metadata.symbol.toLowerCase() === symbol.toLowerCase()) {
        return cached.metadata;
      }
    }
    
    // Ищем в Jupiter списке
    for (const [address, token] of this.jupiterTokenList) {
      if (token.symbol.toLowerCase() === symbol.toLowerCase()) {
        return {
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          logoURI: token.logoURI,
          address: token.address
        };
      }
    }
    
    return null;
  }

  /**
   * ⏱️ УТИЛИТА ДЛЯ ЗАДЕРЖКИ
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 🔍 ПРОВЕРКА ВАЛИДНОСТИ АДРЕСА ТОКЕНА
   */
  isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') {
      return false;
    }
    
    // Базовая проверка формата Solana адреса
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    return solanaAddressRegex.test(address);
  }

  /**
   * 🎯 ПОЛУЧЕНИЕ ПОПУЛЯРНЫХ ТОКЕНОВ
   */
  getPopularTokens(): TokenMetadata[] {
    return Array.from(this.WELL_KNOWN_TOKENS.values());
  }

  /**
   * 📈 ПОЛУЧЕНИЕ МЕТАДАННЫХ С ЦЕНОЙ (через Birdeye)
   */
  async getTokenMetadataWithPrice(mintAddress: string): Promise<TokenMetadata & { price?: number; marketCap?: number } | null> {
    try {
      const basicMetadata = await this.getTokenMetadata(mintAddress);
      if (!basicMetadata) {
        return null;
      }

      // Пытаемся получить цену через Birdeye
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://public-api.birdeye.so/public/price?address=${mintAddress}`, {
        method: 'GET',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Smart-Money-Bot/1.0'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        
        if (this.isBirdeyePriceResponse(data)) {
          return {
            ...basicMetadata,
            price: data.data.value || undefined,
            marketCap: data.data.marketCap || undefined
          };
        }
      }

      return basicMetadata;

    } catch (error) {
      this.logger.debug(`Error getting price data for ${mintAddress}:`, error);
      const basicMetadata = await this.getTokenMetadata(mintAddress);
      return basicMetadata;
    }
  }

  /**
   * 💰 ПОЛУЧЕНИЕ ЦЕНЫ ТОКЕНА (новый метод для TelegramNotifier)
   */
  async getTokenPrice(tokenAddress: string): Promise<number | null> {
    try {
      if (!tokenAddress || tokenAddress === 'UNKNOWN') {
        return null;
      }

      // Проверяем кеш цен
      const cached = this.priceCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.PRICE_CACHE_DURATION) {
        return cached.price;
      }

      // Известные токены с фиксированными ценами
      if (tokenAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || // USDC
          tokenAddress === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') { // USDT
        const price = 1.0;
        this.priceCache.set(tokenAddress, { price, timestamp: Date.now() });
        return price;
      }

      // Получаем через Birdeye API
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://public-api.birdeye.so/public/price?address=${tokenAddress}`, {
        method: 'GET',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Smart-Money-Bot/1.0'
        },
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
      this.logger.debug(`Error getting token price for ${tokenAddress}:`, error);
      return null;
    }
  }

  /**
   * 🎯 ПАКЕТНОЕ ПОЛУЧЕНИЕ ЦЕН ТОКЕНОВ
   */
  async getBatchTokenPrices(tokenAddresses: string[]): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    
    // Обрабатываем пакетами по 5 токенов для соблюдения rate limits
    const batchSize = 5;
    for (let i = 0; i < tokenAddresses.length; i += batchSize) {
      const batch = tokenAddresses.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (address) => {
        const price = await this.getTokenPrice(address);
        results.set(address, price);
      });
      
      await Promise.all(batchPromises);
      
      // Пауза между пакетами для соблюдения rate limits
      if (i + batchSize < tokenAddresses.length) {
        await this.sleep(200);
      }
    }
    
    return results;
  }

  // Type Guards для проверки структуры API ответов
  private isJupiterQuoteResponse(data: any): data is JupiterQuoteResponse {
    return data && 
           typeof data === 'object' && 
           typeof data.inputMint === 'string' &&
           typeof data.outputMint === 'string';
  }

  private isBirdeyeTokenListResponse(data: any): data is BirdeyeTokenListResponse {
    return data && 
           typeof data === 'object' && 
           data.data &&
           typeof data.data === 'object' &&
           Array.isArray(data.data.tokens);
  }

  private isBirdeyePriceResponse(data: any): data is BirdeyePriceResponse {
    return data && 
           typeof data === 'object' && 
           data.data &&
           typeof data.data === 'object' &&
           typeof data.data.value === 'number';
  }

  private isSolanaTokenListResponse(data: any): data is SolanaTokenListResponse {
    return data && 
           typeof data === 'object' && 
           Array.isArray(data.tokens);
  }

  private isJupiterTokenData(data: any): data is JupiterTokenData {
    return data && 
           typeof data === 'object' && 
           typeof data.address === 'string' &&
           typeof data.symbol === 'string' &&
           typeof data.name === 'string' &&
           typeof data.decimals === 'number';
  }
}