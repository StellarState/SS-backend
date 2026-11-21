import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { DocumentExportService } from "../src/services/document-export.service";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceDocument } from "../src/models/InvoiceDocument.model";
import { Investment } from "../src/models/Investment.model";
import { User } from "../src/models/User.model";
import { KYCStatus } from "../src/types/enums";

const OWNER = "issuer-1";
const INVOICE_ID = "invoice-1";
const MINUTE = 60 * 1000;

function makeDocuments(count: number): InvoiceDocument[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${i}`,
    invoiceId: INVOICE_ID,
    cid: `cid-${i}`,
    docType: `type${i}`,
    filename: `file-${i}.pdf`,
    mimeType: "application/pdf",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  })) as unknown as InvoiceDocument[];
}

function makeService(
  tempDir: string,
  options: {
    now: () => number;
    retentionMinutes?: number;
    urlTtlMinutes?: number;
  },
): DocumentExportService {
  const dataSource = {
    getRepository: (entity: unknown) => {
      if (entity === Invoice) {
        return {
          findOneBy: async () =>
            ({ id: INVOICE_ID, sellerId: OWNER, invoiceNumber: "INV-1" }) as unknown as Invoice,
        };
      }
      if (entity === User) {
        return {
          findOneBy: async () => ({ id: OWNER, kycStatus: KYCStatus.APPROVED }) as unknown as User,
        };
      }
      if (entity === Investment) return { exists: async () => false };
      if (entity === InvoiceDocument) return { find: async () => makeDocuments(1) };
      throw new Error("unexpected repository");
    },
  };

  return new DocumentExportService({
    dataSource: dataSource as never,
    ipfsService: { fetchFile: async () => Buffer.from("data") } as never,
    tempDir,
    signingSecret: "test-secret",
    urlTtlMinutes: options.urlTtlMinutes ?? 10,
    retentionMinutes: options.retentionMinutes,
    now: options.now,
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function expectServiceError(fn: () => unknown, code: string, statusCode?: number): void {
  let caught: { code?: string; statusCode?: number } | undefined;
  try {
    fn();
  } catch (error) {
    caught = error as { code?: string; statusCode?: number };
  }
  expect(caught).toBeDefined();
  expect(caught!.code).toBe(code);
  if (statusCode !== undefined) expect(caught!.statusCode).toBe(statusCode);
}

describe("DocumentExportService retention and cleanup (#809)", () => {
  let tempDir: string;
  let clock: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "export-retention-"));
    clock = 1_000_000;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function completedJob(options: {
    retentionMinutes: number;
    urlTtlMinutes: number;
  }): Promise<{ service: DocumentExportService; jobId: string }> {
    const service = makeService(tempDir, {
      now: () => clock,
      retentionMinutes: options.retentionMinutes,
      urlTtlMinutes: options.urlTtlMinutes,
    });
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    await waitFor(() => service.getJobStatus(jobId, OWNER)!.status === "completed");
    return { service, jobId };
  }

  it("bounds the signed URL TTL by the retention window, not just the configured TTL", async () => {
    const { service, jobId } = await completedJob({ retentionMinutes: 5, urlTtlMinutes: 180 });
    const job = service.getJobStatus(jobId, OWNER)!;

    expect(job.retentionExpiresAt).toBe(job.completedAt! + 5 * MINUTE);
    // The 180-minute TTL is cut down to the 5-minute retention window.
    expect(job.downloadTokenExpiresAt).toBe(job.retentionExpiresAt);
    expect(job.downloadTokenExpiresAt! - job.completedAt!).toBeLessThanOrEqual(180 * MINUTE);
  });

  it("keeps the configured TTL when it is shorter than retention", async () => {
    const { service, jobId } = await completedJob({ retentionMinutes: 60, urlTtlMinutes: 2 });
    const job = service.getJobStatus(jobId, OWNER)!;

    expect(job.downloadTokenExpiresAt).toBe(job.completedAt! + 2 * MINUTE);
    expect(job.downloadTokenExpiresAt!).toBeLessThan(job.retentionExpiresAt!);
  });

  it("refuses to stream a deleted export even with the token it was issued", async () => {
    const { service, jobId } = await completedJob({ retentionMinutes: 5, urlTtlMinutes: 30 });
    const job = service.getJobStatus(jobId, OWNER)!;
    const token = job.downloadToken!;
    const zipPath = job.zipPath!;

    clock += 6 * MINUTE;
    await service.cleanupExport(jobId);

    expect(job.deletedAt).toBe(clock);
    expect(job.status).toBe("completed");
    expect(job.downloadToken).toBeUndefined();
    expect(job.zipPath).toBeUndefined();
    expect(service.getJobStatus(jobId, OWNER)).toBeDefined();
    await expect(fs.access(zipPath)).rejects.toThrow();
    expectServiceError(() => service.getDownloadPath(jobId, token), "export_deleted", 410);
  });

  it("refuses an expired export whose object cleanup has not caught up yet", async () => {
    const { service, jobId } = await completedJob({ retentionMinutes: 5, urlTtlMinutes: 30 });
    const job = service.getJobStatus(jobId, OWNER)!;
    const token = job.downloadToken!;

    clock += 6 * MINUTE;

    // Storage lag: the ZIP is still on disk, but the metadata says the
    // retention window has passed. The download must be refused anyway.
    await expect(fs.access(job.zipPath!)).resolves.toBeUndefined();
    expectServiceError(() => service.getDownloadPath(jobId, token), "export_expired", 410);
  });

  it("keeps blocking downloads when object cleanup fails, without marking metadata deleted", async () => {
    const { service, jobId } = await completedJob({ retentionMinutes: 5, urlTtlMinutes: 30 });
    const job = service.getJobStatus(jobId, OWNER)!;
    const token = job.downloadToken!;

    clock += 6 * MINUTE;
    // A non-empty directory in the ZIP's place makes `fs.rm(..., { force: true })`
    // fail, standing in for a storage backend that rejects the delete.
    await fs.rm(job.zipPath!, { force: true });
    await fs.mkdir(job.zipPath!, { recursive: true });
    await fs.writeFile(path.join(job.zipPath!, "blocker"), "x");

    await service.cleanupExport(jobId);

    expect(job.deletedAt).toBeUndefined();
    expect(job.cleanupError).toBeDefined();
    expect(job.status).toBe("completed");
    // Downloads are already blocked by retention, so the lag cannot be exploited.
    expectServiceError(() => service.getDownloadPath(jobId, token), "export_expired", 410);
  });

  it("treats cleanup retries as no-ops so deleted metadata is not resurrected", async () => {
    const { service, jobId } = await completedJob({ retentionMinutes: 5, urlTtlMinutes: 30 });
    const job = service.getJobStatus(jobId, OWNER)!;

    clock += 6 * MINUTE;
    await service.cleanupExport(jobId);
    const deletedAt = job.deletedAt;

    clock += 60 * MINUTE;
    await service.cleanupExport(jobId);
    await service.cleanupExport(jobId);

    expect(job.deletedAt).toBe(deletedAt);
    expect(job.deletedAt).not.toBe(clock);
    expect(job.downloadToken).toBeUndefined();
    expect(job.downloadTokenExpiresAt).toBeUndefined();
    expect(job.zipPath).toBeUndefined();
    expect(job.cleanupError).toBeUndefined();
    expect(job.status).toBe("completed");
  });

  it("does not delete objects before retention elapses, and sweeps only expired jobs", async () => {
    const { service, jobId } = await completedJob({ retentionMinutes: 5, urlTtlMinutes: 30 });
    const job = service.getJobStatus(jobId, OWNER)!;

    clock += 1 * MINUTE;
    expect(await service.cleanupExpiredExports()).toEqual([]);
    await expect(fs.access(job.zipPath!)).resolves.toBeUndefined();

    clock += 5 * MINUTE;
    expect(await service.cleanupExpiredExports()).toEqual([jobId]);
    expect(job.deletedAt).toBe(clock);
    await expect(fs.access(job.zipPath ?? path.join(tempDir, `${jobId}.zip`))).rejects.toThrow();
  });

  it("refuses a download whose file disappeared before metadata caught up", async () => {
    const { service, jobId } = await completedJob({ retentionMinutes: 60, urlTtlMinutes: 30 });
    const job = service.getJobStatus(jobId, OWNER)!;
    const token = job.downloadToken!;

    clock += 1 * MINUTE;
    // Storage lost the object first; metadata is still "completed".
    await fs.rm(job.zipPath!, { force: true });

    expect(job.deletedAt).toBeUndefined();
    expectServiceError(() => service.getDownloadPath(jobId, token), "export_file_missing", 410);
  });
});
