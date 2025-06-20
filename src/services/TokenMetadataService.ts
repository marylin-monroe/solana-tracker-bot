// src/services/TokenMetadataService.ts - ENHANCED with FDV Support & API Efficiency + FIXED DECIMALS HANDLING
import { Logger } from '../utils/Logger';

interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number; // 🔥 КРИТИЧЕСКИ ВАЖНО для правильного расчета USD сумм
  logoURI?: string;
  address: string;
  totalSupply?: number; // For FDV calculation
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

// RPC Response interfaces
interface TokenSupplyResponse {
  context: {
    slot: number;
  };
  value: {
    amount: string;
    decimals: number;
    uiAmount: number;
    uiAmountString: string;
  };
}

// RPC JSON Response wrapper
interface RPCResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

// Enhanced token info with FDV
interface EnhancedTokenInfo {
  symbol: string;
  name: string;
  decimals: number; // 🔥 КРИТИЧЕСКИ ВАЖНО!
  price: number | null;
  totalSupply: number | null;
  fdv: number | null;  // Fully Diluted Valuation
  marketCap: number | null;
}

export class TokenMetadataService {
  private logger: Logger;
  private cache = new Map<string, { metadata: TokenMetadata; timestamp: number }>();
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  private jupiterTokenList: Map<string, JupiterTokenData> = new Map();
  private lastJupiterUpdate = 0;
  private readonly JUPITER_UPDATE_INTERVAL = 60 * 60 * 1000; // 1 hour

  // Price cache
  private priceCache = new Map<string, { price: number; timestamp: number }>();
  private readonly PRICE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Supply cache для FDV расчетов с ОБЯЗАТЕЛЬНЫМИ decimals
  private supplyCache = new Map<string, { supply: number; decimals: number; timestamp: number }>();
  private readonly SUPPLY_CACHE_DURATION = 60 * 60 * 1000; // 1 hour (supply меняется редко)

  // FDV cache
  private fdvCache = new Map<string, { fdv: number; timestamp: number }>();
  private readonly FDV_CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

  // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Известные токены с ОБЯЗАТЕЛЬНЫМИ decimals
  private readonly WELL_KNOWN_TOKENS = new Map<string, TokenMetadata>([
    ['So11111111111111111111111111111111111111112', {
      symbol: 'SOL',
      name: 'Solana',
      decimals: 9, // 🔥 КРИТИЧЕСКИ ВАЖНО: SOL имеет 9 decimals
      address: 'So11111111111111111111111111111111111111112',
      totalSupply: 588_000_000 // Approximate SOL supply
    }],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6, // 🔥 КРИТИЧЕСКИ ВАЖНО: USDC имеет 6 decimals
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    }],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6, // 🔥 КРИТИЧЕСКИ ВАЖНО: USDT имеет 6 decimals
      address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    }],
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', {
      symbol: 'BONK',
      name: 'Bonk',
      decimals: 5, // 🔥 КРИТИЧЕСКИ ВАЖНО: BONK имеет 5 decimals
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
    }],
    ['7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', {
      symbol: 'WIF',
      name: 'dogwifhat',
      decimals: 6, // 🔥 КРИТИЧЕСКИ ВАЖНО: WIF имеет 6 decimals
      address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'
    }]
  ]);

  constructor() {
    this.logger = Logger.getInstance();
    this.logger.info('🏷️ TokenMetadataService initialized (🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: ПРАВИЛЬНАЯ РАБОТА С DECIMALS)');
  }

  /**
   * 🎯 ГЛАВНЫЙ МЕТОД: Получение метаданных токена с ОБЯЗАТЕЛЬНЫМИ decimals
   */
  async getTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') {
        return null;
      }

      // 1. Проверяем кеш
      const cached = this.getCachedMetadata(mintAddress);
      if (cached) {
        // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем, что у кешированной версии есть decimals
        if (typeof cached.decimals === 'number' && cached.decimals >= 0) {
          return cached;
        } else {
          // Если нет decimals - удаляем из кеша и перезапрашиваем
          this.cache.delete(mintAddress);
        }
      }

      // 2. Проверяем известные токены
      const wellKnown = this.WELL_KNOWN_TOKENS.get(mintAddress);
      if (wellKnown) {
        this.setCachedMetadata(mintAddress, wellKnown);
        return wellKnown;
      }

      // 3. 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Получаем decimals через RPC ПЕРВЫМ ДЕЛОМ
      const rpcMetadata = await this.getTokenMetadataFromRPC(mintAddress);
      if (rpcMetadata) {
        // Обогащаем RPC данные через API
        const enrichedMetadata = await this.enrichTokenMetadata(rpcMetadata);
        this.setCachedMetadata(mintAddress, enrichedMetadata);
        return enrichedMetadata;
      }

      // 4. Получаем из Jupiter
      const jupiterData = await this.getFromJupiter(mintAddress);
      if (jupiterData && typeof jupiterData.decimals === 'number') {
        this.setCachedMetadata(mintAddress, jupiterData);
        return jupiterData;
      }

      // 5. Получаем из Birdeye
      const birdeyeData = await this.getFromBirdeye(mintAddress);
      if (birdeyeData && typeof birdeyeData.decimals === 'number') {
        this.setCachedMetadata(mintAddress, birdeyeData);
        return birdeyeData;
      }

      // 6. Получаем из Solana Token List
      const tokenListData = await this.getFromSolanaTokenList(mintAddress);
      if (tokenListData && typeof tokenListData.decimals === 'number') {
        this.setCachedMetadata(mintAddress, tokenListData);
        return tokenListData;
      }

      // 7. Fallback: создаем базовые метаданные с decimals по умолчанию
      const fallbackMetadata = this.createFallbackMetadata(mintAddress);
      this.setCachedMetadata(mintAddress, fallbackMetadata);
      return fallbackMetadata;

    } catch (error) {
      this.logger.error(`Error getting token metadata for ${mintAddress}:`, error);
      
      // При ошибке возвращаем fallback с обязательными decimals
      const fallbackMetadata = this.createFallbackMetadata(mintAddress);
      return fallbackMetadata;
    }
  }

  /**
   * 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Получение метаданных токена через RPC с decimals
   */
  private async getTokenMetadataFromRPC(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      // Получаем через RPC API
      const rpcUrl = process.env.QUICKNODE_HTTP_URL || process.env.ALCHEMY_HTTP_URL;
      if (!rpcUrl) {
        this.logger.debug('No RPC URL available for getTokenMetadataFromRPC');
        return null;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [
            mintAddress,
            {
              encoding: 'jsonParsed',
              commitment: 'confirmed'
            }
          ]
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json() as RPCResponse;
        
        if (data.result && data.result.value && data.result.value.data) {
          const accountData = data.result.value.data;
          
          // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Безопасное извлечение decimals
          if (accountData.parsed && accountData.parsed.info) {
            const info = accountData.parsed.info;
            const decimals = this.safeGetNumberValue(info.decimals, 9);
            
            // Проверяем, что decimals в разумных пределах (0-18)
            if (decimals >= 0 && decimals <= 18) {
              this.logger.debug(`📊 Got RPC metadata for ${mintAddress}: decimals=${decimals}`);
              
              return {
                symbol: this.generateSymbolFromAddress(mintAddress),
                name: `Token ${mintAddress.slice(0, 8)}...`,
                decimals: decimals, // 🔥 КРИТИЧЕСКИ ВАЖНО!
                address: mintAddress,
                totalSupply: this.safeGetNumberValue(info.supply, undefined)
              };
            }
          }
        }
      }

      return null;

    } catch (error) {
      this.logger.debug(`Error getting RPC metadata for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Обогащение базовых метаданных через API
   */
  private async enrichTokenMetadata(baseMetadata: TokenMetadata): Promise<TokenMetadata> {
    try {
      // Пытаемся получить более полную информацию из Jupiter
      const jupiterData = await this.getFromJupiter(baseMetadata.address);
      if (jupiterData && jupiterData.symbol && jupiterData.symbol !== this.generateSymbolFromAddress(baseMetadata.address)) {
        return {
          ...baseMetadata,
          symbol: jupiterData.symbol,
          name: jupiterData.name,
          logoURI: jupiterData.logoURI,
          decimals: baseMetadata.decimals // 🔥 СОХРАНЯЕМ decimals из RPC!
        };
      }

      // Пытаемся получить из Birdeye
      const birdeyeData = await this.getFromBirdeye(baseMetadata.address);
      if (birdeyeData && birdeyeData.symbol && birdeyeData.symbol !== this.generateSymbolFromAddress(baseMetadata.address)) {
        return {
          ...baseMetadata,
          symbol: birdeyeData.symbol,
          name: birdeyeData.name,
          logoURI: birdeyeData.logoURI,
          decimals: baseMetadata.decimals // 🔥 СОХРАНЯЕМ decimals из RPC!
        };
      }

      // Если обогащение не удалось - возвращаем базовые метаданные
      return baseMetadata;

    } catch (error) {
      this.logger.debug('Error enriching token metadata:', error);
      return baseMetadata;
    }
  }

  /**
   * 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Получение Total Supply токена через RPC с decimals
   */
  async getTokenSupply(mintAddress: string): Promise<number | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') {
        return null;
      }

      // Проверяем кеш supply
      const cached = this.supplyCache.get(mintAddress);
      if (cached && Date.now() - cached.timestamp < this.SUPPLY_CACHE_DURATION) {
        return cached.supply;
      }

      // Известные токены с фиксированным supply
      const wellKnown = this.WELL_KNOWN_TOKENS.get(mintAddress);
      if (wellKnown?.totalSupply) {
        this.supplyCache.set(mintAddress, {
          supply: wellKnown.totalSupply,
          decimals: wellKnown.decimals, // 🔥 СОХРАНЯЕМ decimals
          timestamp: Date.now()
        });
        return wellKnown.totalSupply;
      }

      // Получаем через RPC API
      const rpcUrl = process.env.QUICKNODE_HTTP_URL || process.env.ALCHEMY_HTTP_URL;
      if (!rpcUrl) {
        this.logger.debug('No RPC URL available for getTokenSupply');
        return null;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenSupply',
          params: [mintAddress]
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json() as RPCResponse;
        
        if (data.result && data.result.value) {
          // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Используем uiAmount (уже с учетом decimals)
          const supply = parseFloat(data.result.value.uiAmountString || data.result.value.uiAmount);
          const decimals = data.result.value.decimals;

          if (supply > 0 && typeof decimals === 'number') {
            // Кешируем результат с decimals
            this.supplyCache.set(mintAddress, {
              supply,
              decimals, // 🔥 КРИТИЧЕСКИ ВАЖНО сохранить decimals
              timestamp: Date.now()
            });
            
            this.logger.debug(`📊 Got token supply for ${mintAddress}: ${supply.toLocaleString()} (decimals: ${decimals})`);
            return supply;
          }
        }
      }

      return null;

    } catch (error) {
      this.logger.debug(`Error getting token supply for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Получение FDV (Fully Diluted Valuation) с правильными decimals
   */
  async getTokenFDV(mintAddress: string): Promise<number | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') {
        return null;
      }

      // Проверяем кеш FDV
      const cached = this.fdvCache.get(mintAddress);
      if (cached && Date.now() - cached.timestamp < this.FDV_CACHE_DURATION) {
        return cached.fdv;
      }

      // Получаем цену и supply параллельно для эффективности
      const [price, supply] = await Promise.all([
        this.getTokenPrice(mintAddress),
        this.getTokenSupply(mintAddress)
      ]);

      if (price && supply && price > 0 && supply > 0) {
        // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: supply уже учитывает decimals (uiAmount)
        const fdv = price * supply;
        
        // Кешируем результат
        this.fdvCache.set(mintAddress, {
          fdv,
          timestamp: Date.now()
        });

        this.logger.debug(`💎 Calculated FDV for ${mintAddress}: $${fdv.toLocaleString()}`);
        return fdv;
      }

      return null;

    } catch (error) {
      this.logger.debug(`Error calculating FDV for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Пакетное получение FDV для нескольких токенов
   */
  async getBatchTokenFDV(mintAddresses: string[]): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    
    // Обрабатываем пакетами по 3 токена для соблюдения API limits
    const batchSize = 3;
    for (let i = 0; i < mintAddresses.length; i += batchSize) {
      const batch = mintAddresses.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (address) => {
        const fdv = await this.getTokenFDV(address);
        results.set(address, fdv);
      });
      
      await Promise.all(batchPromises);
      
      // Пауза между пакетами для соблюдения rate limits
      if (i + batchSize < mintAddresses.length) {
        await this.sleep(300);
      }
    }
    
    return results;
  }

  /**
   * 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Расширенная информация о токене с ОБЯЗАТЕЛЬНЫМИ decimals
   */
  async getEnhancedTokenInfo(mintAddress: string): Promise<EnhancedTokenInfo | null> {
    try {
      if (!mintAddress || mintAddress === 'UNKNOWN') {
        return null;
      }

      // Получаем все данные параллельно для максимальной эффективности
      const [metadata, price, supply] = await Promise.all([
        this.getTokenMetadata(mintAddress),
        this.getTokenPrice(mintAddress),
        this.getTokenSupply(mintAddress)
      ]);

      if (!metadata) {
        return null;
      }

      // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем, что decimals есть и валидны
      if (typeof metadata.decimals !== 'number' || metadata.decimals < 0) {
        this.logger.warn(`⚠️ Invalid decimals for token ${mintAddress}: ${metadata.decimals}`);
        metadata.decimals = 9; // Fallback
      }

      // Расчет FDV (supply уже учитывает decimals)
      let fdv: number | null = null;
      if (price && supply && price > 0 && supply > 0) {
        fdv = price * supply;
      }

      // Market Cap может быть получен из Birdeye, если доступен
      let marketCap: number | null = null;
      try {
        const birdeyeData = await this.getBirdeyeMarketData(mintAddress);
        marketCap = birdeyeData?.marketCap || null;
      } catch (error) {
        // Не критично, продолжаем без market cap
      }

      return {
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals, // 🔥 КРИТИЧЕСКИ ВАЖНО!
        price,
        totalSupply: supply,
        fdv,
        marketCap
      };

    } catch (error) {
      this.logger.error(`Error getting enhanced token info for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 🔍 ПОЛУЧЕНИЕ ИЗ JUPITER API с правильными decimals
   */
  private async getFromJupiter(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      // Обновляем список токенов Jupiter если нужно
      await this.updateJupiterTokenList();

      // Ищем в кешированном списке
      const jupiterToken = this.jupiterTokenList.get(mintAddress);
      if (jupiterToken) {
        // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем decimals
        const decimals = typeof jupiterToken.decimals === 'number' && jupiterToken.decimals >= 0 
          ? jupiterToken.decimals 
          : 9; // Fallback

        return {
          symbol: jupiterToken.symbol,
          name: jupiterToken.name,
          decimals: decimals, // 🔥 КРИТИЧЕСКИ ВАЖНО!
          logoURI: jupiterToken.logoURI,
          address: mintAddress
        };
      }

      return null;

    } catch (error) {
      this.logger.debug(`Jupiter API error for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 🔍 ПОЛУЧЕНИЕ ИЗ BIRDEYE API с правильными decimals
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
            // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем decimals
            const decimals = typeof token.decimals === 'number' && token.decimals >= 0 
              ? token.decimals 
              : 9; // Fallback

            return {
              symbol: token.symbol || this.generateSymbolFromAddress(mintAddress),
              name: token.name || `Token ${mintAddress.slice(0, 8)}...`,
              decimals: decimals, // 🔥 КРИТИЧЕСКИ ВАЖНО!
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
   * 🔍 ПОЛУЧЕНИЕ ИЗ SOLANA TOKEN LIST с правильными decimals
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
            // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем decimals
            const decimals = typeof token.decimals === 'number' && token.decimals >= 0 
              ? token.decimals 
              : 9; // Fallback

            return {
              symbol: token.symbol,
              name: token.name,
              decimals: decimals, // 🔥 КРИТИЧЕСКИ ВАЖНО!
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
   * 🔄 ОБНОВЛЕНИЕ СПИСКА ТОКЕНОВ JUPITER с проверкой decimals
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
          
          // Заполняем новыми данными с проверкой decimals
          for (const token of tokens) {
            if (this.isJupiterTokenData(token)) {
              // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем валидность decimals
              if (typeof token.decimals === 'number' && token.decimals >= 0 && token.decimals <= 18) {
                this.jupiterTokenList.set(token.address, token);
              } else {
                // Логируем токены с невалидными decimals
                this.logger.debug(`⚠️ Jupiter token ${token.address} has invalid decimals: ${token.decimals}`);
              }
            }
          }
          
          this.lastJupiterUpdate = now;
          this.logger.info(`✅ Updated Jupiter token list: ${this.jupiterTokenList.size} valid tokens`);
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
   * 💰 ПОЛУЧЕНИЕ ЦЕНЫ ТОКЕНА (существующий метод без изменений)
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
   * 🎯 ПАКЕТНОЕ ПОЛУЧЕНИЕ ЦЕН ТОКЕНОВ (существующий метод без изменений)
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

  /**
   * 🔍 ПОЛУЧЕНИЕ MARKET DATA из Birdeye
   */
  private async getBirdeyeMarketData(mintAddress: string): Promise<{ marketCap?: number } | null> {
    try {
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
            marketCap: data.data.marketCap
          };
        }
      }

      return null;

    } catch (error) {
      this.logger.debug(`Birdeye market data error for ${mintAddress}:`, error);
      return null;
    }
  }

  // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

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
   * 🆘 СОЗДАНИЕ FALLBACK МЕТАДАННЫХ с обязательными decimals
   */
  private createFallbackMetadata(mintAddress: string): TokenMetadata {
    return {
      symbol: this.generateSymbolFromAddress(mintAddress),
      name: `Token ${mintAddress.slice(0, 8)}...`,
      decimals: 9, // 🔥 КРИТИЧЕСКИ ВАЖНО: Стандартное значение для Solana
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
   * 🔢 БЕЗОПАСНОЕ ПОЛУЧЕНИЕ ЧИСЛОВОГО ЗНАЧЕНИЯ
   */
  private safeGetNumberValue(value: any, defaultValue: number = 0): number {
    if (typeof value === 'number' && !isNaN(value) && isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && isFinite(parsed)) {
        return parsed;
      }
    }
    return defaultValue;
  }

  /**
   * ⏱️ УТИЛИТА ДЛЯ ЗАДЕРЖКИ
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ========== ОСТАЛЬНЫЕ СУЩЕСТВУЮЩИЕ МЕТОДЫ ==========

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
          decimals: token.decimals, // 🔥 КРИТИЧЕСКИ ВАЖНО!
          logoURI: token.logoURI,
          address: token.address
        };
      }
    }
    
    return null;
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
   * 📈 ПОЛУЧЕНИЕ МЕТАДАННЫХ С ЦЕНОЙ
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
   * 📊 ПОЛУЧЕНИЕ РАСШИРЕННОЙ СТАТИСТИКИ КЕША
   */
  getCacheStats(): {
    totalCached: number;
    jupiterTokens: number;
    priceCacheSize: number;
    supplyCacheSize: number;
    fdvCacheSize: number;
    cacheHitRate: number;
    lastJupiterUpdate: Date | null;
  } {
    return {
      totalCached: this.cache.size,
      jupiterTokens: this.jupiterTokenList.size,
      priceCacheSize: this.priceCache.size,
      supplyCacheSize: this.supplyCache.size,
      fdvCacheSize: this.fdvCache.size,
      cacheHitRate: 0, // Можно добавить отслеживание hit rate
      lastJupiterUpdate: this.lastJupiterUpdate ? new Date(this.lastJupiterUpdate) : null
    };
  }

  /**
   * 🧹 РАСШИРЕННАЯ ОЧИСТКА КЕША
   */
  clearCache(): void {
    this.cache.clear();
    this.priceCache.clear();
    this.supplyCache.clear();
    this.fdvCache.clear();
    this.logger.info('🧹 All token metadata caches cleared');
  }

  /**
   * 🔄 ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ JUPITER СПИСКА
   */
  async forceUpdateJupiterList(): Promise<void> {
    this.lastJupiterUpdate = 0; // Сбрасываем время последнего обновления
    await this.updateJupiterTokenList();
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