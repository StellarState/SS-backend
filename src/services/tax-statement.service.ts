import { DataSource } from "typeorm";
import { Readable } from "stream";
import { Decimal } from "decimal.js";
import PDFDocument from "pdfkit";
import { Investment } from "../models/Investment.model";
import { InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";

export interface TaxStatementInvoiceRow {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  settlementDate: string;
  principal: string;
  yield: string;
  totalPayout: string;
}

export interface TaxStatement {
  userId: string;
  year: number;
  totalPrincipal: string;
  totalYield: string;
  totalPayout: string;
  invoices: TaxStatementInvoiceRow[];
  /** Alias for convenience */
  rows?: TaxStatementInvoiceRow[];
  principalReturned?: string;
  yieldEarned?: string;
  totalReturns?: string;
}

export interface ObjectStorage {
  get(key: string): Promise<Buffer | null>;
  set(key: string, data: Buffer, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
  has?(key: string): Promise<boolean>;
}

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly storage = new Map<string, Buffer>();

  async get(key: string): Promise<Buffer | null> {
    return this.storage.get(key) ?? null;
  }

  async set(key: string, data: Buffer): Promise<void> {
    this.storage.set(key, data);
  }

  async delete(key: string): Promise<void> {
    this.storage.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.storage.has(key);
  }
}

export class TaxStatementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: ObjectStorage = new InMemoryObjectStorage(),
  ) {}

  getStorageKey(userId: string, year: number | string): string {
    return `tax-statements/${userId}/${year}.pdf`;
  }

  /**
   * Aggregates settled payouts into principal and yield per invoice for a calendar year (#873).
   * Returns an empty statement with zero totals when no payouts exist.
   */
  async build(userId: string, year: number | string): Promise<TaxStatement> {
    const numYear = typeof year === "string" ? parseInt(year, 10) : year;
    if (isNaN(numYear) || numYear < 1900 || numYear > 2200) {
      throw new ServiceError("INVALID_YEAR", "A valid 4-digit calendar year is required", 400);
    }

    const investmentRepo = this.dataSource.getRepository(Investment);
    let investments: Investment[] = [];
    try {
      investments = await investmentRepo.find({
        where: {
          investorId: userId,
          status: InvestmentStatus.SETTLED,
        },
        relations: ["invoice"],
      });
    } catch {
      // If relations not supported in lightweight mock, fallback to find without relations
      investments = await investmentRepo.find({
        where: {
          investorId: userId,
          status: InvestmentStatus.SETTLED,
        },
      });
    }

    const invoiceMap = new Map<
      string,
      {
        invoiceId: string;
        invoiceNumber: string;
        customerName: string;
        settlementDate: Date;
        principal: Decimal;
        yield: Decimal;
        totalPayout: Decimal;
      }
    >();

    for (const inv of investments) {
      // Determine settlement date
      const dateVal =
        (inv as any).settledAt ??
        inv.updatedAt ??
        inv.invoice?.updatedAt ??
        inv.createdAt ??
        new Date();
      const d = dateVal instanceof Date ? dateVal : new Date(dateVal);

      const matchesYear = d.getUTCFullYear() === numYear || d.getFullYear() === numYear;
      if (!matchesYear) continue;

      const principal = new Decimal(inv.investmentAmount || "0");
      const totalPayout = new Decimal(
        inv.actualReturn ?? inv.expectedReturn ?? inv.investmentAmount ?? "0",
      );
      const yieldEarned = totalPayout.minus(principal);
      const positiveYield = yieldEarned.isNegative() ? new Decimal(0) : yieldEarned;

      const invoiceId = inv.invoiceId;
      const invoiceNumber =
        inv.invoice?.invoiceNumber ??
        (inv as any).invoiceNumber ??
        `INV-${invoiceId.slice(0, 8)}`;
      const customerName =
        inv.invoice?.customerName ?? (inv as any).customerName ?? "";
      const settlementDate = d;

      const existing = invoiceMap.get(invoiceId);
      if (existing) {
        existing.principal = existing.principal.plus(principal);
        existing.yield = existing.yield.plus(positiveYield);
        existing.totalPayout = existing.totalPayout.plus(totalPayout);
        if (settlementDate > existing.settlementDate) {
          existing.settlementDate = settlementDate;
        }
      } else {
        invoiceMap.set(invoiceId, {
          invoiceId,
          invoiceNumber,
          customerName,
          settlementDate,
          principal,
          yield: positiveYield,
          totalPayout,
        });
      }
    }

    let totalPrincipal = new Decimal(0);
    let totalYield = new Decimal(0);
    let totalPayout = new Decimal(0);

    const invoiceRows: TaxStatementInvoiceRow[] = [];

    for (const item of invoiceMap.values()) {
      totalPrincipal = totalPrincipal.plus(item.principal);
      totalYield = totalYield.plus(item.yield);
      totalPayout = totalPayout.plus(item.totalPayout);

      invoiceRows.push({
        invoiceId: item.invoiceId,
        invoiceNumber: item.invoiceNumber,
        customerName: item.customerName,
        settlementDate: item.settlementDate.toISOString(),
        principal: item.principal.toFixed(2),
        yield: item.yield.toFixed(2),
        totalPayout: item.totalPayout.toFixed(2),
      });
    }

    // Deterministic sorting by invoiceNumber
    invoiceRows.sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));

    const totalPrincipalStr = totalPrincipal.toFixed(2);
    const totalYieldStr = totalYield.toFixed(2);
    const totalPayoutStr = totalPayout.toFixed(2);

    return {
      userId,
      year: numYear,
      totalPrincipal: totalPrincipalStr,
      totalYield: totalYieldStr,
      totalPayout: totalPayoutStr,
      invoices: invoiceRows,
      rows: invoiceRows,
      principalReturned: totalPrincipalStr,
      yieldEarned: totalYieldStr,
      totalReturns: totalPayoutStr,
    };
  }

  /**
   * Generates a PDF statement with pdfkit including summary totals and per-invoice table (#873).
   */
  async renderPdf(statement: TaxStatement): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Title & Header
      doc.font("Helvetica-Bold").fontSize(20).text("Annual Investor Tax Statement", { align: "center" });
      doc.moveDown(0.5);
      doc.font("Helvetica").fontSize(10).fillColor("#666666").text(`Generated on ${new Date().toISOString().split("T")[0]}`, { align: "center" });
      doc.moveDown();

      doc.fillColor("#000000").fontSize(11);
      doc.font("Helvetica-Bold").text("Tax Year: ", { continued: true }).font("Helvetica").text(String(statement.year));
      doc.font("Helvetica-Bold").text("Investor ID: ", { continued: true }).font("Helvetica").text(statement.userId);
      doc.moveDown();

      // Summary Box
      doc.font("Helvetica-Bold").fontSize(13).text("Summary Totals");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(11);
      doc.text(`Total Principal Returned: $${statement.totalPrincipal}`);
      doc.text(`Total Yield Earned: $${statement.totalYield}`);
      doc.font("Helvetica-Bold").text(`Total Payout: $${statement.totalPayout}`);
      doc.font("Helvetica");
      doc.moveDown();

      // Per-invoice Section
      doc.font("Helvetica-Bold").fontSize(13).text("Settled Payouts Per Invoice");
      doc.moveDown(0.5);

      if (statement.invoices.length === 0) {
        doc.font("Helvetica-Oblique").fontSize(10).text("No settled payouts recorded for this calendar year.");
      } else {
        const startX = 50;
        let y = doc.y;

        doc.font("Helvetica-Bold").fontSize(9);
        doc.text("Invoice #", startX, y, { width: 90 });
        doc.text("Customer", startX + 95, y, { width: 120 });
        doc.text("Date", startX + 220, y, { width: 70 });
        doc.text("Principal", startX + 295, y, { width: 65, align: "right" });
        doc.text("Yield", startX + 365, y, { width: 60, align: "right" });
        doc.text("Total", startX + 430, y, { width: 65, align: "right" });

        y += 15;
        doc.moveTo(startX, y).lineTo(startX + 495, y).lineWidth(1).stroke("#cccccc");
        doc.fillColor("#000000");
        y += 6;

        doc.font("Helvetica").fontSize(9);
        for (const inv of statement.invoices) {
          if (y > 720) {
            doc.addPage();
            y = 50;
          }
          const formattedDate = inv.settlementDate.split("T")[0];
          doc.text(inv.invoiceNumber, startX, y, { width: 90 });
          doc.text(inv.customerName || "-", startX + 95, y, { width: 120 });
          doc.text(formattedDate, startX + 220, y, { width: 70 });
          doc.text(`$${inv.principal}`, startX + 295, y, { width: 65, align: "right" });
          doc.text(`$${inv.yield}`, startX + 365, y, { width: 60, align: "right" });
          doc.text(`$${inv.totalPayout}`, startX + 430, y, { width: 65, align: "right" });

          y += 16;
        }

        y += 2;
        doc.moveTo(startX, y).lineTo(startX + 495, y).lineWidth(1).stroke("#cccccc");
        doc.fillColor("#000000");
        y += 6;

        // Total Row
        doc.font("Helvetica-Bold").fontSize(9);
        doc.text("Total", startX, y, { width: 90 });
        doc.text(`$${statement.totalPrincipal}`, startX + 295, y, { width: 65, align: "right" });
        doc.text(`$${statement.totalYield}`, startX + 365, y, { width: 60, align: "right" });
        doc.text(`$${statement.totalPayout}`, startX + 430, y, { width: 65, align: "right" });
      }

      doc.end();
    });
  }

  /**
   * Retrieves cached PDF statement or generates, stores, and returns a new one (#873).
   */
  async getOrGeneratePdf(userId: string, year: number | string): Promise<Buffer> {
    const numYear = typeof year === "string" ? parseInt(year, 10) : year;
    const key = this.getStorageKey(userId, numYear);
    const cached = await this.storage.get(key);
    if (cached) {
      return cached;
    }

    const statement = await this.build(userId, numYear);
    const pdfBuffer = await this.renderPdf(statement);
    await this.storage.set(key, pdfBuffer, "application/pdf");
    return pdfBuffer;
  }

  /**
   * Builds CSV representation with the exact same rows and totals (#873).
   */
  buildCsv(statement: TaxStatement): string {
    const headers = [
      "Invoice ID",
      "Invoice Number",
      "Customer Name",
      "Settlement Date",
      "Principal",
      "Yield",
      "Total Payout",
    ];
    const lines: string[] = [headers.join(",")];

    for (const inv of statement.invoices) {
      const escapedCustomer = `"${inv.customerName.replace(/"/g, '""')}"`;
      const formattedDate = inv.settlementDate.split("T")[0];
      lines.push(
        [
          inv.invoiceId,
          inv.invoiceNumber,
          escapedCustomer,
          formattedDate,
          inv.principal,
          inv.yield,
          inv.totalPayout,
        ].join(","),
      );
    }

    // Totals line
    lines.push(
      [
        "Total",
        "",
        "",
        "",
        statement.totalPrincipal,
        statement.totalYield,
        statement.totalPayout,
      ].join(","),
    );

    return lines.join("\n");
  }

  /**
   * Streams CSV data for client response (#873).
   */
  streamCsv(statement: TaxStatement): Readable {
    const csvContent = this.buildCsv(statement);
    return Readable.from([csvContent]);
  }

  /**
   * Invalidates cached PDF statement for a user and year in object storage (#873).
   */
  async invalidate(userId: string, year: number | string): Promise<void> {
    const numYear = typeof year === "string" ? parseInt(year, 10) : year;
    const key = this.getStorageKey(userId, numYear);
    await this.storage.delete(key);
  }

  /** Alias for invalidate */
  async invalidateCache(userId: string, year: number | string): Promise<void> {
    return this.invalidate(userId, year);
  }

  /** Checks if PDF is currently cached in object storage */
  async hasCachedPdf(userId: string, year: number | string): Promise<boolean> {
    const numYear = typeof year === "string" ? parseInt(year, 10) : year;
    const key = this.getStorageKey(userId, numYear);
    const data = await this.storage.get(key);
    return data !== null;
  }
}

export function createTaxStatementService(
  dataSource: DataSource,
  storage?: ObjectStorage,
): TaxStatementService {
  return new TaxStatementService(dataSource, storage);
}
