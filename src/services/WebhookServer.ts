// src/services/WebhookServer.ts - 🔥 ТЕХНИЧЕСКОЕ ЛОГИРОВАНИЕ ДЛЯ ОТЛАДКИ
import express from 'express';
import { Database } from './Database';
import { SmartMoneyDatabase } from './SmartMoneyDatabase';
import { TelegramNotifier } from './TelegramNotifier';
import { SolanaMonitor } from './SolanaMonitor';
import { TokenMetadataService } from './TokenMetadataService';
import { Logger } from '../utils/Logger';
import { SmartMoneySwap, SmartMoneyWallet, TokenSwap } from '../types';

interface SolanaWebhookPayload {
  type: string;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  transaction?: {
    signatures: string[];
    message?: {
      accountKeys?: string[];
    };
  };
  meta?: {
    preBalances: number[];
    postBalances: number[];
    err?: any;
    preTokenBalances?: Array<{
      accountIndex: number;
      mint: string;
      owner: string;
      uiTokenAmount: {
        amount: string;
        decimals: number;
        uiAmount: number;
        uiAmountString: string;
      };
    }>;
    postTokenBalances?: Array<{
      accountIndex: number;
      mint: string;
      owner: string;
      uiTokenAmount: {
        amount: string;
        decimals: number;
        uiAmount: number;
        uiAmountString: string;
      };
    }>;
  };
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  events?: {
    swap?: Array<{
      nativeInput?: {
        account: string;
        amount: string;
      };
      nativeOutput?: {
        account: string;
        amount: string;
      };
      tokenInputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        mint: string;
        rawTokenAmount: {
          tokenAmount: string;
          decimals: number;
        };
      }>;
      tokenOutputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        mint: string;
        rawTokenAmount: {
          tokenAmount: string;
          decimals: number;
        };
      }>;
    }>;
  };
}

interface ProcessingStats {
  totalTransactionsProcessed: number;
  smartMoneyTransactions: number;
  regularTransactions: number;
  alertsSent: number;
  filteredTransactions: number;
  errorCount: number;
  avgProcessingTime: number;
  lastProcessedTime: Date;
  transactionTypes: {
    swaps: number;
    transfers: number;
    other: number;
  };
  usdCalculationStats: {
    correctCalculations: number;
    fallbackCalculations: number;
    errorCalculations: number;
  };
  profitableSwaps: number;
  ignoredMajorSwaps: number;
  oldTransactionsFiltered: number;
  unifiedCalculatorIgnored: number;
  balancesExtracted: number;
  eventsIgnored: number;
}

export class WebhookServer {
  private app: express.Application;
  private database: Database;
  private smDatabase: SmartMoneyDatabase;
  private telegramNotifier: TelegramNotifier;
  private solanaMonitor: SolanaMonitor | null;
  private tokenMetadataService: TokenMetadataService;
  private logger: Logger;
  private port: number;
  private server: any;

  private readonly PAYMENT_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'So11111111111111111111111111111111111111111', // WSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
    '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', // stSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
    'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A'  // hSOL
  ]);

  private tokenInfoCache = new Map<string, { 
    symbol: string; 
    name: string; 
    decimals: number;
    isCexListed?: boolean;
    createdAt?: Date;
    timestamp: number; 
  }>();

  private readonly PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 минут

  private readonly CEX_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Bonk
    'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', // WEN
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
    'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt', // SRM
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WIF
    '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump', // PNUT
    'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump', // GOAT
    'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', // BOME
    'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', // HNT
    'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6', // KIN
    '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', // stSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
    'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', // hSOL
    'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', // UXD
    'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX' // USDH
  ]);

  private processingStats: ProcessingStats = {
    totalTransactionsProcessed: 0,
    smartMoneyTransactions: 0,
    regularTransactions: 0,
    alertsSent: 0,
    filteredTransactions: 0,
    errorCount: 0,
    avgProcessingTime: 0,
    lastProcessedTime: new Date(),
    transactionTypes: {
      swaps: 0,
      transfers: 0,
      other: 0
    },
    usdCalculationStats: {
      correctCalculations: 0,
      fallbackCalculations: 0,
      errorCalculations: 0
    },
    profitableSwaps: 0,
    ignoredMajorSwaps: 0,
    oldTransactionsFiltered: 0,
    unifiedCalculatorIgnored: 0,
    balancesExtracted: 0,
    eventsIgnored: 0
  };

  private requestCounters = {
    lastMinuteRequests: 0,
    lastMinuteErrors: 0,
    lastMinuteReset: Date.now() + 60000
  };

  constructor(
    database: Database,
    telegramNotifier: TelegramNotifier,
    solanaMonitor: SolanaMonitor | null,
    smDatabase: SmartMoneyDatabase
  ) {
    this.database = database;
    this.smDatabase = smDatabase;
    this.telegramNotifier = telegramNotifier;
    this.solanaMonitor = solanaMonitor;
    this.tokenMetadataService = new TokenMetadataService();
    this.logger = Logger.getInstance();
    this.port = parseInt(process.env.PORT || '3000');

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    this.startCacheCleanup();
    this.logger.info('[WebhookServer] CONSTRUCTOR: Initialized with technical debugging');
  }

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    this.app.use((req, res, next) => {
      const now = Date.now();
      
      if (now >= this.requestCounters.lastMinuteReset) {
        this.requestCounters.lastMinuteRequests = 0;
        this.requestCounters.lastMinuteErrors = 0;
        this.requestCounters.lastMinuteReset = now + 60000;
      }
      
      this.requestCounters.lastMinuteRequests++;
      next();
    });

    this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      this.logger.error('Express error:', error);
      this.requestCounters.lastMinuteErrors++;
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  private setupRoutes(): void {
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        stats: this.processingStats,
        performance: {
          requestsLastMinute: this.requestCounters.lastMinuteRequests,
          errorsLastMinute: this.requestCounters.lastMinuteErrors
        }
      });
    });

    this.app.post('/webhook/solana', async (req, res) => {
      try {
        this.processingStats.totalTransactionsProcessed++;
        await this.processWebhookTransactionWithStats(req.body as SolanaWebhookPayload);
        res.status(200).json({ success: true });
      } catch (error) {
        this.logger.error('Webhook processing error:', error as Error);
        this.processingStats.errorCount++;
        this.requestCounters.lastMinuteErrors++;
        res.status(500).json({ error: 'Processing failed' });
      }
    });

    this.app.post('/webhook/helius', async (req, res) => {
      try {
        this.processingStats.totalTransactionsProcessed++;
        await this.processWebhookTransactionWithStats(req.body as SolanaWebhookPayload);
        res.status(200).json({ success: true });
      } catch (error) {
        this.logger.error('Webhook processing error:', error as Error);
        this.processingStats.errorCount++;
        this.requestCounters.lastMinuteErrors++;
        res.status(500).json({ error: 'Processing failed' });
      }
    });

    this.app.get('/stats', (req, res) => {
      res.json({
        ...this.processingStats,
        cacheStats: {
          tokenInfoCache: this.tokenInfoCache.size
        },
        requestCounters: this.requestCounters
      });
    });

    this.app.use((req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });
  }

  private async processWebhookTransactionWithStats(txData: SolanaWebhookPayload): Promise<void> {
    const startTime = Date.now();
    
    try {
      console.log(`[WebhookServer] WEBHOOK_RECEIVED: signature=${txData.signature?.slice(0,12)}, timestamp=${txData.timestamp}, feePayer=${txData.feePayer || 'undefined'}`);
      
      if (!this.isTransactionRecentAndValid(txData)) {
        this.processingStats.oldTransactionsFiltered++;
        console.log(`[WebhookServer] WEBHOOK_FILTERED_OLD: signature=${txData.signature?.slice(0,12)}, reason=too_old_or_invalid`);
        return;
      }

      // Определяем тип транзакции для статистики
      if (txData.meta?.preTokenBalances && txData.meta?.postTokenBalances) {
        this.processingStats.transactionTypes.swaps++;
        console.log(`[WebhookServer] WEBHOOK_TYPE_DETECTED: type=swap, signature=${txData.signature?.slice(0,12)}`);
      } else if (txData.tokenTransfers && txData.tokenTransfers.length > 0) {
        this.processingStats.transactionTypes.transfers++;
        console.log(`[WebhookServer] WEBHOOK_TYPE_DETECTED: type=transfer, signature=${txData.signature?.slice(0,12)}`);
      } else {
        this.processingStats.transactionTypes.other++;
        console.log(`[WebhookServer] WEBHOOK_TYPE_DETECTED: type=other, signature=${txData.signature?.slice(0,12)}`);
      }

      await this.processWebhookTransaction(txData);
      
      const processingTime = Date.now() - startTime;
      this.processingStats.avgProcessingTime = 
        (this.processingStats.avgProcessingTime + processingTime) / 2;
        
    } catch (error) {
      console.error(`[WebhookServer] WEBHOOK_PROCESSING_ERROR: signature=${txData.signature?.slice(0,12)}, error=${error}`);
      this.processingStats.errorCount++;
      throw error;
    }
  }

  private isTransactionRecentAndValid(txData: SolanaWebhookPayload): boolean {
    if (!txData || !txData.timestamp) {
      console.log(`[WebhookServer] VALIDATION_FAILED: missing_txData_or_timestamp`);
      return false;
    }

    const transactionTime = txData.timestamp * 1000;
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 минут

    const transactionAge = Math.abs(now - transactionTime);

    console.log(`[WebhookServer] VALIDATION_CHECK: transactionTime=${transactionTime}, now=${now}, age=${transactionAge}ms, maxAge=${maxAge}ms`);

    if (transactionAge > maxAge) {
        console.log(`[WebhookServer] VALIDATION_FAILED: transaction_too_old, age=${transactionAge}ms > ${maxAge}ms`);
        return false;
    }
    
    if (txData.meta?.err) {
        console.log(`[WebhookServer] VALIDATION_FAILED: transaction_has_error, err=${JSON.stringify(txData.meta.err)}`);
        return false;
    }

    console.log(`[WebhookServer] VALIDATION_PASSED: signature=${txData.signature?.slice(0,12)}`);
    return true;
  }

  private async processWebhookTransaction(txData: SolanaWebhookPayload): Promise<void> {
    try {
      console.log(`[WebhookServer] PROCESS_WEBHOOK_START: signature=${txData.signature?.slice(0,12)}`);
      console.log(`[WebhookServer] PROCESS_WEBHOOK_BALANCES_CHECK: preTokenBalances=${!!txData.meta?.preTokenBalances}, postTokenBalances=${!!txData.meta?.postTokenBalances}, preTokenBalances_length=${txData.meta?.preTokenBalances?.length || 0}, postTokenBalances_length=${txData.meta?.postTokenBalances?.length || 0}`);
      
      if (!txData.meta?.preTokenBalances || !txData.meta?.postTokenBalances) {
        this.processingStats.eventsIgnored++;
        console.log(`[WebhookServer] PROCESS_WEBHOOK_NO_BALANCES: forwarding to SolanaMonitor, signature=${txData.signature?.slice(0,12)}`);
        
        // Попробуем fallback к SolanaMonitor для обработки
        if (this.solanaMonitor) {
          await this.solanaMonitor.processTransaction(txData);
          this.processingStats.regularTransactions++;
          console.log(`[WebhookServer] PROCESS_WEBHOOK_FORWARDED: to SolanaMonitor, signature=${txData.signature?.slice(0,12)}`);
        }
        return;
      }

      this.processingStats.balancesExtracted++;
      console.log(`[WebhookServer] PROCESS_WEBHOOK_BALANCES_FOUND: extracting swap info, signature=${txData.signature?.slice(0,12)}`);
      
      const swapInfo = await this.extractSwapInfoFromBalances(txData);
      if (!swapInfo) {
        console.log(`[WebhookServer] PROCESS_WEBHOOK_NO_SWAP_INFO: failed to extract, signature=${txData.signature?.slice(0,12)}`);
        return;
      }

      console.log(`[WebhookServer] PROCESS_WEBHOOK_SWAP_EXTRACTED: walletAddress=${swapInfo.walletAddress.slice(0,8)}, inputMint=${swapInfo.inputMint.slice(0,8)}, outputMint=${swapInfo.outputMint.slice(0,8)}, signature=${txData.signature?.slice(0,12)}`);

      // Проверяем, является ли это Smart Money кошельком
      console.log(`[WebhookServer] PROCESS_WEBHOOK_CHECKING_SMART_WALLET: walletAddress=${swapInfo.walletAddress}`);
      const smartWallet = await this.smDatabase.getSmartWallet(swapInfo.walletAddress);
      
      if (!smartWallet || !smartWallet.isActive) {
        console.log(`[WebhookServer] PROCESS_WEBHOOK_REGULAR_WALLET: not smart money or inactive, forwarding to SolanaMonitor, walletAddress=${swapInfo.walletAddress.slice(0,8)}`);
        // Обычная транзакция - отправляем в SolanaMonitor
        if (this.solanaMonitor) {
          await this.solanaMonitor.processTransaction(txData);
        }
        this.processingStats.regularTransactions++;
        return;
      }

      console.log(`[WebhookServer] PROCESS_WEBHOOK_SMART_WALLET_DETECTED: category=${smartWallet.category}, walletAddress=${smartWallet.address.slice(0,8)}, isActive=${smartWallet.isActive}`);

      // Smart Money транзакция - обрабатываем здесь
      await this.processSmartMoneySwap(swapInfo, smartWallet, txData);

    } catch (error) {
      console.error(`[WebhookServer] PROCESS_WEBHOOK_ERROR: signature=${txData.signature?.slice(0,12)}, error=${error}`);
      this.logger.error(`Error processing transaction ${txData.signature}:`, error as Error);
    }
  }

  // ===== КРИТИЧЕСКАЯ ФУНКЦИЯ С МАКСИМАЛЬНЫМ ЛОГИРОВАНИЕМ =====
  private async extractSwapInfoFromBalances(txData: SolanaWebhookPayload): Promise<{
    walletAddress: string; inputMint: string; outputMint: string;
    inputAmountRaw: number; outputAmountRaw: number;
  } | null> {
    try {
      console.log(`[WebhookServer] EXTRACT_SWAP_START: signature=${txData.signature?.slice(0,12)}`);
      
      const transaction = Array.isArray(txData) ? txData[0] : txData;
      
      if (!transaction?.meta) {
        console.log(`[WebhookServer] EXTRACT_SWAP_NO_META: transaction.meta is missing`);
        return null;
      }

      const preTokenBalances = transaction.meta.preTokenBalances || [];
      const postTokenBalances = transaction.meta.postTokenBalances || [];
      
      console.log(`[WebhookServer] EXTRACT_SWAP_BALANCES: preTokenBalances.length=${preTokenBalances.length}, postTokenBalances.length=${postTokenBalances.length}`);
      
      // КРИТИЧЕСКИЙ АНАЛИЗ КОШЕЛЬКА
      const walletAddress = this.extractWalletAddressFromTransaction(transaction);
      if (!walletAddress) {
        console.log(`[WebhookServer] EXTRACT_SWAP_NO_WALLET: extractWalletAddressFromTransaction returned null`);
        return null;
      }

      console.log(`[WebhookServer] EXTRACT_SWAP_WALLET_FOUND: walletAddress=${walletAddress}`);

      const tokenChanges = new Map<string, { changeUI: number, changeRaw: number, mint: string, decimals: number }>();

      // Анализ существующих токен-аккаунтов ТОЛЬКО для пользователя
      let preBalanceAnalyzed = 0;
      for (const pre of preTokenBalances) {
        if (pre.owner !== walletAddress) {
          console.log(`[WebhookServer] EXTRACT_SWAP_SKIP_PRE: pre.owner=${pre.owner} != walletAddress=${walletAddress}, mint=${pre.mint}`);
          continue;
        }
        preBalanceAnalyzed++;
        
        const post = postTokenBalances.find(p => p.accountIndex === pre.accountIndex);
        
        const preAmountUI = parseFloat(pre.uiTokenAmount.uiAmountString || pre.uiTokenAmount.uiAmount?.toString() || '0');
        const postAmountUI = post ? parseFloat(post.uiTokenAmount.uiAmountString || post.uiTokenAmount.uiAmount?.toString() || '0') : 0;
        const changeUI = postAmountUI - preAmountUI;
        
        const preAmountRaw = parseInt(pre.uiTokenAmount.amount || '0');
        const postAmountRaw = post ? parseInt(post.uiTokenAmount.amount || '0') : 0;
        const changeRaw = postAmountRaw - preAmountRaw;
        
        console.log(`[WebhookServer] EXTRACT_SWAP_PRE_ANALYZED: mint=${pre.mint.slice(0,8)}, preAmountUI=${preAmountUI}, postAmountUI=${postAmountUI}, changeUI=${changeUI}, changeRaw=${changeRaw}`);
        
        if (Math.abs(changeUI) > 1e-9) {
          tokenChanges.set(pre.mint, { 
            changeUI, 
            changeRaw,
            mint: pre.mint, 
            decimals: pre.uiTokenAmount.decimals 
          });
          console.log(`[WebhookServer] EXTRACT_SWAP_TOKEN_CHANGE_ADDED: mint=${pre.mint.slice(0,8)}, changeUI=${changeUI}, changeRaw=${changeRaw}`);
        }
      }
      
      console.log(`[WebhookServer] EXTRACT_SWAP_PRE_SUMMARY: preBalanceAnalyzed=${preBalanceAnalyzed} out of ${preTokenBalances.length} total`);

      // Анализ НОВЫХ токен-аккаунтов ТОЛЬКО для пользователя
      let newAccountsAnalyzed = 0;
      for (const post of postTokenBalances) {
        if (post.owner !== walletAddress || tokenChanges.has(post.mint)) {
          if (post.owner !== walletAddress) {
            console.log(`[WebhookServer] EXTRACT_SWAP_SKIP_POST: post.owner=${post.owner} != walletAddress=${walletAddress}, mint=${post.mint}`);
          }
          continue;
        }
        
        const isNewAccount = !preTokenBalances.find(p => p.accountIndex === post.accountIndex);
        if (isNewAccount) {
          newAccountsAnalyzed++;
          const changeUI = parseFloat(post.uiTokenAmount.uiAmountString || post.uiTokenAmount.uiAmount?.toString() || '0');
          const changeRaw = parseInt(post.uiTokenAmount.amount || '0');
          
          console.log(`[WebhookServer] EXTRACT_SWAP_NEW_ACCOUNT: mint=${post.mint.slice(0,8)}, changeUI=${changeUI}, changeRaw=${changeRaw}`);
          
          if (changeUI > 1e-9) {
            tokenChanges.set(post.mint, { 
              changeUI, 
              changeRaw,
              mint: post.mint, 
              decimals: post.uiTokenAmount.decimals 
            });
            console.log(`[WebhookServer] EXTRACT_SWAP_NEW_TOKEN_CHANGE_ADDED: mint=${post.mint.slice(0,8)}, changeUI=${changeUI}, changeRaw=${changeRaw}`);
          }
        }
      }
      
      console.log(`[WebhookServer] EXTRACT_SWAP_POST_SUMMARY: newAccountsAnalyzed=${newAccountsAnalyzed}`);

      // Анализ изменений нативного SOL для пользователя
      const accountKeys = transaction.transaction?.message?.accountKeys || [];
      console.log(`[WebhookServer] EXTRACT_SWAP_ACCOUNT_KEYS: accountKeys.length=${accountKeys.length}`);
      
      const walletIndex = accountKeys.findIndex((key: any) => {
        const keyString = typeof key === 'string' ? key : key?.pubkey || key?.toString?.() || '';
        return keyString === walletAddress;
      });
      
      console.log(`[WebhookServer] EXTRACT_SWAP_WALLET_INDEX: walletIndex=${walletIndex}`);
      
      if (walletIndex !== -1 && transaction.meta?.preBalances && transaction.meta?.postBalances) {
        const preSolBalance = transaction.meta.preBalances[walletIndex] || 0;
        const postSolBalance = transaction.meta.postBalances[walletIndex] || 0;
        const solChangeRaw = postSolBalance - preSolBalance;
        const solChangeUI = solChangeRaw / 1e9;
        
        console.log(`[WebhookServer] EXTRACT_SWAP_SOL_ANALYSIS: preSolBalance=${preSolBalance}, postSolBalance=${postSolBalance}, solChangeRaw=${solChangeRaw}, solChangeUI=${solChangeUI}`);
        
        if (Math.abs(solChangeUI) > 0.01) {
          tokenChanges.set('So11111111111111111111111111111111111111112', {
            changeUI: solChangeUI,
            changeRaw: solChangeRaw,
            mint: 'So11111111111111111111111111111111111111112',
            decimals: 9
          });
          console.log(`[WebhookServer] EXTRACT_SWAP_SOL_CHANGE_ADDED: solChangeUI=${solChangeUI}, solChangeRaw=${solChangeRaw}`);
        }
      }

      const spentTokens = Array.from(tokenChanges.values()).filter(c => c.changeUI < 0);
      const receivedTokens = Array.from(tokenChanges.values()).filter(c => c.changeUI > 0);

      console.log(`[WebhookServer] EXTRACT_SWAP_TOKEN_SUMMARY: spentTokens.length=${spentTokens.length}, receivedTokens.length=${receivedTokens.length}`);
      
      spentTokens.forEach((token, index) => {
        console.log(`[WebhookServer] EXTRACT_SWAP_SPENT_TOKEN_${index}: mint=${token.mint.slice(0,8)}, changeUI=${token.changeUI}, changeRaw=${token.changeRaw}`);
      });
      
      receivedTokens.forEach((token, index) => {
        console.log(`[WebhookServer] EXTRACT_SWAP_RECEIVED_TOKEN_${index}: mint=${token.mint.slice(0,8)}, changeUI=${token.changeUI}, changeRaw=${token.changeRaw}`);
      });

      if (spentTokens.length === 0 || receivedTokens.length === 0) {
        console.log(`[WebhookServer] EXTRACT_SWAP_INSUFFICIENT_TOKENS: spentTokens.length=${spentTokens.length}, receivedTokens.length=${receivedTokens.length}`);
        return null;
      }

      // ПРАВИЛЬНАЯ ЛОГИКА: ИЩЕМ PAYMENT TOKEN ПАРУ
      let inputMint: string | null = null;
      let outputMint: string | null = null;
      let inputAmountRaw = 0;
      let outputAmountRaw = 0;

      // Ищем payment token в потраченных токенах
      const spentPaymentToken = spentTokens.find(token => this.PAYMENT_TOKENS.has(token.mint));
      
      console.log(`[WebhookServer] EXTRACT_SWAP_SPENT_PAYMENT_CHECK: spentPaymentToken=${spentPaymentToken ? spentPaymentToken.mint.slice(0,8) : 'not found'}`);
      
      if (spentPaymentToken) {
        // BUY: Тратим payment token -> получаем обычный токен
        const receivedNonPaymentToken = receivedTokens.find(token => !this.PAYMENT_TOKENS.has(token.mint));
        
        console.log(`[WebhookServer] EXTRACT_SWAP_BUY_CHECK: receivedNonPaymentToken=${receivedNonPaymentToken ? receivedNonPaymentToken.mint.slice(0,8) : 'not found'}`);
        
        if (receivedNonPaymentToken) {
          inputMint = spentPaymentToken.mint;
          outputMint = receivedNonPaymentToken.mint;
          inputAmountRaw = Math.abs(spentPaymentToken.changeRaw);
          outputAmountRaw = receivedNonPaymentToken.changeRaw;
          console.log(`[WebhookServer] EXTRACT_SWAP_BUY_DETECTED: inputMint=${inputMint.slice(0,8)}, outputMint=${outputMint.slice(0,8)}, inputAmountRaw=${inputAmountRaw}, outputAmountRaw=${outputAmountRaw}`);
        }
      } else {
        // Ищем payment token в полученных токенах
        const receivedPaymentToken = receivedTokens.find(token => this.PAYMENT_TOKENS.has(token.mint));
        
        console.log(`[WebhookServer] EXTRACT_SWAP_RECEIVED_PAYMENT_CHECK: receivedPaymentToken=${receivedPaymentToken ? receivedPaymentToken.mint.slice(0,8) : 'not found'}`);
        
        if (receivedPaymentToken) {
          // SELL: Тратим обычный токен -> получаем payment token
          const spentNonPaymentToken = spentTokens.find(token => !this.PAYMENT_TOKENS.has(token.mint));
          
          console.log(`[WebhookServer] EXTRACT_SWAP_SELL_CHECK: spentNonPaymentToken=${spentNonPaymentToken ? spentNonPaymentToken.mint.slice(0,8) : 'not found'}`);
          
          if (spentNonPaymentToken) {
            inputMint = spentNonPaymentToken.mint;
            outputMint = receivedPaymentToken.mint;
            inputAmountRaw = Math.abs(spentNonPaymentToken.changeRaw);
            outputAmountRaw = receivedPaymentToken.changeRaw;
            console.log(`[WebhookServer] EXTRACT_SWAP_SELL_DETECTED: inputMint=${inputMint.slice(0,8)}, outputMint=${outputMint.slice(0,8)}, inputAmountRaw=${inputAmountRaw}, outputAmountRaw=${outputAmountRaw}`);
          }
        }
      }

      // Если не нашли правильную пару - используем УМНЫЙ fallback
      if (!inputMint || !outputMint) {
        console.log(`[WebhookServer] EXTRACT_SWAP_FALLBACK: No payment token pair found, using fallback logic`);
        
        const spentToken = spentTokens[0];
        const receivedToken = receivedTokens[0];
        
        inputMint = spentToken.mint;
        outputMint = receivedToken.mint;
        inputAmountRaw = Math.abs(spentToken.changeRaw);
        outputAmountRaw = receivedToken.changeRaw;
        
        console.log(`[WebhookServer] EXTRACT_SWAP_FALLBACK_RESULT: inputMint=${inputMint.slice(0,8)}, outputMint=${outputMint.slice(0,8)}, inputAmountRaw=${inputAmountRaw}, outputAmountRaw=${outputAmountRaw}`);
      }

      // Фильтрация технических операций (деньги в деньги)
      const inputIsPayment = this.PAYMENT_TOKENS.has(inputMint);
      const outputIsPayment = this.PAYMENT_TOKENS.has(outputMint);

      console.log(`[WebhookServer] EXTRACT_SWAP_PAYMENT_CHECK: inputIsPayment=${inputIsPayment}, outputIsPayment=${outputIsPayment}`);

      if (inputIsPayment && outputIsPayment) {
        console.log(`[WebhookServer] EXTRACT_SWAP_PAYMENT_TO_PAYMENT_FILTERED: Both tokens are payment tokens`);
        return null;
      }

      console.log(`[WebhookServer] EXTRACT_SWAP_SUCCESS: walletAddress=${walletAddress.slice(0,8)}, inputMint=${inputMint.slice(0,8)}, outputMint=${outputMint.slice(0,8)}, inputAmountRaw=${inputAmountRaw}, outputAmountRaw=${outputAmountRaw}`);
      return { walletAddress, inputMint, outputMint, inputAmountRaw, outputAmountRaw };

    } catch (error) {
      console.error(`[WebhookServer] EXTRACT_SWAP_ERROR: ${error}`);
      this.logger.error('[extractSwapInfoFromBalances] Error:', error);
      return null;
    }
  }

  // ===== КРИТИЧЕСКАЯ ФУНКЦИЯ С МАКСИМАЛЬНЫМ ЛОГИРОВАНИЕМ =====
  private extractWalletAddressFromTransaction(txData: any): string | null {
    console.log(`[WebhookServer] EXTRACT_WALLET_START: Analyzing transaction for wallet address`);
    
    let walletSource = '';
    let walletAddress = null;
    
    // ПРИОРИТЕТ 1: feePayer
    if (txData.feePayer) {
      walletAddress = txData.feePayer;
      walletSource = 'feePayer';
      console.log(`[WebhookServer] EXTRACT_WALLET_FEEPAYER: Found feePayer=${walletAddress}`);
    }
    // ПРИОРИТЕТ 2: accountKeys[0]
    else if (txData.transaction?.message?.accountKeys?.[0]) {
      walletAddress = txData.transaction.message.accountKeys[0];
      walletSource = 'accountKeys[0]';
      console.log(`[WebhookServer] EXTRACT_WALLET_ACCOUNT_KEYS: Found accountKeys[0]=${walletAddress}`);
    }
    // ПРИОРИТЕТ 3: preTokenBalances[0].owner (МОЖЕТ БЫТЬ ПУЛ!)
    else if (txData.meta?.preTokenBalances?.[0]?.owner) {
      walletAddress = txData.meta.preTokenBalances[0].owner;
      walletSource = 'preTokenBalances[0].owner';
      console.log(`[WebhookServer] EXTRACT_WALLET_PRE_TOKEN_BALANCE: Found preTokenBalances[0].owner=${walletAddress} - WARNING: MAY BE POOL!`);
    }
    // ПРИОРИТЕТ 4: postTokenBalances[0].owner (МОЖЕТ БЫТЬ ПУЛ!)
    else if (txData.meta?.postTokenBalances?.[0]?.owner) {
      walletAddress = txData.meta.postTokenBalances[0].owner;
      walletSource = 'postTokenBalances[0].owner';
      console.log(`[WebhookServer] EXTRACT_WALLET_POST_TOKEN_BALANCE: Found postTokenBalances[0].owner=${walletAddress} - WARNING: MAY BE POOL!`);
    }
    
    if (walletAddress) {
      console.log(`[WebhookServer] EXTRACT_WALLET_SUCCESS: source=${walletSource}, address=${walletAddress}`);
      
      // ДЕТЕКЦИЯ ИЗВЕСТНЫХ ПУЛОВ
      if (walletAddress === 'BFauTbx7qMjsz9dQJSmSraxmCD1C7x9DwJ9ynYreB1YJ') {
        console.log(`[WebhookServer] EXTRACT_WALLET_WARNING: DETECTED KNOWN POOL ADDRESS! This is AMM pool, not user wallet!`);
      }
      
      // АНАЛИЗ ВСЕХ БАЛАНСОВ ДЛЯ КОНТЕКСТА
      if (txData.meta?.preTokenBalances) {
        console.log(`[WebhookServer] EXTRACT_WALLET_CONTEXT_PRE: All preTokenBalances owners:`);
        txData.meta.preTokenBalances.forEach((balance: any, index: number) => {
          console.log(`[WebhookServer] EXTRACT_WALLET_CONTEXT_PRE_${index}: owner=${balance.owner}, mint=${balance.mint?.slice(0,8)}`);
        });
      }
      
      if (txData.meta?.postTokenBalances) {
        console.log(`[WebhookServer] EXTRACT_WALLET_CONTEXT_POST: All postTokenBalances owners:`);
        txData.meta.postTokenBalances.forEach((balance: any, index: number) => {
          console.log(`[WebhookServer] EXTRACT_WALLET_CONTEXT_POST_${index}: owner=${balance.owner}, mint=${balance.mint?.slice(0,8)}`);
        });
      }
      
      if (txData.transaction?.message?.accountKeys) {
        console.log(`[WebhookServer] EXTRACT_WALLET_CONTEXT_KEYS: All accountKeys:`);
        txData.transaction.message.accountKeys.forEach((key: any, index: number) => {
          const keyString = typeof key === 'string' ? key : key?.pubkey || key?.toString?.() || 'unknown';
          console.log(`[WebhookServer] EXTRACT_WALLET_CONTEXT_KEY_${index}: ${keyString}`);
        });
      }
    } else {
      console.log(`[WebhookServer] EXTRACT_WALLET_FAILED: No wallet address found in any source`);
    }
    
    return walletAddress;
  }

  // Обработка Smart Money свапа
  private async processSmartMoneySwap(
    balanceInfo: { walletAddress: string; inputMint: string; outputMint: string; inputAmountRaw: number; outputAmountRaw: number; },
    smartWallet: SmartMoneyWallet,
    txData: SolanaWebhookPayload
  ): Promise<void> {
    try {
      console.log(`[WebhookServer] PROCESS_SMART_MONEY_START: walletAddress=${balanceInfo.walletAddress.slice(0,8)}, inputMint=${balanceInfo.inputMint.slice(0,8)}, outputMint=${balanceInfo.outputMint.slice(0,8)}`);
      
      // ВЫЗЫВАЕМ ЕДИНЫЙ РАСЧЕТНЫЙ ЦЕНТР С ЛОГИРОВАНИЕМ
      console.log(`[WebhookServer] CALLING_UNIFIED_CALCULATOR: inputMint=${balanceInfo.inputMint}, inputAmountRaw=${balanceInfo.inputAmountRaw}, outputMint=${balanceInfo.outputMint}, outputAmountRaw=${balanceInfo.outputAmountRaw}`);
      
      const valueCalculation = await this.tokenMetadataService.calculateSwapUSDValue(
        balanceInfo.inputMint,
        balanceInfo.inputAmountRaw,
        balanceInfo.outputMint,
        balanceInfo.outputAmountRaw
      );
      
      if (!valueCalculation) {
        console.log(`[WebhookServer] UNIFIED_CALCULATOR_FILTERED: No result from calculateSwapUSDValue`);
        this.logger.debug(`[processSmartMoneySwap] IGNORED by Unified Calculator`);
        this.processingStats.unifiedCalculatorIgnored++;
        return;
      }
      
      console.log(`[WebhookServer] UNIFIED_CALCULATOR_RESULT: amountUSD=${valueCalculation.amountUSD}, swapType=${valueCalculation.swapType}, tokenAddress=${valueCalculation.tokenAddress}, paymentToken=${valueCalculation.paymentToken}, paymentTokenAmount=${valueCalculation.paymentTokenAmount}, paymentTokenPrice=${valueCalculation.paymentTokenPrice}`);
      
      // ПОЛУЧАЕМ ВСЕ ГОТОВЫЕ ДАННЫЕ ИЗ ЕДИНОГО РАСЧЕТНОГО ЦЕНТРА
      const { amountUSD, swapType, tokenAddress, paymentToken, paymentTokenAmount, paymentTokenPrice } = valueCalculation;

      // Первичный фильтр по минимальной сумме
      if (amountUSD < 700) {
        console.log(`[WebhookServer] SMART_MONEY_SMALL_TRANSACTION: amountUSD=${amountUSD} < 700, filtered out`);
        this.processingStats.filteredTransactions++;
        return;
      }

      console.log(`[WebhookServer] SMART_MONEY_LARGE_TRANSACTION: ${swapType.toUpperCase()} - ${this.tokenMetadataService.getTokenSymbol(tokenAddress)} - $${amountUSD.toFixed(0)} - processing`);

      this.processingStats.usdCalculationStats.correctCalculations++;

      // Получаем метаданные токенов
      const tokenInfo = await this.getTokenInfo(tokenAddress);
      const paymentTokenInfo = await this.getTokenInfo(paymentToken);
      
      console.log(`[WebhookServer] SMART_MONEY_TOKEN_INFO: tokenInfo.symbol=${tokenInfo.symbol}, tokenInfo.decimals=${tokenInfo.decimals}, paymentTokenInfo.symbol=${paymentTokenInfo.symbol}`);
      
      // Рассчитываем количество основного токена
      const actualTokenAmount = swapType === 'buy' ? 
        balanceInfo.outputAmountRaw / Math.pow(10, tokenInfo.decimals) :
        balanceInfo.inputAmountRaw / Math.pow(10, tokenInfo.decimals);
      
      console.log(`[WebhookServer] SMART_MONEY_ACTUAL_TOKEN_AMOUNT: swapType=${swapType}, actualTokenAmount=${actualTokenAmount}, calculation=${swapType === 'buy' ? `${balanceInfo.outputAmountRaw} / ${Math.pow(10, tokenInfo.decimals)}` : `${balanceInfo.inputAmountRaw} / ${Math.pow(10, tokenInfo.decimals)}`}`);
      
      const tokenPrice = actualTokenAmount > 0 ? amountUSD / actualTokenAmount : 0;

      // ФОРМИРУЕМ СМАРТ МАНИ СВАП
      const smartMoneySwap: SmartMoneySwap = {
        transactionId: txData.signature,
        walletAddress: smartWallet.address,
        tokenAddress: tokenAddress,
        tokenSymbol: tokenInfo.symbol,
        tokenName: tokenInfo.name,
        tokenAmount: actualTokenAmount,
        amountUSD: amountUSD,
        swapType: swapType,
        timestamp: new Date(txData.timestamp * 1000),
        category: smartWallet.category,
        usdProfit7d: smartWallet.usdProfit7d,
        winrate7d: smartWallet.winrate7d,
        buy7d: smartWallet.buy7d,
        
        tokenPrice: tokenPrice,
        paymentTokenSymbol: paymentTokenInfo.symbol,
        paymentTokenAmount: paymentTokenAmount,
        paymentTokenPrice: paymentTokenPrice,
        
        isCexListed: this.CEX_TOKENS.has(tokenAddress),
        isFamilyMember: false as const,
      };

      console.log(`[WebhookServer] SMART_MONEY_SWAP_CREATED: transactionId=${smartMoneySwap.transactionId.slice(0,12)}, walletAddress=${smartMoneySwap.walletAddress.slice(0,8)}, tokenSymbol=${smartMoneySwap.tokenSymbol}, swapType=${smartMoneySwap.swapType}, amountUSD=${smartMoneySwap.amountUSD}`);

      // Проверяем фильтры и отправляем
      if (this.shouldProcessSmartMoneySwap(smartMoneySwap, smartWallet)) {
        console.log(`[WebhookServer] SMART_MONEY_SWAP_APPROVED: proceeding with save and notify`);
        await this.saveSmartMoneyTransaction(smartMoneySwap);
        await this.sendSmartMoneyNotification(smartMoneySwap, smartWallet);
        
        this.processingStats.smartMoneyTransactions++;
        this.processingStats.profitableSwaps++;

        console.log(`[WebhookServer] SMART_MONEY_ALERT_SENT: ${smartMoneySwap.tokenSymbol} - ${smartMoneySwap.amountUSD.toFixed(0)} - ${smartMoneySwap.swapType}`);
      } else {
        console.log(`[WebhookServer] SMART_MONEY_SWAP_FILTERED: below $2000 threshold or other filter`);
        this.processingStats.filteredTransactions++;
      }

    } catch (error) {
      console.error(`[WebhookServer] PROCESS_SMART_MONEY_ERROR: ${error}`);
      this.logger.error('Error processing Smart Money swap:', error as Error);
      this.processingStats.errorCount++;
    }
  }

  private shouldProcessSmartMoneySwap(swapInfo: SmartMoneySwap, smartWallet: SmartMoneyWallet): boolean {
    const result = swapInfo.amountUSD >= 2000;
    console.log(`[WebhookServer] SHOULD_PROCESS_SMART_MONEY: amountUSD=${swapInfo.amountUSD}, threshold=2000, result=${result}`);
    return result;
  }

  private async validateSmartMoneyTransaction(
    walletAddress: string,
    tokenAddress: string,
    amountUSD: number,
    swapType: 'buy' | 'sell'
  ): Promise<{ isValid: boolean; reason?: string; riskScore: number; suspiciousFactors: string[] }> {
    
    const suspiciousFactors: string[] = [];
    let riskScore = 0;

    try {
      if (amountUSD > 500000) {
        suspiciousFactors.push('Extremely large trade');
        riskScore += 15;
      }

      const isValid = riskScore < 70;
      const reason = isValid ? undefined : `Risk score too high (${riskScore}/100)`;

      return {
        isValid,
        reason,
        riskScore,
        suspiciousFactors
      };

    } catch (error) {
      this.logger.error('Error in Smart Money validation:', error);
      return {
        isValid: true,
        riskScore: 0,
        suspiciousFactors: ['Validation error']
      };
    }
  }

  private async saveSmartMoneyTransaction(swapInfo: SmartMoneySwap): Promise<void> {
    try {
      if (!this.smDatabase || !this.telegramNotifier) return;

      await this.smDatabase.saveSmartMoneyTransaction({
        transactionId: swapInfo.transactionId,
        walletAddress: swapInfo.walletAddress,
        tokenAddress: swapInfo.tokenAddress,
        tokenSymbol: swapInfo.tokenSymbol,
        tokenName: swapInfo.tokenName,
        tokenAmount: swapInfo.tokenAmount,
        amountUSD: swapInfo.amountUSD,
        swapType: swapInfo.swapType,
        timestamp: swapInfo.timestamp,
        category: swapInfo.category,
        winrate7d: swapInfo.winrate7d,
        usdProfit7d: swapInfo.usdProfit7d,
        buy7d: swapInfo.buy7d,
        dex: 'QuickNode-Webhook-Balances'
      });

      const tokenSwap: TokenSwap = {
        transactionId: swapInfo.transactionId,
        walletAddress: swapInfo.walletAddress,
        tokenAddress: swapInfo.tokenAddress,
        tokenSymbol: swapInfo.tokenSymbol,
        tokenName: swapInfo.tokenName,
        amount: swapInfo.tokenAmount,
        amountUSD: swapInfo.amountUSD,
        timestamp: swapInfo.timestamp,
        dex: 'Smart Money Filtered',
        price: swapInfo.tokenPrice || (swapInfo.amountUSD / swapInfo.tokenAmount),
        swapType: swapInfo.swapType,
        isNewWallet: false,
        isReactivatedWallet: false,
        daysSinceLastActivity: 0,
        paymentTokenSymbol: swapInfo.paymentTokenSymbol,
        paymentTokenAmount: swapInfo.paymentTokenAmount,
        paymentTokenPrice: swapInfo.paymentTokenPrice,
        decimals: (await this.tokenMetadataService.getDecimals(swapInfo.tokenAddress)) || 9,
        actualTokenAmount: swapInfo.tokenAmount,
        rawTokenAmount: Math.floor(swapInfo.tokenAmount * Math.pow(10, 9)) // Примерный расчет
      };

      await this.database.saveTransaction(tokenSwap);

    } catch (error) {
      this.logger.error('Error saving Smart Money transaction:', error as Error);
    }
  }

  private async sendSmartMoneyNotification(swapInfo: SmartMoneySwap, smartWallet: SmartMoneyWallet): Promise<void> {
    try {
      await this.telegramNotifier.sendSmartMoneySwapAlert(swapInfo);
      this.processingStats.alertsSent++;
    } catch (error) {
      this.logger.error('Error sending Smart Money notification:', error as Error);
    }
  }

  private async getTokenInfo(tokenAddress: string): Promise<{ symbol: string; name: string; decimals: number; isCexListed: boolean }> {
    const cached = this.tokenInfoCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < 3600000) {
      return { 
        symbol: cached.symbol, 
        name: cached.name, 
        decimals: cached.decimals,
        isCexListed: cached.isCexListed || false
      };
    }

    try {
      const metadata = await this.tokenMetadataService.getTokenMetadata(tokenAddress);
      
      let symbol = 'UNKNOWN';
      let name = 'Unknown Token';
      let decimals = 9;
      const isCexListed = this.CEX_TOKENS.has(tokenAddress);
      
      if (metadata) {
        symbol = metadata.symbol || symbol;
        name = metadata.name || name;
        decimals = metadata.decimals || decimals;
      } else {
        symbol = this.tokenMetadataService.getTokenSymbol(tokenAddress);
        name = `Token ${tokenAddress.slice(0, 8)}...`;
        decimals = 9;
      }
      
      const tokenInfo = {
        symbol,
        name,
        decimals,
        isCexListed,
        timestamp: Date.now()
      };
      
      this.tokenInfoCache.set(tokenAddress, tokenInfo);
      return { symbol: tokenInfo.symbol, name: tokenInfo.name, decimals: tokenInfo.decimals, isCexListed: tokenInfo.isCexListed };

    } catch (error) {
      this.logger.error(`Error getting token info for ${tokenAddress}:`, error);
      
      const fallbackSymbol = this.tokenMetadataService.getTokenSymbol(tokenAddress);
      const fallbackName = tokenAddress ? `Token ${tokenAddress.slice(0, 8)}...` : 'Unknown Token';
      const fallbackDecimals = 9;
      const isCexListed = this.CEX_TOKENS.has(tokenAddress);
      
      this.tokenInfoCache.set(tokenAddress, {
        symbol: fallbackSymbol,
        name: fallbackName,
        decimals: fallbackDecimals,
        isCexListed,
        timestamp: Date.now()
      });

      return { symbol: fallbackSymbol, name: fallbackName, decimals: fallbackDecimals, isCexListed };
    }
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;
      
      for (const [key, value] of this.tokenInfoCache.entries()) {
        if (now - value.timestamp > ONE_HOUR) {
          this.tokenInfoCache.delete(key);
        }
      }
      
    }, 5 * 60 * 1000);
  }

  getFilteringStats(): {
    totalSwapsAnalyzed: number;
    ignoredByUnifiedCalculator: number;
    successfulCalculations: number;
    successRate: string;
    balancesExtracted: number;
    eventsIgnored: number;
  } {
    const total = this.processingStats.unifiedCalculatorIgnored + this.processingStats.usdCalculationStats.correctCalculations;
    const successful = this.processingStats.usdCalculationStats.correctCalculations;
    const successRate = total > 0 ? ((successful / total) * 100).toFixed(2) + '%' : '0%';

    return {
      totalSwapsAnalyzed: total,
      ignoredByUnifiedCalculator: this.processingStats.unifiedCalculatorIgnored,
      successfulCalculations: successful,
      successRate,
      balancesExtracted: this.processingStats.balancesExtracted,
      eventsIgnored: this.processingStats.eventsIgnored
    };
  }

  getProcessingStats(): ProcessingStats {
    return { ...this.processingStats };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          resolve();
        });

        this.server.on('error', (error: any) => {
          this.logger.error('Server error:', error);
          reject(error);
        });

      } catch (error) {
        this.logger.error('Failed to start webhook server:', error);
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}