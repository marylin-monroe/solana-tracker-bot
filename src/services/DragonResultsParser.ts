// src/services/DragonResultsParser.ts - ИСПРАВЛЕНА КРИТИЧЕСКАЯ УТЕЧКА ПАМЯТИ
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { Logger } from '../utils/Logger';
import { SmartMoneyWallet } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface DragonWallet {
  wallet: string; pnl: number; winrate: number; trades: number; volume: number;
  last_active: number; sol_balance: number; score?: number; profitFactor?: number;
  tier?: 'whale' | 'genius' | 'quality' | 'filter_out';
}

interface DragonConfig {
  dragonOutputPath: string; minPnl: number; minWinrate: number; minTrades: number;
  maxDaysInactive: number;
  whaleThresholds: { megaWhale: number; whale: number; bigPlayer: number; quality: number; };
  scoreWeights: { pnl: number; winrate: number; volume: number; trades: number; activity: number; };
}

interface DragonParseResult {
  totalParsed: number; filtered: number; added: number; updated: number; skipped: number;
  cleared: number; categories: { snipers: number; hunters: number; traders: number };
  topPerformers: DragonWallet[]; profitDistribution: {
    megaWhales: number; whales: number; bigPlayers: number; quality: number; regular: number;
  }; averagePnL: number; totalValue: number; replaceMode?: boolean;
}

export class DragonResultsParser {
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private logger: Logger;
  private config: DragonConfig;

  constructor(smDatabase: SmartMoneyDatabase, telegramNotifier: TelegramNotifier, config?: Partial<DragonConfig>) {
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.logger = Logger.getInstance();
    
    this.config = {
      dragonOutputPath: this.resolveDragonPath(config?.dragonOutputPath),
      minPnl: config?.minPnl || 50000, minWinrate: config?.minWinrate || 58,
      minTrades: config?.minTrades || 100, maxDaysInactive: config?.maxDaysInactive || 7,
      whaleThresholds: { megaWhale: 1_000_000, whale: 500_000, bigPlayer: 200_000, quality: 100_000, ...config?.whaleThresholds },
      scoreWeights: { pnl: 0.5, winrate: 0.2, volume: 0.15, trades: 0.1, activity: 0.05, ...config?.scoreWeights }
    };

    this.logger.info(`🐲 Dragon Parser initialized with STRICT CRITERIA + MEMORY OPTIMIZATION`);
    this.logger.info(`💰 THRESHOLDS: PnL≥${this.config.minPnl/1000}K, WR≥${this.config.minWinrate}%, Trades≥${this.config.minTrades}`);
  }

  private resolveDragonPath(customPath?: string): string {
    if (customPath) return customPath;
    if (process.env.DRAGON_OUTPUT_PATH) {
      this.logger.info(`📁 Using DRAGON_OUTPUT_PATH: ${process.env.DRAGON_OUTPUT_PATH}`);
      return process.env.DRAGON_OUTPUT_PATH;
    }

    const possiblePaths = [
      '/opt/render/project/src/data/dragon-output', '/app/data/dragon/output',
      './data/dragon-output', './dragon-git/dragon-files',
      'C:\\Users\\ibm\\OneDrive\\Документы\\dragon-git\\dragon-files',
      'C:\\Users\\ibm\\OneDrive\\Документы\\Dragon-main\\Dragon\\data\\Solana\\TopTraders\\',
      './Dragon/data/Solana/TopTraders', 'C:\\Dragon\\data\\Solana\\TopTraders\\',
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
        }
      }

      this.logger.info(`🔄 Syncing Dragon files from Git...`);
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
    } catch (error) {
      this.logger.error('❌ Error syncing from Git:', error);
    }
  }

  async parseLatestDragonResults(forceReplace: boolean = false): Promise<DragonParseResult> {
    try {
      this.logger.info(`🐲 Starting Dragon parsing (Replace Mode: ${forceReplace}) with MEMORY OPTIMIZATION...`);

      await this.syncFromGit();

      const files = await this.findLatestDragonFiles();
      if (files.length === 0) {
        this.logger.warn('⚠️ No Dragon files found after Git sync');
        return this.createEmptyResult(forceReplace);
      }

      this.logger.info(`📄 Found ${files.length} Dragon files to process`);

      const allWallets: DragonWallet[] = [];
      for (const filePath of files) {
        const wallets = await this.parseDragonJsonFileOptimized(filePath);
        if (wallets.length > 0) {
          allWallets.push(...wallets);
          
          // 🔥 ПРИНУДИТЕЛЬНАЯ ОЧИСТКА ПАМЯТИ после каждого файла
          if (global.gc) {
            global.gc();
            this.logger.debug(`🧹 Memory cleanup after ${path.basename(filePath)}`);
          }
        }
      }

      const uniqueWallets = this.deduplicateWallets(allWallets);
      this.logger.info(`🔄 After deduplication: ${uniqueWallets.length} unique wallets`);

      const filteredWallets = this.applyProfitFirstFiltering(uniqueWallets);
      this.logger.info(`💰 After STRICT filtering: ${filteredWallets.length} high-quality wallets (${((filteredWallets.length / uniqueWallets.length) * 100).toFixed(1)}% selected)`);

      const scoredWallets = this.calculateProfitFirstScores(filteredWallets);
      scoredWallets.sort((a, b) => this.compareProfitPriority(a, b));

      const smartWallets = this.convertToSmartWallets(scoredWallets);
      
      let clearedCount = 0, addedCount = 0, updatedCount = 0, skippedCount = 0;
      let errors: string[] = [];

      if (forceReplace) {
        this.logger.info('🔥 REPLACE MODE: Clearing existing Dragon wallets and adding new ones');
        const replacementResult = await this.smDatabase.replaceDragonWallets(smartWallets);
        clearedCount = replacementResult.cleared;
        addedCount = replacementResult.added;
        errors = replacementResult.errors;
        
        await this.sendReplacementNotification(clearedCount, addedCount, errors);
      } else {
        this.logger.info('📈 NORMAL MODE: Adding/updating Dragon wallets');
        for (const smWallet of smartWallets) {
          try {
            const existing = await this.smDatabase.getSmartWallet(smWallet.address);
            if (existing) {
              const settings = await this.smDatabase.getWalletSettings(existing.address);
              const isDragonWallet = settings && await this.isDragonWallet(existing.address);
              
              if (isDragonWallet) {
                if (smWallet.totalPnL > existing.totalPnL || smWallet.winRate > existing.winRate || smWallet.totalTrades > existing.totalTrades) {
                  await this.updateExistingWallet(existing, smWallet);
                  updatedCount++;
                } else {
                  skippedCount++;
                }
              } else {
                skippedCount++;
              }
            } else {
              await this.smDatabase.saveSmartWallet(smWallet, {
                nickname: `Dragon-${smWallet.address.slice(0, 8)}`,
                addedBy: 'dragon', verified: true, enabled: true,
                priority: this.determinePriority(smWallet)
              });
              addedCount++;
            }
          } catch (error) {
            const errorMsg = `Failed to process ${smWallet.address}: ${error}`;
            errors.push(errorMsg);
            this.logger.warn(`⚠️ ${errorMsg}`);
          }
        }
        
        await this.sendNormalNotification(addedCount, updatedCount, skippedCount, errors);
      }

      const finalResult = this.createResult(allWallets.length, uniqueWallets.length - filteredWallets.length,
        addedCount, updatedCount, skippedCount, clearedCount, scoredWallets, forceReplace);

      // 🔥 ФИНАЛЬНАЯ ОЧИСТКА ПАМЯТИ
      allWallets.length = 0;
      uniqueWallets.length = 0;
      filteredWallets.length = 0;
      scoredWallets.length = 0;
      
      if (global.gc) {
        global.gc();
        this.logger.info('🧹 Final memory cleanup completed');
      }

      this.logger.info(`✅ Dragon parsing completed. Mode: ${forceReplace ? 'REPLACE' : 'NORMAL'}. Added: ${addedCount}, Updated: ${updatedCount}, Cleared: ${clearedCount}`);
      return finalResult;

    } catch (error) {
      this.logger.error('❌ Critical error during Dragon results parsing:', error);
      
      // ОЧИСТКА ПАМЯТИ В СЛУЧАЕ ОШИБКИ
      if (global.gc) {
        global.gc();
      }
      
      throw error;
    }
  }

  private async findLatestDragonFiles(): Promise<string[]> {
    try {
      if (!fs.existsSync(this.config.dragonOutputPath)) {
        this.logger.warn(`⚠️ Dragon output path not found: ${this.config.dragonOutputPath}`);
        return [];
      }

      const files = fs.readdirSync(this.config.dragonOutputPath);
      
      const jsonFiles = files
        .filter(file => {
          if (file.startsWith('.git') || file === 'README.md' || file === '.gitignore' || 
              file === 'package.json' || file === 'package-lock.json') return false;
          
          return file.endsWith('.json') && (
            file.includes('topTraders') || file.includes('TopTraders') ||
            file.includes('dragon') || file.includes('traders') ||
            file.includes('wallet') || file.includes('result')
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
          return { name: file, path: filePath, mtime };
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
   * 🔥 ОПТИМИЗИРОВАННЫЙ ПАРСИНГ JSON - БАТЧЕВАЯ ОБРАБОТКА С ОЧИСТКОЙ ПАМЯТИ
   */
  private async parseDragonJsonFileOptimized(filePath: string): Promise<DragonWallet[]> {
    try {
      // Проверяем размер файла
      const stats = fs.statSync(filePath);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      this.logger.info(`📄 Parsing Dragon file: ${path.basename(filePath)} (${fileSizeMB.toFixed(1)}MB)`);
      
      if (fileSizeMB > 100) {
        this.logger.warn(`⚠️ LARGE FILE WARNING: ${fileSizeMB.toFixed(1)}MB - processing with extra caution`);
      }

      // Читаем файл
      const fileContent = fs.readFileSync(filePath, 'utf8');
      let jsonData: any;
      
      try {
        jsonData = JSON.parse(fileContent);
      } catch (parseError) {
        this.logger.error(`❌ Invalid JSON in file ${filePath}:`, parseError);
        return [];
      }

      const dragonWallets: DragonWallet[] = [];
      let processedCount = 0;
      
      // 🔥 БАТЧЕВАЯ ОБРАБОТКА для экономии памяти
      const entries = Object.entries(jsonData);
      const BATCH_SIZE = 1000; // Обрабатываем по 1000 записей
      
      this.logger.info(`🔄 Processing ${entries.length} entries in batches of ${BATCH_SIZE}`);
      
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        
        for (const [walletAddress, metrics] of batch) {
          if (!metrics || typeof metrics !== 'object') continue;
          
          const data = metrics as any;
          const boughtUsd = this.parseUsdString(data.boughtUsd || '0');
          const totalProfit = this.parseUsdString(data.totalProfit || '0');
          const buys = parseInt(data.buys || '0');
          const sells = parseInt(data.sells || '0');
          const totalTrades = buys + sells;

          const winrate = totalTrades > 0 ? 
            (data.winRate !== undefined ? parseFloat(data.winRate) : 
             (sells > 0 ? Math.min((totalProfit > 0 ? 70 : 30), 100) : 0)) : 0;

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
          processedCount++;
        }
        
        // 🔥 ПРИНУДИТЕЛЬНАЯ ОЧИСТКА ПАМЯТИ каждые 5000 записей
        if (i % (BATCH_SIZE * 5) === 0 && global.gc) {
          global.gc();
          this.logger.debug(`🧹 GC triggered after ${processedCount} entries`);
        }
      }

      // 🔥 ОЧИЩАЕМ ПЕРЕМЕННЫЕ ИЗ ПАМЯТИ
      jsonData = null;
      entries.length = 0;
      
      // ПРИНУДИТЕЛЬНАЯ ОЧИСТКА
      if (global.gc) {
        global.gc();
      }

      this.logger.info(`✅ Parsed ${dragonWallets.length}/${processedCount} valid wallets from ${path.basename(filePath)}`);
      return dragonWallets;
      
    } catch (error) {
      this.logger.error(`❌ Error parsing Dragon JSON file ${filePath}:`, error);
      
      // ПРИНУДИТЕЛЬНАЯ ОЧИСТКА В СЛУЧАЕ ОШИБКИ
      if (global.gc) {
        global.gc();
      }
      
      return [];
    }
  }

  private convertToSmartWallets(dragonWallets: DragonWallet[]): SmartMoneyWallet[] {
    return dragonWallets.map(wallet => {
      const category = this.determineCategory(wallet);
      const tierName = wallet.tier?.toUpperCase() || 'DRAGON';
      const categoryName = category.toUpperCase();
      const nickname = `${tierName}-${categoryName}-${wallet.wallet.slice(0, 6)}`;

      return {
        address: wallet.wallet, category: category, winRate: wallet.winrate,
        totalPnL: wallet.pnl, totalTrades: wallet.trades,
        avgTradeSize: wallet.trades > 0 ? wallet.volume / wallet.trades : 0,
        maxTradeSize: wallet.volume * 0.1, minTradeSize: wallet.volume * 0.01,
        performanceScore: wallet.score || 70, sharpeRatio: undefined, maxDrawdown: undefined,
        lastActiveAt: new Date(wallet.last_active * 1000), isActive: true,
        isFamilyMember: false, familyAddresses: undefined, coordinationScore: 0,
        stealthLevel: undefined, earlyEntryRate: undefined, avgHoldTime: undefined,
        volumeScore: undefined, createdAt: new Date(), updatedAt: new Date()
      } as SmartMoneyWallet;
    });
  }

  private async isDragonWallet(address: string): Promise<boolean> {
    try {
      const source = await this.smDatabase.getWalletSource(address);
      return source === 'dragon';
    } catch (error) {
      return false;
    }
  }

  private determineCategory(wallet: DragonWallet): 'sniper' | 'hunter' | 'trader' {
    if (wallet.tier === 'whale') return 'trader';
    if (wallet.pnl > 100000 && wallet.trades > 50) return 'trader';
    if (wallet.pnl > 50000 && wallet.trades > 20) return 'hunter';
    return 'sniper';
  }

  private determinePriority(wallet: SmartMoneyWallet): 'high' | 'medium' | 'low' {
    if (wallet.totalPnL >= 1000000) return 'high';
    if (wallet.totalPnL >= 500000) return 'high';
    if (wallet.winRate >= 60) return 'high';
    return 'medium';
  }

  private isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    if (address.length < 32 || address.length > 44) return false;
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return base58Regex.test(address);
  }

  private parseUsdString(usdString: string): number {
    if (!usdString || typeof usdString !== 'string') return 0;
    const cleaned = usdString.replace(/[$,\s]/g, '');
    let multiplier = 1;
    if (cleaned.endsWith('K') || cleaned.endsWith('k')) multiplier = 1000;
    else if (cleaned.endsWith('M') || cleaned.endsWith('m')) multiplier = 1000000;
    else if (cleaned.endsWith('B') || cleaned.endsWith('b')) multiplier = 1000000000;
    const numberPart = cleaned.replace(/[KMBkmb]$/, '');
    const number = parseFloat(numberPart);
    return isNaN(number) ? 0 : number * multiplier;
  }

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

  private applyProfitFirstFiltering(wallets: DragonWallet[]): DragonWallet[] {
    return wallets.filter(wallet => {
      if (wallet.pnl >= this.config.whaleThresholds.megaWhale) {
        wallet.tier = 'whale'; return true;
      }
      if (wallet.pnl >= this.config.whaleThresholds.whale && wallet.winrate >= 30) {
        wallet.tier = 'whale'; return true;
      }
      if (wallet.pnl >= this.config.whaleThresholds.bigPlayer && wallet.winrate >= 40) {
        wallet.tier = 'genius'; return true;
      }
      if (wallet.pnl >= this.config.whaleThresholds.quality && wallet.winrate >= 45) {
        wallet.tier = 'quality'; return true;
      }
      if (wallet.pnl < this.config.minPnl || wallet.winrate < this.config.minWinrate || 
          wallet.trades < this.config.minTrades || wallet.winrate > 99.9 || 
          wallet.volume > wallet.pnl * 100) {
        wallet.tier = 'filter_out'; return false;
      }
      wallet.tier = 'quality'; return true;
    });
  }

  private calculateProfitFirstScores(wallets: DragonWallet[]): DragonWallet[] {
    if (wallets.length === 0) return wallets;
    
    const maxPnl = Math.max(...wallets.map(w => w.pnl));
    const maxVolume = Math.max(...wallets.map(w => w.volume));
    const maxTrades = Math.max(...wallets.map(w => w.trades));
    const now = Date.now() / 1000;
    
    return wallets.map(wallet => {
      const pnlScore = maxPnl > 0 ? wallet.pnl / maxPnl : 0;
      const winrateScore = wallet.winrate / 100;
      const volumeScore = maxVolume > 0 ? wallet.volume / maxVolume : 0;
      const tradesScore = maxTrades > 0 ? wallet.trades / maxTrades : 0;
      const daysSinceActive = (now - wallet.last_active) / (24 * 60 * 60);
      const activityScore = Math.max(0, 1 - (daysSinceActive / this.config.maxDaysInactive));
      
      let score = (pnlScore * this.config.scoreWeights.pnl + winrateScore * this.config.scoreWeights.winrate +
        volumeScore * this.config.scoreWeights.volume + tradesScore * this.config.scoreWeights.trades +
        activityScore * this.config.scoreWeights.activity) * 100;

      if (wallet.tier === 'whale') score += 25;
      else if (wallet.tier === 'genius') score += 15;
      else if (wallet.tier === 'quality') score += 5;

      if (wallet.trades > 0 && wallet.pnl > 0) {
        const avgProfitPerTrade = wallet.pnl / wallet.trades;
        wallet.profitFactor = avgProfitPerTrade > 0 ? Math.min(avgProfitPerTrade / 1000, 10) : 0;
      }
      
      return { ...wallet, score: Math.round(score * 100) / 100 };
    });
  }

  private compareProfitPriority(a: DragonWallet, b: DragonWallet): number {
    const tierPriority = { whale: 4, genius: 3, quality: 2, filter_out: 1 };
    const aTier = tierPriority[a.tier || 'quality'] || 2;
    const bTier = tierPriority[b.tier || 'quality'] || 2;
    
    if (aTier !== bTier) return bTier - aTier;
    if (Math.abs(a.pnl - b.pnl) > 10000) return b.pnl - a.pnl;
    return (b.score || 0) - (a.score || 0);
  }

  private async updateExistingWallet(existing: any, wallet: SmartMoneyWallet): Promise<void> {
    await this.smDatabase.updateWalletPerformance(existing.address, {
      winRate: Math.max(wallet.winRate, existing.winRate),
      totalPnL: Math.max(wallet.totalPnL, existing.totalPnL),
      totalTrades: Math.max(wallet.totalTrades, existing.totalTrades),
      lastActiveAt: wallet.lastActiveAt, performanceScore: wallet.performanceScore
    });
  }

  private async sendReplacementNotification(clearedCount: number, addedCount: number, errors: string[]): Promise<void> {
    const emoji = errors.length > 0 ? '⚠️' : '✅';
    const message = `${emoji} <b>Dragon Database REPLACED</b>\n\n` +
      `🗑️ <b>Cleared Old:</b> <code>${clearedCount}</code> Dragon wallets\n` +
      `➕ <b>Added New:</b> <code>${addedCount}</code> STRICT-filtered wallets\n\n` +
      `💰 <b>STRICT Thresholds Applied:</b>\n` +
      `• Min PnL: <code>$${this.formatNumber(this.config.minPnl)}</code>\n` +
      `• Min WR: <code>${this.config.minWinrate}%</code>\n` +
      `• Min Trades: <code>${this.config.minTrades}</code>\n\n` +
      `🔄 <b>Database Status:</b> <code>Completely Refreshed</code>\n` +
      (errors.length > 0 ? `⚠️ <b>Errors:</b> <code>${errors.length}</code>\n` : '') +
      `⏰ <code>${new Date().toLocaleString()}</code>`;

    await this.telegramNotifier.sendCycleLog(message);
  }

  private async sendNormalNotification(addedCount: number, updatedCount: number, skippedCount: number, errors: string[]): Promise<void> {
    const message = `🐲 <b>Dragon Import Complete</b>\n\n` +
      `➕ <b>Added:</b> <code>${addedCount}</code> new wallets\n` +
      `🔄 <b>Updated:</b> <code>${updatedCount}</code> existing\n` +
      `⏭️ <b>Skipped:</b> <code>${skippedCount}</code> unchanged\n\n` +
      `💰 <b>STRICT Criteria:</b> PnL≥$${this.config.minPnl/1000}K, WR≥${this.config.minWinrate}%, Trades≥${this.config.minTrades}\n` +
      (errors.length > 0 ? `⚠️ <b>Errors:</b> <code>${errors.length}</code>\n` : '') +
      `⏰ <code>${new Date().toLocaleString()}</code>`;

    await this.telegramNotifier.sendCycleLog(message);
  }

  private createResult(totalParsedFromFile: number, filteredOutCount: number, added: number, updated: number,
    skipped: number, cleared: number, finalWallets: DragonWallet[], replaceMode: boolean = false): DragonParseResult {
    const categories = this.categorizeWallets(finalWallets);
    const profitDistribution = this.calculateProfitDistribution(finalWallets);
    const totalValue = finalWallets.reduce((sum, w) => sum + w.pnl, 0);
    const averagePnL = finalWallets.length > 0 ? totalValue / finalWallets.length : 0;

    return {
      totalParsed: totalParsedFromFile, filtered: filteredOutCount, added, updated, skipped, cleared,
      categories, topPerformers: finalWallets.sort((a,b) => this.compareProfitPriority(a,b)).slice(0, 15),
      profitDistribution, averagePnL, totalValue, replaceMode
    };
  }

  private categorizeWallets(wallets: DragonWallet[]): { snipers: number; hunters: number; traders: number } {
    const categories = { snipers: 0, hunters: 0, traders: 0 };
    for (const wallet of wallets) {
      const category = this.determineCategory(wallet);
      categories[category + 's' as keyof typeof categories]++;
    }
    return categories;
  }

  private calculateProfitDistribution(wallets: DragonWallet[]): {
    megaWhales: number; whales: number; bigPlayers: number; quality: number; regular: number;
  } {
    const distribution = { megaWhales: 0, whales: 0, bigPlayers: 0, quality: 0, regular: 0 };
    for (const wallet of wallets) {
      if (wallet.pnl >= this.config.whaleThresholds.megaWhale) distribution.megaWhales++;
      else if (wallet.pnl >= this.config.whaleThresholds.whale) distribution.whales++;
      else if (wallet.pnl >= this.config.whaleThresholds.bigPlayer) distribution.bigPlayers++;
      else if (wallet.pnl >= this.config.whaleThresholds.quality) distribution.quality++;
      else distribution.regular++;
    }
    return distribution;
  }

  private createEmptyResult(replaceMode: boolean = false): DragonParseResult {
    return {
      totalParsed: 0, filtered: 0, added: 0, updated: 0, skipped: 0, cleared: 0,
      categories: { snipers: 0, hunters: 0, traders: 0 }, topPerformers: [],
      profitDistribution: { megaWhales: 0, whales: 0, bigPlayers: 0, quality: 0, regular: 0 },
      averagePnL: 0, totalValue: 0, replaceMode
    };
  }

  private formatNumber(num: number): string {
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toFixed(0);
  }

  async forceSyncFromGit(): Promise<boolean> {
    try { await this.syncFromGit(); return true; } 
    catch (error) { this.logger.error('❌ Force Git sync failed:', error); return false; }
  }

  async getDragonStats(): Promise<{
    lastRun?: Date; totalFilesFound: number; configPath: string;
    isConfigured: boolean; gitSyncEnabled: boolean;
  }> {
    const files = await this.findLatestDragonFiles();
    return {
      totalFilesFound: files.length, configPath: this.config.dragonOutputPath,
      isConfigured: fs.existsSync(this.config.dragonOutputPath),
      gitSyncEnabled: !!process.env.DRAGON_REPO_URL
    };
  }
}