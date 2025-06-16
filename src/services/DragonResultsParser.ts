// src/services/DragonResultsParser.ts
// 🐲 ПАРСЕР РЕЗУЛЬТАТОВ DRAGON ДЛЯ SMART MONEY БОТА
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';

export interface DragonWallet {
  wallet: string;
  pnl: number;
  winrate: number;
  trades: number;
  volume: number;
  last_active: number; // timestamp
  sol_balance: number;
  score?: number; // рассчитанный рейтинг
}

export interface DragonParseConfig {
  dragonOutputPath: string; // путь к папке TopTraders/Output/
  minPnl: number;
  minWinrate: number;
  minTrades: number;
  maxDaysInactive: number;
  scoreWeights: {
    pnl: number;
    winrate: number;
    volume: number;
    trades: number;
    activity: number;
  };
  autoCategories: {
    sniperThreshold: number;    // порог PnL для sniper
    hunterThreshold: number;    // порог PnL для hunter  
    traderMinTrades: number;    // мин. сделок для trader
  };
}

export interface DragonParseResult {
  totalParsed: number;
  filtered: number;
  added: number;
  updated: number;
  skipped: number;
  categories: {
    snipers: number;
    hunters: number;
    traders: number;
  };
  topPerformers: DragonWallet[];
}

export class DragonResultsParser {
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private logger: Logger;
  private config: DragonParseConfig;

  constructor(
    smDatabase: SmartMoneyDatabase, 
    telegramNotifier: TelegramNotifier,
    config?: Partial<DragonParseConfig>
  ) {
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.logger = Logger.getInstance();
    
    // Конфигурация по умолчанию
    this.config = {
      dragonOutputPath: 'C:\\Users\\ibm\\OneDrive\\Документы\\Dragon-main\\Dragon\\data\\Solana\\TopTraders\\', // 🔧 ИСПРАВЛЕН ПУТЬ
      minPnl: 5000,           // мин $5K PnL
      minWinrate: 60,         // мин 60% winrate
      minTrades: 10,          // мин 10 сделок
      maxDaysInactive: 7,     // макс 7 дней неактивности
      scoreWeights: {
        pnl: 0.4,            // 40% веса на PnL
        winrate: 0.25,       // 25% на winrate
        volume: 0.15,        // 15% на объем
        trades: 0.1,         // 10% на количество сделок
        activity: 0.1        // 10% на активность
      },
      autoCategories: {
        sniperThreshold: 50000,    // $50K+ PnL = sniper
        hunterThreshold: 20000,    // $20K+ PnL = hunter
        traderMinTrades: 50        // 50+ сделок = trader
      },
      ...config
    };

    this.logger.info('🐲 Dragon Results Parser initialized');
  }

  /**
   * Главный метод - сканирует папку Dragon и парсит последние результаты
   */
  async parseLatestDragonResults(): Promise<DragonParseResult> {
    try {
      this.logger.info('🔍 Scanning Dragon output folder...');
      
      // 1. Поиск последних JSON файлов Dragon
      const latestFiles = await this.findLatestDragonFiles();
      
      if (latestFiles.length === 0) {
        this.logger.warn('⚠️ No Dragon result files found');
        return this.createEmptyResult();
      }

      this.logger.info(`📁 Found ${latestFiles.length} Dragon result files`);

      // 2. Парсинг всех найденных файлов
      const allWallets: DragonWallet[] = [];
      
      for (const filePath of latestFiles) {
        const wallets = await this.parseDragonJsonFile(filePath);
        allWallets.push(...wallets);
        this.logger.info(`📊 Parsed ${wallets.length} wallets from ${path.basename(filePath)}`);
      }

      // 3. Дедупликация по адресу кошелька
      const uniqueWallets = this.deduplicateWallets(allWallets);
      this.logger.info(`🔄 After deduplication: ${uniqueWallets.length} unique wallets`);

      // 4. Фильтрация по критериям
      const filteredWallets = this.filterWallets(uniqueWallets);
      this.logger.info(`✅ After filtering: ${filteredWallets.length} quality wallets`);

      // 5. Расчет рейтингов
      const scoredWallets = this.calculateScores(filteredWallets);
      this.logger.info(`🎯 Calculated scores for ${scoredWallets.length} wallets`);

      // 6. Сортировка по рейтингу
      scoredWallets.sort((a, b) => (b.score || 0) - (a.score || 0));

      // 7. Добавление в базу данных
      const dbResult = await this.addWalletsToDatabase(scoredWallets);

      // 8. Отправка уведомления
      await this.sendDragonImportNotification(dbResult, scoredWallets.slice(0, 10));

      return dbResult;

    } catch (error) {
      this.logger.error('❌ Error parsing Dragon results:', error);
      throw error;
    }
  }

  /**
   * Поиск последних JSON файлов Dragon в папке Output
   */
  private async findLatestDragonFiles(): Promise<string[]> {
    try {
      if (!fs.existsSync(this.config.dragonOutputPath)) {
        this.logger.warn(`⚠️ Dragon output path not found: ${this.config.dragonOutputPath}`);
        return [];
      }

      const files = fs.readdirSync(this.config.dragonOutputPath);
      
      // Фильтруем JSON файлы Dragon (паттерн: topTraders_*.json)
      const jsonFiles = files
        .filter(file => file.startsWith('topTraders_') && file.endsWith('.json'))
        .map(file => ({
          name: file,
          path: path.join(this.config.dragonOutputPath, file),
          mtime: fs.statSync(path.join(this.config.dragonOutputPath, file)).mtime
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()) // новые файлы первыми
        .slice(0, 5) // берем только 5 последних файлов
        .map(file => file.path);

      return jsonFiles;

    } catch (error) {
      this.logger.error('❌ Error finding Dragon files:', error);
      return [];
    }
  }

  /**
   * Парсинг отдельного JSON файла Dragon
   */
  private async parseDragonJsonFile(filePath: string): Promise<DragonWallet[]> {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const jsonData = JSON.parse(fileContent);

      const dragonWallets: DragonWallet[] = [];

      // Dragon создает объект где ключ = адрес кошелька, значение = метрики
      for (const [walletAddress, metrics] of Object.entries(jsonData)) {
        // Пропускаем пустые объекты
        if (!metrics || typeof metrics !== 'object' || Object.keys(metrics).length === 0) {
          continue;
        }

        const data = metrics as any;

        // Парсим данные Dragon
        const boughtUsd = this.parseUsdString(data.boughtUsd || '0');
        const totalProfit = this.parseUsdString(data.totalProfit || '0');
        const buys = parseInt(data.buys || '0');
        const sells = parseInt(data.sells || '0');
        const totalTrades = buys + sells;

        // Рассчитываем winrate (продажи как процент от всех сделок)
        const winrate = totalTrades > 0 ? (sells / totalTrades) * 100 : 0;

        // Валидируем адрес и базовые данные
        if (walletAddress && walletAddress.length >= 32 && totalTrades > 0) {
          dragonWallets.push({
            wallet: walletAddress,
            pnl: totalProfit,
            winrate: winrate,
            trades: totalTrades,
            volume: boughtUsd,
            last_active: Date.now() / 1000, // текущее время
            sol_balance: 0 // Dragon не предоставляет баланс
          });
        }
      }

      return dragonWallets;

    } catch (error) {
      this.logger.error(`❌ Error parsing Dragon JSON file ${filePath}:`, error);
      return [];
    }
  }

  /**
   * Парсинг строки с USD в число
   */
  private parseUsdString(usdString: string): number {
    if (!usdString || typeof usdString !== 'string') {
      return 0;
    }
    
    // Убираем $, запятые и пробелы, оставляем только цифры и точку
    const cleaned = usdString.replace(/[$,\s]/g, '');
    const number = parseFloat(cleaned);
    
    return isNaN(number) ? 0 : number;
  }

  /**
   * Дедупликация кошельков по адресу
   */
  private deduplicateWallets(wallets: DragonWallet[]): DragonWallet[] {
    const walletMap = new Map<string, DragonWallet>();
    
    for (const wallet of wallets) {
      const existing = walletMap.get(wallet.wallet);
      
      if (!existing || wallet.pnl > existing.pnl) {
        // Берем кошелек с лучшим PnL
        walletMap.set(wallet.wallet, wallet);
      }
    }
    
    return Array.from(walletMap.values());
  }

  /**
   * Фильтрация кошельков по критериям качества
   */
  private filterWallets(wallets: DragonWallet[]): DragonWallet[] {
    const now = Date.now() / 1000;
    
    return wallets.filter(wallet => {
      // Фильтр по PnL
      if (wallet.pnl < this.config.minPnl) return false;
      
      // Фильтр по winrate
      if (wallet.winrate < this.config.minWinrate) return false;
      
      // Фильтр по количеству сделок
      if (wallet.trades < this.config.minTrades) return false;
      
      // Фильтр по активности (последняя активность)
      const daysSinceActive = (now - wallet.last_active) / (24 * 60 * 60);
      if (daysSinceActive > this.config.maxDaysInactive) return false;
      
      return true;
    });
  }

  /**
   * Расчет рейтинга кошелька на основе весов
   */
  private calculateScores(wallets: DragonWallet[]): DragonWallet[] {
    // Находим максимальные значения для нормализации
    const maxPnl = Math.max(...wallets.map(w => w.pnl));
    const maxVolume = Math.max(...wallets.map(w => w.volume));
    const maxTrades = Math.max(...wallets.map(w => w.trades));
    const now = Date.now() / 1000;
    
    return wallets.map(wallet => {
      // Нормализуем значения от 0 до 1
      const pnlScore = wallet.pnl / maxPnl;
      const winrateScore = wallet.winrate / 100; // winrate уже в процентах
      const volumeScore = maxVolume > 0 ? wallet.volume / maxVolume : 0;
      const tradesScore = maxTrades > 0 ? wallet.trades / maxTrades : 0;
      
      // Активность (чем новее, тем лучше)
      const daysSinceActive = (now - wallet.last_active) / (24 * 60 * 60);
      const activityScore = Math.max(0, 1 - (daysSinceActive / this.config.maxDaysInactive));
      
      // Итоговый рейтинг
      const score = (
        pnlScore * this.config.scoreWeights.pnl +
        winrateScore * this.config.scoreWeights.winrate +
        volumeScore * this.config.scoreWeights.volume +
        tradesScore * this.config.scoreWeights.trades +
        activityScore * this.config.scoreWeights.activity
      ) * 100; // приводим к шкале 0-100
      
      return {
        ...wallet,
        score: Math.round(score * 100) / 100 // округляем до 2 знаков
      };
    });
  }

  /**
   * Добавление кошельков в базу данных Smart Money
   */
  private async addWalletsToDatabase(wallets: DragonWallet[]): Promise<DragonParseResult> {
    const result: DragonParseResult = {
      totalParsed: wallets.length,
      filtered: 0, // уже отфильтровано ранее
      added: 0,
      updated: 0,
      skipped: 0,
      categories: { snipers: 0, hunters: 0, traders: 0 },
      topPerformers: wallets.slice(0, 10)
    };

    for (const wallet of wallets) {
      try {
        // Определяем категорию на основе PnL и количества сделок
        const category = this.determineWalletCategory(wallet);
        
        // Проверяем, существует ли кошелек в базе
        const existingWallet = await this.smDatabase.getSmartWallet(wallet.wallet);
        
        if (existingWallet) {
          // Обновляем существующий кошелек если новые данные лучше
          if (wallet.pnl > existingWallet.totalPnL || wallet.winrate > existingWallet.winRate) {
            await this.updateExistingWallet(existingWallet, wallet, category);
            result.updated++;
          } else {
            result.skipped++;
          }
        } else {
          // Добавляем новый кошелек
          await this.addNewWallet(wallet, category);
          result.added++;
          result.categories[category + 's' as keyof typeof result.categories]++;
        }

      } catch (error) {
        this.logger.error(`❌ Error processing wallet ${wallet.wallet}:`, error);
        result.skipped++;
      }
    }

    return result;
  }

  /**
   * Определение категории кошелька на основе данных
   */
  private determineWalletCategory(wallet: DragonWallet): 'sniper' | 'hunter' | 'trader' {
    const { sniperThreshold, hunterThreshold, traderMinTrades } = this.config.autoCategories;
    
    // Trader - много сделок
    if (wallet.trades >= traderMinTrades) {
      return 'trader';
    }
    
    // Sniper - высокий PnL с меньшим количеством сделок
    if (wallet.pnl >= sniperThreshold) {
      return 'sniper';
    }
    
    // Hunter - средний PnL
    if (wallet.pnl >= hunterThreshold) {
      return 'hunter';
    }
    
    // По умолчанию hunter
    return 'hunter';
  }

  /**
   * Добавление нового кошелька в базу данных
   */
  private async addNewWallet(wallet: DragonWallet, category: 'sniper' | 'hunter' | 'trader'): Promise<void> {
    const smartWallet = {
      address: wallet.wallet,
      category,
      winRate: wallet.winrate,
      totalPnL: wallet.pnl,
      totalTrades: wallet.trades,
      avgTradeSize: wallet.volume / Math.max(wallet.trades, 1),
      maxTradeSize: wallet.volume * 0.1, // примерная оценка
      minTradeSize: wallet.volume * 0.001, // примерная оценка
      performanceScore: wallet.score || 0,
      lastActiveAt: new Date(wallet.last_active * 1000),
      isActive: true,
      volumeScore: Math.min(100, wallet.volume / 10000) // нормализуем объем
    };

    await this.smDatabase.saveSmartWallet(smartWallet, {
      nickname: `Dragon ${category} ${wallet.wallet.slice(0, 8)}`,
      description: `Импортирован из Dragon. PnL: ${wallet.pnl.toFixed(0)}, WR: ${wallet.winrate}%`,
      addedBy: 'discovery', // Исправлено: используем 'discovery' вместо 'dragon'
      verified: true,
      priority: wallet.score && wallet.score > 75 ? 'high' : 'medium'
    });
  }

  /**
   * Обновление существующего кошелька
   */
  private async updateExistingWallet(
    existing: any, 
    dragon: DragonWallet, 
    category: 'sniper' | 'hunter' | 'trader'
  ): Promise<void> {
    // Обновляем только если Dragon данные лучше
    const updatedWallet = {
      ...existing,
      totalPnL: Math.max(existing.totalPnL, dragon.pnl),
      winRate: Math.max(existing.winRate, dragon.winrate),
      totalTrades: Math.max(existing.totalTrades, dragon.trades),
      performanceScore: Math.max(existing.performanceScore, dragon.score || 0),
      lastActiveAt: new Date(Math.max(
        existing.lastActiveAt.getTime(),
        dragon.last_active * 1000
      ))
    };

    await this.smDatabase.saveSmartWallet(updatedWallet);
    this.logger.debug(`🔄 Updated wallet ${dragon.wallet} with better Dragon data`);
  }

  /**
   * Отправка уведомления о результатах импорта
   */
  private async sendDragonImportNotification(
    result: DragonParseResult, 
    topWallets: DragonWallet[]
  ): Promise<void> {
    try {
      const message = `🐲 <b>Dragon Import Results</b>

📊 <b>Statistics:</b>
• Parsed: <code>${result.totalParsed}</code> wallets
• Added: <code>${result.added}</code> new
• Updated: <code>${result.updated}</code> existing  
• Skipped: <code>${result.skipped}</code> duplicates

🎯 <b>Categories:</b>
• 🔫 Snipers: <code>${result.categories.snipers}</code>
• 💡 Hunters: <code>${result.categories.hunters}</code>  
• 🐳 Traders: <code>${result.categories.traders}</code>

🏆 <b>Top 5 Performers:</b>
${topWallets.slice(0, 5).map((w, i) => 
  `<code>${i + 1}.</code> $${w.pnl.toFixed(0)} | ${w.winrate}% WR | ${w.trades} trades`
).join('\n')}

⏰ <code>${new Date().toLocaleString()}</code>`;

      await this.telegramNotifier.sendCycleLog(message);
      
    } catch (error) {
      this.logger.error('❌ Error sending Dragon import notification:', error);
    }
  }

  /**
   * Создание пустого результата
   */
  private createEmptyResult(): DragonParseResult {
    return {
      totalParsed: 0,
      filtered: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      categories: { snipers: 0, hunters: 0, traders: 0 },
      topPerformers: []
    };
  }

  /**
   * Обновление конфигурации парсера
   */
  updateConfig(newConfig: Partial<DragonParseConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('🔧 Dragon parser configuration updated');
  }

  /**
   * Получение текущей конфигурации
   */
  getConfig(): DragonParseConfig {
    return { ...this.config };
  }

  /**
   * Получение статистики парсера
   */
  async getStats(): Promise<{
    lastScanTime?: Date;
    totalFilesFound: number;
    configPath: string;
    isConfigured: boolean;
  }> {
    const files = await this.findLatestDragonFiles();
    
    return {
      totalFilesFound: files.length,
      configPath: this.config.dragonOutputPath,
      isConfigured: fs.existsSync(this.config.dragonOutputPath)
    };
  }
}