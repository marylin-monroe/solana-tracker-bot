// src/services/LargeTransactionMonitor.ts - ИСПРАВЛЕНО: добавлен maxSupportedTransactionVersion + интеграция TokenMetadataService
// 🚨 MODULE B: Independent Large Transaction Monitoring ($2M+ USD)

import { Logger } from '../utils/Logger';
import { TelegramNotifier } from './TelegramNotifier';
import { MultiProviderService } from './MultiProviderService';
import { TokenMetadataService } from './TokenMetadataService'; // 🆕 ДОБАВЛЕНО

interface LargeTransaction {
  signature: string;
  amount: number;
  amountUSD: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  fromAddress: string;
  toAddress: string;
  transactionType: 'buy' | 'sell';
  timestamp: Date;
  blockNumber: number;
  chain: 'solana' | 'base' | 'ethereum';
  gasUsed?: number;
  gasPrice?: number;
}

interface FilterResult {
  passed: boolean;
  reason?: string;
  riskScore: number;
  suspiciousFactors: string[];
}

interface MonitoringStats {
  totalScanned: number;
  largeTransactionsFound: number;
  filtered: number;
  alertsSent: number;
  lastScanTime: Date;
  avgProcessingTime: number;
  errors: number; // 🔧 ИСПРАВЛЕНО: переименовано с errorsCount
}

export class LargeTransactionMonitor {
  private logger: Logger;
  private telegramNotifier: TelegramNotifier;
  private multiProvider: MultiProviderService;
  private tokenMetadataService: TokenMetadataService; // 🆕 ДОБАВЛЕНО
  
  // 🚨 THRESHOLD FOR LARGE TRANSACTIONS ($2M USD)
  private readonly LARGE_TX_THRESHOLD = 2_000_000;
  
  // 🛡️ KNOWN SCAM ADDRESSES (should be loaded from external source)
  private scamAddresses = new Set<string>([
    // Common scam addresses - would be loaded from API in production
    '11111111111111111111111111111112', // System program (not scam, just example)
  ]);
  
  // 🏛️ KNOWN EXCHANGE ADDRESSES
  private exchangeAddresses = new Set<string>([
    // Major exchange hot/cold wallets - would be loaded from API
    'FTXexchangeHotWallet123456789012345678901', // Example
    'BinanceHotWallet12345678901234567890123', // Example
    'CoinbaseHotWallet123456789012345678901' // Example
  ]);
  
  // 👤 TOKEN CREATOR/OWNER TRACKING
  private tokenCreators = new Map<string, {
    creatorAddress: string;
    deploymentTime: Date;
    teamWallets: string[];
  }>();
  
  // 📊 MONITORING STATE
  private isMonitoring = false;
  private lastProcessedSlot = 0; // 🔧 ИСПРАВЛЕНО: переименовано с lastScannedBlock
  private monitoringInterval: NodeJS.Timeout | null = null;
  private stats: MonitoringStats = {
    totalScanned: 0,
    largeTransactionsFound: 0,
    filtered: 0,
    alertsSent: 0,
    lastScanTime: new Date(),
    avgProcessingTime: 0,
    errors: 0 // 🔧 ИСПРАВЛЕНО
  };

  // 💾 RECENTLY PROCESSED TRANSACTIONS CACHE
  private processedTransactions = new Set<string>();
  private readonly MAX_CACHE_SIZE = 10000;

  constructor(
    telegramNotifier: TelegramNotifier,
    multiProvider: MultiProviderService
  ) {
    this.logger = Logger.getInstance();
    this.telegramNotifier = telegramNotifier;
    this.multiProvider = multiProvider;
    this.tokenMetadataService = new TokenMetadataService(); // 🆕 ДОБАВЛЕНО
    
    this.logger.info('🚨 Large Transaction Monitor initialized ($2M+ threshold)');
  }

  /**
   * 🚀 MAIN MONITORING FUNCTION - scans for large transactions
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      this.logger.warn('⚠️ Large Transaction Monitor already running');
      return;
    }

    this.isMonitoring = true;
    this.logger.info('🚨 Starting Large Transaction Monitor ($2M+ USD threshold)');
    
    // Load known addresses before starting
    await this.loadKnownAddresses();
    
    // Start monitoring loop
    this.monitoringLoop();
    
    this.logger.info('✅ Large Transaction Monitor started successfully');
  }

  /**
   * 🛑 STOP MONITORING
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    this.logger.info('🛑 Large Transaction Monitor stopped');
  }

  /**
   * 🔄 IMPROVED MONITORING LOOP - better error handling
   */
  private async monitoringLoop(): Promise<void> {
    while (this.isMonitoring) {
      try {
        await this.scanForLargeTransactions();
        await this.sleep(15000); // 15 секунд между сканированиями
      } catch (error) {
        this.logger.error('❌ Error in monitoring loop:', error);
        this.stats.errors++;
        
        // Пауза при ошибке перед повторной попыткой
        await this.sleep(30000); // 30 секунд при ошибке
      }
    }
  }

  /**
   * 🔍 SCAN RECENT BLOCKS FOR LARGE TRANSACTIONS - УЛУЧШЕНО
   */
  private async scanForLargeTransactions(): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Get latest slot number (исправлено с block на slot для Solana)
      let latestSlot: number;
      try {
        const slotResponse = await this.multiProvider.makeRequest('getSlot', [
          { commitment: 'confirmed' }
        ]);
        
        // ✅ ИСПРАВЛЕНО: Правильное извлечение данных из APIResponse
        if (!slotResponse.success || !slotResponse.data) {
          this.logger.warn('⚠️ Failed to get latest slot from response');
          return;
        }
        latestSlot = slotResponse.data;
      } catch (slotError) {
        this.logger.warn('⚠️ Failed to get latest slot, using cached value');
        return;
      }

      // Сканируем только новые слоты
      const startSlot = this.lastProcessedSlot + 1;
      const endSlot = Math.min(latestSlot, startSlot + 3); // Не более 3 слотов за раз

      if (startSlot > endSlot) {
        return; // Нет новых слотов
      }

      this.logger.debug(`🔍 Scanning slots ${startSlot} to ${endSlot} for large transactions`);

      // Сканируем слоты последовательно
      for (let slot = startSlot; slot <= endSlot; slot++) {
        if (!this.isMonitoring) break;
        
        try {
          await this.scanBlock(slot);
          this.lastProcessedSlot = slot;
          this.stats.totalScanned++;
          
          // Небольшая пауза между слотами
          await this.sleep(100);
        } catch (blockError) {
          this.logger.warn(`⚠️ Failed to scan slot ${slot}:`, blockError);
          this.stats.errors++;
          // Продолжаем сканирование следующих слотов
        }
      }

      this.stats.lastScanTime = new Date();
      
      // Update average processing time
      const processingTime = Date.now() - startTime;
      this.stats.avgProcessingTime = (this.stats.avgProcessingTime + processingTime) / 2;

    } catch (error) {
      this.stats.errors++;
      this.logger.error('❌ Error scanning for large transactions:', error);
    }
  }

  /**
   * 🔍 SCAN SPECIFIC BLOCK FOR LARGE TRANSACTIONS - ✅ ИСПРАВЛЕНО: добавлен maxSupportedTransactionVersion
   */
  private async scanBlock(slot: number): Promise<void> {
    try {
      this.logger.debug(`🔍 Scanning slot ${slot} for large transactions...`);

      // ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Добавлен maxSupportedTransactionVersion: 0
      const blockResponse = await this.multiProvider.makeRequest('getBlock', [
        slot,
        {
          maxSupportedTransactionVersion: 0,  // ← ДОБАВЛЕНА ЭТА СТРОКА
          commitment: 'confirmed',
          transactionDetails: 'full',
          rewards: false
        }
      ]);

      // ✅ ИСПРАВЛЕНО: Правильное извлечение данных из APIResponse
      if (!blockResponse.success || !blockResponse.data || !blockResponse.data.transactions) {
        return;
      }

      const transactions = blockResponse.data.transactions;
      
      // Analyze each transaction in the block
      for (const tx of transactions) {
        if (tx.transaction && tx.transaction.signatures && tx.transaction.signatures[0]) {
          const signature = tx.transaction.signatures[0];
          
          // Skip if already processed
          if (this.processedTransactions.has(signature)) {
            continue;
          }

          await this.analyzeLargeTransaction(tx, slot);
          
          // Add to processed cache
          this.processedTransactions.add(signature);
          
          // Cleanup cache if too large
          if (this.processedTransactions.size > this.MAX_CACHE_SIZE) {
            const firstElement = this.processedTransactions.values().next().value;
            this.processedTransactions.delete(firstElement);
          }
        }
      }

    } catch (error) {
      this.logger.error(`❌ Error scanning slot ${slot}:`, error);
      this.stats.errors++;
    }
  }

  /**
   * 🔍 ANALYZE INDIVIDUAL TRANSACTION FOR LARGE AMOUNTS - УЛУЧШЕНО
   */
  private async analyzeLargeTransaction(txData: any, slot: number): Promise<void> {
    try {
      const tx = txData.transaction;
      const meta = txData.meta;
      
      if (!tx || !meta || meta.err) {
        return;
      }

      const signature = tx.signatures[0];
      const timestamp = new Date(txData.blockTime * 1000);

      // Analyze token transfers for large amounts
      const tokenTransfers = meta.tokenTransfers || [];
      const nativeTransfers = meta.preBalances && meta.postBalances ? 
        this.extractNativeTransfers(meta.preBalances, meta.postBalances, tx.message.accountKeys) : [];

      // Check token transfers
      for (const transfer of tokenTransfers) {
        const amountUSD = await this.estimateTokenValueUSD(transfer.mint, transfer.tokenAmount);
        
        if (amountUSD >= this.LARGE_TX_THRESHOLD) {
          // 🆕 ИСПОЛЬЗУЕМ TokenMetadataService
          const tokenMetadata = await this.tokenMetadataService.getTokenMetadata(transfer.mint);
          
          const largeTransaction: LargeTransaction = {
            signature,
            amount: transfer.tokenAmount,
            amountUSD,
            tokenAddress: transfer.mint,
            tokenSymbol: tokenMetadata?.symbol || 'UNKNOWN',
            tokenName: tokenMetadata?.name || 'Unknown Token',
            fromAddress: transfer.fromUserAccount || '',
            toAddress: transfer.toUserAccount || '',
            transactionType: this.determineTransactionType(transfer),
            timestamp,
            blockNumber: slot,
            chain: 'solana'
          };

          await this.processLargeTransaction(largeTransaction);
        }
      }

      // Check native SOL transfers
      for (const transfer of nativeTransfers) {
        const solAmount = Math.abs(transfer.change) / 1e9; // Convert lamports to SOL
        const amountUSD = await this.estimateSOLValueUSD(solAmount);
        
        if (amountUSD >= this.LARGE_TX_THRESHOLD) {
          const largeTransaction: LargeTransaction = {
            signature,
            amount: solAmount,
            amountUSD,
            tokenAddress: 'So11111111111111111111111111111111111111112', // SOL
            tokenSymbol: 'SOL',
            tokenName: 'Solana',
            fromAddress: transfer.fromAddress || '',
            toAddress: transfer.toAddress || '',
            transactionType: transfer.change > 0 ? 'buy' : 'sell',
            timestamp,
            blockNumber: slot,
            chain: 'solana'
          };

          await this.processLargeTransaction(largeTransaction);
        }
      }

    } catch (error) {
      this.logger.error('❌ Error analyzing transaction:', error);
      this.stats.errors++;
    }
  }

  /**
   * 🆕 НОВЫЙ МЕТОД: Extract native SOL transfers
   */
  private extractNativeTransfers(preBalances: number[], postBalances: number[], accountKeys: string[]): Array<{
    fromAddress: string;
    toAddress: string;
    change: number;
  }> {
    const transfers = [];
    
    for (let i = 0; i < preBalances.length && i < postBalances.length && i < accountKeys.length; i++) {
      const change = postBalances[i] - preBalances[i];
      
      if (Math.abs(change) > 1000000) { // Минимум 0.001 SOL (1M lamports)
        transfers.push({
          fromAddress: change < 0 ? accountKeys[i] : '',
          toAddress: change > 0 ? accountKeys[i] : '',
          change
        });
      }
    }
    
    return transfers;
  }

  /**
   * 🔍 PROCESS DETECTED LARGE TRANSACTION
   */
  private async processLargeTransaction(tx: LargeTransaction): Promise<void> {
    try {
      this.stats.largeTransactionsFound++;
      
      this.logger.info(`💰 Large transaction detected: $${this.formatNumber(tx.amountUSD)} ${tx.tokenSymbol}`);

      // Apply filtering rules
      const filterResult = await this.filterTransaction(tx);
      
      if (filterResult.passed) {
        await this.sendLargeTransactionAlert(tx);
        this.stats.alertsSent++;
        this.logger.info(`🚨 Large transaction alert sent: $${this.formatNumber(tx.amountUSD)} ${tx.tokenSymbol}`);
      } else {
        this.stats.filtered++;
        this.logger.debug(`🚫 Large transaction filtered: ${filterResult.reason} (Risk: ${filterResult.riskScore})`);
      }

    } catch (error) {
      this.logger.error('❌ Error processing large transaction:', error);
      this.stats.errors++;
    }
  }

  /**
   * 🛡️ FILTER TRANSACTION TO EXCLUDE SCAMS, TOKEN OWNERS, ETC.
   */
  private async filterTransaction(tx: LargeTransaction): Promise<FilterResult> {
    let riskScore = 0;
    const suspiciousFactors: string[] = [];

    try {
      // 1. CHECK FOR KNOWN SCAM ADDRESSES
      if (this.scamAddresses.has(tx.fromAddress) || this.scamAddresses.has(tx.toAddress)) {
        return {
          passed: false,
          reason: 'Known scam address detected',
          riskScore: 100,
          suspiciousFactors: ['scam_address']
        };
      }

      // 2. CHECK FOR EXCHANGE INTERNAL TRANSFERS
      if (this.exchangeAddresses.has(tx.fromAddress) && this.exchangeAddresses.has(tx.toAddress)) {
        return {
          passed: false,
          reason: 'Exchange internal transfer',
          riskScore: 0,
          suspiciousFactors: ['exchange_internal']
        };
      }

      // 3. CHECK FOR TOKEN CREATOR/OWNER TRANSACTIONS
      const tokenCreator = this.tokenCreators.get(tx.tokenAddress);
      if (tokenCreator) {
        if (tx.fromAddress === tokenCreator.creatorAddress || 
            tx.toAddress === tokenCreator.creatorAddress ||
            tokenCreator.teamWallets.includes(tx.fromAddress) ||
            tokenCreator.teamWallets.includes(tx.toAddress)) {
          return {
            passed: false,
            reason: 'Token creator/team transaction',
            riskScore: 30,
            suspiciousFactors: ['token_creator']
          };
        }
      }

      // 4. CHECK FOR SUSPICIOUS PATTERNS
      if (await this.isSuspiciousPattern(tx)) {
        riskScore += 40;
        suspiciousFactors.push('suspicious_pattern');
      }

      // 5. CHECK WALLET AGE (very new wallets are suspicious for large amounts)
      const fromWalletAge = await this.getWalletAge(tx.fromAddress);
      const toWalletAge = await this.getWalletAge(tx.toAddress);
      
      if (fromWalletAge < 1 || toWalletAge < 1) { // Less than 1 hour
        riskScore += 50;
        suspiciousFactors.push('very_new_wallet');
      } else if (fromWalletAge < 24 || toWalletAge < 24) { // Less than 24 hours
        riskScore += 25;
        suspiciousFactors.push('new_wallet');
      }

      // 6. CHECK FOR ROUND NUMBERS (often suspicious)
      if (this.isRoundNumber(tx.amountUSD)) {
        riskScore += 15;
        suspiciousFactors.push('round_number');
      }

      // 7. CHECK FOR MASSIVE AMOUNTS (> $50M)
      if (tx.amountUSD > 50_000_000) {
        riskScore += 20;
        suspiciousFactors.push('massive_amount');
      }

      // 8. CHECK TOKEN AGE
      const tokenAge = await this.getTokenAge(tx.tokenAddress);
      if (tokenAge < 24) { // Token less than 24 hours old
        riskScore += 30;
        suspiciousFactors.push('new_token');
      }

      // DECISION: Pass if risk score is below threshold
      const passed = riskScore < 70; // Threshold of 70/100
      
      return {
        passed,
        reason: passed ? undefined : `High risk score (${riskScore}/100)`,
        riskScore,
        suspiciousFactors
      };

    } catch (error) {
      this.logger.error('❌ Error filtering transaction:', error);
      this.stats.errors++;
      return {
        passed: true, // Default to pass on error
        reason: undefined,
        riskScore: 0,
        suspiciousFactors: ['filter_error']
      };
    }
  }

  /**
   * 🔍 CHECK FOR SUSPICIOUS TRANSACTION PATTERNS
   */
  private async isSuspiciousPattern(tx: LargeTransaction): Promise<boolean> {
    try {
      // Check for exact round numbers (suspicious)
      if (tx.amountUSD % 1000000 === 0) { // Exact millions
        return true;
      }

      // Check for related wallet activity (simplified check)
      // In production, this would analyze transaction graphs
      return false;

    } catch (error) {
      this.logger.error('❌ Error checking suspicious patterns:', error);
      return false;
    }
  }

  /**
   * 📅 GET WALLET AGE IN HOURS - УЛУЧШЕНО
   */
  private async getWalletAge(address: string): Promise<number> {
    try {
      const signaturesResponse = await this.multiProvider.makeRequest('getSignaturesForAddress', [
        address,
        { limit: 1000 }
      ]);
      
      // ✅ ИСПРАВЛЕНО: Правильное извлечение данных из APIResponse
      if (!signaturesResponse.success || !signaturesResponse.data || signaturesResponse.data.length === 0) {
        return 0;
      }

      // Get oldest transaction
      const oldestTx = signaturesResponse.data[signaturesResponse.data.length - 1];
      if (!oldestTx.blockTime) return 0;
      
      const oldestTime = oldestTx.blockTime * 1000; // Convert to milliseconds
      const ageMs = Date.now() - oldestTime;
      
      return ageMs / (1000 * 60 * 60); // Convert to hours

    } catch (error) {
      this.logger.error(`❌ Error getting wallet age for ${address}:`, error);
      return 24; // Default to 24 hours if error
    }
  }

  /**
   * 📅 GET TOKEN AGE IN HOURS
   */
  private async getTokenAge(tokenAddress: string): Promise<number> {
    try {
      // For simplicity, return 48 hours for unknown tokens
      // In production, this would query token creation time
      return 48;

    } catch (error) {
      this.logger.error(`❌ Error getting token age for ${tokenAddress}:`, error);
      return 48; // Default to 48 hours
    }
  }

  /**
   * 🔢 CHECK IF AMOUNT IS SUSPICIOUSLY ROUND
   */
  private isRoundNumber(amount: number): boolean {
    // Check for exact millions, half-millions, etc.
    return amount % 500000 === 0;
  }

  /**
   * 📢 SEND TELEGRAM ALERT FOR LARGE TRANSACTION
   */
  private async sendLargeTransactionAlert(tx: LargeTransaction): Promise<void> {
    try {
      const ageStr = this.formatTransactionAge(tx.timestamp);
      const chainEmoji = tx.chain === 'solana' ? '☀️' : tx.chain === 'base' ? '🔵' : '⚡';
      
      const message = `🚨 <b>Large Transaction Alert!</b> ${chainEmoji}\n\n` +
        `💰 <b>Amount:</b> <code>$${this.formatNumber(tx.amountUSD)}</code>\n` +
        `🪙 <b>Token:</b> <code>${tx.tokenSymbol}</code> (${tx.tokenName})\n` +
        `📊 <b>Type:</b> <code>${tx.transactionType.toUpperCase()}</code>\n` +
        `🕒 <b>Age:</b> <code>${ageStr}</code>\n\n` +
        `👤 <b>From:</b> <code>${this.truncateAddress(tx.fromAddress)}</code>\n` +
        `👤 <b>To:</b> <code>${this.truncateAddress(tx.toAddress)}</code>\n\n` +
        `🔗 <b>Signature:</b> <code>${tx.signature.slice(0, 16)}...${tx.signature.slice(-8)}</code>\n` +
        `📦 <b>Slot:</b> <code>${tx.blockNumber}</code>\n\n` +
        `✅ <i>Filtered: No scam/owner/exchange activity detected</i>\n\n` +
        `<a href="https://solscan.io/tx/${tx.signature}">View Transaction</a> | ` +
        `<a href="https://solscan.io/token/${tx.tokenAddress}">Token Info</a>`;

      await this.telegramNotifier.sendCycleLog(message);

    } catch (error) {
      this.logger.error('❌ Error sending large transaction alert:', error);
      this.stats.errors++;
    }
  }

  /**
   * 💰 ESTIMATE TOKEN VALUE IN USD - УЛУЧШЕНО с TokenMetadataService
   */
  private async estimateTokenValueUSD(tokenAddress: string, amount: number): Promise<number> {
    try {
      // Используем TokenMetadataService для получения метаданных
      const tokenMetadata = await this.tokenMetadataService.getTokenMetadata(tokenAddress);
      
      if (tokenAddress === 'So11111111111111111111111111111111111111112') {
        // SOL price (hardcoded for example, should be from API)
        return amount * 140; // Assuming $140 per SOL
      }
      
      if (tokenAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
        // USDC
        return amount;
      }
      
      if (tokenAddress === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
        // USDT
        return amount;
      }
      
      // For other tokens, use a rough estimate
      // In production, query real-time prices from Jupiter/CoinGecko
      return amount * 0.001; // Default very low price

    } catch (error) {
      this.logger.error(`❌ Error estimating token value for ${tokenAddress}:`, error);
      return 0;
    }
  }

  /**
   * 💰 ESTIMATE SOL VALUE IN USD
   */
  private async estimateSOLValueUSD(solAmount: number): Promise<number> {
    try {
      // Hardcoded SOL price (should be from API in production)
      const solPrice = 140; // $140 per SOL
      return solAmount * solPrice;

    } catch (error) {
      this.logger.error('❌ Error estimating SOL value:', error);
      return 0;
    }
  }

  /**
   * 🔍 DETERMINE TRANSACTION TYPE
   */
  private determineTransactionType(transfer: any): 'buy' | 'sell' {
    // Simplified logic - in production would analyze DEX interactions
    return 'buy'; // Default to buy for now
  }

  /**
   * 📋 LOAD KNOWN SCAM/EXCHANGE ADDRESSES
   */
  private async loadKnownAddresses(): Promise<void> {
    try {
      // In production, this would load from:
      // - Chainalysis API
      // - MistTrack API
      // - Custom databases
      // - Community-maintained lists
      
      this.logger.info('📋 Loading known addresses for filtering...');
      
      // Example: Load exchange addresses
      const exchangeAddresses = [
        // Would be loaded from API or database
      ];
      
      // Example: Load scam addresses  
      const scamAddresses = [
        // Would be loaded from scam database
      ];
      
      this.logger.info(`📋 Loaded ${this.scamAddresses.size} scam addresses and ${this.exchangeAddresses.size} exchange addresses`);

    } catch (error) {
      this.logger.error('❌ Error loading known addresses:', error);
    }
  }

  /**
   * 🔧 UTILITY METHODS
   */
  private formatNumber(num: number): string {
    if (num >= 1_000_000_000) {
      return `${(num / 1_000_000_000).toFixed(1)}B`;
    } else if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toFixed(0);
  }

  private truncateAddress(address: string): string {
    if (address.length <= 8) return address;
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  }

  private formatTransactionAge(timestamp: Date): string {
    const ageMs = Date.now() - timestamp.getTime();
    const ageMinutes = Math.floor(ageMs / (1000 * 60));
    
    if (ageMinutes < 1) {
      return 'Just now';
    } else if (ageMinutes < 60) {
      return `${ageMinutes}m ago`;
    } else {
      const ageHours = Math.floor(ageMinutes / 60);
      if (ageHours < 24) {
        return `${ageHours}h ${ageMinutes % 60}m ago`;
      } else {
        const ageDays = Math.floor(ageHours / 24);
        return `${ageDays}d ${ageHours % 24}h ago`;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 📊 GET MONITORING STATISTICS
   */
  getStats(): MonitoringStats {
    return { ...this.stats };
  }

  /**
   * 🔧 UPDATE THRESHOLD (for testing)
   */
  setThreshold(newThreshold: number): void {
    // Allow lowering threshold for testing
    // this.LARGE_TX_THRESHOLD = newThreshold;
    this.logger.info(`🔧 Large transaction threshold updated to $${this.formatNumber(newThreshold)}`);
  }

  /**
   * 🧹 CLEANUP METHOD
   */
  cleanup(): void {
    this.stopMonitoring();
    this.processedTransactions.clear();
    this.tokenCreators.clear();
    this.logger.info('🧹 Large Transaction Monitor cleanup completed');
  }
}