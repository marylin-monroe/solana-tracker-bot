// src/services/TokenMetadataService.ts - ИСПРАВЛЕНО: убраны все дублирования переменных
// Замена Helius API на Jupiter/Birdeye API

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
}

export class TokenMetadataService {
  private logger: Logger;
  private cache = new Map<string, { metadata: TokenMetadata; timestamp: number }>();
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 часа
  private jupiterTokenList: Map<string, JupiterTokenData> = new Map();
  private lastJupiterUpdate = 0;
  private readonly JUPITER_UPDATE_INTERVAL = 60 * 60 * 1000; // 1 час

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
    }]
  ]);

  constructor() {
    this.logger = Logger.getInstance();
    this.logger.info('🏷️ TokenMetadataService initialized (Jupiter + Birdeye APIs)');
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

      // 5. Возвращаем fallback
      const fallback: TokenMetadata = {
        symbol: `${mintAddress.slice(0, 8)}...`,
        name: 'Unknown Token',
        decimals: 9,
        address: mintAddress
      };
      
      this.setCachedMetadata(mintAddress, fallback);
      return fallback;

    } catch (error) {
      this.logger.error(`❌ Error getting token metadata for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 🚀 Jupiter API - основной источник данных
   */
  private async getFromJupiter(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      // Обновляем список токенов Jupiter если нужно
      await this.updateJupiterTokenList();

      // Ищем токен в списке
      const tokenData = this.jupiterTokenList.get(mintAddress);
      if (tokenData) {
        return {
          symbol: tokenData.symbol || 'UNKNOWN',
          name: tokenData.name || 'Unknown Token',
          decimals: tokenData.decimals || 9,
          logoURI: tokenData.logoURI,
          address: mintAddress
        };
      }

      return null;

    } catch (error) {
      this.logger.warn(`⚠️ Jupiter API error for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 🦅 Birdeye API - резервный источник данных
   */
  private async getFromBirdeye(mintAddress: string): Promise<TokenMetadata | null> {
    try {
      const response = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mintAddress}`, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'User-Agent': 'Smart-Money-Bot/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const birdeyeResponse = await response.json();
      const apiData = birdeyeResponse as any;
      
      if (apiData && apiData.data) {
        const tokenInfo = apiData.data;
        return {
          symbol: tokenInfo.symbol || 'UNKNOWN',
          name: tokenInfo.name || 'Unknown Token',
          decimals: tokenInfo.decimals || 9,
          logoURI: tokenInfo.logoURI,
          address: mintAddress
        };
      }

      return null;

    } catch (error) {
      this.logger.warn(`⚠️ Birdeye API error for ${mintAddress}:`, error);
      return null;
    }
  }

  /**
   * 📋 Обновление списка токенов Jupiter
   */
  private async updateJupiterTokenList(): Promise<void> {
    const now = Date.now();
    
    // Обновляем не чаще раза в час
    if (now - this.lastJupiterUpdate < this.JUPITER_UPDATE_INTERVAL && this.jupiterTokenList.size > 0) {
      return;
    }

    try {
      this.logger.info('🔄 Updating Jupiter token list...');

      const response = await fetch('https://token.jup.ag/all', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'User-Agent': 'Smart-Money-Bot/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const jupiterResponse = await response.json();
      const tokens: JupiterTokenData[] = Array.isArray(jupiterResponse) ? jupiterResponse : [];
      
      // Обновляем карту токенов
      this.jupiterTokenList.clear();
      for (const token of tokens) {
        if (token.address && token.symbol) {
          this.jupiterTokenList.set(token.address, token);
        }
      }

      this.lastJupiterUpdate = now;
      this.logger.info(`✅ Updated Jupiter token list: ${this.jupiterTokenList.size} tokens`);

    } catch (error) {
      this.logger.error('❌ Failed to update Jupiter token list:', error);
    }
  }

  /**
   * 💾 Кеширование метаданных
   */
  private getCachedMetadata(mintAddress: string): TokenMetadata | null {
    const cached = this.cache.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached.metadata;
    }
    return null;
  }

  private setCachedMetadata(mintAddress: string, metadata: TokenMetadata): void {
    this.cache.set(mintAddress, {
      metadata,
      timestamp: Date.now()
    });

    // Очищаем старые записи если кеш становится слишком большим
    if (this.cache.size > 10000) {
      const now = Date.now();
      for (const [key, value] of this.cache.entries()) {
        if (now - value.timestamp > this.CACHE_DURATION) {
          this.cache.delete(key);
        }
      }
    }
  }

  /**
   * 🎯 Массовое получение метаданных (для оптимизации)
   */
  async getMultipleTokenMetadata(mintAddresses: string[]): Promise<Map<string, TokenMetadata>> {
    const results = new Map<string, TokenMetadata>();
    
    // Обновляем Jupiter список один раз
    await this.updateJupiterTokenList();

    // Получаем метаданные для каждого токена
    const promises = mintAddresses.map(async (address) => {
      const metadata = await this.getTokenMetadata(address);
      if (metadata) {
        results.set(address, metadata);
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  /**
   * 📊 Статистика сервиса
   */
  getStats(): {
    cacheSize: number;
    jupiterTokens: number;
    lastJupiterUpdate: Date | null;
    wellKnownTokens: number;
  } {
    return {
      cacheSize: this.cache.size,
      jupiterTokens: this.jupiterTokenList.size,
      lastJupiterUpdate: this.lastJupiterUpdate > 0 ? new Date(this.lastJupiterUpdate) : null,
      wellKnownTokens: this.WELL_KNOWN_TOKENS.size
    };
  }

  /**
   * 🧹 Очистка кеша
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.info('🧹 Token metadata cache cleared');
  }

  /**
   * 🔄 Принудительное обновление Jupiter списка
   */
  async forceUpdateJupiterList(): Promise<boolean> {
    this.lastJupiterUpdate = 0; // Сбрасываем время последнего обновления
    try {
      await this.updateJupiterTokenList();
      return true;
    } catch (error) {
      return false;
    }
  }
}