// src/services/DragonResultsParser.ts - 🔥 CLEAN SLATE: ТОЛЬКО CSV поля, убираем legacy
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { MultiProviderService } from './MultiProviderService';
import { Logger } from '../utils/Logger';
import { SmartMoneyWallet } from '../types';
import * as Papa from 'papaparse';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 🔥 ЧИСТЫЙ ИНТЕРФЕЙС ДЛЯ CSV BULK WALLET CHECKER
interface DragonWallet {
  // ТОЛЬКО поля из CSV
  identifier: string;            // -> address
  totalProfitPercent: number;
  averageHoldingMins: number;
  usdProfit7d: number;           // 🔥 КЛЮЧЕВОЕ ПОЛЕ
  usdProfit30d: number;
  winrate7d: number;             // 🔥 КЛЮЧЕВОЕ ПОЛЕ
  solBalance: number;
  buy7d: number;                 // 🔥 КЛЮЧЕВОЕ ПОЛЕ - недавняя активность
  tags: string[];
  
  // Поля, которые мы вычисляем сами
  category?: 'sniper' | 'hunter' | 'trader';
  score?: number;
}

interface DragonConfig {
  dragonOutputPath: string; 
  // 🔥 НОВЫЕ КРИТЕРИИ "ВХОДНОГО БИЛЕТА"
  minProfit7d: number;           // Минимальная прибыль за 7 дней
  minWinrate7d: number;          // Минимальный винрейт за 7 дней
  minSolBalance: number;         // Минимальный баланс SOL
  minTotalProfitPercent: number; // Минимальный общий процент прибыли
  minActivity7d: number;         // Минимальная активность за 7 дней (покупки)
  maxDaysInactive: number;
  whaleThresholds: { megaWhale: number; whale: number; bigPlayer: number; quality: number; };
  scoreWeights: { profit7d: number; winrate: number; activity: number; balance: number; };
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
    
    // 🔥 НОВЫЕ КРИТЕРИИ "MONEY-FIRST" - ФОКУС НА ПРИБЫЛЬ И РОСТ КАПИТАЛА
    this.config = {
      dragonOutputPath: this.resolveDragonPath(config?.dragonOutputPath),
      minProfit7d: config?.minProfit7d || 8000,                     // $8K базовый порог (снижен)
      minWinrate7d: config?.minWinrate7d || 25,                     // 25% мягкий порог (игнорируется в основной логике)
      minSolBalance: config?.minSolBalance || 20,                   // 20 SOL базовый порог  
      minTotalProfitPercent: config?.minTotalProfitPercent || 8,    // 8% базовый рост капитала
      minActivity7d: config?.minActivity7d || 1,                    // минимум 1 покупка за 7 дней
      maxDaysInactive: config?.maxDaysInactive || 14,
      whaleThresholds: { 
        megaWhale: 100_000, 
        whale: 50_000, 
        bigPlayer: 30_000,    // Снижен с 20K до 30K
        quality: 10_000, 
        ...config?.whaleThresholds 
      },
      scoreWeights: { 
        profit7d: 0.3,        // Снижен приоритет прибыли
        winrate: 0.1,         // Минимальный вес винрейта  
        activity: 0.2, 
        balance: 0.4,         // Увеличен приоритет баланса
        ...config?.scoreWeights 
      }
    };

    this.logger.info(`🐲 Dragon Parser MONEY-FIRST MODE initialized`);
    this.logger.info(`💰 NEW LOGIC: Focus on totalProfitPercent + profit stability + balance. Winrate mostly ignored!`);
  }

  private resolveDragonPath(customPath?: string): string {
    if (customPath) return customPath;
    if (process.env.DRAGON_OUTPUT_PATH) {
      this.logger.info(`📁 Using DRAGON_OUTPUT_PATH: ${process.env.DRAGON_OUTPUT_PATH}`);
      return process.env.DRAGON_OUTPUT_PATH;
    }

    const possiblePaths = [
      '/opt/render/project/src/data/dragon-output', 
      '/app/data/dragon/output',
      './data/dragon-output', 
      './dragon-git/dragon-files',
      // 🔥 ОБНОВЛЕН ПУТЬ НА BULK WALLET CHECKER
      'C:\\Users\\ibm\\OneDrive\\Документы\\dragon-git\\dragon-files',
      'C:\\Users\\ibm\\OneDrive\\Документы\\Dragon-main\\Dragon\\data\\Solana\\BulkWallet\\',
      './Dragon/data/Solana/BulkWallet', 
      'C:\\Dragon\\data\\Solana\\BulkWallet\\',
      'D:\\Dragon\\data\\Solana\\BulkWallet\\',
      path.join(os.homedir(), 'dragon-git/dragon-files'),
      path.join(os.homedir(), 'Dragon/data/Solana/BulkWallet'),
      '/opt/dragon/data/Solana/BulkWallet'
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

  // 🔥 УЛУЧШЕННЫЙ parseUsdString для обработки "$75,545.71"
  private parseUsdString(usdString: string): number {
    if (!usdString || typeof usdString !== 'string') return 0;
    
    // Убираем $, кавычки, пробелы, но СОХРАНЯЕМ запятые как разделители тысяч
    const cleaned = usdString
      .replace(/[$"'\s]/g, '') // Убираем $, кавычки, пробелы
      .replace(/,/g, ''); // Убираем запятые (разделители тысяч)
    
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }

  private parsePercentageString(percentString: string): number {
    if (!percentString || typeof percentString !== 'string') return 0;
    // Удаляет % и превращает в число
    const cleaned = percentString.replace(/[%]/g, '');
    const number = parseFloat(cleaned);
    return isNaN(number) ? 0 : number;
  }

  // 🔥🔥🔥 ИСПРАВЛЕНО: parseHoldingTimeString теперь различает часы и минуты
  private parseHoldingTimeString(holdingString: string): number {
    if (!holdingString || typeof holdingString !== 'string') return 0;
    
    const trimmed = holdingString.trim();
    
    // Проверяем суффикс
    if (trimmed.endsWith('h')) {
      // Часы - умножаем на 60 для получения минут
      const cleaned = trimmed.replace(/h$/g, '');
      const hours = parseFloat(cleaned);
      return isNaN(hours) ? 0 : hours * 60;
    } else if (trimmed.endsWith('m')) {
      // Минуты - оставляем как есть
      const cleaned = trimmed.replace(/m$/g, '');
      const minutes = parseFloat(cleaned);
      return isNaN(minutes) ? 0 : minutes;
    } else {
      // Если нет суффикса, предполагаем что это часы (для обратной совместимости)
      const hours = parseFloat(trimmed);
      return isNaN(hours) ? 0 : hours * 60;
    }
  }

  // 🔥 УЛУЧШЕННЫЙ parseWinrateString для обработки "?" 
  private parseWinrateString(winrateString: string): number {
    if (!winrateString || typeof winrateString !== 'string') return 0;
    
    // Обрабатываем случай с "?" (мало данных для расчета винрейта)
    if (winrateString.trim() === '?' || winrateString.trim() === '') return 0;
    
    // Удаляет % и превращает в число
    const cleaned = winrateString.replace(/[%]/g, '');
    const number = parseFloat(cleaned);
    return isNaN(number) ? 0 : number;
  }

  // 🔥 УЛУЧШЕННЫЙ parseTagsString для всех форматов
  private parseTagsString(tagsString: string): string[] {
    if (!tagsString || tagsString.trim() === '' || tagsString === '[]') {
      return [];
    }
    
    try {
      // Обрабатываем разные форматы: ['photon'], "fresh_wallet", [axiom]
      let cleaned = tagsString.replace(/[\[\]'"]/g, '').trim();
      if (!cleaned) return [];
      
      return cleaned.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    } catch (error) {
      this.logger.warn(`⚠️ Error parsing tags: ${tagsString}`, error);
      return [];
    }
  }

  async parseLatestDragonResults(forceReplace: boolean = false): Promise<DragonParseResult> {
    try {
      this.logger.info(`🐲 Starting Dragon CSV parsing (Replace Mode: ${forceReplace})...`);

      await this.syncFromGit();

      const files = await this.findLatestDragonFiles();
      if (files.length === 0) {
        this.logger.warn('⚠️ No Dragon CSV files found after Git sync');
        return this.createEmptyResult(forceReplace);
      }

      this.logger.info(`📄 Found ${files.length} Dragon CSV files to process`);

      const allWallets: DragonWallet[] = [];
      for (const filePath of files) {
        const wallets = await this.parseDragonCsvFile(filePath);
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
      this.logger.info(`💰 After GATEKEEPING filtering: ${filteredWallets.length} qualified wallets (${((filteredWallets.length / uniqueWallets.length) * 100).toFixed(1)}% selected)`);

      // 🔥 ПРИСВАИВАЕМ КАТЕГОРИИ
      for (const wallet of filteredWallets) {
        wallet.category = this.determineCategory(wallet);
      }

      const scoredWallets = this.calculateProfitFirstScores(filteredWallets);
      
      scoredWallets.sort((a, b) => this.compareProfitPriority(a, b));

      const smartWallets = this.convertToSmartWallets(scoredWallets);
      
      let clearedCount = 0, addedCount = 0, updatedCount = 0, skippedCount = 0;
      let errors: string[] = [];

      // 🔥 НОВЫЙ, ПРАВИЛЬНЫЙ БЛОК
if (forceReplace) {
  // --- СЦЕНАРИЙ 1: /dragon_replace ---
  this.logger.info('🔥 REPLACE MODE: Clearing ALL existing Dragon wallets and adding new ones.');
  
  // Вызываем твой метод, который УЖЕ умеет чистить и добавлять. Он идеален для этой задачи.
  const replacementResult = await this.smDatabase.replaceDragonWallets(smartWallets, []);
  
  // Сохраняем статистику
  clearedCount = replacementResult.cleared;
  addedCount = replacementResult.added;
  skippedCount = replacementResult.skipped;
  errors = replacementResult.errors;
  
  // Отправляем уведомление о ПОЛНОЙ ЗАМЕНЕ
  await this.sendReplacementNotification(clearedCount, addedCount, errors);

} else {
  // --- СЦЕНАРИЙ 2: /dragon (Добавление без очистки) ---
  this.logger.info('📈 ADD MODE: Checking for new wallets to add to the database...');
  
  let addedCount = 0;
  let skippedCount = 0; // Считаем кошельки, которые уже есть в базе
  const errors: string[] = [];

  // Проходим по каждому кошельку из CSV-файлов
  for (const wallet of smartWallets) {
    try {
      const existingWallet = await this.smDatabase.getSmartWallet(wallet.address);
      
      if (!existingWallet) {
        // Если кошелька нет в базе - добавляем его
        await this.smDatabase.saveSmartWallet(wallet, { addedBy: 'dragon' });
        addedCount++;
        this.logger.info(`➕ Added new wallet: ${wallet.nickname}`);
      } else {
        // Если кошелек уже есть - пропускаем
        skippedCount++;
      }
    } catch (error) {
      this.logger.error(`❌ Error processing wallet ${wallet.address} in ADD MODE:`, error);
      errors.push(wallet.address);
    }
  }

  // Отправляем уведомление о ДОБАВЛЕНИИ
  await this.sendNormalNotification(addedCount, 0, skippedCount, errors); // `updatedCount` здесь всегда 0
}
      const finalResult = this.createResult(allWallets.length, uniqueWallets.length - filteredWallets.length,
        addedCount, updatedCount, skippedCount, clearedCount, scoredWallets, forceReplace);

      // 🔥 ФИНАЛЬНАЯ ОЧИСТКА ПАМЯТИ
      allWallets.length = 0;
      uniqueWallets.length = 0;
      filteredWallets.length = 0;
      
      if (global.gc) {
        global.gc();
        this.logger.info('🧹 Final memory cleanup completed');
      }

      this.logger.info(`✅ Dragon CSV parsing completed. Mode: ${forceReplace ? 'REPLACE' : 'NORMAL'}. Added: ${addedCount}, Updated: ${updatedCount}, Cleared: ${clearedCount}`);
      return finalResult;

    } catch (error) {
      this.logger.error('❌ Critical error during Dragon CSV parsing:', error);
      
      if (global.gc) {
        global.gc();
      }
      
      throw error;
    }
  }

  // 🔥 ПОИСК CSV ФАЙЛОВ
  private async findLatestDragonFiles(): Promise<string[]> {
    try {
      if (!fs.existsSync(this.config.dragonOutputPath)) {
        this.logger.warn(`⚠️ Dragon output path not found: ${this.config.dragonOutputPath}`);
        return [];
      }

      const files = fs.readdirSync(this.config.dragonOutputPath);
      
      // 🔥 ИЩЕМ CSV ФАЙЛЫ ВМЕСТО JSON
      const csvFiles = files
        .filter(file => {
          if (file.startsWith('.git') || file === 'README.md' || file === '.gitignore' || 
              file === 'package.json' || file === 'package-lock.json') return false;
          
          return file.endsWith('.csv') && (
            file.includes('wallets') || file.includes('output') ||
            file.includes('bulk') || file.includes('result')
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

      this.logger.info(`🔍 Dragon CSV files found: ${csvFiles.map(f => path.basename(f)).join(', ')}`);
      return csvFiles;
    } catch (error) {
      this.logger.error('❌ Error finding Dragon CSV files:', error);
      return [];
    }
  }

  // 🔥 ПАРСИНГ CSV ФАЙЛА С PAPAPARSE
  private async parseDragonCsvFile(filePath: string): Promise<DragonWallet[]> {
    this.logger.info(`📄 Parsing Dragon CSV file with PapaParse: ${path.basename(filePath)}`);
    
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const wallets: DragonWallet[] = [];

    // 🔥 PapaParse решает проблему с кавычками!
    const parseResult = Papa.parse(fileContent, {
      header: true, // Используем первую строку как заголовки
      skipEmptyLines: true,
      dynamicTyping: false, // Оставляем все как строки для наших хелперов
    });

    if (parseResult.errors.length > 0) {
      this.logger.warn(`⚠️ PapaParse errors in ${path.basename(filePath)}:`, parseResult.errors);
    }

    this.logger.info(`📋 CSV Headers: ${parseResult.meta.fields?.join(', ')}`);
    this.logger.info(`📊 Total rows to process: ${parseResult.data.length}`);

    for (const row of parseResult.data as any[]) {
      try {
        // 🔥 Обращаемся по именам заголовков - надежнее индексов!
        const wallet: DragonWallet = {
          identifier: row['Identifier']?.toString() || '',
          totalProfitPercent: this.parsePercentageString(row['totalProfitPercent']),
          averageHoldingMins: this.parseHoldingTimeString(row['averageHoldingMins']),
          usdProfit7d: this.parseUsdString(row['7dUSDProfit']),      
          usdProfit30d: this.parseUsdString(row['30dUSDProfit']),    
          winrate7d: this.parseWinrateString(row['winrate_7d']),     // 🔥 Новый метод для обработки "?"
          tags: this.parseTagsString(row['tags']),                   // 🔥 Сохраняем tags
          solBalance: parseFloat(row['sol_balance'] || '0'),
          buy7d: parseInt(row['buy_7d'] || '0', 10),
        };

        // Проверяем валидность (базовые проверки)
        if (this.isValidSolanaAddress(wallet.identifier) && wallet.totalProfitPercent > 0) {
          wallets.push(wallet);
          
          // Логируем первые 5 для проверки
          if (wallets.length <= 5) {
            this.logger.info(`✅ Wallet ${wallets.length}: ${wallet.identifier.slice(0,8)}... | Growth: ${wallet.totalProfitPercent}% | 7d: $${wallet.usdProfit7d} | 30d: $${wallet.usdProfit30d} | WR: ${wallet.winrate7d}% | Tags: [${wallet.tags.join(',')}]`);
          }
        } else {
          if (wallets.length < 3) { // Логируем первые ошибки
            this.logger.warn(`❌ Invalid: ${row['Identifier']?.toString()?.slice(0,8) || 'N/A'}... | Growth: ${this.parsePercentageString(row['totalProfitPercent'])}% | Valid: ${this.isValidSolanaAddress(wallet.identifier)}`);
          }
        }
      } catch (error) {
        this.logger.warn(`⚠️ Error processing row: ${JSON.stringify(row)}`, error);
      }
    }

    this.logger.info(`✅ Parsed ${wallets.length} valid wallets from ${path.basename(filePath)} using PapaParse`);
    return wallets;
  }

  // 🔥🔥🔥 ИСПРАВЛЕНО: НОВАЯ ЛОГИКА ФИЛЬТРАЦИИ + ФИЛЬТР БОТОВ
  private applyProfitFirstFiltering(wallets: DragonWallet[]): DragonWallet[] {
    this.logger.info(`🔍 Applying MONEY-FIRST gatekeeping filters to ${wallets.length} wallets...`);

    let loggedRejections = 0;

    const filtered = wallets.filter(wallet => {
      // 🔥🔥🔥 ФИЛЬТР БОТОВ - исключаем кошельки с >1600 сделками за 7 дней
      if (wallet.buy7d > 1600) {
        if (loggedRejections < 5) {
          loggedRejections++;
        }
        return false;
      }

      // Отсеиваем кошельки с "?" в winrate (мало торгуют)
      if (typeof wallet.winrate7d !== 'number' || wallet.winrate7d === 0) {
        return false;
      }

      // 🥇 ПРИОРИТЕТ #1: Супер-рост капитала? Мягкие требования к остальному
      const superGrowth = wallet.totalProfitPercent >= 15 && wallet.usdProfit7d >= 10000;
      
      // 🥈 ПРИОРИТЕТ #2: Хорошая прибыль + рост капитала  
      const goodProfitAndGrowth = wallet.usdProfit7d >= 20000 && wallet.totalProfitPercent >= 10;
      
      // 🥉 ПРИОРИТЕТ #3: Стабильность (30d больше 7d) + рост
      const stabGrowth = wallet.usdProfit30d > wallet.usdProfit7d && 
                        wallet.totalProfitPercent >= 12 && 
                        wallet.usdProfit7d >= 8000;

      // 🏅 ПРИОРИТЕТ #4: Высокий баланс + хороший рост (киты)
      const whaleGrowth = wallet.solBalance >= 150 && 
                         wallet.totalProfitPercent >= 10 && 
                         wallet.usdProfit7d >= 8000;

      // Базовые требования
      const basicRequirements = wallet.solBalance >= this.config.minSolBalance && 
                               wallet.buy7d >= this.config.minActivity7d;

      const passed = basicRequirements && (superGrowth || goodProfitAndGrowth || stabGrowth || whaleGrowth);

      if (!passed && loggedRejections < 5) {
        this.logger.info(`❌ Filtered out: ${wallet.identifier.slice(0,8)}... | Profit7d: $${wallet.usdProfit7d} | Growth: ${wallet.totalProfitPercent}% | WR: ${wallet.winrate7d}% | SOL: ${wallet.solBalance}`);
        loggedRejections++;
      }

      return passed;
    });

    this.logger.info(`✅ MONEY-FIRST filtering complete. Passed: ${filtered.length}/${wallets.length}.`);
    this.logger.info(`💰 Focus: totalProfitPercent > profit7d/30d > solBalance > activity | winrate IGNORED`);
    return filtered;
  }

  // 🔥 ЧИСТАЯ ЛОГИКА КАТЕГОРИЗАЦИИ - ТОЛЬКО ВРЕМЯ ХОЛДА (прибыльность уже проверена в фильтре!)
  private determineCategory(wallet: DragonWallet): 'sniper' | 'hunter' | 'trader' {
    // 🎯 ФИЛОСОФИЯ: Если кошелек дошел до этой функции - он УЖЕ прибыльный!
    // Категория определяется ТОЛЬКО стилем торговли (время холда)
    
    // 1. SNIPER: Быстрые сделки (30 минут - 3 часа)
    if (wallet.averageHoldingMins >= 30 && wallet.averageHoldingMins <= 180) {
      return 'sniper';
    }

    // 2. TRADER: Длинные позиции (более 6 часов)  
    if (wallet.averageHoldingMins >= 360) {
      return 'trader';
    }

    // 3. HUNTER: Средние позиции (3-6 часов) или любые другие случаи
    // Сюда попадают: 180-360 мин, <30 мин, или любые аномальные значения
    return 'hunter';
  }

  private deduplicateWallets(wallets: DragonWallet[]): DragonWallet[] {
    const walletMap = new Map<string, DragonWallet>();
    for (const wallet of wallets) {
      const existing = walletMap.get(wallet.identifier);
      if (!existing || wallet.usdProfit7d > existing.usdProfit7d) {
        walletMap.set(wallet.identifier, wallet);
      }
    }
    return Array.from(walletMap.values());
  }

  private calculateProfitFirstScores(wallets: DragonWallet[]): DragonWallet[] {
    if (wallets.length === 0) return wallets;
    
    const maxProfit7d = Math.max(...wallets.map(w => w.usdProfit7d));
    const maxWinrate = Math.max(...wallets.map(w => w.winrate7d));
    const maxActivity = Math.max(...wallets.map(w => w.buy7d));
    const maxBalance = Math.max(...wallets.map(w => w.solBalance));
    
    return wallets.map(wallet => {
      const profit7dScore = maxProfit7d > 0 ? wallet.usdProfit7d / maxProfit7d : 0;
      const winrateScore = maxWinrate > 0 ? wallet.winrate7d / maxWinrate : 0;
      const activityScore = maxActivity > 0 ? wallet.buy7d / maxActivity : 0;
      const balanceScore = maxBalance > 0 ? wallet.solBalance / maxBalance : 0;
      
      const score = (profit7dScore * this.config.scoreWeights.profit7d + 
                    winrateScore * this.config.scoreWeights.winrate +
                    activityScore * this.config.scoreWeights.activity + 
                    balanceScore * this.config.scoreWeights.balance) * 100;
      
      return { ...wallet, score: Math.round(score * 100) / 100 };
    });
  }

  private compareProfitPriority(a: DragonWallet, b: DragonWallet): number {
    // Сначала по прибыли за 7 дней, потом по score
    if (Math.abs(a.usdProfit7d - b.usdProfit7d) > 1000) return b.usdProfit7d - a.usdProfit7d;
    return (b.score || 0) - (a.score || 0);
  }

  // 🔥 КОНВЕРТАЦИЯ В SMARTWALLET С НОВОЙ ЛОГИКОЙ
  private convertToSmartWallets(dragonWallets: DragonWallet[]): SmartMoneyWallet[] {
    return dragonWallets.map(wallet => {
      // Убедимся, что категория присвоена
      const category = wallet.category || 'hunter'; 

      // Формируем nickname с учетом tags
      const tagsStr = wallet.tags.length > 0 ? `-${wallet.tags[0]}` : '';
      const nickname = `Dragon-${category.toUpperCase()}-${wallet.identifier.slice(0, 8)}${tagsStr}`;

      return {
        address: wallet.identifier,
        category: category,
        nickname: nickname,
        
        // 🔥 CSV ПОЛЯ + ПРИОРИТЕТ НА РОСТ КАПИТАЛА
        usdProfit7d: wallet.usdProfit7d,
        usdProfit30d: wallet.usdProfit30d,
        winrate7d: wallet.winrate7d,
        buy7d: wallet.buy7d,
        avgHoldingMins: wallet.averageHoldingMins,
        totalProfitPercent: wallet.totalProfitPercent,
        solBalance: wallet.solBalance,
        
        // 🔥 НОВЫЙ SCORING - ПРИОРИТЕТ НА РОСТ КАПИТАЛА
        performanceScore: (wallet.totalProfitPercent * 3) + (wallet.usdProfit7d / 1000) + (wallet.solBalance / 10),
        lastActiveAt: new Date(),
        isActive: true,
        
        // Остальные поля по умолчанию
        sharpeRatio: null,
        maxDrawdown: null,
        isFamilyMember: false,
        familyAddresses: undefined,
        coordinationScore: 0,
        stealthLevel: null,
        earlyEntryRate: null,
        volumeScore: null,
        createdAt: new Date(),
        updatedAt: new Date()
      } as SmartMoneyWallet;
    });
  }

  private async sendReplacementNotification(clearedCount: number, addedCount: number, errors: string[]): Promise<void> {
    const emoji = errors.length > 0 ? '⚠️' : '✅';
    const message = `${emoji} <b>Dragon Database REPLACED (MONEY-FIRST Mode)</b>\n\n` +
      `🗑️ <b>Cleared Old:</b> <code>${clearedCount}</code> Dragon wallets\n` +
      `➕ <b>Added New:</b> <code>${addedCount}</code> PROFITABLE wallets\n\n` +
      `💰 <b>NEW MONEY-FIRST LOGIC:</b>\n` +
      `🥇 <b>Priority #1:</b> totalProfitPercent ≥ 15% + profit ≥ $10K\n` +
      `🥈 <b>Priority #2:</b> Profit7d ≥ $20K + growth ≥ 10%\n` +
      `🥉 <b>Priority #3:</b> Stability (30d > 7d) + growth ≥ 12%\n` +
      `🏅 <b>Priority #4:</b> Whale balance ≥ 150 SOL + growth ≥ 10%\n\n` +
      `🚫 <b>Winrate MOSTLY IGNORED</b> (focus on 💰 not %wins)\n` +
      `🤖 <b>BOT FILTER:</b> Excluded wallets with >1000 trades/7d\n` +
      `🔄 <b>Source:</b> Bulk Wallet Checker CSV\n` +
      (errors.length > 0 ? `⚠️ <b>Errors:</b> <code>${errors.length}</code>\n` : '') +
      `⏰ <code>${new Date().toLocaleString()}</code>`;

    await this.telegramNotifier.sendCycleLog(message);
  }

  private async sendNormalNotification(addedCount: number, updatedCount: number, skippedCount: number, errors: string[]): Promise<void> {
    const message = `🐲 <b>Dragon CSV Import Complete</b>\n\n` +
      `➕ <b>Added:</b> <code>${addedCount}</code> new ACTIVE wallets\n` +
      `🔄 <b>Updated:</b> <code>${updatedCount}</code> existing\n` +
      `⏭️ <b>Skipped:</b> <code>${skippedCount}</code> unchanged\n\n` +
      `💰 <b>ВХОДНОЙ БИЛЕТ:</b>\n` +
      `Profit7d≥$${this.config.minProfit7d/1000}K | WR7d≥${this.config.minWinrate7d}% | SOL≥${this.config.minSolBalance} | TotalProfit≥${this.config.minTotalProfitPercent}% | Activity≥${this.config.minActivity7d}\n` +
      `🤖 <b>BOT FILTER:</b> Excluded wallets with >1000 trades/7d\n` +
      `🔄 <b>Source:</b> Bulk Wallet Checker CSV\n` +
      (errors.length > 0 ? `⚠️ <b>Errors:</b> <code>${errors.length}</code>\n` : '') +
      `⏰ <code>${new Date().toLocaleString()}</code>`;

    await this.telegramNotifier.sendCycleLog(message);
  }

  private isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    if (address.length < 32 || address.length > 44) return false;
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return base58Regex.test(address);
  }

  private createResult(totalParsedFromFile: number, filteredOutCount: number, added: number, updated: number,
    skipped: number, cleared: number, finalWallets: DragonWallet[], replaceMode: boolean = false): DragonParseResult {
    const categories = this.categorizeWallets(finalWallets);
    const profitDistribution = this.calculateProfitDistribution(finalWallets);
    const totalValue = finalWallets.reduce((sum, w) => sum + w.usdProfit7d, 0);
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
      const category = wallet.category || 'hunter';
      categories[category + 's' as keyof typeof categories]++;
    }
    return categories;
  }

  private calculateProfitDistribution(wallets: DragonWallet[]): {
    megaWhales: number; whales: number; bigPlayers: number; quality: number; regular: number;
  } {
    const distribution = { megaWhales: 0, whales: 0, bigPlayers: 0, quality: 0, regular: 0 };
    for (const wallet of wallets) {
      if (wallet.usdProfit7d >= this.config.whaleThresholds.megaWhale) distribution.megaWhales++;
      else if (wallet.usdProfit7d >= this.config.whaleThresholds.whale) distribution.whales++;
      else if (wallet.usdProfit7d >= this.config.whaleThresholds.bigPlayer) distribution.bigPlayers++;
      else if (wallet.usdProfit7d >= this.config.whaleThresholds.quality) distribution.quality++;
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