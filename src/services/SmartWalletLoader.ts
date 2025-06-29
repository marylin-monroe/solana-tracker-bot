// src/services/SmartWalletLoader.ts - 🔥 ПОЛНОСТЬЮ ИСПРАВЛЕН под новую структуру CSV
import fs from 'fs';
import path from 'path';
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { Logger } from '../utils/Logger';
import { SmartMoneyWallet } from '../types';

// 🔥 НОВЫЙ ИНТЕРФЕЙС ПОД НОВУЮ СТРУКТУРУ CSV
interface WalletConfig {
  address: string;
  category: 'sniper' | 'hunter' | 'trader';
  nickname: string;
  description: string;
  addedBy: 'manual' | 'discovery' | 'placeholder';
  addedAt: string;
  verified: boolean;
  
  // 🔥 ОБНОВЛЕННЫЕ МЕТРИКИ ПОД CSV СТРУКТУРУ
  usdProfit7d: number;
  usdProfit30d: number;
  winrate7d: number;
  buy7d: number;
  avgHoldingMins: number;
  totalProfitPercent: number;
  solBalance: number;
  
  performanceScore: number;
  minTradeAlert: number;
  priority: 'high' | 'medium' | 'low';
  enabled: boolean;
}

interface SmartWalletsConfig {
  version: string;
  lastUpdated: string;
  description: string;
  totalWallets: number;
  wallets: WalletConfig[];
  discovery: {
    autoDiscoveryEnabled: boolean;
    maxWallets: number;
    minPerformanceScore: number;
    discoveryInterval: string;
    lastDiscovery: string | null;
  };
  filters: {
    minWinrate7d: number;
    minUsdProfit7d: number;
    minBuy7d: number;
    maxInactiveDays: number;
  };
}

export class SmartWalletLoader {
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private logger: Logger;
  private configPath: string;
  private config: SmartWalletsConfig | null = null;

  constructor(smDatabase: SmartMoneyDatabase, telegramNotifier: TelegramNotifier) {
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.logger = Logger.getInstance();
    this.configPath = path.join(process.cwd(), 'data', 'smart_wallets.json');
  }

  // 🔥 HARDCODED кошельки - ПОЛНОСТЬЮ ОБНОВЛЕНЫ под новую структуру
  private getHardcodedWallets(): WalletConfig[] {
    return [
      {
        address: "3NgFx68GWTcoreJyJear9yLxQBmjccXAYaUphq5h9PEJ",
        category: "sniper",
        nickname: "Alpha Sniper",
        description: "High-performance sniper wallet with excellent timing",
        addedBy: "manual",
        addedAt: "2025-06-13T09:00:00.000Z",
        verified: true,
        // 🔥 НОВЫЕ МЕТРИКИ
        usdProfit7d: 45000,
        usdProfit30d: 165000,
        winrate7d: 82.4,
        buy7d: 12,
        avgHoldingMins: 45,
        totalProfitPercent: 28.5,
        solBalance: 85.2,
        performanceScore: 88,
        minTradeAlert: 2000,
        priority: "high",
        enabled: true
      },
      {
        address: "G5nxEXuFMfV74DSnsrSatqCW32F34XUnBeq3PfDS7w5E",
        category: "hunter",
        nickname: "Token Hunter Pro",
        description: "Professional token hunter with strong analytics",
        addedBy: "manual",
        addedAt: "2025-06-13T09:00:00.000Z",
        verified: true,
        usdProfit7d: 38000,
        usdProfit30d: 142000,
        winrate7d: 76.8,
        buy7d: 8,
        avgHoldingMins: 180,
        totalProfitPercent: 24.1,
        solBalance: 156.7,
        performanceScore: 84,
        minTradeAlert: 3000,
        priority: "high",
        enabled: true
      },
      {
        address: "9peW76TTRt5dp4wiQid8dw2pmxpwpN5eXZ15bmLBNCsx",
        category: "trader",
        nickname: "Momentum Trader",
        description: "Skilled momentum trader with consistent profits",
        addedBy: "manual",
        addedAt: "2025-06-13T09:00:00.000Z",
        verified: true,
        usdProfit7d: 52000,
        usdProfit30d: 198000,
        winrate7d: 71.2,
        buy7d: 5,
        avgHoldingMins: 320,
        totalProfitPercent: 31.8,
        solBalance: 234.3,
        performanceScore: 81,
        minTradeAlert: 5000,
        priority: "high",
        enabled: true
      },
      {
        address: "4kVx7J5Q3A8k2B6N9Mwz1XcPdE7fRhYtUiNmBvCaZsWx",
        category: "sniper",
        nickname: "Quick Draw",
        description: "Lightning-fast sniper with high win rate",
        addedBy: "manual",
        addedAt: "2025-06-13T09:00:00.000Z",
        verified: true,
        usdProfit7d: 41000,
        usdProfit30d: 178000,
        winrate7d: 85.7,
        buy7d: 15,
        avgHoldingMins: 38,
        totalProfitPercent: 26.9,
        solBalance: 67.4,
        performanceScore: 89,
        minTradeAlert: 1500,
        priority: "high",
        enabled: true
      },
      {
        address: "7mPqRsKjL9N3xFvYwZbCt8aE2BgHu6MqWx5DyTcVnUiJ",
        category: "hunter",
        nickname: "Trend Spotter",
        description: "Expert at identifying emerging trends",
        addedBy: "manual",
        addedAt: "2025-06-13T09:00:00.000Z",
        verified: true,
        usdProfit7d: 33000,
        usdProfit30d: 125000,
        winrate7d: 73.4,
        buy7d: 6,
        avgHoldingMins: 240,
        totalProfitPercent: 19.8,
        solBalance: 142.1,
        performanceScore: 78,
        minTradeAlert: 2500,
        priority: "medium",
        enabled: true
      },
      {
        address: "2bNqWx8K4mYzJv7FcDtRhU3pE6GsLnPjQ9XyVaBwZeHu",
        category: "trader",
        nickname: "Volume Master",
        description: "High-volume trader with solid risk management",
        addedBy: "manual",
        addedAt: "2025-06-13T09:00:00.000Z",
        verified: true,
        usdProfit7d: 47000,
        usdProfit30d: 187000,
        winrate7d: 68.9,
        buy7d: 4,
        avgHoldingMins: 480,
        totalProfitPercent: 29.3,
        solBalance: 312.8,
        performanceScore: 76,
        minTradeAlert: 4000,
        priority: "medium",
        enabled: true
      },
      {
        address: "6jFtMn2X9wYvKpBq4LcHuR8sD5GzNyEaJx3QrWbTmUiP",
        category: "sniper",
        nickname: "Precision Shot",
        description: "Highly precise sniper with minimal losses",
        addedBy: "manual", 
        addedAt: "2025-06-13T09:00:00.000Z",
        verified: true,
        usdProfit7d: 39000,
        usdProfit30d: 156000,
        winrate7d: 79.3,
        buy7d: 11,
        avgHoldingMins: 42,
        totalProfitPercent: 23.7,
        solBalance: 73.9,
        performanceScore: 86,
        minTradeAlert: 1800,
        priority: "high",
        enabled: true
      },
      {
        address: "8pKxWm4Y2vNzJbFq9LcMtR6sE3HyGaUj5XqBwCdTnZiY",
        category: "hunter",
        nickname: "Opportunity Seeker",
        description: "Always finds the best opportunities",
        addedBy: "manual",
        addedAt: "2025-06-13T09:00:00.000Z",
        verified: true,
        usdProfit7d: 29000,
        usdProfit30d: 118000,
        winrate7d: 74.8,
        buy7d: 7,
        avgHoldingMins: 200,
        totalProfitPercent: 17.2,
        solBalance: 134.6,
        performanceScore: 77,
        minTradeAlert: 2200,
        priority: "medium",
        enabled: true
      },
      {
        address: "3kVyJn5L8xFzMpCq2BgWtR9sA4HuGbNj6YzDwExTmRiU",
        category: "trader",
        nickname: "Strategy Expert", 
        description: "Advanced strategy implementation specialist",
        addedBy: "manual",
        addedAt: "2025-06-13T09:00:00.000Z",
        verified: true,
        usdProfit7d: 58000,
        usdProfit30d: 215000,
        winrate7d: 70.1,
        buy7d: 3,
        avgHoldingMins: 540,
        totalProfitPercent: 34.2,
        solBalance: 287.5,
        performanceScore: 79,
        minTradeAlert: 6000,
        priority: "medium",
        enabled: true
      },
      {
        address: "5mQrBx7K3yWzJvFn9LcPtU8aE2GsNyDj4XbCwHdVmZiP",
        category: "sniper",
        nickname: "Flash Strike",
        description: "Ultra-fast execution with excellent timing",
        addedBy: "manual",
        addedAt: "2025-06-13T09:00:00.000Z", 
        verified: true,
        usdProfit7d: 43000,
        usdProfit30d: 167000,
        winrate7d: 81.6,
        buy7d: 13,
        avgHoldingMins: 35,
        totalProfitPercent: 25.4,
        solBalance: 69.1,
        performanceScore: 87,
        minTradeAlert: 1600,
        priority: "high",
        enabled: true
      }
    ];
  }

  private createDefaultConfig(): SmartWalletsConfig {
    return {
      version: "2.0.0",
      lastUpdated: new Date().toISOString(),
      description: "Smart Money wallets configuration with CSV structure (usdProfit7d, winrate7d, buy7d)",
      totalWallets: 0,
      wallets: [],
      discovery: {
        autoDiscoveryEnabled: true,
        maxWallets: 100,
        minPerformanceScore: 75,
        discoveryInterval: "48h",
        lastDiscovery: null
      },
      filters: {
        minWinrate7d: 65,
        minUsdProfit7d: 20000,
        minBuy7d: 1,
        maxInactiveDays: 7
      }
    };
  }

  async loadWallets(): Promise<number> {
    try {
      this.logger.info('📂 Loading Smart Money wallets (NEW CSV STRUCTURE)...');
      
      // Загружаем конфиг
      await this.loadConfig();
      
      if (!this.config || this.config.wallets.length === 0) {
        this.logger.info('📝 No config found or empty, creating from hardcoded wallets...');
        await this.createConfigFromHardcodedWallets();
      }
      
      // Синхронизируем с базой данных
      const syncResult = await this.syncDatabaseWithConfig();
      
      this.logger.info(`✅ Wallet loading complete: ${syncResult.added} added, ${syncResult.updated} updated`);
      
      return syncResult.added + syncResult.updated;
      
    } catch (error) {
      this.logger.error('❌ Error loading wallets:', error);
      return 0;
    }
  }

  async loadWalletsFromConfig(): Promise<number> {
    return await this.loadWallets();
  }

  private async loadConfig(): Promise<void> {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.info('📄 Config file not found, will create new one');
        return;
      }

      const configData = fs.readFileSync(this.configPath, 'utf8');
      this.config = JSON.parse(configData);
      
      this.logger.info(`📄 Loaded config with ${this.config?.wallets.length || 0} wallets`);
      
    } catch (error) {
      this.logger.error('❌ Error loading config:', error);
      this.config = null;
    }
  }

  private async createConfigFromHardcodedWallets(): Promise<void> {
    try {
      const hardcodedWallets = this.getHardcodedWallets();
      
      const newConfig = this.createDefaultConfig();
      newConfig.wallets = hardcodedWallets;
      newConfig.totalWallets = hardcodedWallets.length;
      newConfig.description = "Smart Money wallets (hardcoded defaults) - CSV structure v2.0";
      
      // Создаем директорию если не существует
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      fs.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 2), 'utf8');
      this.config = newConfig;
      
      this.logger.info(`✅ Created config with ${hardcodedWallets.length} hardcoded wallets (NEW STRUCTURE)`);
      
    } catch (error) {
      this.logger.error('❌ Error creating config from hardcoded wallets:', error);
    }
  }

  // 🔥 ИСПРАВЛЕНО: Синхронизация ТОЛЬКО MANUAL кошельков между JSON конфигом и БД
  async syncDatabaseWithConfig(): Promise<{ added: number; updated: number; disabled: number }> {
    try {
      if (!this.config) {
        this.logger.warn('⚠️ SmartWalletLoader: No config loaded, skipping sync');
        return { added: 0, updated: 0, disabled: 0 };
      }

      let added = 0;
      let updated = 0;
      let disabled = 0;

      // 🔥 1. Работаем ТОЛЬКО с кошельками, помеченными как "manual" в JSON конфиге
      const configManualWallets = this.config.wallets.filter(w => w.addedBy === 'manual');
      const configManualAddresses = new Set(configManualWallets.map(w => w.address));

      this.logger.info(`📊 Found ${configManualWallets.length} manual wallets in config (out of ${this.config.wallets.length} total)`);

      // 🔥 2. Получаем из БД ТОЛЬКО кошельки, помеченные как "manual"
      const dbManualWallets = await this.smDatabase.getWalletsByAddedBy('manual');
      
      this.logger.info(`📊 Found ${dbManualWallets.length} manual wallets in database`);

      // 🔥 3. Добавляем/обновляем ручные кошельки из конфига в БД
      for (const walletConfig of configManualWallets) {
        try {
          if (!walletConfig.enabled) {
            this.logger.debug(`⏭️ Skipping disabled manual wallet: ${walletConfig.address.slice(0, 8)}`);
            continue;
          }

          const existingDbWallet = dbManualWallets.find(w => w.address === walletConfig.address);
          
          if (!existingDbWallet) {
            // Добавляем новый ручной кошелек
            const smartWallet = this.createSmartWalletFromConfig(walletConfig);
            const dbConfig = this.createDbConfigFromWalletConfig(walletConfig);
            
            await this.smDatabase.saveSmartWallet(smartWallet, dbConfig);
            added++;
            this.logger.info(`➕ Added new manual wallet: ${walletConfig.address.slice(0, 8)} (${walletConfig.nickname})`);
          } else {
            // Обновляем настройки существующего ручного кошелька
            await this.smDatabase.updateWalletSettings(walletConfig.address, {
              minTradeAlert: walletConfig.minTradeAlert,
              priority: walletConfig.priority,
              enabled: walletConfig.enabled
            });
            updated++;
            this.logger.debug(`🔄 Updated manual wallet settings: ${walletConfig.address.slice(0, 8)}`);
          }
        } catch (error) {
          this.logger.error(`❌ Error syncing manual wallet ${walletConfig?.address}:`, error);
        }
      }

      // 🔥 4. Отключаем ручные кошельки из БД, которых больше нет в JSON конфиге
      for (const dbWallet of dbManualWallets) {
        if (!configManualAddresses.has(dbWallet.address)) {
          await this.smDatabase.updateWalletSettings(dbWallet.address, { enabled: false });
          this.logger.info(`♿️ Disabled manual wallet not in config: ${dbWallet.address.slice(0, 8)}`);
          disabled++;
        }
      }

      this.logger.info(`✅ Manual wallets sync completed: ${added} added, ${updated} updated, ${disabled} disabled`);
      this.logger.info(`🔄 Dragon wallets are NOT affected by this sync (they are managed separately by DragonResultsParser)`);

      return { added, updated, disabled };

    } catch (error) {
      this.logger.error('❌ Error syncing manual wallets with config:', error);
      return { added: 0, updated: 0, disabled: 0 };
    }
  }

  async exportConfigFromDatabase(): Promise<void> {
    try {
      this.logger.info('📤 Exporting wallet config from database...');

      const dbWallets = await this.smDatabase.getAllActiveSmartWallets();
      const exportedWallets: WalletConfig[] = [];

      for (const wallet of dbWallets) {
        try {
          const settings = await this.smDatabase.getWalletSettings(wallet.address);
          
          if (settings) {
            exportedWallets.push({
              address: wallet.address,
              category: wallet.category,
              nickname: settings.nickname || `${wallet.category} ${wallet.address.slice(0, 8)}`,
              description: settings.description || `Auto-exported ${wallet.category} wallet`,
              addedBy: 'discovery',
              addedAt: new Date().toISOString(),
              verified: true,
              // 🔥 ИСПОЛЬЗУЕМ НОВЫЕ ПОЛЯ
              usdProfit7d: wallet.usdProfit7d,
              usdProfit30d: wallet.usdProfit30d,
              winrate7d: wallet.winrate7d,
              buy7d: wallet.buy7d,
              avgHoldingMins: wallet.avgHoldingMins,
              totalProfitPercent: wallet.totalProfitPercent,
              solBalance: wallet.solBalance,
              performanceScore: wallet.performanceScore,
              minTradeAlert: settings.minTradeAlert,
              priority: settings.priority,
              enabled: settings.enabled
            });
          }
        } catch (error) {
          this.logger.error(`❌ Error exporting wallet ${wallet.address}:`, error);
        }
      }

      const newConfig: SmartWalletsConfig = this.createDefaultConfig();
      newConfig.wallets = exportedWallets;
      newConfig.totalWallets = exportedWallets.length;
      newConfig.description = "Smart Money кошельки (экспорт из БД) - CSV structure v2.0";

      // 🔒 БЕЗОПАСНОЕ КОПИРОВАНИЕ СУЩЕСТВУЮЩИХ НАСТРОЕК
      if (this.config?.discovery) {
        newConfig.discovery = { ...this.config.discovery };
      }
      if (this.config?.filters) {
        newConfig.filters = { ...this.config.filters };
      }

      // 🔒 БЕЗОПАСНОЕ СОЗДАНИЕ BACKUP
      try {
        const backupPath = this.configPath.replace('.json', `_backup_${Date.now()}.json`);
        if (fs.existsSync(this.configPath)) {
          fs.copyFileSync(this.configPath, backupPath);
          this.logger.info(`💾 Backup saved: ${backupPath}`);
        }
      } catch (error) {
        this.logger.warn('⚠️ Failed to create backup, continuing...', error);
      }

      fs.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 2), 'utf8');
      this.config = newConfig;

      this.logger.info(`✅ Exported ${exportedWallets.length} wallets to config`);

    } catch (error) {
      this.logger.error('❌ Error exporting config from database:', error);
    }
  }

  async exportCurrentDatabaseToConfig(): Promise<void> {
    await this.exportConfigFromDatabase();
  }

  async updateWalletSettings(
    address: string, 
    settings: {
      enabled?: boolean;
      priority?: 'high' | 'medium' | 'low';
      minTradeAlert?: number;
    }
  ): Promise<void> {
    try {
      await this.smDatabase.updateWalletSettings(address, settings);
      
      // Обновляем также в конфиге если загружен
      if (this.config) {
        const walletConfig = this.config.wallets.find(w => w.address === address);
        if (walletConfig) {
          if (settings.enabled !== undefined) walletConfig.enabled = settings.enabled;
          if (settings.priority !== undefined) walletConfig.priority = settings.priority;
          if (settings.minTradeAlert !== undefined) walletConfig.minTradeAlert = settings.minTradeAlert;
          
          // Сохраняем обновленный конфиг
          fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
        }
      }
      
      this.logger.info(`✅ Updated settings for wallet ${address}`);
      
    } catch (error) {
      this.logger.error(`❌ Error updating wallet settings for ${address}:`, error);
    }
  }

  async addWallet(
    address: string,
    category: 'sniper' | 'hunter' | 'trader',
    nickname: string,
    description: string,
    metrics?: any
  ): Promise<boolean> {
    try {
      // 🔥 УБРАЛИ validateMetrics - используем дефолтные значения под новую структуру
      const defaultMetrics = {
        usdProfit7d: metrics?.usdProfit7d || 25000,
        usdProfit30d: metrics?.usdProfit30d || 95000,
        winrate7d: metrics?.winrate7d || 75,
        buy7d: metrics?.buy7d || 5,
        avgHoldingMins: category === 'sniper' ? 45 : category === 'hunter' ? 180 : 360,
        totalProfitPercent: metrics?.totalProfitPercent || 20,
        solBalance: category === 'sniper' ? 70 : category === 'hunter' ? 150 : 250,
        performanceScore: metrics?.performanceScore || 80
      };
      
      const walletConfig: WalletConfig = {
        address,
        category,
        nickname,
        description,
        addedBy: 'manual',
        addedAt: new Date().toISOString(),
        verified: true,
        ...defaultMetrics,
        minTradeAlert: category === 'trader' ? 15000 : category === 'hunter' ? 5000 : 3000,
        priority: defaultMetrics.performanceScore > 85 ? 'high' : 'medium',
        enabled: true
      };

      // Добавляем в БД
      const smartWallet = this.createSmartWalletFromConfig(walletConfig);
      const dbConfig = this.createDbConfigFromWalletConfig(walletConfig);
      await this.smDatabase.saveSmartWallet(smartWallet, dbConfig);

      // Добавляем в конфиг
      if (!this.config) {
        await this.loadConfig();
      }
      
      if (this.config) {
        this.config.wallets.push(walletConfig);
        this.config.totalWallets = this.config.wallets.length;
        this.config.lastUpdated = new Date().toISOString();
        
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      }

      this.logger.info(`✅ Added wallet ${address} (${category})`);
      return true;

    } catch (error) {
      this.logger.error(`❌ Error adding wallet ${address}:`, error);
      return false;
    }
  }

  async removeWallet(address: string): Promise<boolean> {
    try {
      // Деактивируем в БД
      await this.smDatabase.deactivateWallet(address, 'Removed by user');

      // Удаляем из конфига
      if (this.config) {
        this.config.wallets = this.config.wallets.filter(w => w.address !== address);
        this.config.totalWallets = this.config.wallets.length;
        this.config.lastUpdated = new Date().toISOString();
        
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      }

      this.logger.info(`✅ Removed wallet ${address}`);
      return true;

    } catch (error) {
      this.logger.error(`❌ Error removing wallet ${address}:`, error);
      return false;
    }
  }

  async forceReplaceAllWallets(): Promise<boolean> {
    try {
      this.logger.info('🔄 Force replacing all wallets...');

      const hardcodedWallets = this.getHardcodedWallets();
      const walletConfigs = hardcodedWallets.map(w => this.createDbConfigFromWalletConfig(w));
      
      // Конвертируем в SmartMoneyWallet объекты
      const smartWallets = hardcodedWallets.map(w => this.createSmartWalletFromConfig(w));

      // Используем метод из SmartMoneyDatabase для замены всех кошельков
      await this.smDatabase.safeReplaceAllWallets(smartWallets, walletConfigs);

      // Обновляем конфиг файл
      const newConfig = this.createDefaultConfig();
      newConfig.wallets = hardcodedWallets;
      newConfig.totalWallets = hardcodedWallets.length;
      newConfig.description = "Smart Money wallets (force replaced with hardcoded) - CSV v2.0";

      // Создаем директорию если не существует
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      fs.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 2), 'utf8');
      this.config = newConfig;

      this.logger.info(`✅ Force replaced all wallets with ${hardcodedWallets.length} hardcoded wallets`);
      return true;

    } catch (error) {
      this.logger.error('❌ Error force replacing wallets:', error);
      return false;
    }
  }

  async getStats(): Promise<{
    totalWallets: number;
    configWallets: number;
    enabledWallets: number;
    lastConfigUpdate: string | null;
    configExists: boolean;
  }> {
    try {
      const dbCount = await this.smDatabase.getWalletCount();
      
      return {
        totalWallets: dbCount,
        configWallets: this.config?.wallets.length || 0,
        enabledWallets: this.config?.wallets.filter(w => w.enabled).length || 0,
        lastConfigUpdate: this.config?.lastUpdated || null,
        configExists: fs.existsSync(this.configPath)
      };
      
    } catch (error) {
      this.logger.error('❌ Error getting stats:', error);
      return {
        totalWallets: 0,
        configWallets: 0,
        enabledWallets: 0,
        lastConfigUpdate: null,
        configExists: false
      };
    }
  }

  // 🔥 ПОЛНОСТЬЮ ПЕРЕПИСАН под новую структуру SmartMoneyWallet
  private createSmartWalletFromConfig(walletConfig: WalletConfig): SmartMoneyWallet {
    return {
      address: walletConfig.address,
      category: walletConfig.category,
      nickname: walletConfig.nickname,
      
      // 🔥 ПРЯМОЕ СОПОСТАВЛЕНИЕ С НОВЫМИ ПОЛЯМИ
      usdProfit7d: walletConfig.usdProfit7d,
      usdProfit30d: walletConfig.usdProfit30d,
      winrate7d: walletConfig.winrate7d,
      buy7d: walletConfig.buy7d,
      avgHoldingMins: walletConfig.avgHoldingMins,
      totalProfitPercent: walletConfig.totalProfitPercent,
      solBalance: walletConfig.solBalance,
      
      // Системные поля
      performanceScore: walletConfig.performanceScore,
      isActive: true,
      lastActiveAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }

  private createDbConfigFromWalletConfig(walletConfig: WalletConfig) {
    return {
      nickname: walletConfig.nickname,
      description: walletConfig.description,
      minTradeAlert: walletConfig.minTradeAlert,
      priority: walletConfig.priority,
      addedBy: walletConfig.addedBy === 'placeholder' ? 'discovery' : walletConfig.addedBy,
      verified: walletConfig.verified
    };
  }
}