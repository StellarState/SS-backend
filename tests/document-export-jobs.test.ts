import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { DocumentExportService } from "../src/services/document-export.service";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceDocument } from "../src/models/InvoiceDocument.model";
import { Investment } from "../src/models/Investment.model";
import { User } from "../src/models/User.model";
import { DocumentExportJob } from "../src/models/DocumentExportJob.model";
import { KYCStatus } from "../src/types/enums";

const OWNER = "issuer-1";
const OTHER = "someone-else";
const INVOICE_ID = "invoice-1";

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
  documents: InvoiceDocument[],
  fetchFile: jest.Mock,
  tempDir: string,
) {
  const jobs: DocumentExportJob[] = [];
  const dataSource = {
    getRepository: (entity: unknown) => {
      if (entity === DocumentExportJob) {
        return {
          create: (input: Partial<DocumentExportJob>) => Object.assign(new DocumentExportJob(), input),
          save: async (job: DocumentExportJob) => {
            job.createdAt = new Date();
            jobs.push(job);
            return job;
          },
          findOneBy: async (criteria: Partial<DocumentExportJob>) =>
            jobs.find((job) => Object.entries(criteria).every(([key, value]) => job[key as keyof DocumentExportJob] === value)) ?? null,
          findOneByOrFail: async (criteria: Partial<DocumentExportJob>) => {
            const job = jobs.find((candidate) =>
              Object.entries(criteria).every(([key, value]) => candidate[key as keyof DocumentExportJob] === value));
            if (!job) throw new Error("job not found");
            return job;
          },
          update: async (criteria: Partial<DocumentExportJob>, changes: Partial<DocumentExportJob>) => {
            const job = jobs.find((candidate) =>
              Object.entries(criteria).every(([key, value]) => candidate[key as keyof DocumentExportJob] === value));
            if (!job) return { affected: 0 };
            Object.assign(job, changes);
            return { affected: 1 };
          },
          find: async () => jobs,
          delete: async () => ({ affected: 0 }),
        };
      }
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
      if (entity === InvoiceDocument) return { find: async () => documents };
      throw new Error("unexpected repository");
    },
  };

  return new DocumentExportService({
    dataSource: dataSource as never,
    ipfsService: { fetchFile } as never,
    tempDir,
    signingSecret: "test-secret",
    urlTtlMinutes: 10,
  });
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
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

function deferred() {
  let release!: () => void;
  const promise = new Promise<Buffer>((resolve) => {
    release = () => resolve(Buffer.from("data"));
  });
  return { promise, release };
}

describe("DocumentExportService jobs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "export-jobs-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("starts queued with zero progress", async () => {
    const service = makeService(makeDocuments(1), jest.fn(async () => Buffer.from("x")), tempDir);

    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    const job = (await service.getJobStatus(jobId, OWNER))!;

    expect(job.status).toBe("queued");
    expect(job.progress).toBe(0);

    // Stop the queued job before teardown removes its output directory.
    await service.cancelJob(jobId, OWNER);
  });

  it("reports monotonic, bounded progress and reaches 100 only on completion", async () => {
    const seen: number[] = [];
    let service!: DocumentExportService;
    let jobId = "";
    const fetchFile = jest.fn(async () => {
      seen.push((await service.getJobStatus(jobId, OWNER))!.progress);
      return Buffer.from("x");
    });
    service = makeService(makeDocuments(4), fetchFile, tempDir);

    ({ jobId } = await service.requestExport(INVOICE_ID, OWNER));
    await waitFor(async () => (await service.getJobStatus(jobId, OWNER))!.status === "completed");

    const job = (await service.getJobStatus(jobId, OWNER))!;
    expect(seen).toEqual([0, 25, 50, 75]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.every((value) => value >= 0 && value < 100)).toBe(true);
    expect(job.progress).toBe(100);
    expect(job.processedDocuments).toBe(4);
    expect(job.totalDocuments).toBe(4);
    expect(job.downloadToken).toBeDefined();
  });

  it("hides jobs from users other than the requester", async () => {
    const service = makeService(makeDocuments(1), jest.fn(async () => Buffer.from("x")), tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);

    expect(await service.getJobStatus(jobId, OTHER)).toBeUndefined();
    expect(await service.getJobStatus("exp_missing", OWNER)).toBeUndefined();
    await expect(service.cancelJob(jobId, OTHER)).rejects.toMatchObject({ code: "export_job_not_found" });
    // The failed attempt did not cancel the owner's job.
    expect((await service.getJobStatus(jobId, OWNER))!.status).not.toBe("cancelled");

    await service.cancelJob(jobId, OWNER);
  });

  it("cancels a queued job before any work starts", async () => {
    const fetchFile = jest.fn(async () => Buffer.from("x"));
    const service = makeService(makeDocuments(2), fetchFile, tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);

    const cancelled = await service.cancelJob(jobId, OWNER);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(cancelled.status).toBe("cancelled");
    expect((await service.getJobStatus(jobId, OWNER))!.status).toBe("cancelled");
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("cancels a running job, stops fetching and never completes it", async () => {
    const gate = deferred();
    const fetchFile = jest.fn(() => gate.promise);
    const service = makeService(makeDocuments(3), fetchFile, tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    await waitFor(() => fetchFile.mock.calls.length === 1);
    expect((await service.getJobStatus(jobId, OWNER))!.status).toBe("running");

    await service.cancelJob(jobId, OWNER);
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const job = (await service.getJobStatus(jobId, OWNER))!;
    expect(job.status).toBe("cancelled");
    expect(job.downloadToken).toBeUndefined();
    expect(job.zipPath).toBeUndefined();
    expect(fetchFile).toHaveBeenCalledTimes(1);
    await expect(service.getDownloadPath(jobId, "any")).rejects.toMatchObject({ code: "export_not_ready" });
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it("treats a repeated cancel as a no-op", async () => {
    const service = makeService(makeDocuments(1), jest.fn(async () => Buffer.from("x")), tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);

    const first = await service.cancelJob(jobId, OWNER);
    const second = await service.cancelJob(jobId, OWNER);

    expect(second.status).toBe("cancelled");
    expect(second.cancelledAt).toBe(first.cancelledAt);
  });

  it("refuses to cancel a completed job", async () => {
    const service = makeService(makeDocuments(1), jest.fn(async () => Buffer.from("x")), tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    await waitFor(async () => (await service.getJobStatus(jobId, OWNER))!.status === "completed");

    await expect(service.cancelJob(jobId, OWNER)).rejects.toMatchObject({ code: "export_not_cancellable", statusCode: 409 });
    expect((await service.getJobStatus(jobId, OWNER))!.status).toBe("completed");
  });

  it("marks a job failed when a document cannot be fetched, and keeps it failed", async () => {
    const fetchFile = jest.fn(async () => {
      throw new Error("gateway down");
    });
    const service = makeService(makeDocuments(2), fetchFile, tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    await waitFor(async () => (await service.getJobStatus(jobId, OWNER))!.status === "failed");

    const job = (await service.getJobStatus(jobId, OWNER))!;
    expect(job.error).toBe("gateway down");
    expect(job.progress).toBeLessThan(100);
    await expect(service.cancelJob(jobId, OWNER)).rejects.toMatchObject({ code: "export_not_cancellable", statusCode: 409 });
  });

  it("fails a job whose invoice has no documents", async () => {
    const service = makeService([], jest.fn(), tempDir);
    const { jobId } = await service.requestExport(INVOICE_ID, OWNER);
    await waitFor(async () => (await service.getJobStatus(jobId, OWNER))!.status === "failed");

    expect((await service.getJobStatus(jobId, OWNER))!.error).toMatch(/no documents/i);
  });
});
