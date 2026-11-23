import { DataSource } from "typeorm";
import { SecondaryDepthSnapshot } from "../models/SecondaryDepthSnapshot.model";
import { Invoice } from "../models/Invoice.model";
import { ServiceError } from "../utils/service-error";
import type { MetricsRegistry } from "../observability/metrics";

export const DEPTH_SWEEP_INTERVAL_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface DepthCursor {
  invoice: string;
  before: string;
  watermark: string;
}

export class SecondaryDepthService {
  constructor(
    private readonly source: DataSource,
    private readonly metrics?: MetricsRegistry
  ) {}

  async current(invoiceId: string) {
    await this.assertInvoice(invoiceId);
    let snapshot = await this.source
      .getRepository(SecondaryDepthSnapshot)
      .findOne({ where: { invoiceId }, order: { id: "DESC" } });
    const lag = snapshot?.validUntil
      ? Math.max(0, (Date.now() - snapshot.validUntil.getTime()) / 1000)
      : 0;
    if (!snapshot || (snapshot.validUntil && snapshot.validUntil.getTime() <= Date.now())) {
      await this.source.query("SELECT refresh_secondary_depth($1)", [invoiceId]);
      snapshot = await this.source
        .getRepository(SecondaryDepthSnapshot)
        .findOneOrFail({ where: { invoiceId }, order: { id: "DESC" } });
    }
    this.metrics?.setDepthSnapshotLagSeconds(lag);
    return snapshot;
  }

  async history(invoiceId: string, limit: unknown = 20, cursor?: unknown) {
    await this.assertInvoice(invoiceId);
    const size = typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : limit;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 100)
      throw new ServiceError(
        "INVALID_PAGE_SIZE",
        "limit must be an integer between 1 and 100",
        400
      );
    let boundary: DepthCursor | null = null;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== "string" || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
          throw new Error("cursor");
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as DepthCursor;
        if (
          parsed.invoice !== invoiceId ||
          typeof parsed.before !== "string" ||
          typeof parsed.watermark !== "string" ||
          !/^[1-9]\d{0,18}$/.test(parsed.before) ||
          !/^[1-9]\d{0,18}$/.test(parsed.watermark) ||
          BigInt(parsed.before) > BigInt(parsed.watermark) ||
          BigInt(parsed.watermark) > 9223372036854775807n
        )
          throw new Error("cursor");
        boundary = parsed;
      } catch {
        throw new ServiceError(
          "INVALID_DEPTH_CURSOR",
          "Cursor does not belong to this depth history",
          400
        );
      }
    }
    const query = this.source
      .getRepository(SecondaryDepthSnapshot)
      .createQueryBuilder("snapshot")
      .where("snapshot.invoice_id = :invoiceId", { invoiceId })
      .andWhere("snapshot.captured_at >= :cutoff", { cutoff: new Date(Date.now() - 90 * 86400000) })
      .orderBy("snapshot.id", "DESC")
      .take(size + 1);
    if (boundary) query.andWhere("snapshot.id < :before AND snapshot.id <= :watermark", boundary);
    const rows = await query.getMany();
    const more = rows.length > size;
    const data = rows.slice(0, size);
    const watermark = boundary?.watermark ?? data[0]?.id;
    const next = more
      ? Buffer.from(
          JSON.stringify({ invoice: invoiceId, before: data[data.length - 1].id, watermark })
        ).toString("base64url")
      : null;
    return { data, meta: { next_cursor: next, has_more: more, retention_days: 90 } };
  }

  /** Expiry refresh and retention for dormant books. Mutations snapshot synchronously. */
  async sweep(): Promise<void> {
    const latest = (await this.source
      .query(`SELECT DISTINCT ON (invoice_id) invoice_id, captured_at, valid_until
      FROM secondary_depth_snapshots ORDER BY invoice_id, id DESC`)) as Array<{
      invoice_id: string;
      captured_at: Date;
      valid_until: Date | null;
    }>;
    let lag = 0;
    for (const row of latest) {
      if (row.valid_until && row.valid_until.getTime() <= Date.now()) {
        lag = Math.max(lag, (Date.now() - row.valid_until.getTime()) / 1000);
        await this.source.query("SELECT refresh_secondary_depth($1)", [row.invoice_id]);
      }
    }
    this.metrics?.setDepthSnapshotLagSeconds(lag);
    await this.source
      .query(`DELETE FROM secondary_depth_snapshots WHERE captured_at < clock_timestamp() - interval '90 days'
      AND id NOT IN (SELECT DISTINCT ON (invoice_id) id FROM secondary_depth_snapshots ORDER BY invoice_id, id DESC)`);
  }

  private async assertInvoice(id: string): Promise<void> {
    if (!UUID.test(id) || !(await this.source.getRepository(Invoice).existsBy({ id })))
      throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
  }
}
