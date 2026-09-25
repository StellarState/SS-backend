import { DataSource } from "typeorm";
import { ServiceError } from "../utils/service-error";
import { logger } from "../observability/logger";

export interface GetTransactionHistoryOptions {
  userId: string;
  types?: string[]; // invest, claim, list, cancel, settle, buyback
  cursor?: string;
  limit?: number;
}

export interface WalletTransaction {
  id: string;
  amount: string;
  type: string;
  entityId: string;
  timestamp: Date;
  stellarTxHash: string | null;
}

export interface TransactionHistoryResult {
  data: WalletTransaction[];
  total: number;
  nextCursor: string | null;
}

export class TransactionService {
  constructor(private readonly dataSource: DataSource) {}

  async getWalletHistory(options: GetTransactionHistoryOptions): Promise<TransactionHistoryResult> {
    try {
      const { userId, types, cursor, limit = 20 } = options;

      if (!userId) {
        throw new ServiceError("invalid_input", "User ID is required", 400);
      }

      const take = Math.max(1, Math.min(limit, 100));

      // Parse cursor
      let cursorTimestamp: Date | null = null;
      let cursorId: string | null = null;

      if (cursor) {
        try {
          const decoded = Buffer.from(cursor, "base64").toString("utf-8");
          const [ts, id] = decoded.split("_");
          if (ts && id) {
            cursorTimestamp = new Date(ts);
            cursorId = id;
          }
        } catch (e) {
          throw new ServiceError("invalid_cursor", "Invalid cursor format", 400);
        }
      }

      // Allowed requested types map safely
      const validTypes = ["invest", "claim", "list", "cancel", "settle", "buyback"];
      let queryTypes = types?.filter(t => validTypes.includes(t)) || validTypes;
      if (queryTypes.length === 0) {
        queryTypes = validTypes; // fallback to all
      }

      const parameters: any[] = [userId];
      let paramIdx = 2; // $1 is userId

      // Build the UNION query
      const unionParts: string[] = [];

      // 1. invest
      if (queryTypes.includes("invest")) {
        unionParts.push(`
          SELECT id, amount::text, 'invest' as type, COALESCE(investment_id, invoice_id) as entity_id, timestamp, stellar_tx_hash
          FROM transactions
          WHERE user_id = $1 AND type = 'investment'
        `);
      }

      // 2. claim
      if (queryTypes.includes("claim")) {
        unionParts.push(`
          SELECT id, amount::text, 'claim' as type, COALESCE(investment_id, invoice_id) as entity_id, timestamp, stellar_tx_hash
          FROM transactions
          WHERE user_id = $1 AND type IN ('payment', 'withdrawal', 'refund')
        `);
      }

      // 3. list
      if (queryTypes.includes("list")) {
        unionParts.push(`
          SELECT h.id, i.amount::text, 'list' as type, i.id as entity_id, h.created_at as timestamp, NULL as stellar_tx_hash
          FROM invoice_status_history h
          JOIN invoices i ON h.invoice_id = i.id
          WHERE h.actor_id = $1::varchar AND h.to_status = 'published'
        `);
      }

      // 4. cancel
      if (queryTypes.includes("cancel")) {
        unionParts.push(`
          SELECT h.id, i.amount::text, 'cancel' as type, i.id as entity_id, h.created_at as timestamp, NULL as stellar_tx_hash
          FROM invoice_status_history h
          JOIN invoices i ON h.invoice_id = i.id
          WHERE h.actor_id = $1::varchar AND h.to_status = 'cancelled'
        `);
      }

      // 5. settle
      if (queryTypes.includes("settle")) {
        // Here actor_id might be admin or system. If we want it for the wallet, 
        // we can find invoices owned by the user that transitioned to settled.
        unionParts.push(`
          SELECT h.id, i.amount::text, 'settle' as type, i.id as entity_id, h.created_at as timestamp, i.smart_contract_id as stellar_tx_hash
          FROM invoice_status_history h
          JOIN invoices i ON h.invoice_id = i.id
          WHERE i.seller_id = $1::uuid AND h.to_status = 'settled'
        `);
      }

      // 6. buyback (currently returning empty, built for future compatibility)
      if (queryTypes.includes("buyback")) {
        // Dummy block to fulfill type, returning 0 rows
        unionParts.push(`
          SELECT h.id, i.amount::text, 'buyback' as type, i.id as entity_id, h.created_at as timestamp, NULL as stellar_tx_hash
          FROM invoice_status_history h
          JOIN invoices i ON h.invoice_id = i.id
          WHERE 1=0
        `);
      }

      if (unionParts.length === 0) {
        return { data: [], total: 0, nextCursor: null };
      }

      const combinedQuery = unionParts.join("\nUNION ALL\n");

      // Count query
      const countSql = `SELECT COUNT(*) as total FROM (${combinedQuery}) as c`;
      const countResult = await this.dataSource.query(countSql, [userId]);
      const total = parseInt(countResult[0]?.total || "0", 10);

      // Main query
      let mainSql = `SELECT * FROM (${combinedQuery}) as combined`;
      
      const conditions: string[] = [];
      if (cursorTimestamp && cursorId) {
        conditions.push(`(timestamp < $${paramIdx} OR (timestamp = $${paramIdx} AND id < $${paramIdx + 1}))`);
        parameters.push(cursorTimestamp, cursorId);
        paramIdx += 2;
      }

      if (conditions.length > 0) {
        mainSql += ` WHERE ${conditions.join(" AND ")}`;
      }

      mainSql += ` ORDER BY timestamp DESC, id DESC LIMIT $${paramIdx}`;
      parameters.push(take + 1); // fetch one extra for cursor

      const rows: any[] = await this.dataSource.query(mainSql, parameters);

      let nextCursor: string | null = null;
      const data = rows.slice(0, take).map((row) => ({
        id: row.id,
        amount: row.amount,
        type: row.type,
        entityId: row.entity_id,
        timestamp: row.timestamp,
        stellarTxHash: row.stellar_tx_hash || null,
      }));

      if (rows.length > take) {
        const lastRow = data[data.length - 1];
        nextCursor = Buffer.from(`${lastRow.timestamp.toISOString()}_${lastRow.id}`).toString("base64");
      }

      return {
        data,
        total,
        nextCursor,
      };

    } catch (error) {
      if (error instanceof ServiceError) throw error;
      logger.error("Failed to fetch transaction history", { error, userId: options.userId });
      throw new ServiceError("fetch_transactions_failed", "Failed to fetch transaction history", 500);
    }
  }
}

export function createTransactionService(dataSource: DataSource): TransactionService {
  return new TransactionService(dataSource);
}
