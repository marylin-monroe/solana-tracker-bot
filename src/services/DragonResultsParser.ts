// src/services/DragonResultsParser.ts - ИСПРАВЛЕНО: ТОЛЬКО чтение файлов Dragon + Git синхронизация
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { Logger } from '../utils/Logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface DragonWallet {
  wallet: string;
  pnl: number;
  winrate: number;
  trades: number;
  volume: number;
  last_active: number;
  sol_balance: number;
  score?: number;
}

interface DragonConfig {
  // 🔧 ЕДИНСТВЕННОЕ что нужно - путь к файлам Dragon
  dragonOutputPath: string;
  
  // Критерии фильтрации (работают превосходно - 11 из 100!)
  minPnl: number;
  minWinrate: number;
  minTrades: number;
  maxDaysInactive: number;
  
  // Веса для scoring
  scoreWeights: {
    pnl: number;
    winrate: number;
    volume: number;
    trades: number;
    activity: number;
  };
}

interface DragonParseResult {
  totalParsed: number;
  filtered: number;
  added: number;
  updated: number;
  skipped: number;
  categories: { snipers: number; hunters: number; traders: number };
  topPerformers: DragonWallet[];
}

export class DragonResultsParser {
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private logger: Logger;
  private config: DragonConfig;

  constructor(
    smDatabase: SmartMoneyDatabase,
    telegramNotifier: TelegramNotifier,
    config?: Partial<DragonConfig>
  ) {
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.logger = Logger.getInstance();
    
    // 🔧 ИСПРАВЛЕНО: Только путь к файлам Dragon
    this.config = {
      dragonOutputPath: this.resolveDragonPath(config?.dragonOutputPath),
      
      // Сохраняем отличные настройки фильтрации!
      minPnl: config?.minPnl || 10000,
      minWinrate: config?.minWinrate || 65,
      minTrades: config?.minTrades || 15,
      maxDaysInactive: config?.maxDaysInactive || 7,
      
      scoreWeights: {
        pnl: 0.3,
        winrate: 0.25,
        volume: 0.2,
        trades: 0.15,
        activity: 0.1,
        ...config?.scoreWeights
      }
    };

    this.logger.info(`🐲 Dragon Results Parser initialized`);
    this.logger.info(`📁 Output path: ${this.config.dragonOutputPath}`);
    this.logger.info(`🎯 Filters: PnL≥$${this.config.minPnl}, WR≥${this.config.minWinrate}%, Trades≥${this.config.minTrades}`);
  }

  /**
   * 🔧 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: Автоматическое определение Dragon paths
   */
  private resolveDragonPath(customPath?: string): string {
    if (customPath) {
      return customPath;
    }

    // 1. Environment variable (для Render и Git)
    if (process.env.DRAGON_OUTPUT_PATH) {
      this.logger.info(`📁 Using DRAGON_OUTPUT_PATH: ${process.env.DRAGON_OUTPUT_PATH}`);
      return process.env.DRAGON_OUTPUT_PATH;
    }

    // 2. Проверяем стандартные локации
    const possiblePaths = [
      // Render/Production (с Git)
      '/opt/render/project/src/data/dragon-output',
      '/app/data/dragon/output',
      
      // Local development (с Git)  
      './data/dragon-output',
      './dragon-git/dragon-files',
      
      // Windows Git папка (ваша новая)
      'C:\\Users\\ibm\\OneDrive\\Документы\\dragon-git\\dragon-files',
      
      // Старый Windows путь (fallback)
      'C:\\Users\\ibm\\OneDrive\\Документы\\Dragon-main\\Dragon\\data\\Solana\\TopTraders\\',
      
      // Alternative paths
      './Dragon/data/Solana/TopTraders',
      'C:\\Dragon\\data\\Solana\\TopTraders\\',
      'D:\\Dragon\\data\\Solana\\TopTraders\\',
      
      // macOS/Linux
      path.join(os.homedir(), 'dragon-git/dragon-files'),
      path.join(os.homedir(), 'Dragon/data/Solana/TopTraders'),
      '/opt/dragon/data/Solana/TopTraders'
    ];

    for (const testPath of possiblePaths) {
      if (fs.existsSync(testPath)) {
        this.logger.info(`✅ Found Dragon output path: ${testPath}`);
        return testPath;
      }
    }

    // Fallback - создаем локальную папку
    const fallbackPath = path.join(process.cwd(), 'data', 'dragon', 'output');
    if (!fs.existsSync(fallbackPath)) {
      fs.mkdirSync(fallbackPath, { recursive: true });
      this.logger.info(`📁 Created fallback Dragon path: ${fallbackPath}`);
    }
    
    return fallbackPath;
  }

  /**
   * 🔄 СИНХРОНИЗАЦИЯ С GIT РЕПОЗИТОРИЕМ
   */
  private async syncFromGit(): Promise<void> {
    try {
      const outputPath = this.config.dragonOutputPath;
      const repoUrl = process.env.DRAGON_REPO_URL;
      const githubToken = process.env.GITHUB_TOKEN;

      if (!repoUrl) {
        this.logger.warn('⚠️ DRAGON_REPO_URL not configured, skipping Git sync');
        return;
      }

      // Подготавливаем URL с токеном для приватного repo
      let authUrl = repoUrl;
      if (githubToken && repoUrl.includes('github.com')) {
        authUrl = repoUrl.replace('https://github.com/', `https://${githubToken}@github.com/`);
      }

      this.logger.info(`🔄 Syncing Dragon files from Git...`);
      this.logger.info(`📁 Target path: ${outputPath}`);

      // Проверяем, существует ли Git репозиторий
      const gitPath = path.join(outputPath, '.git');
      
      if (!fs.existsSync(gitPath)) {
        // Первый запуск - клонируем репозиторий
        this.logger.info('🆕 First run - cloning Dragon repository...');
        
        // Создаем родительскую папку если нужно
        const parentDir = path.dirname(outputPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        await execAsync(`git clone "${authUrl}" "${outputPath}"`);
        this.logger.info('✅ Dragon repository cloned successfully');
        
      } else {
        // Обновляем существующий репозиторий
        this.logger.info('🔄 Updating existing Dragon repository...');
        
        try {
          await execAsync(`cd "${outputPath}" && git pull`);
          this.logger.info('✅ Dragon repository updated successfully');
        } catch (error) {
          this.logger.warn('⚠️ Git pull failed, trying to reset and pull again...');
          
          // Пытаемся сбросить и подтянуть заново
          await execAsync(`cd "${outputPath}" && git reset --hard HEAD`);
          await execAsync(`cd "${outputPath}" && git pull`);
          this.logger.info('✅ Dragon repository reset and updated');
        }
      }

      // Проверяем наличие JSON файлов
      const files = await this.findLatestDragonFiles();
      this.logger.info(`📄 Found ${files.length} Dragon JSON files after sync`);

    } catch (error) {
      this.logger.error('❌ Error syncing from Git:', error);
      // Не бросаем ошибку - продолжаем работать с локальными файлами
    }
  }

  /**
   * ✅ ОСНОВНОЙ МЕТОД: Парсинг последних результатов Dragon
   */
  async parseLatestDragonResults(): Promise<DragonParseResult> {
    try {
      this.logger.info('🐲 Starting Dragon results parsing...');

      // 🆕 1. Синхронизируемся с Git репозиторием
      await this.syncFromGit();

      // 2. Поиск новых файлов Dragon (теперь после Git sync)
      const files = await this.findLatestDragonFiles();
      if (files.length === 0) {
        this.logger.warn('⚠️ No Dragon files found after Git sync');
        return this.createEmptyResult();
      }

      this.logger.info(`📄 Found ${files.length} Dragon files to process`);

      // 3. Парсинг JSON файлов
      const allWallets: DragonWallet[] = [];
      for (const filePath of files) {
        const wallets = await this.parseDragonJsonFile(filePath);
        allWallets.push(...wallets);
        this.logger.info(`📊 Parsed ${wallets.length} wallets from ${path.basename(filePath)}`);
      }

      // 4. Дедупликация по адресу
      const uniqueWallets = this.deduplicateWallets(allWallets);
      this.logger.info(`🔄 After deduplication: ${uniqueWallets.length} unique wallets`);

      // 5. Фильтрация по критериям (ВАША ОТЛИЧНАЯ ЛОГИКА!)
      const filteredWallets = this.filterWallets(uniqueWallets);
      this.logger.info(`✅ After filtering: ${filteredWallets.length} quality wallets (${((filteredWallets.length / uniqueWallets.length) * 100).toFixed(1)}% selected)`);

      // 6. Расчет рейтингов
      const scoredWallets = this.calculateScores(filteredWallets);
      
      // 7. Сортировка по рейтингу
      scoredWallets.sort((a, b) => (b.score || 0) - (a.score || 0));

      // 8. Добавление в базу данных
      const dbResult = await this.addWalletsToDatabase(scoredWallets);

      // 9. Отправка уведомления
      await this.sendDragonImportNotification(dbResult, scoredWallets.slice(0, 10));

      return dbResult;

    } catch (error) {
      this.logger.error('❌ Error parsing Dragon results:', error);
      throw error;
    }
  }

  /**
   * 🔍 Поиск последних JSON файлов Dragon (игнорирует Git файлы)
   */
  private async findLatestDragonFiles(): Promise<string[]> {
    try {
      if (!fs.existsSync(this.config.dragonOutputPath)) {
        this.logger.warn(`⚠️ Dragon output path not found: ${this.config.dragonOutputPath}`);
        return [];
      }

      const files = fs.readdirSync(this.config.dragonOutputPath);
      
      // ✅ ИСПРАВЛЕНО: Игнорируем Git файлы и ищем только JSON Dragon файлы
      const jsonFiles = files
        .filter(file => {
          // Игнорируем Git служебные файлы
          if (file.startsWith('.git')) return false;
          if (file === 'README.md') return false;
          if (file === '.gitignore') return false;
          
          // Только JSON файлы Dragon
          return file.endsWith('.json') && (
            file.includes('topTraders') || 
            file.includes('TopTraders') ||
            file.includes('dragon') ||
            file.includes('traders')
          );
        })
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
   * 📄 Парсинг отдельного JSON файла Dragon
   */
  private async parseDragonJsonFile(filePath: string): Promise<DragonWallet[]> {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const jsonData = JSON.parse(fileContent);

      const dragonWallets: DragonWallet[] = [];

      // Dragon создает объект где ключ = адрес кошелька, значение = метрики
      for (const [walletAddress, metrics] of Object.entries(jsonData)) {
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

        // Рассчитываем winrate
        const winrate = totalTrades > 0 ? (sells / totalTrades) * 100 : 0;

        // Валидируем адрес и данные
        if (walletAddress && walletAddress.length >= 32 && totalTrades > 0) {
          dragonWallets.push({
            wallet: walletAddress,
            pnl: totalProfit,
            winrate: winrate,
            trades: totalTrades,
            volume: boughtUsd,
            last_active: Date.now() / 1000,
            sol_balance: 0
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
   * 💰 Парсинг строки с USD в число
   */
  private parseUsdString(usdString: string): number {
    if (!usdString || typeof usdString !== 'string') {
      return 0;
    }
    
    const cleaned = usdString.replace(/[$,\s]/g, '');
    const number = parseFloat(cleaned);
    
    return isNaN(number) ? 0 : number;
  }

  /**
   * 🔄 Дедупликация кошельков по адресу
   */
  private deduplicateWallets(wallets: DragonWallet[]): DragonWallet[] {
    const walletMap = new Map<string, DragonWallet>();
    
    for (const wallet of wallets) {
      const existing = walletMap.get(wallet.wallet);
      
      if (!existing || wallet.pnl > existing.pnl) {
        walletMap.set(wallet.wallet, wallet);
      }
    }
    
    return Array.from(walletMap.values());
  }

  /**
   * 🎯 ВАША ОТЛИЧНАЯ ФИЛЬТРАЦИЯ! (11 из 100 - превосходно!)
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
      
      // Фильтр по активности
      const daysSinceActive = (now - wallet.last_active) / (24 * 60 * 60);
      if (daysSinceActive > this.config.maxDaysInactive) return false;
      
      return true;
    });
  }

  /**
   * 📊 Расчет рейтинга кошелька
   */
  private calculateScores(wallets: DragonWallet[]): DragonWallet[] {
    const maxPnl = Math.max(...wallets.map(w => w.pnl));
    const maxVolume = Math.max(...wallets.map(w => w.volume));
    const maxTrades = Math.max(...wallets.map(w => w.trades));
    const now = Date.now() / 1000;
    
    return wallets.map(wallet => {
      const pnlScore = wallet.pnl / maxPnl;
      const winrateScore = wallet.winrate / 100;
      const volumeScore = maxVolume > 0 ? wallet.volume / maxVolume : 0;
      const tradesScore = maxTrades > 0 ? wallet.trades / maxTrades : 0;
      
      const daysSinceActive = (now - wallet.last_active) / (24 * 60 * 60);
      const activityScore = Math.max(0, 1 - (daysSinceActive / this.config.maxDaysInactive));
      
      const score = (
        pnlScore * this.config.scoreWeights.pnl +
        winrateScore * this.config.scoreWeights.winrate +
        volumeScore * this.config.scoreWeights.volume +
        tradesScore * this.config.scoreWeights.trades +
        activityScore * this.config.scoreWeights.activity
      ) * 100;
      
      return {
        ...wallet,
        score: Math.round(score * 100) / 100
      };
    });
  }

  /**
   * 💾 Добавление кошельков в базу данных
   */
  private async addWalletsToDatabase(wallets: DragonWallet[]): Promise<DragonParseResult> {
    const result: DragonParseResult = {
      totalParsed: wallets.length,
      filtered: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      categories: { snipers: 0, hunters: 0, traders: 0 },
      topPerformers: wallets.slice(0, 10)
    };

    for (const wallet of wallets) {
      try {
        const category = this.determineWalletCategory(wallet);
        const existingWallet = await this.smDatabase.getSmartWallet(wallet.wallet);
        
        if (existingWallet) {
          if (wallet.pnl > existingWallet.totalPnL || wallet.winrate > existingWallet.winRate) {
            await this.updateExistingWallet(existingWallet, wallet, category);
            result.updated++;
          } else {
            result.skipped++;
          }
        } else {
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
   * 🎯 Определение категории кошелька
   */
  private determineWalletCategory(wallet: DragonWallet): 'sniper' | 'hunter' | 'trader' {
    // Высокий PnL + много сделок = trader
    if (wallet.pnl > 50000 && wallet.trades > 50) {
      return 'trader';
    }
    
    // Средний PnL + средние сделки = hunter  
    if (wallet.pnl > 20000 && wallet.trades > 20) {
      return 'hunter';
    }
    
    // Остальные = sniper
    return 'sniper';
  }

  /**
   * ➕ Добавление нового кошелька
   */
  private async addNewWallet(wallet: DragonWallet, category: 'sniper' | 'hunter' | 'trader'): Promise<void> {
    const smartWallet = {
      address: wallet.wallet,
      category,
      winRate: wallet.winrate,
      totalPnL: wallet.pnl,
      totalTrades: wallet.trades,
      avgTradeSize: wallet.trades > 0 ? wallet.volume / wallet.trades : 0,
      maxTradeSize: wallet.volume * 0.1, // примерная оценка
      minTradeSize: wallet.volume * 0.001, // примерная оценка
      performanceScore: wallet.score || 75,
      lastActiveAt: new Date(wallet.last_active * 1000),
      isActive: true
    };

    await this.smDatabase.saveSmartWallet(smartWallet, {
      nickname: `${category.charAt(0).toUpperCase() + category.slice(1)} ${wallet.wallet.slice(0, 8)}`,
      addedBy: 'dragon',
      verified: true,
      enabled: true,
      priority: wallet.score && wallet.score > 85 ? 'high' : 'medium'
    });
  }

  /**
   * 🔄 Обновление существующего кошелька
   */
  private async updateExistingWallet(existing: any, wallet: DragonWallet, category: 'sniper' | 'hunter' | 'trader'): Promise<void> {
    await this.smDatabase.updateWalletPerformance(existing.address, {
      winRate: wallet.winrate,
      totalPnL: wallet.pnl,
      totalTrades: wallet.trades,
      lastActiveAt: new Date(wallet.last_active * 1000),
      performanceScore: wallet.score
    });
  }

  /**
   * 📤 Отправка уведомления
   */
  private async sendDragonImportNotification(result: DragonParseResult, topPerformers: DragonWallet[]): Promise<void> {
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
${topPerformers.slice(0, 5).map((w, i) => 
  `<code>${i + 1}.</code> $${w.pnl.toFixed(0)} | ${w.winrate.toFixed(1)}% WR | ${w.trades} trades`
).join('\n')}

⏰ <code>${new Date().toLocaleString()}</code>`;

    await this.telegramNotifier.sendCycleLog(message);
  }

  /**
   * 📊 Создание пустого результата
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
   * 🎯 МЕТОД для ручного запуска Git синхронизации (для команды /dragon)
   */
  async forceSyncFromGit(): Promise<boolean> {
    try {
      await this.syncFromGit();
      return true;
    } catch (error) {
      this.logger.error('❌ Force Git sync failed:', error);
      return false;
    }
  }

  /**
   * 📋 Получение статистики Dragon
   */
  async getDragonStats(): Promise<{
    lastRun?: Date;
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