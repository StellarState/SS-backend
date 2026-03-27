import { DataSource, Repository } from "typeorm";
import { Investment } from "../../models/Investment.model";
import { Transaction } from "../../models/Transaction.model";
import { InvestmentStatus, TransactionStatus, TransactionType } from "../../types/enums";
import { ServiceError } from "../../utils/service-error";

export interface SorobanEscrowFundingInput {
  investmentId: string;
  invoiceId: string;
  investorId: string;
  amount: string;
}

export interface SorobanEscrowFundingDraft {
  contractId: string;
  xdr: string;
  expiresAt: string;
}

export interface SorobanEscrowClient {
  prepareInvestmentFunding(
    input: SorobanEscrowFundingInput,
  ): Promise<SorobanEscrowFundingDraft>;
}

interface FundingUnitOfWork {
  findInvestmentByIdForUpdate(investmentId: string): Promise<Investment | null>;
  findTransactionByInvestmentIdForUpdate(investmentId: string): Promise<Transaction | null>;
  saveTransaction(transaction: Transaction): Promise<Transaction>;
  createTransaction(input: Partial<Transaction>): Transaction;
}

interface FundingTransactionRunner {
  runInTransaction<T>(callback: (unitOfWork: FundingUnitOfWork) => Promise<T>): Promise<T>;
}

interface InvestmentFundingReader {
  findById(investmentId: string): Promise<Investment | null>;
}

export interface OrchestrateInvestmentFundingResult {
  mode: "disabled" | "wallet_xdr";
  investmentId: string;
  invoiceId: string;
  transactionId?: string;
  xdr?: string;
  contractId?: string;
  expiresAt?: string;
  requiresReconciliation: boolean;
}

interface OrchestrateInvestmentFundingServiceDependencies {
  investmentReader: InvestmentFundingReader;
  transactionRunner: FundingTransactionRunner;
  sorobanEscrowClient: SorobanEscrowClient;
  config: {
    enabled: boolean;
    contractId: string | null;
    fundingMode: "wallet_xdr";
  };
}

export class OrchestrateInvestmentFundingService {
  constructor(
    private readonly dependencies: OrchestrateInvestmentFundingServiceDependencies,
  ) {}

  async orchestrateFunding(
    investmentId: string,
  ): Promise<OrchestrateInvestmentFundingResult> {
    const investment = await this.dependencies.investmentReader.findById(investmentId);

    if (!investment) {
      throw new ServiceError("investment_not_found", "Investment not found.", 404);
    }

    if (investment.status !== InvestmentStatus.PENDING) {
      throw new ServiceError(
        "invalid_investment_state",
        "Only pending investments can be funded.",
        409,
      );
    }

    if (!investment.invoiceId) {
      throw new ServiceError(
        "invoice_not_found",
        "Investment must be linked to an invoice before funding.",
        409,
      );
    }

    if (!this.dependencies.config.enabled) {
      return {
        mode: "disabled",
        investmentId: investment.id,
        invoiceId: investment.invoiceId,
        requiresReconciliation: false,
      };
    }

    const contractId = this.dependencies.config.contractId;

    if (!contractId) {
      throw new ServiceError(
        "soroban_contract_not_configured",
        "Soroban escrow is enabled but no contract ID is configured.",
        500,
      );
    }

    const draft = await this.dependencies.sorobanEscrowClient.prepareInvestmentFunding({
      investmentId: investment.id,
      invoiceId: investment.invoiceId,
      investorId: investment.investorId,
      amount: investment.investmentAmount,
    });

    return this.dependencies.transactionRunner.runInTransaction(async (unitOfWork) => {
      const lockedInvestment = await unitOfWork.findInvestmentByIdForUpdate(investment.id);

      if (!lockedInvestment) {
        throw new ServiceError("investment_not_found", "Investment not found.", 404);
      }

      const existingTransaction = await unitOfWork.findTransactionByInvestmentIdForUpdate(
        lockedInvestment.id,
      );

      const transaction =
        existingTransaction ??
        unitOfWork.createTransaction({
          userId: lockedInvestment.investorId,
          invoiceId: lockedInvestment.invoiceId,
          investmentId: lockedInvestment.id,
          type: TransactionType.INVESTMENT,
          amount: lockedInvestment.investmentAmount,
          status: TransactionStatus.PENDING,
        });

      transaction.userId = lockedInvestment.investorId;
      transaction.invoiceId = lockedInvestment.invoiceId;
      transaction.investmentId = lockedInvestment.id;
      transaction.type = TransactionType.INVESTMENT;
      transaction.amount = lockedInvestment.investmentAmount;
      transaction.status = TransactionStatus.PENDING;

      const savedTransaction = await unitOfWork.saveTransaction(transaction);

      return {
        mode: "wallet_xdr" as const,
        investmentId: lockedInvestment.id,
        invoiceId: lockedInvestment.invoiceId,
        transactionId: savedTransaction.id,
        xdr: draft.xdr,
        contractId,
        expiresAt: draft.expiresAt,
        requiresReconciliation: true,
      };
    });
  }
}

class TypeOrmInvestmentFundingReader implements InvestmentFundingReader {
  constructor(private readonly repository: Repository<Investment>) {}

  findById(investmentId: string): Promise<Investment | null> {
    return this.repository.findOne({
      where: { id: investmentId },
    });
  }
}

class TypeOrmFundingTransactionRunner implements FundingTransactionRunner {
  constructor(private readonly dataSource: DataSource) {}

  runInTransaction<T>(callback: (unitOfWork: FundingUnitOfWork) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) =>
      callback({
        findInvestmentByIdForUpdate: (investmentId: string) =>
          manager.getRepository(Investment).findOne({
            where: { id: investmentId },
          }),
        findTransactionByInvestmentIdForUpdate: (investmentId: string) =>
          manager.getRepository(Transaction).findOne({
            where: {
              investmentId,
              type: TransactionType.INVESTMENT,
            },
            order: {
              timestamp: "DESC",
            },
          }),
        saveTransaction: (transaction: Transaction) =>
          manager.getRepository(Transaction).save(transaction),
        createTransaction: (input: Partial<Transaction>) =>
          manager.getRepository(Transaction).create(input),
      }),
    );
  }
}

export function createOrchestrateInvestmentFundingService(
  dataSource: DataSource,
  sorobanEscrowClient: SorobanEscrowClient,
  config: OrchestrateInvestmentFundingServiceDependencies["config"],
): OrchestrateInvestmentFundingService {
  return new OrchestrateInvestmentFundingService({
    investmentReader: new TypeOrmInvestmentFundingReader(
      dataSource.getRepository(Investment),
    ),
    transactionRunner: new TypeOrmFundingTransactionRunner(dataSource),
    sorobanEscrowClient,
    config,
  });
}
