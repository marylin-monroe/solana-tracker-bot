// src/services/DragonActivityChecker.ts - ОТЛОЖЕННАЯ ПРОВЕРКА АКТИВНОСТИ DRAGON КОШЕЛЬКОВ + ИСПРАВЛЕНИЯ
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { MultiProviderService } from './MultiProviderService';
import { TelegramNotifier } from './TelegramNotifier';
import { Logger } from '../utils/Logger';

interface ActivityCheckConfig {
  enabled: boolean;
  maxDaysInactive: number;        // 7 дней по умолчанию
  batchSize: number;              // 5 кошельков за раз
  delayBetweenBatches: number;    // 10 секунд между батчами
  maxRequestsPerMinute: number;   // 30 запросов в минуту
  recheckIntervalHours: number;   // 24 часа
}

interface ActivityCheckResult {
  checked: number;
  deactivated: number;
  errors: number;
  details: string[];
}

interface WalletActivityInfo {
  address: string;
  lastTransactionTime: number | null;
  daysSinceLastTransaction: number;
  shouldDeactivate: boolean;
  error?: string;
}

export class DragonActivityChecker {
  private smDatabase: SmartMoneyDatabase;
  private multiProvider: MultiProviderService;
  private telegramNotifier: TelegramNotifier;
  private logger: Logger;
  private config: ActivityCheckConfig;

  // Кеш для избежания повторных проверок
  private lastCheckedCache = new Map<string, number>();
  private isRunning = false;

  constructor(
    smDatabase: SmartMoneyDatabase,
    multiProvider: MultiProviderService,
    telegramNotifier: TelegramNotifier,
    config?: Partial<ActivityCheckConfig>
  ) {
    this.smDatabase = smDatabase;
    this.multiProvider = multiProvider;
    this.telegramNotifier = telegramNotifier;
    this.logger = Logger.getInstance();

    // Конфигурация по умолчанию
    this.config = {
      enabled: true,
      maxDaysInactive: 7,           // 7 дней
      batchSize: 5,                 // 5 кошельков за раз
      delayBetweenBatches: 10000,   // 10 секунд
      maxRequestsPerMinute: 30,     // 30 запросов в минуту
      recheckIntervalHours: 24,     // 24 часа
      ...config
    };

    this.logger.info('🧹 DragonActivityChecker initialized with POST-processing cleanup logic');
  }

  /**
   * 🎯 ГЛАВНЫЙ МЕТОД: Проверка активности Dragon кошельков
   */
  async checkDragonWalletsActivity(): Promise<ActivityCheckResult> {
    if (this.isRunning) {
      this.logger.warn('⚠️ Activity check already running, skipping');
      return { checked: 0, deactivated: 0, errors: 0, details: [] };
    }

    if (!this.config.enabled) {
      this.logger.info('🚫 Dragon activity check disabled');
      return { checked: 0, deactivated: 0, errors: 0, details: [] };
    }

    try {
      this.isRunning = true;
      this.logger.info('🧹 Starting Dragon wallets activity check (POST-processing cleanup)...');

      // 1. Найти Dragon кошельки для проверки
      const walletsToCheck = await this.findDragonWalletsToCheck();
      
      if (walletsToCheck.length === 0) {
        this.logger.info('✅ No Dragon wallets need activity checking at this time');
        return { checked: 0, deactivated: 0, errors: 0, details: [] };
      }

      this.logger.info(`🔍 Found ${walletsToCheck.length} Dragon wallets to check for activity`);

      // 2. Проверить активность батчами
      const result = await this.batchCheckActivity(walletsToCheck);

      // 3. Деактивировать неактивные кошельки
      const deactivated = await this.deactivateInactiveWallets(result.filter(w => w.shouldDeactivate));

      const finalResult: ActivityCheckResult = {
        checked: result.length,
        deactivated: deactivated,
        errors: result.filter(w => w.error).length,
        details: result.map(w => 
          `${w.address.slice(0, 8)}: ${w.daysSinceLastTransaction}d ago ${w.shouldDeactivate ? '(DEACTIVATED)' : ''}`
        )
      };

      this.logger.info(`✅ Activity check completed: ${finalResult.checked} checked, ${finalResult.deactivated} deactivated`);
      
      // Отправляем уведомление если были деактивированы кошельки
      if (finalResult.deactivated > 0) {
        await this.sendActivityCheckNotification(finalResult);
      }
      
      return finalResult;

    } catch (error) {
      this.logger.error('❌ Error in Dragon activity check:', error);
      return { checked: 0, deactivated: 0, errors: 1, details: [`Error: ${error}`] };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 🔍 ПОИСК DRAGON КОШЕЛЬКОВ ДЛЯ ПРОВЕРКИ
   * ИСПРАВЛЕНО: Просто берем все активные Dragon кошельки, фильтруем по времени последней проверки
   */
  private async findDragonWalletsToCheck(): Promise<string[]> {
    try {
      // 🔥 ИСПРАВЛЕНО: Используем публичный метод вместо прямого доступа к db
      const dragonWallets = await this.smDatabase.getAllActiveDragonWallets();

      // Фильтруем кошельки которые не проверялись недавно
      const now = Date.now();
      const filteredWallets = dragonWallets
        .filter(address => {
          const lastChecked = this.lastCheckedCache.get(address);
          if (!lastChecked) return true; // Не проверялся, нужно проверить
          
          const hoursSinceLastCheck = (now - lastChecked) / (1000 * 60 * 60);
          return hoursSinceLastCheck >= this.config.recheckIntervalHours;
        });

      this.logger.info(`🔍 Found ${filteredWallets.length} Dragon wallets to check (${dragonWallets.length} total, filtered by ${this.config.recheckIntervalHours}h interval)`);
      return filteredWallets;

    } catch (error) {
      this.logger.error('❌ Error finding Dragon wallets for activity check:', error);
      return [];
    }
  }

  /**
   * 📦 БАТЧЕВАЯ ПРОВЕРКА АКТИВНОСТИ
   */
  private async batchCheckActivity(walletAddresses: string[]): Promise<WalletActivityInfo[]> {
    const results: WalletActivityInfo[] = [];
    const batches = this.createBatches(walletAddresses, this.config.batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      this.logger.info(`🔍 Checking batch ${i + 1}/${batches.length} (${batch.length} wallets)`);

      // Проверяем кошельки в батче параллельно
      const batchResults = await Promise.allSettled(
        batch.map(address => this.checkSingleWalletActivity(address))
      );

      // Обрабатываем результаты
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            address: batch[index],
            lastTransactionTime: null,
            daysSinceLastTransaction: 999,
            shouldDeactivate: false,
            error: `Failed to check: ${result.reason}`
          });
        }
      });

      // Пауза между батчами (кроме последнего)
      if (i < batches.length - 1) {
        await this.sleep(this.config.delayBetweenBatches);
      }
    }

    return results;
  }

  /**
   * 🔍 ПРОВЕРКА АКТИВНОСТИ ОДНОГО КОШЕЛЬКА
   */
  private async checkSingleWalletActivity(address: string): Promise<WalletActivityInfo> {
    try {
      // Обновляем кеш времени последней проверки
      this.lastCheckedCache.set(address, Date.now());

      // Получаем последнюю транзакцию кошелька через MultiProviderService
      const response = await this.multiProvider.getSignaturesForAddress(address, { limit: 1 });
      
      if (!response.success || !response.data || response.data.length === 0) {
        // Нет транзакций = неактивный кошелек
        return {
          address,
          lastTransactionTime: null,
          daysSinceLastTransaction: 999,
          shouldDeactivate: true
        };
      }

      const signatures = response.data;
      const lastTransactionTime = signatures[0]?.blockTime;
      
      if (!lastTransactionTime) {
        return {
          address,
          lastTransactionTime: null,
          daysSinceLastTransaction: 999,
          shouldDeactivate: true
        };
      }

      // Вычисляем количество дней с последней транзакции
      const now = Date.now() / 1000;
      const daysSinceLastTransaction = (now - lastTransactionTime) / (24 * 60 * 60);
      const shouldDeactivate = daysSinceLastTransaction > this.config.maxDaysInactive;

      this.logger.debug(`📊 ${address.slice(0, 8)}: ${daysSinceLastTransaction.toFixed(1)} days ago ${shouldDeactivate ? '(INACTIVE)' : '(ACTIVE)'}`);

      return {
        address,
        lastTransactionTime,
        daysSinceLastTransaction: Math.round(daysSinceLastTransaction * 10) / 10,
        shouldDeactivate
      };

    } catch (error) {
      this.logger.warn(`⚠️ Error checking wallet ${address.slice(0, 8)}:`, error);
      return {
        address,
        lastTransactionTime: null,
        daysSinceLastTransaction: 0,
        shouldDeactivate: false,
        error: `API Error: ${error}`
      };
    }
  }

  /**
   * 🚫 ДЕАКТИВАЦИЯ НЕАКТИВНЫХ КОШЕЛЬКОВ
   */
  private async deactivateInactiveWallets(inactiveWallets: WalletActivityInfo[]): Promise<number> {
    if (inactiveWallets.length === 0) return 0;

    let deactivatedCount = 0;

    for (const wallet of inactiveWallets) {
      try {
        await this.smDatabase.deactivateWallet(
          wallet.address, 
          `Inactive for ${wallet.daysSinceLastTransaction} days (Dragon activity check)`
        );
        deactivatedCount++;
        
        this.logger.info(`🚫 Deactivated inactive Dragon wallet: ${wallet.address.slice(0, 8)} (${wallet.daysSinceLastTransaction}d inactive)`);
      } catch (error) {
        this.logger.error(`❌ Error deactivating wallet ${wallet.address}:`, error);
      }
    }

    return deactivatedCount;
  }

  /**
   * 📢 ОТПРАВКА УВЕДОМЛЕНИЯ О ПРОВЕРКЕ АКТИВНОСТИ
   */
  private async sendActivityCheckNotification(result: ActivityCheckResult): Promise<void> {
    const message = `🧹 <b>Dragon Activity Cleanup</b>\n\n` +
      `✅ <b>Checked:</b> <code>${result.checked}</code> wallets\n` +
      `🚫 <b>Deactivated:</b> <code>${result.deactivated}</code> inactive (>7d)\n` +
      (result.errors > 0 ? `❌ <b>Errors:</b> <code>${result.errors}</code>\n` : '') +
      `\n📊 <b>Recently Deactivated:</b>\n` +
      `${result.details
        .filter(d => d.includes('(DEACTIVATED)'))
        .slice(0, 8)
        .map(d => `<code>${d}</code>`)
        .join('\n')}\n` +
      (result.details.filter(d => d.includes('(DEACTIVATED)')).length > 8 ? 
        `<i>... and ${result.details.filter(d => d.includes('(DEACTIVATED)')).length - 8} more</i>\n` : '') +
      `\n⏰ <code>${new Date().toLocaleString()}</code>`;

    await this.telegramNotifier.sendCycleLog(message);
  }

  /**
   * 🎯 ПОЛУЧЕНИЕ СТАТИСТИКИ ACTIVITY CHECKER
   */
  getStats(): {
    isRunning: boolean;
    config: ActivityCheckConfig;
    cacheSize: number;
    lastRun?: Date;
  } {
    return {
      isRunning: this.isRunning,
      config: this.config,
      cacheSize: this.lastCheckedCache.size,
      lastRun: this.lastCheckedCache.size > 0 ? new Date() : undefined
    };
  }

  /**
   * 🔧 ОЧИСТКА КЕША
   */
  clearCache(): void {
    this.lastCheckedCache.clear();
    this.logger.info('🧹 Activity check cache cleared');
  }

  // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

  private createBatches<T>(array: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < array.length; i += batchSize) {
      batches.push(array.slice(i, i + batchSize));
    }
    return batches;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 🔧 ОБНОВЛЕНИЕ КОНФИГУРАЦИИ
   */
  updateConfig(newConfig: Partial<ActivityCheckConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('🔧 Dragon activity checker config updated');
  }

  /**
   * 🔄 ПРИНУДИТЕЛЬНАЯ ПРОВЕРКА ВСЕХ DRAGON КОШЕЛЬКОВ
   * Игнорирует кеш и проверяет абсолютно все
   */
  async forceCheckAllDragonWallets(): Promise<ActivityCheckResult> {
    this.logger.info('🔥 FORCE CHECK: Clearing cache and checking ALL Dragon wallets...');
    
    // Очищаем кеш чтобы проверить все
    this.clearCache();
    
    // Запускаем обычную проверку - теперь она охватит всех
    return await this.checkDragonWalletsActivity();
  }
}