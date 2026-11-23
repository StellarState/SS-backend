import Decimal from "decimal.js";
import { DataSource, Repository } from "typeorm";
import { RoyaltyEvent } from "../models/RoyaltyEvent.model";
import { AppError } from "../utils/http-error";

export interface StatementOptions {
  limit?: number;
  cursor?: string | null;
  cycleFrom?: string;
  cycleTo?: string;
  keyAddress?: string;
  revision?: number;
}
interface StatementCursor {
  sequence: string;
  watermark: string;
  scope: string;
}

export interface RoyaltyStatementRow {
  id: string;
  cycleId: string | null;
  cycleAt: string | null;
  revision: number;
  keyAddress: string;
  gross: string;
  platformFee: string;
  net: string;
  txHash: string | null;
  paidAt: string | null;
}

export function statementTotals(rows: RoyaltyStatementRow[]) {
  const sum = (field: "gross" | "platformFee" | "net") =>
    rows.reduce((total, r) => total.plus(r[field]), new Decimal(0)).toFixed(4);
  return { gross: sum("gross"), platformFee: sum("platformFee"), net: sum("net") };
}

/** Statements sort on an immutable database sequence rather than mutable payment dates. */
export class RoyaltyStatementsService {
  constructor(private readonly dataSource: DataSource) {}

  private normalize(wallet: string, options: StatementOptions) {
    const from = options.cycleFrom ? new Date(options.cycleFrom) : null;
    const to = options.cycleTo ? new Date(options.cycleTo) : null;
    if (
      (from && Number.isNaN(from.getTime())) ||
      (to && Number.isNaN(to.getTime())) ||
      (from && to && from > to)
    ) {
      throw new AppError(400, "Invalid cycle date range", "INVALID_CYCLE_RANGE");
    }
    if (
      options.revision !== undefined &&
      (!Number.isSafeInteger(options.revision) || options.revision < 1)
    )
      throw new AppError(400, "Invalid revision", "INVALID_REVISION");
    const scope = JSON.stringify([
      wallet,
      from?.toISOString() ?? null,
      to?.toISOString() ?? null,
      options.keyAddress ?? null,
      options.revision ?? null,
    ]);
    let cursor: StatementCursor | null = null;
    if (options.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString());
        if (
          !cursor ||
          cursor.scope !== scope ||
          !/^\d+$/.test(cursor.sequence) ||
          !/^\d+$/.test(cursor.watermark) ||
          BigInt(cursor.sequence) > BigInt(cursor.watermark)
        )
          throw new Error();
      } catch {
        throw new AppError(400, "Cursor does not match statement filters", "INVALID_CURSOR");
      }
    }
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError(400, "Limit must be between 1 and 100", "INVALID_LIMIT");
    return { from, to, scope, cursor, limit };
  }

  private query(repo: Repository<RoyaltyEvent>, wallet: string, options: StatementOptions) {
    const normalized = this.normalize(wallet, options);
    const qb = repo.createQueryBuilder("r").where("r.creatorWallet = :wallet", { wallet });
    if (normalized.from) qb.andWhere("r.cycleAt >= :from", { from: normalized.from });
    if (normalized.to) qb.andWhere("r.cycleAt <= :to", { to: normalized.to });
    if (options.keyAddress) qb.andWhere("r.keyAddress = :key", { key: options.keyAddress });
    if (options.revision !== undefined)
      qb.andWhere("r.revision = :revision", { revision: options.revision });
    return { qb, ...normalized };
  }

  private row(r: RoyaltyEvent): RoyaltyStatementRow {
    return {
      id: r.id,
      cycleId: r.cycleId ?? null,
      cycleAt: r.cycleAt?.toISOString() ?? null,
      revision: r.revision,
      keyAddress: r.keyAddress,
      gross: new Decimal(r.gross ?? r.amount).toFixed(4),
      platformFee: new Decimal(r.platformFee ?? 0).toFixed(4),
      net: new Decimal(r.amount).toFixed(4),
      txHash: r.txHash,
      paidAt: r.paidAt?.toISOString() ?? null,
    };
  }

  async list(wallet: string, options: StatementOptions = {}) {
    const { qb, cursor, scope, limit } = this.query(
      this.dataSource.getRepository(RoyaltyEvent),
      wallet,
      options
    );
    const watermark =
      cursor?.watermark ??
      String(
        (await qb.clone().select("COALESCE(MAX(r.statementSequence), 0)", "maximum").getRawOne())
          ?.maximum ?? "0"
      );
    qb.andWhere("r.statementSequence <= :watermark", { watermark });
    if (cursor) qb.andWhere("r.statementSequence < :sequence", { sequence: cursor.sequence });
    const rows = await qb
      .orderBy("r.statementSequence", "DESC")
      .take(limit + 1)
      .getMany();
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => this.row(r));
    const nextCursor = hasMore
      ? Buffer.from(
          JSON.stringify({ sequence: rows[limit - 1].statementSequence, watermark, scope })
        ).toString("base64url")
      : null;
    return { items, totals: statementTotals(items), hasMore, nextCursor };
  }

  async export(wallet: string, options: StatementOptions = {}) {
    if (options.cursor)
      throw new AppError(400, "Export uses range filters without a cursor", "INVALID_CURSOR");
    return this.dataSource.transaction("REPEATABLE READ", async (m) => {
      const { qb } = this.query(m.getRepository(RoyaltyEvent), wallet, options);
      const rows = await qb.orderBy("r.statementSequence", "DESC").take(10001).getMany();
      if (rows.length > 10000)
        throw new AppError(
          413,
          "Limit export to 10000 rows using cycle filters",
          "EXPORT_TOO_LARGE"
        );
      const items = rows.map((r) => this.row(r));
      return { items, totals: statementTotals(items), rowCount: items.length };
    });
  }
}

export function statementCsv(rows: RoyaltyStatementRow[]): string {
  const fields: Array<keyof RoyaltyStatementRow> = [
    "id",
    "cycleId",
    "cycleAt",
    "revision",
    "keyAddress",
    "gross",
    "platformFee",
    "net",
    "txHash",
    "paidAt",
  ];
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[=+@\-\t\r\n]/.test(text)) text = `'${text}`; // Prevent spreadsheet formulas in indexed strings.
    return `"${text.replace(/"/g, '""')}"`;
  };
  return (
    fields.join(",") +
    "\r\n" +
    rows.map((r) => fields.map((f) => cell(r[f])).join(",")).join("\r\n") +
    (rows.length ? "\r\n" : "")
  );
}
