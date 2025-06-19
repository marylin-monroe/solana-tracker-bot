// src/services/DragonResultsParser.ts - PROFIT-FIRST OPTIMIZED: Максимальная прибыльность за счет умной фильтрации
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
  profitFactor?: number; // 🆕 ДОБАВЛЕНО для приоритизации
  tier?: 'whale' | 'genius' | 'quality' | 'filter_out'; // 🆕 НОВАЯ КЛАССИФИКАЦИЯ
}

interface DragonConfig {
  dragonOutputPath: string;
  
  // 🚀 PROFIT-FIRST КРИТЕРИИ (реалистичные для заработка)
  minPnl: number;           // Увеличено до $50K
  minWinrate: number;       // Снижено до 35%
  minTrades: number;        // Снижено до 10
  maxDaysInactive: number;
  
  // 🆕 WHALE DETECTION (автопроходы)
  whaleThresholds: {
    megaWhale: number;      // $1M+ автопроходы
    whale: number;          // $500K+ автопроходы  
    bigPlayer: number;      // $200K+ с 40% WR
    quality: number;        // $100K+ с 45% WR
  };
  
  // 🔧 СКОРРЕКТИРОВАННЫЕ ВЕСА (PnL приоритет)
  scoreWeights: {
    pnl: number;           // Увеличен до 0.5
    winrate: number;       // Снижен до 0.2
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
  
  // 🆕 PROFIT ANALYTICS
  profitDistribution: {
    megaWhales: number;    // $1M+
    whales: number;        // $500K+
    bigPlayers: number;    // $200K+
    quality: number;       // $100K+
    regular: number;       // <$100K
  };
  averagePnL: number;
  totalValue: number;
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
    
    // 🚀 PROFIT-FIRST КОНФИГУРАЦИЯ
    this.config = {
      dragonOutputPath: this.resolveDragonPath(config?.dragonOutputPath),
      
      // ✅ НОВЫЕ РЕАЛИСТИЧНЫЕ КРИТЕРИИ (для заработка)
      minPnl: config?.minPnl || 50000,        // $50K (было $10K)
      minWinrate: config?.minWinrate || 35,   // 35% (было 65%)
      minTrades: config?.minTrades || 10,     // 10 (было 15)
      maxDaysInactive: config?.maxDaysInactive || 7,
      
      // 🐳 WHALE DETECTION THRESHOLDS
      whaleThresholds: {
        megaWhale: 1_000_000,  // $1M+ 
        whale: 500_000,        // $500K+
        bigPlayer: 200_000,    // $200K+
        quality: 100_000,      // $100K+
        ...config?.whaleThresholds
      },
      
      // 🔧 PnL-ПРИОРИТЕТНЫЕ ВЕСА
      scoreWeights: {
        pnl: 0.5,           // Увеличен с 0.3 до 0.5
        winrate: 0.2,       // Снижен с 0.25 до 0.2
        volume: 0.15,       // Снижен с 0.2 до 0.15
        trades: 0.1,        // Снижен с 0.15 до 0.1
        activity: 0.05,     // Снижен с 0.1 до 0.05
        ...config?.scoreWeights
      }
    };

    this.logger.info(`🐲 Dragon Results Parser initialized (PROFIT-FIRST MODE)`);
    this.logger.info(`💰 NEW THRESHOLDS: PnL≥$${this.config.minPnl/1000}K, WR≥${this.config.minWinrate}%, Trades≥${this.config.minTrades}`);
    this.logger.info(`🐳 WHALE DETECTION: $${this.config.whaleThresholds.whale/1000}K+ auto-pass`);
  }

  /**
   * 🔧 Автоматическое определение Dragon paths (без изменений)
   */
  private resolveDragonPath(customPath?: string): string {
    if (customPath) {
      return customPath;
    }

    if (process.env.DRAGON_OUTPUT_PATH) {
      this.logger.info(`📁 Using DRAGON_OUTPUT_PATH: ${process.env.DRAGON_OUTPUT_PATH}`);
      return process.env.DRAGON_OUTPUT_PATH;
    }

    const possiblePaths = [
      '/opt/render/project/src/data/dragon-output',
      '/app/data/dragon/output',
      './data/dragon-output',
      './dragon-git/dragon-files',
      'C:\\Users\\ibm\\OneDrive\\Документы\\dragon-git\\dragon-files',
      'C:\\Users\\ibm\\OneDrive\\Документы\\Dragon-main\\Dragon\\data\\Solana\\TopTraders\\',
      './Dragon/data/Solana/TopTraders',
      'C:\\Dragon\\data\\Solana\\TopTraders\\',
      'D:\\Dragon\\data\\Solana\\TopTraders\\',
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

    const fallbackPath = path.join(process.cwd(), 'data', 'dragon', 'output');
    if (!fs.existsSync(fallbackPath)) {
      fs.mkdirSync(fallbackPath, { recursive: true });
      this.logger.info(`📁 Created fallback Dragon path: ${fallbackPath}`);
    }
    
    return fallbackPath;
  }

  /**
   * 🔄 Git синхронизация (без изменений)
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

      let authUrl = repoUrl;
      if (githubToken && repoUrl.includes('github.com')) {
        if (githubToken.trim().length > 0) {
          authUrl = repoUrl.replace('https://github.com/', `https://${githubToken}@github.com/`);
        } else {
          this.logger.warn('⚠️ GITHUB_TOKEN is empty, using repo URL without authentication');
        }
      }

      this.logger.info(`🔄 Syncing Dragon files from Git...`);
      this.logger.info(`📁 Target path: ${outputPath}`);

      const gitPath = path.join(outputPath, '.git');
      
      if (!fs.existsSync(gitPath)) {
        this.logger.info('🆕 First run - cloning Dragon repository...');
        
        const parentDir = path.dirname(outputPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        try {
          await execAsync(`git clone "${authUrl}" "${outputPath}"`);
          this.logger.info('✅ Dragon repository cloned successfully');
        } catch (cloneError) {
          this.logger.error('❌ Failed to clone Dragon repository:', cloneError);
          if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
          }
          return;
        }
        
      } else {
        this.logger.info('🔄 Updating existing Dragon repository...');
        
        try {
          const { stdout, stderr } = await execAsync(`cd "${outputPath}" && git pull`);
          if (stderr && !stderr.includes('Already up to date')) {
            this.logger.warn('⚠️ Git pull warnings:', stderr);
          }
          this.logger.info('✅ Dragon repository updated successfully');
        } catch (pullError) {
          this.logger.warn('⚠️ Git pull failed, trying to reset and pull again...');
          
          try {
            await execAsync(`cd "${outputPath}" && git reset --hard HEAD`);
            await execAsync(`cd "${outputPath}" && git pull`);
            this.logger.info('✅ Dragon repository reset and updated');
          } catch (resetError) {
            this.logger.error('❌ Failed to reset and pull repository:', resetError);
          }
        }
      }

      const files = await this.findLatestDragonFiles();
      this.logger.info(`📄 Found ${files.length} Dragon JSON files after sync`);

    } catch (error) {
      this.logger.error('❌ Error syncing from Git:', error);
    }
  }

  /**
   * ✅ ОСНОВНОЙ МЕТОД: Парсинг с profit-first логикой
   */
  async parseLatestDragonResults(): Promise<DragonParseResult> {
    try {
      this.logger.info('🐲 Starting PROFIT-FIRST Dragon results parsing...');

      await this.syncFromGit();

      const files = await this.findLatestDragonFiles();
      if (files.length === 0) {
        this.logger.warn('⚠️ No Dragon files found after Git sync');
        return this.createEmptyResult();
      }

      this.logger.info(`📄 Found ${files.length} Dragon files to process`);

      // Парсинг JSON файлов
      const allWallets: DragonWallet[] = [];
      for (const filePath of files) {
        const wallets = await this.parseDragonJsonFile(filePath);
        allWallets.push(...wallets);
        this.logger.info(`📊 Parsed ${wallets.length} wallets from ${path.basename(filePath)}`);
      }

      // Дедупликация
      const uniqueWallets = this.deduplicateWallets(allWallets);
      this.logger.info(`🔄 After deduplication: ${uniqueWallets.length} unique wallets`);

      // 🚀 НОВАЯ PROFIT-FIRST ФИЛЬТРАЦИЯ
      const filteredWallets = this.applyProfitFirstFiltering(uniqueWallets);
      this.logger.info(`💰 After PROFIT-FIRST filtering: ${filteredWallets.length} high-quality wallets (${((filteredWallets.length / uniqueWallets.length) * 100).toFixed(1)}% selected)`);

      // Расчет новых рейтингов
      const scoredWallets = this.calculateProfitFirstScores(filteredWallets);
      
      // Сортировка по новой логике (PnL приоритет)
      scoredWallets.sort((a, b) => this.compareProfitPriority(a, b));

      // Добавление в базу данных
      const dbResult = await this.addWalletsToDatabase(scoredWallets);

      // Расширенная аналитика
      const enrichedResult = this.enrichResultWithProfitAnalytics(dbResult, scoredWallets);

      // Отправка уведомления с profit-аналитикой
      await this.sendProfitFirstNotification(enrichedResult, scoredWallets.slice(0, 10));

      return enrichedResult;

    } catch (error) {
      this.logger.error('❌ Error parsing Dragon results:', error);
      throw error;
    }
  }

  /**
   * 🔍 Поиск файлов (без изменений)
   */
  private async findLatestDragonFiles(): Promise<string[]> {
    try {
      if (!fs.existsSync(this.config.dragonOutputPath)) {
        this.logger.warn(`⚠️ Dragon output path not found: ${this.config.dragonOutputPath}`);
        return [];
      }

      const files = fs.readdirSync(this.config.dragonOutputPath);
      
      const jsonFiles = files
        .filter(file => {
          if (file.startsWith('.git')) return false;
          if (file === 'README.md') return false;
          if (file === '.gitignore') return false;
          if (file === 'package.json') return false;
          if (file === 'package-lock.json') return false;
          
          return file.endsWith('.json') && (
            file.includes('topTraders') || 
            file.includes('TopTraders') ||
            file.includes('dragon') ||
            file.includes('traders') ||
            file.includes('wallet') ||
            file.includes('result')
          );
        })
        .map(file => {
          const filePath = path.join(this.config.dragonOutputPath, file);
          let mtime: Date;
          try {
            mtime = fs.statSync(filePath).mtime;
          } catch (error) {
            this.logger.warn(`⚠️ Could not get mtime for ${file}:`, error);
            mtime = new Date(0);
          }
          return {
            name: file,
            path: filePath,
            mtime
          };
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, 5)
        .map(file => file.path);

      this.logger.info(`🔍 Dragon files found: ${jsonFiles.map(f => path.basename(f)).join(', ')}`);
      return jsonFiles;

    } catch (error) {
      this.logger.error('❌ Error finding Dragon files:', error);
      return [];
    }
  }

  /**
   * 📄 Парсинг JSON файла (без изменений)
   */
  private async parseDragonJsonFile(filePath: string): Promise<DragonWallet[]> {
    try {
      this.logger.info(`📄 Parsing Dragon file: ${path.basename(filePath)}`);
      
      const fileContent = fs.readFileSync(filePath, 'utf8');
      
      let jsonData: any;
      try {
        jsonData = JSON.parse(fileContent);
      } catch (parseError) {
        this.logger.error(`❌ Invalid JSON in file ${filePath}:`, parseError);
        return [];
      }

      const dragonWallets: DragonWallet[] = [];

      for (const [walletAddress, metrics] of Object.entries(jsonData)) {
        if (!metrics || typeof metrics !== 'object' || Object.keys(metrics).length === 0) {
          continue;
        }

        const data = metrics as any;

        const boughtUsd = this.parseUsdString(data.boughtUsd || '0');
        const totalProfit = this.parseUsdString(data.totalProfit || '0');
        const buys = parseInt(data.buys || '0');
        const sells = parseInt(data.sells || '0');
        const totalTrades = buys + sells;

        const winrate = totalTrades > 0 ? 
          (data.winRate !== undefined ? parseFloat(data.winRate) : 
           (sells > 0 ? (sells / totalTrades) * 100 : 0)) : 0;

        if (this.isValidSolanaAddress(walletAddress) && totalTrades > 0 && boughtUsd > 0) {
          dragonWallets.push({
            wallet: walletAddress,
            pnl: totalProfit,
            winrate: Math.min(winrate, 100),
            trades: totalTrades,
            volume: boughtUsd,
            last_active: Date.now() / 1000,
            sol_balance: parseFloat(data.solBalance || '0')
          });
        }
      }

      this.logger.info(`✅ Parsed ${dragonWallets.length} valid wallets from ${path.basename(filePath)}`);
      return dragonWallets;

    } catch (error) {
      this.logger.error(`❌ Error parsing Dragon JSON file ${filePath}:`, error);
      return [];
    }
  }

  /**
   * 🔍 Валидация адреса (без изменений)
   */
  private isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    if (address.length < 32 || address.length > 44) return false;
    
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return base58Regex.test(address);
  }

  /**
   * 💰 Парсинг USD строки (без изменений)
   */
  private parseUsdString(usdString: string): number {
    if (!usdString || typeof usdString !== 'string') {
      return 0;
    }
    
    const cleaned = usdString.replace(/[$,\s]/g, '');
    
    let multiplier = 1;
    if (cleaned.endsWith('K') || cleaned.endsWith('k')) {
      multiplier = 1000;
    } else if (cleaned.endsWith('M') || cleaned.endsWith('m')) {
      multiplier = 1000000;
    } else if (cleaned.endsWith('B') || cleaned.endsWith('b')) {
      multiplier = 1000000000;
    }
    
    const numberPart = cleaned.replace(/[KMBkmb]$/, '');
    const number = parseFloat(numberPart);
    
    return isNaN(number) ? 0 : number * multiplier;
  }

  /**
   * 🔄 Дедупликация (без изменений)
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
   * 🚀 НОВАЯ PROFIT-FIRST ФИЛЬТРАЦИЯ
   */
  private applyProfitFirstFiltering(wallets: DragonWallet[]): DragonWallet[] {
    const now = Date.now() / 1000;
    
    return wallets.filter(wallet => {
      // 🐳 WHALE AUTO-PASS: Мега-киты проходят с любым WR
      if (wallet.pnl >= this.config.whaleThresholds.megaWhale) {
        wallet.tier = 'whale';
        this.logger.debug(`🐳 MEGA-WHALE AUTO-PASS: $${wallet.pnl/1000}K with ${wallet.winrate.toFixed(1)}% WR`);
        return true;
      }

      // 🐋 WHALE AUTO-PASS: Киты проходят с WR ≥ 30%
      if (wallet.pnl >= this.config.whaleThresholds.whale && wallet.winrate >= 30) {
        wallet.tier = 'whale';
        this.logger.debug(`🐋 WHALE AUTO-PASS: $${wallet.pnl/1000}K with ${wallet.winrate.toFixed(1)}% WR`);
        return true;
      }

      // 💰 BIG PLAYER: $200K+ нужен WR ≥ 40%
      if (wallet.pnl >= this.config.whaleThresholds.bigPlayer && wallet.winrate >= 40) {
        wallet.tier = 'genius';
        this.logger.debug(`💰 BIG PLAYER PASS: $${wallet.pnl/1000}K with ${wallet.winrate.toFixed(1)}% WR`);
        return true;
      }

      // 💎 QUALITY: $100K+ нужен WR ≥ 45%
      if (wallet.pnl >= this.config.whaleThresholds.quality && wallet.winrate >= 45) {
        wallet.tier = 'quality';
        return true;
      }

      // 📊 STANDARD FILTERS: Базовые критерии
      if (wallet.pnl < this.config.minPnl) {
        wallet.tier = 'filter_out';
        return false;
      }
      
      if (wallet.winrate < this.config.minWinrate) {
        wallet.tier = 'filter_out';
        return false;
      }
      
      if (wallet.trades < this.config.minTrades) {
        wallet.tier = 'filter_out';
        return false;
      }
      
      // Фильтр по активности
      const daysSinceActive = (now - wallet.last_active) / (24 * 60 * 60);
      if (daysSinceActive > this.config.maxDaysInactive) {
        wallet.tier = 'filter_out';
        return false;
      }
      
      // Дополнительные фильтры безопасности
      if (wallet.winrate > 99.9) {
        wallet.tier = 'filter_out';
        return false; // Подозрительно высокий WR
      }
      
      if (wallet.volume > wallet.pnl * 100) {
        wallet.tier = 'filter_out';
        return false; // Нереалистичное соотношение
      }
      
      wallet.tier = 'quality';
      return true;
    });
  }

  /**
   * 📊 НОВЫЙ РАСЧЕТ РЕЙТИНГА С PROFIT-PRIORITY
   */
  private calculateProfitFirstScores(wallets: DragonWallet[]): DragonWallet[] {
    if (wallets.length === 0) return wallets;
    
    const maxPnl = Math.max(...wallets.map(w => w.pnl));
    const maxVolume = Math.max(...wallets.map(w => w.volume));
    const maxTrades = Math.max(...wallets.map(w => w.trades));
    const now = Date.now() / 1000;
    
    return wallets.map(wallet => {
      // 🚀 НОВАЯ ФОРМУЛА РАСЧЕТА SCORE (PnL доминирует)
      const pnlScore = maxPnl > 0 ? wallet.pnl / maxPnl : 0;
      const winrateScore = wallet.winrate / 100;
      const volumeScore = maxVolume > 0 ? wallet.volume / maxVolume : 0;
      const tradesScore = maxTrades > 0 ? wallet.trades / maxTrades : 0;
      
      const daysSinceActive = (now - wallet.last_active) / (24 * 60 * 60);
      const activityScore = Math.max(0, 1 - (daysSinceActive / this.config.maxDaysInactive));
      
      // 🔧 ПРИМЕНЯЕМ НОВЫЕ ВЕСА (PnL = 0.5)
      let score = (
        pnlScore * this.config.scoreWeights.pnl +
        winrateScore * this.config.scoreWeights.winrate +
        volumeScore * this.config.scoreWeights.volume +
        tradesScore * this.config.scoreWeights.trades +
        activityScore * this.config.scoreWeights.activity
      ) * 100;

      // 🐳 TIER BONUS: Дополнительные баллы за tier
      if (wallet.tier === 'whale') {
        score += 25; // Киты получают +25 баллов
      } else if (wallet.tier === 'genius') {
        score += 15; // Гении получают +15 баллов
      } else if (wallet.tier === 'quality') {
        score += 5;  // Качественные получают +5 баллов
      }

      // 📈 Расчет Profit Factor (если есть данные)
      if (wallet.trades > 0 && wallet.pnl > 0) {
        const avgProfitPerTrade = wallet.pnl / wallet.trades;
        wallet.profitFactor = avgProfitPerTrade > 0 ? 
          Math.min(avgProfitPerTrade / 1000, 10) : 0; // Нормализуем
      }
      
      return {
        ...wallet,
        score: Math.round(score * 100) / 100
      };
    });
  }

  /**
   * 🔀 НОВОЕ СРАВНЕНИЕ ПО PROFIT-PRIORITY
   */
  private compareProfitPriority(a: DragonWallet, b: DragonWallet): number {
    // 1. Сначала по tier
    const tierPriority = { whale: 4, genius: 3, quality: 2, filter_out: 1 };
    const aTier = tierPriority[a.tier || 'quality'] || 2;
    const bTier = tierPriority[b.tier || 'quality'] || 2;
    
    if (aTier !== bTier) {
      return bTier - aTier; // Высший tier первым
    }
    
    // 2. Внутри tier - по PnL (главный критерий)
    if (Math.abs(a.pnl - b.pnl) > 10000) { // Разница больше $10K
      return b.pnl - a.pnl;
    }
    
    // 3. При близких PnL - по score
    return (b.score || 0) - (a.score || 0);
  }

  /**
   * 📊 ОБОГАЩЕНИЕ РЕЗУЛЬТАТА PROFIT-АНАЛИТИКОЙ
   */
  private enrichResultWithProfitAnalytics(
    result: DragonParseResult, 
    wallets: DragonWallet[]
  ): DragonParseResult {
    
    const profitDistribution = {
      megaWhales: wallets.filter(w => w.pnl >= this.config.whaleThresholds.megaWhale).length,
      whales: wallets.filter(w => w.pnl >= this.config.whaleThresholds.whale && w.pnl < this.config.whaleThresholds.megaWhale).length,
      bigPlayers: wallets.filter(w => w.pnl >= this.config.whaleThresholds.bigPlayer && w.pnl < this.config.whaleThresholds.whale).length,
      quality: wallets.filter(w => w.pnl >= this.config.whaleThresholds.quality && w.pnl < this.config.whaleThresholds.bigPlayer).length,
      regular: wallets.filter(w => w.pnl < this.config.whaleThresholds.quality).length
    };

    const totalValue = wallets.reduce((sum, w) => sum + w.pnl, 0);
    const averagePnL = wallets.length > 0 ? totalValue / wallets.length : 0;

    return {
      ...result,
      profitDistribution,
      averagePnL,
      totalValue,
      topPerformers: wallets.slice(0, 15) // Увеличиваем до 15 топов
    };
  }

  /**
   * 💾 Добавление в базу данных (обновлено под новые tier)
   */
  private async addWalletsToDatabase(wallets: DragonWallet[]): Promise<DragonParseResult> {
    const result: DragonParseResult = {
      totalParsed: wallets.length,
      filtered: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      categories: { snipers: 0, hunters: 0, traders: 0 },
      topPerformers: wallets.slice(0, 10),
      profitDistribution: { megaWhales: 0, whales: 0, bigPlayers: 0, quality: 0, regular: 0 },
      averagePnL: 0,
      totalValue: 0
    };

    for (const wallet of wallets) {
      try {
        const category = this.determineWalletCategory(wallet);
        const existingWallet = await this.smDatabase.getSmartWallet(wallet.wallet);
        
        if (existingWallet) {
          if (wallet.pnl > existingWallet.totalPnL || 
              wallet.winrate > existingWallet.winRate ||
              wallet.trades > existingWallet.totalTrades) {
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

    this.logger.info(`💾 Database update complete: +${result.added} added, ~${result.updated} updated, =${result.skipped} skipped`);
    return result;
  }

  /**
   * 🎯 ОБНОВЛЕННОЕ определение категории (с учетом tier)
   */
  private determineWalletCategory(wallet: DragonWallet): 'sniper' | 'hunter' | 'trader' {
    // Tier влияет на категорию
    if (wallet.tier === 'whale') {
      return 'trader'; // Киты = трейдеры
    }
    
    // Высокий PnL + много сделок = trader
    if (wallet.pnl > 100000 && wallet.trades > 50) {
      return 'trader';
    }
    
    // Средний PnL + средние сделки = hunter  
    if (wallet.pnl > 50000 && wallet.trades > 20) {
      return 'hunter';
    }
    
    // Остальные = sniper
    return 'sniper';
  }

  /**
   * ➕ Добавление нового кошелька (обновлено)
   */
  private async addNewWallet(wallet: DragonWallet, category: 'sniper' | 'hunter' | 'trader'): Promise<void> {
    const smartWallet = {
      address: wallet.wallet,
      category,
      winRate: wallet.winrate,
      totalPnL: wallet.pnl,
      totalTrades: wallet.trades,
      avgTradeSize: wallet.trades > 0 ? wallet.volume / wallet.trades : 0,
      maxTradeSize: wallet.volume * 0.1,
      minTradeSize: wallet.volume * 0.001,
      performanceScore: wallet.score || 75,
      lastActiveAt: new Date(wallet.last_active * 1000),
      isActive: true
    };

    // 🆕 TIER-BASED PRIORITY
    let priority: 'high' | 'medium' | 'low' = 'medium';
    if (wallet.tier === 'whale') {
      priority = 'high';
    } else if (wallet.tier === 'genius') {
      priority = 'high';
    } else if (wallet.score && wallet.score > 85) {
      priority = 'high';
    }

    await this.smDatabase.saveSmartWallet(smartWallet, {
      nickname: `${wallet.tier?.toUpperCase() || 'QUALITY'} ${category.charAt(0).toUpperCase() + category.slice(1)} ${wallet.wallet.slice(0, 8)}`,
      addedBy: 'dragon',
      verified: true,
      enabled: true,
      priority
    });
  }

  /**
   * 🔄 Обновление существующего кошелька (без изменений)
   */
  private async updateExistingWallet(existing: any, wallet: DragonWallet, category: 'sniper' | 'hunter' | 'trader'): Promise<void> {
    await this.smDatabase.updateWalletPerformance(existing.address, {
      winRate: Math.max(wallet.winrate, existing.winRate),
      totalPnL: Math.max(wallet.pnl, existing.totalPnL),
      totalTrades: Math.max(wallet.trades, existing.totalTrades),
      lastActiveAt: new Date(wallet.last_active * 1000),
      performanceScore: wallet.score || existing.performanceScore
    });
  }

  /**
   * 📤 НОВОЕ уведомление с profit-аналитикой
   */
  private async sendProfitFirstNotification(result: DragonParseResult, topPerformers: DragonWallet[]): Promise<void> {
    const message = `🐲 <b>Dragon Import Results (PROFIT-FIRST)</b>

📊 <b>Statistics:</b>
• Parsed: <code>${result.totalParsed}</code> wallets
• Added: <code>${result.added}</code> new
• Updated: <code>${result.updated}</code> existing  
• Skipped: <code>${result.skipped}</code> duplicates

🎯 <b>Categories:</b>
• 🔫 Snipers: <code>${result.categories.snipers}</code>
• 💡 Hunters: <code>${result.categories.hunters}</code>  
• 🐳 Traders: <code>${result.categories.traders}</code>

💰 <b>Profit Distribution:</b>
• 🐋 Mega-Whales ($1M+): <code>${result.profitDistribution.megaWhales}</code>
• 🐳 Whales ($500K+): <code>${result.profitDistribution.whales}</code>
• 💎 Big Players ($200K+): <code>${result.profitDistribution.bigPlayers}</code>
• ⭐ Quality ($100K+): <code>${result.profitDistribution.quality}</code>

📈 <b>Analytics:</b>
• Avg PnL: <code>$${this.formatNumber(result.averagePnL)}</code>
• Total Value: <code>$${this.formatNumber(result.totalValue)}</code>

🏆 <b>Top 5 Performers:</b>
${topPerformers.slice(0, 5).map((w, i) => 
  `<code>${i + 1}.</code> ${w.tier?.toUpperCase() || 'QUALITY'} - $${this.formatNumber(w.pnl)} | ${w.winrate.toFixed(1)}% WR | ${w.trades} trades`
).join('\n')}

⏰ <code>${new Date().toLocaleString()}</code>`;

    await this.telegramNotifier.sendCycleLog(message);
  }

  /**
   * 📊 Создание пустого результата (обновлено)
   */
  private createEmptyResult(): DragonParseResult {
    return {
      totalParsed: 0,
      filtered: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      categories: { snipers: 0, hunters: 0, traders: 0 },
      topPerformers: [],
      profitDistribution: { megaWhales: 0, whales: 0, bigPlayers: 0, quality: 0, regular: 0 },
      averagePnL: 0,
      totalValue: 0
    };
  }

  /**
   * 🎯 Ручная синхронизация (без изменений)
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
   * 📋 Статистика Dragon (без изменений)
   */
  async getDragonStats(): Promise<{
    lastRun?: Date;
    totalFilesFound: number;
    configPath: string;
    isConfigured: boolean;
    gitSyncEnabled: boolean;
  }> {
    const files = await this.findLatestDragonFiles();
    
    return {
      totalFilesFound: files.length,
      configPath: this.config.dragonOutputPath,
      isConfigured: fs.existsSync(this.config.dragonOutputPath),
      gitSyncEnabled: !!process.env.DRAGON_REPO_URL
    };
  }

  /**
   * 💰 Форматирование чисел (без изменений)
   */
  private formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    } else {
      return num.toFixed(0);
    }
  }
}