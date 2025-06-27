// src/services/DragonResultsParser.ts - ✅ ОТЛАДОЧНАЯ ВЕРСИЯ ДЛЯ ПОИСКА ПРОБЛЕМЫ
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { MultiProviderService } from './MultiProviderService';
import { Logger } from '../utils/Logger';
import { SmartMoneyWallet } from '../types';
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
  last_active?: number; 
  sol_balance: number; 
  score?: number; 
  profitFactor?: number;
  tier?: 'whale' | 'genius' | 'quality' | 'filter_out';
  // 🔥 НОВЫЕ ПОЛЯ ДЛЯ СТРОГОЙ ФИЛЬТРАЦИИ
  unrealizedProfit?: number; // Нереализованная прибыль
  multiplier?: number;       // Множитель капитала
}

interface DragonConfig {
  dragonOutputPath: string; 
  minPnl: number; 
  minWinrate: number; 
  minTrades: number;
  maxDaysInactive: number;
  // 🔥 ДОБАВЛЯЕМ НОВЫЕ НАСТРАИВАЕМЫЕ ПОЛЯ
  minUnrealizedProfit: number;  // Минимальная нереализованная прибыль
  minMultiplier: number;        // Минимальный множитель
  whaleThresholds: { megaWhale: number; whale: number; bigPlayer: number; quality: number; };
  scoreWeights: { pnl: number; winrate: number; volume: number; trades: number; activity: number; };
}

interface DragonParseResult {
  totalParsed: number; 
  filtered: number; 
  added: number; 
  updated: number; 
  skipped: number;
  cleared: number; 
  categories: { snipers: number; hunters: number; traders: number };
  topPerformers: DragonWallet[]; 
  profitDistribution: {
    megaWhales: number; whales: number; bigPlayers: number; quality: number; regular: number;
  }; 
  averagePnL: number; 
  totalValue: number; 
  replaceMode?: boolean;
}

export class DragonResultsParser {
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private multiProvider: MultiProviderService;
  private logger: Logger;
  private config: DragonConfig;

  constructor(
    smDatabase: SmartMoneyDatabase, 
    telegramNotifier: TelegramNotifier, 
    multiProvider: MultiProviderService,
    config?: Partial<DragonConfig>
  ) {
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.multiProvider = multiProvider;
    this.logger = Logger.getInstance();
    
    // 🔥 НАСТРАИВАЕМЫЕ КРИТЕРИИ С ДЕФОЛТАМИ
    this.config = {
      dragonOutputPath: this.resolveDragonPath(config?.dragonOutputPath),
      minPnl: config?.minPnl || 150000,                    // ✅ 150K (было 50K)
      minWinrate: config?.minWinrate || 35,                // ✅ 35% (было 58%)
      minTrades: config?.minTrades || 25,                 // ✅ 100 (настраиваемо)
      maxDaysInactive: config?.maxDaysInactive || 14,      // ✅ 14 дней (было 7)
      // 🔥 НОВЫЕ НАСТРАИВАЕМЫЕ ПОЛЯ
      minUnrealizedProfit: config?.minUnrealizedProfit || 30000,  // ✅ 30K (настраиваемо)
      minMultiplier: config?.minMultiplier || 3,                  // ✅ 3x (настраиваемо)
      whaleThresholds: { 
        megaWhale: 1_000_000, 
        whale: 500_000, 
        bigPlayer: 200_000, 
        quality: 100_000, 
        ...config?.whaleThresholds 
      },
      scoreWeights: { 
        pnl: 0.5, 
        winrate: 0.2, 
        volume: 0.15, 
        trades: 0.1, 
        activity: 0.05, 
        ...config?.scoreWeights 
      }
    };

    this.logger.info(`🐲 Dragon Parser initialized with DEBUG MODE + CONFIGURABLE CRITERIA`);
    this.logger.info(`💰 THRESHOLDS: PnL≥${this.config.minPnl/1000}K, WR≥${this.config.minWinrate}%, Trades≥${this.config.minTrades}, Multiplier≥${this.config.minMultiplier}x, Unrealized≥${this.config.minUnrealizedProfit/1000}K, Active≤${this.config.maxDaysInactive}d`);
    this.logger.info(`🔍 PRE-FILTERING: Elite wallets (whale/genius/500K+) checked for activity before DB insertion`);
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
      this.logger.info(`🐲 Starting Dragon parsing (Replace Mode: ${forceReplace}) with DEBUG MODE...`);

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
      
      // 🔥 PRE-FILTERING активности для элитных кошельков
      const activityCheckedWallets = await this.preFilterByActivity(scoredWallets);
      
      activityCheckedWallets.sort((a, b) => this.compareProfitPriority(a, b));

      // 🔥 СОЗДАЕМ ОБА МАССИВА СИНХРОННО
      const smartWallets = this.convertToSmartWallets(activityCheckedWallets);
      const dragonTiers = activityCheckedWallets.map(wallet => this.determineTier(wallet));
      
      // ⚠️ КРИТИЧЕСКАЯ ПРОВЕРКА СИНХРОННОСТИ
      if (smartWallets.length !== dragonTiers.length) {
        this.logger.error(`❌ CRITICAL: Arrays length mismatch! smartWallets: ${smartWallets.length}, dragonTiers: ${dragonTiers.length}`);
        throw new Error('Arrays must have same length!');
      }

      // 🔥 ПРОВЕРКА СООТВЕТСТВИЯ TIER И NICKNAME
      smartWallets.forEach((wallet, i) => {
        const expectedTier = dragonTiers[i].toUpperCase();
        if (!wallet.nickname?.includes(expectedTier)) {
          this.logger.warn(`⚠️ Nickname ${wallet.nickname} should contain ${expectedTier}`);
        }
      });
      
      let clearedCount = 0, addedCount = 0, updatedCount = 0, skippedCount = 0;
      let errors: string[] = [];

      if (forceReplace) {
        this.logger.info('🔥 REPLACE MODE: Clearing existing Dragon wallets and adding new ones');
        const replacementResult = await this.smDatabase.replaceDragonWallets(smartWallets, dragonTiers);
        clearedCount = replacementResult.cleared;
        addedCount = replacementResult.added;
        errors = replacementResult.errors;
        
        await this.sendReplacementNotification(clearedCount, addedCount, errors);
      } else {
        this.logger.info('📈 NORMAL MODE: Using replaceDragonWallets with tier information');
        const result = await this.smDatabase.replaceDragonWallets(smartWallets, dragonTiers);
        clearedCount = result.cleared;
        addedCount = result.added;
        skippedCount = result.skipped;
        errors = result.errors;
        
        await this.sendNormalNotification(addedCount, updatedCount, skippedCount, errors);
      }

      const finalResult = this.createResult(allWallets.length, uniqueWallets.length - filteredWallets.length,
        addedCount, updatedCount, skippedCount, clearedCount, activityCheckedWallets, forceReplace);

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
   * 🔥 ОПТИМИЗИРОВАННЫЙ ПАРСИНГ JSON С ОТЛАДКОЙ
   */
  private async parseDragonJsonFileOptimized(filePath: string): Promise<DragonWallet[]> {
    try {
      const stats = fs.statSync(filePath);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      this.logger.info(`📄 Parsing Dragon file: ${path.basename(filePath)} (${fileSizeMB.toFixed(1)}MB)`);
      
      if (fileSizeMB > 100) {
        this.logger.warn(`⚠️ LARGE FILE WARNING: ${fileSizeMB.toFixed(1)}MB - processing with extra caution`);
      }

      const fileContent = fs.readFileSync(filePath, 'utf8');
      let jsonData: any;
      
      try {
        jsonData = JSON.parse(fileContent);
      } catch (parseError) {
        this.logger.error(`❌ Invalid JSON in file ${filePath}:`, parseError);
        return [];
      }

      // 🔍 ОТЛАДКА СТРУКТУРЫ JSON
      console.log('🔍 JSON STRUCTURE DEBUG:');
      console.log('Type of jsonData:', typeof jsonData);
      console.log('Is Array:', Array.isArray(jsonData));
      console.log('Keys count:', Object.keys(jsonData).length);
      console.log('First 3 keys:', Object.keys(jsonData).slice(0, 3));

      // Проверяем первые 3 записи
      const firstEntries = Object.entries(jsonData).slice(0, 3);
      firstEntries.forEach(([key, value], i) => {
        console.log(`\n🔍 Entry ${i + 1}:`);
        console.log('  Key:', key);
        console.log('  Value type:', typeof value);
        console.log('  Value:', JSON.stringify(value, null, 2));
      });

      const dragonWallets: DragonWallet[] = [];
      let processedCount = 0;
      
      const entries = Object.entries(jsonData);
      const BATCH_SIZE = 1000;
      
      this.logger.info(`🔄 Processing ${entries.length} entries in batches of ${BATCH_SIZE}`);
      
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        
        for (const [walletAddress, metrics] of batch) {
          if (!metrics || typeof metrics !== 'object') continue;
          
          const data = metrics as any;
          const boughtUsd = this.parseUsdString(data.boughtUsd || '0');
          const totalProfit = this.parseUsdString(data.totalProfit || '0');
          
          // 🔥 ЧИТАЕМ НОВЫЕ ПОЛЯ ИЗ JSON С ОТЛАДКОЙ
          const unrealizedProfit = this.parseUsdString(data.unrealizedProfit || '0');
          const multiplierStr = (data.multiplier || '0').toString().replace(/x/i, '');
          const multiplier = parseFloat(multiplierStr);
          
          // 🔍 ПОДРОБНАЯ ОТЛАДКА ПАРСИНГА ПЕРВЫХ 20 ЗАПИСЕЙ
          if (processedCount < 20) {
            console.log(`\n🔍 PARSING ${processedCount + 1}:`);
            console.log('  Address:', walletAddress);
            console.log('  Metrics type:', typeof metrics);
            console.log('  Raw data.multiplier:', JSON.stringify(data.multiplier));
            console.log('  Raw data.totalProfit:', JSON.stringify(data.totalProfit));
            console.log('  Raw data.unrealizedProfit:', JSON.stringify(data.unrealizedProfit));
            console.log('  multiplierStr after replace:', JSON.stringify(multiplierStr));
            console.log('  Parsed multiplier:', multiplier);
            console.log('  Is multiplier NaN:', isNaN(multiplier));
          }
          
          // 🔥 ОТЛАДКА: Логируем первые 5 записей для проверки
          if (processedCount < 5) {
            this.logger.info(`🔍 DEBUG wallet ${processedCount + 1}:`);
            this.logger.info(`   Address: ${walletAddress.slice(0,8)}...`);
            this.logger.info(`   Raw data.totalProfit: "${data.totalProfit}"`);
            this.logger.info(`   Raw data.unrealizedProfit: "${data.unrealizedProfit}"`);
            this.logger.info(`   Raw data.multiplier: "${data.multiplier}"`);
            this.logger.info(`   Raw data.buys: "${data.buys}", data.sells: "${data.sells}"`);
            this.logger.info(`   Parsed totalProfit: ${totalProfit}`);
            this.logger.info(`   Parsed unrealizedProfit: ${unrealizedProfit}`);
            this.logger.info(`   Parsed multiplier: ${multiplier} (from "${multiplierStr}")`);
          }
          
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
              sol_balance: parseFloat(data.solBalance || '0'),
              // 🔥 ДОБАВЛЕНЫ НОВЫЕ ПОЛЯ
              unrealizedProfit: isNaN(unrealizedProfit) ? 0 : unrealizedProfit,
              multiplier: isNaN(multiplier) ? 0 : multiplier
            });
          }
          processedCount++;
        }
        
        if (i % (BATCH_SIZE * 5) === 0 && global.gc) {
          global.gc();
          this.logger.debug(`🧹 GC triggered after ${processedCount} entries`);
        }
      }

      jsonData = null;
      entries.length = 0;
      
      if (global.gc) {
        global.gc();
      }

      // 🔥 СТАТИСТИКА ПО ПОЛЯМ ПОСЛЕ ПАРСИНГА
      let undefinedUnrealized = 0, zeroUnrealized = 0;
      let undefinedMultiplier = 0, zeroMultiplier = 0;
      for (const wallet of dragonWallets) {
        if (wallet.unrealizedProfit === undefined) undefinedUnrealized++;
        else if (wallet.unrealizedProfit === 0) zeroUnrealized++;
        
        if (wallet.multiplier === undefined) undefinedMultiplier++;
        else if (wallet.multiplier === 0) zeroMultiplier++;
      }
      
      this.logger.info(`📊 FIELD STATISTICS:`);
      this.logger.info(`   Unrealized: ${undefinedUnrealized} undefined, ${zeroUnrealized} zero, ${dragonWallets.length - undefinedUnrealized - zeroUnrealized} valid`);
      this.logger.info(`   Multiplier: ${undefinedMultiplier} undefined, ${zeroMultiplier} zero, ${dragonWallets.length - undefinedMultiplier - zeroMultiplier} valid`);

      this.logger.info(`✅ Parsed ${dragonWallets.length}/${processedCount} valid wallets from ${path.basename(filePath)}`);
      return dragonWallets;
      
    } catch (error) {
      this.logger.error(`❌ Error parsing Dragon JSON file ${filePath}:`, error);
      
      if (global.gc) {
        global.gc();
      }
      
      return [];
    }
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

  // 🔥 ОТЛАДОЧНАЯ ФИЛЬТРАЦИЯ С ДЕТАЛЬНОЙ СТАТИСТИКОЙ
  private applyProfitFirstFiltering(wallets: DragonWallet[]): DragonWallet[] {
  this.logger.info(`🔍 DEBUGGING: Starting filtering of ${wallets.length} wallets with criteria:`);
  this.logger.info(`   PnL≥${this.config.minPnl}, WR≥${this.config.minWinrate}%, Trades≥${this.config.minTrades}, Unrealized≥${this.config.minUnrealizedProfit}, Multiplier≥${this.config.minMultiplier}x`);
  
  let filteredByPnl = 0, filteredByUnrealized = 0, filteredByWinrate = 0, filteredByMultiplier = 0, filteredByTrades = 0, filteredByWinrateTooHigh = 0;
  let unrealizedUndefined = 0, multiplierUndefined = 0;
  
  // 🔥 АНАЛИЗИРУЕМ ПЕРВЫЕ 10 КОШЕЛЬКОВ ДЛЯ ОТЛАДКИ
  this.logger.info(`🔍 SAMPLE DATA from first 10 wallets:`);
  for (let i = 0; i < Math.min(10, wallets.length); i++) {
    const w = wallets[i];
    this.logger.info(`   ${i+1}. PnL:${w.pnl}, WR:${w.winrate}%, Trades:${w.trades}, Unrealized:${w.unrealizedProfit || 'undefined'}, Multi:${w.multiplier || 'undefined'}`);
  }

  // 🔍 ОТЛАДКА MULTIPLIER РАСПРЕДЕЛЕНИЯ
  let mult_0_to_1 = 0, mult_1_to_2 = 0, mult_2_plus = 0, mult_nan = 0;
  wallets.forEach(w => {
    if (isNaN(w.multiplier || NaN)) mult_nan++;
    else if ((w.multiplier || 0) < 1) mult_0_to_1++;
    else if ((w.multiplier || 0) < 2) mult_1_to_2++;
    else mult_2_plus++;
  });
  
  console.log(`🔍 Multiplier distribution: 0-1x: ${mult_0_to_1}, 1-2x: ${mult_1_to_2}, 2x+: ${mult_2_plus}, NaN: ${mult_nan}`);

  const filtered = wallets.filter(wallet => {
    // ===== СНАЧАЛА ВСЕ СТРОГИЕ ФИЛЬТРЫ (ПРИМЕНЯЮТСЯ КО ВСЕМ БЕЗ ИСКЛЮЧЕНИЯ) =====
    if (wallet.pnl < this.config.minPnl) { 
      filteredByPnl++; 
      return false; 
    }
    
    if (wallet.unrealizedProfit === undefined) { 
      unrealizedUndefined++; 
      return false; 
    }
    if (wallet.unrealizedProfit < this.config.minUnrealizedProfit) { 
      filteredByUnrealized++; 
      return false; 
    }
    
    if (wallet.winrate < this.config.minWinrate) { 
      filteredByWinrate++; 
      return false; 
    }
    
    if (wallet.multiplier === undefined) { 
      multiplierUndefined++; 
      return false; 
    }
    if (wallet.multiplier < this.config.minMultiplier) { 
      filteredByMultiplier++; 
      return false; 
    }
    
    if (wallet.trades < this.config.minTrades) { 
      filteredByTrades++; 
      return false; 
    }
    
    if (wallet.winrate > 99.9) { 
      filteredByWinrateTooHigh++; 
      return false; 
    }

    // ===== ТОЛЬКО ДЛЯ ТЕХ, КТО ПРОШЕЛ ВСЕ СТРОГИЕ ПРОВЕРКИ, ПРИСВАИВАЕМ TIER =====
    // (Это происходит ПОСЛЕ всех фильтров, только для кошельков, которые точно попадут в итоговый список)
    if (wallet.pnl >= this.config.whaleThresholds.megaWhale) {
      wallet.tier = 'whale'; 
    } else if (wallet.pnl >= 200000 && wallet.winrate >= 50) {
      wallet.tier = 'genius';
    } else {
      wallet.tier = 'quality';
    }
    
    return true; // Пропускаем только тех, кто прошел ВСЕ строгие проверки
  });

  // 🔥 ДЕТАЛЬНАЯ СТАТИСТИКА ФИЛЬТРАЦИИ
  this.logger.info(`🔍 FILTERING RESULTS:`);
  this.logger.info(`   ✅ Passed: ${filtered.length}/${wallets.length} (${(filtered.length/wallets.length*100).toFixed(1)}%)`);
  this.logger.info(`   ❌ Filtered by PnL<${this.config.minPnl}: ${filteredByPnl}`);
  this.logger.info(`   ❌ Filtered by Unrealized undefined: ${unrealizedUndefined}`);
  this.logger.info(`   ❌ Filtered by Unrealized<${this.config.minUnrealizedProfit}: ${filteredByUnrealized}`);
  this.logger.info(`   ❌ Filtered by Winrate<${this.config.minWinrate}%: ${filteredByWinrate}`);
  this.logger.info(`   ❌ Filtered by Multiplier undefined: ${multiplierUndefined}`);
  this.logger.info(`   ❌ Filtered by Multiplier<${this.config.minMultiplier}x: ${filteredByMultiplier}`);
  this.logger.info(`   ❌ Filtered by Trades<${this.config.minTrades}: ${filteredByTrades}`);
  this.logger.info(`   ❌ Filtered by Winrate>99.9%: ${filteredByWinrateTooHigh}`);

  return filtered;
}

  // 🔥 БЕЗ ДУБЛИРУЮЩИХ ПРОВЕРОК - только tier определение
  private determineTier(wallet: DragonWallet): 'whale' | 'genius' | 'quality' | 'filter_out' {
    if (wallet.pnl >= 1_000_000) {
      return 'whale';
    }
    if (wallet.pnl >= 500_000 && wallet.winrate >= 58) {
      return 'whale';  
    }
    if (wallet.pnl >= 200_000 && wallet.winrate >= 60) {
      return 'genius';
    }
    if (wallet.pnl >= 100_000 && wallet.winrate >= 63) {
      return 'quality';
    }
    return 'quality';
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
      const daysSinceActive = (now - (wallet.last_active || 0)) / (24 * 60 * 60);
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

  private convertToSmartWallets(dragonWallets: DragonWallet[]): SmartMoneyWallet[] {
    return dragonWallets.map(wallet => {
      const category = this.determineCategory(wallet);
      const tier = this.determineTier(wallet);
      
      const tierName = tier.toUpperCase();
      const nickname = `Dragon-${tierName}-${wallet.wallet.slice(0, 8)}`;

      return {
        address: wallet.wallet, category: category, winRate: wallet.winrate,
        totalPnL: wallet.pnl, totalTrades: wallet.trades,
        avgTradeSize: wallet.trades > 0 ? wallet.volume / wallet.trades : 0,
        maxTradeSize: wallet.volume * 0.1, minTradeSize: wallet.volume * 0.01,
        performanceScore: wallet.score || 70, sharpeRatio: null, maxDrawdown: null,
        lastActiveAt: wallet.last_active ? new Date(wallet.last_active * 1000) : new Date(0),
        isActive: true,
        isFamilyMember: false, familyAddresses: null, coordinationScore: 0,
        stealthLevel: null, earlyEntryRate: null, avgHoldTime: null,
        volumeScore: null, createdAt: new Date(), updatedAt: new Date(),
        nickname: nickname
      } as SmartMoneyWallet;
    });
  }

  /**
   * 🔍 PRE-FILTERING: Проверяем активность элитных кошельков ДО добавления в БД
   */
  private async preFilterByActivity(wallets: DragonWallet[]): Promise<DragonWallet[]> {
    const eliteWallets = wallets.filter(w => 
      w.tier === 'whale' || w.tier === 'genius' || w.pnl >= 500_000
    );
    
    if (eliteWallets.length === 0) {
      this.logger.info('✅ No elite wallets to pre-filter for activity');
      return wallets;
    }
    
    this.logger.info(`🔍 PRE-FILTERING: Checking activity for ${eliteWallets.length} elite wallets (tier: whale/genius, PnL≥500K)...`);
    
    const activeEliteWallets: DragonWallet[] = [];
    const batchSize = 3;
    let totalChecked = 0;
    let totalFiltered = 0;
    
    for (let i = 0; i < eliteWallets.length; i += batchSize) {
      const batch = eliteWallets.slice(i, i + batchSize);
      
      this.logger.debug(`🔍 Checking batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(eliteWallets.length/batchSize)}: ${batch.length} wallets`);
      
      const checks = await Promise.allSettled(
        batch.map(wallet => this.checkWalletActivityQuick(wallet.wallet))
      );
      
      checks.forEach((result, index) => {
        const wallet = batch[index];
        totalChecked++;
        
        if (result.status === 'fulfilled' && result.value.isActive) {
          if (result.value.lastTransactionTime) {
            wallet.last_active = result.value.lastTransactionTime;
          }
          activeEliteWallets.push(wallet);
          this.logger.debug(`✅ Active elite: ${wallet.wallet.slice(0,8)} (${wallet.tier}, ${this.formatNumber(wallet.pnl)})`);
        } else {
          totalFiltered++;
          const reason = result.status === 'rejected' ? 'API Error' : 'Inactive >14d';
          this.logger.info(`❌ FILTERED OUT inactive elite wallet: ${wallet.wallet.slice(0,8)} (${wallet.tier}, ${this.formatNumber(wallet.pnl)}) - ${reason}`);
        }
      });
      
      if (i + batchSize < eliteWallets.length) {
        await this.sleep(8000);
      }
    }
    
    const nonEliteWallets = wallets.filter(w => 
      w.tier !== 'whale' && w.tier !== 'genius' && w.pnl < 500_000
    );
    
    const finalWallets = [...activeEliteWallets, ...nonEliteWallets];
    
    this.logger.info(`✅ PRE-FILTERING completed: ${activeEliteWallets.length}/${eliteWallets.length} elite wallets are active (${totalFiltered} filtered out)`);
    this.logger.info(`📊 Final count: ${finalWallets.length} wallets (${activeEliteWallets.length} active elite + ${nonEliteWallets.length} quality with old dates)`);
    this.logger.info(`🔍 Quality wallets will be checked later by DragonActivityChecker (lastActiveAt = 1970)`);
    
    return finalWallets;
  }

  /**
   * ⚡ БЫСТРАЯ ПРОВЕРКА АКТИВНОСТИ ОДНОГО КОШЕЛЬКА
   */
  private async checkWalletActivityQuick(address: string): Promise<{isActive: boolean, lastTransactionTime: number | null}> {
    try {
      const response = await this.multiProvider.getSignaturesForAddress(address, { limit: 1 });
      
      if (!response.success || !response.data?.[0]?.blockTime) {
        this.logger.debug(`❌ No transactions found for ${address.slice(0,8)}`);
        return { isActive: false, lastTransactionTime: null };
      }
      
      const lastTxTime = response.data[0].blockTime;
      const daysSince = (Date.now() / 1000 - lastTxTime) / (24 * 60 * 60);
      const isActive = daysSince <= 14;
      
      this.logger.debug(`📊 ${address.slice(0,8)}: ${daysSince.toFixed(1)}d ago ${isActive ? '(ACTIVE)' : '(INACTIVE)'}`);
      
      return { 
        isActive, 
        lastTransactionTime: lastTxTime 
      };
      
    } catch (error) {
      this.logger.warn(`⚠️ Error checking activity for ${address.slice(0,8)}:`, error);
      return { isActive: false, lastTransactionTime: null };
    }
  }

  private async sendReplacementNotification(clearedCount: number, addedCount: number, errors: string[]): Promise<void> {
    const emoji = errors.length > 0 ? '⚠️' : '✅';
    const message = `${emoji} <b>Dragon Database REPLACED</b>\n\n` +
      `🗑️ <b>Cleared Old:</b> <code>${clearedCount}</code> Dragon wallets\n` +
      `➕ <b>Added New:</b> <code>${addedCount}</code> ELITE wallets\n\n` +
      `💰 <b>DEBUG CRITERIA:</b>\n` +
      `💸 <b>PnL:</b> ≥${this.config.minPnl/1000}K\n` +
      `💎 <b>Unrealized:</b> ≥${this.config.minUnrealizedProfit/1000}K\n` +
      `📈 <b>Multiplier:</b> ≥${this.config.minMultiplier}x\n` +
      `🎯 <b>Winrate:</b> ≥${this.config.minWinrate}%\n` +
      `📊 <b>Trades:</b> ≥${this.config.minTrades}\n` +
      `⏰ <b>Active:</b> ≤${this.config.maxDaysInactive} days\n\n` +
      `🔍 <b>PRE-FILTERING:</b> Elite wallets checked for activity\n` +
      `📅 <b>Quality wallets:</b> Old dates → will be checked by ActivityChecker\n` +
      `🔄 <b>Database Status:</b> <code>Completely Refreshed</code>\n` +
      (errors.length > 0 ? `⚠️ <b>Errors:</b> <code>${errors.length}</code>\n` : '') +
      `⏰ <code>${new Date().toLocaleString()}</code>`;

    await this.telegramNotifier.sendCycleLog(message);
  }

  private async sendNormalNotification(addedCount: number, updatedCount: number, skippedCount: number, errors: string[]): Promise<void> {
    const message = `🐲 <b>Dragon Import Complete</b>\n\n` +
      `➕ <b>Added:</b> <code>${addedCount}</code> new ELITE wallets\n` +
      `🔄 <b>Updated:</b> <code>${updatedCount}</code> existing\n` +
      `⏭️ <b>Skipped:</b> <code>${skippedCount}</code> unchanged\n\n` +
      `💰 <b>DEBUG CRITERIA:</b>\n` +
      `PnL≥${this.config.minPnl/1000}K | Unrealized≥${this.config.minUnrealizedProfit/1000}K | Multi≥${this.config.minMultiplier}x | WR≥${this.config.minWinrate}% | Trades≥${this.config.minTrades} | Active≤${this.config.maxDaysInactive}d\n` +
      `🔍 <b>PRE-FILTERING:</b> Elite wallets activity-checked\n` +
      `📅 <b>Quality wallets:</b> Old dates → ActivityChecker will verify\n` +
      (errors.length > 0 ? `⚠️ <b>Errors:</b> <code>${errors.length}</code>\n` : '') +
      `⏰ <code>${new Date().toLocaleString()}</code>`;

    await this.telegramNotifier.sendCycleLog(message);
  }

  // 🔥 ОТЛАДКА parseUsdString для больших сумм
  private parseUsdString(usdString: string): number {
    if (!usdString || typeof usdString !== 'string') return 0;
    const cleaned = usdString.replace(/[$,\s]/g, '');
    let multiplier = 1;
    if (cleaned.endsWith('K') || cleaned.endsWith('k')) multiplier = 1000;
    else if (cleaned.endsWith('M') || cleaned.endsWith('m')) multiplier = 1000000;
    else if (cleaned.endsWith('B') || cleaned.endsWith('b')) multiplier = 1000000000;
    const numberPart = cleaned.replace(/[KMBkmb]$/, '');
    const number = parseFloat(numberPart);
    const result = isNaN(number) ? 0 : number * multiplier;
    
    // 🔥 ОТЛАДКА для больших значений
    if (result > 1000000) {
      this.logger.debug(`parseUsdString: "${usdString}" → cleaned:"${cleaned}" → number:${number} → result:${result}`);
    }
    
    return result;
  }

  private async updateExistingWallet(existing: any, wallet: SmartMoneyWallet): Promise<void> {
    await this.smDatabase.updateWalletPerformance(existing.address, {
      winRate: Math.max(wallet.winRate, existing.winRate),
      totalPnL: Math.max(wallet.totalPnL, existing.totalPnL),
      totalTrades: Math.max(wallet.totalTrades, existing.totalTrades),
      lastActiveAt: wallet.lastActiveAt, performanceScore: wallet.performanceScore
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

  private isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    if (address.length < 32 || address.length > 44) return false;
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return base58Regex.test(address);
  }

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