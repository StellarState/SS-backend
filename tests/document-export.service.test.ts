import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { DataSource } from "typeorm";
import { DocumentExportJob } from "../src/models/DocumentExportJob.model";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceDocument } from "../src/models/InvoiceDocument.model";
import { Investment } from "../src/models/Investment.model";
import { User } from "../src/models/User.model";
import { DocumentExportService } from "../src/services/document-export.service";
import { KYCStatus } from "../src/types/enums";

describe("DocumentExportService", () => {
  let tempDir: string;
  let service: DocumentExportService;
  let rows: DocumentExportJob[];
  let documents: InvoiceDocument[];
  let fetchFile: jest.Mock;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "document-export-"));
    rows = [];
    documents = [
      {
        cid: "cid-one",
        docType: "invoice",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        cid: "cid-two",
        docType: "proof",
        filename: "proof.pdf",
        mimeType: "application/pdf",
        createdAt: new Date("2026-01-03T00:00:00Z"),
      },
    ] as InvoiceDocument[];
    fetchFile = jest.fn(async () => Buffer.from("document bytes"));

    const jobRepository = {
      create: (input: Partial<DocumentExportJob>) => Object.assign(new DocumentExportJob(), input),
      save: async (job: DocumentExportJob) => {
        job.createdAt ??= new Date();
        job.updatedAt = new Date();
        rows.push(job);
        return job;
      },
      findOneBy: async (criteria: Record<string, unknown>) =>
        rows.find((job) => Object.entries(criteria).every(([key, value]) => job[key as keyof DocumentExportJob] === value)) ?? null,
      findOneByOrFail: async (criteria: Record<string, unknown>) => {
        const job = rows.find((candidate) =>
          Object.entries(criteria).every(([key, value]) => candidate[key as keyof DocumentExportJob] === value));
        if (!job) throw new Error("job not found");
        return job;
      },
      find: async () => rows.filter((job) =>
        (job.status === "running" && (job.leaseExpiresAt?.getTime() ?? Infinity) <= Date.now()) ||
        ((job.status === "completed" || job.status === "failed" || job.status === "cancelled") &&
          (job.expiresAt?.getTime() ?? Infinity) <= Date.now())
      ),
      update: async (criteria: Record<string, unknown>, changes: Partial<DocumentExportJob>) => {
        const job = rows.find((candidate) =>
          candidate.id === criteria.id &&
          (criteria.status === undefined || candidate.status === criteria.status) &&
          (criteria.requesterId === undefined || candidate.requesterId === criteria.requesterId) &&
          (criteria.leaseOwner === undefined || candidate.leaseOwner === criteria.leaseOwner) &&
          (criteria.leaseExpiresAt === undefined ||
            (candidate.leaseExpiresAt?.getTime() ?? Infinity) <= Date.now())
        );
        if (!job) return { affected: 0 };
        Object.assign(job, changes, { updatedAt: new Date() });
        return { affected: 1 };
      },
      delete: async (criteria: Record<string, unknown>) => {
        const index = rows.findIndex((job) =>
          job.id === criteria.id &&
          (job.status === "completed" || job.status === "failed" || job.status === "cancelled") &&
          (job.expiresAt?.getTime() ?? Infinity) <= Date.now()
        );
        if (index < 0) return { affected: 0 };
        rows.splice(index, 1);
        return { affected: 1 };
      },
    };
    const repositories = new Map<unknown, unknown>([
      [DocumentExportJob, jobRepository],
      [Invoice, { findOneBy: async () => ({ id: "invoice-id", invoiceNumber: "INV-001", sellerId: "user-id" }) }],
      [User, { findOneBy: async () => ({ id: "user-id", kycStatus: KYCStatus.APPROVED }) }],
      [Investment, { exists: async () => false }],
      [InvoiceDocument, { find: async () => documents }],
    ]);
    const dataSource = {
      getRepository: (entity: unknown) => repositories.get(entity),
    } as unknown as DataSource;
    service = new DocumentExportService({
      dataSource,
      ipfsService: { fetchFile } as never,
      tempDir,
      signingSecret: "test-secret",
      urlTtlMinutes: 60,
      retentionMs: 60_000,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function waitForStatus(jobId: string, expected: "completed" | "failed") {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await service.getJobStatus(jobId, "user-id");
      if (job?.status === expected) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Export job did not become ${expected}`);
  }

  it("persists completed jobs, includes every document, and verifies signed downloads", async () => {
    const { jobId } = await service.requestExport("invoice-id", "user-id");
    const job = await waitForStatus(jobId, "completed");
    expect(fetchFile).toHaveBeenCalledTimes(2);
    expect(job.downloadToken).toBeDefined();
    expect(await service.getDownloadPath(jobId, job.downloadToken!)).toBe(job.zipPath);
    expect((await fs.stat(job.zipPath!)).size).toBeGreaterThan(0);
  });

  it("fails and removes partial archives when an IPFS document fetch fails", async () => {
    fetchFile.mockRejectedValueOnce(new Error("gateway unavailable"));
    const { jobId } = await service.requestExport("invoice-id", "user-id");
    const job = await waitForStatus(jobId, "failed");
    expect(job.error).toContain("gateway unavailable");
    await expect(fs.stat(path.join(tempDir, `${jobId}.zip`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks a simulated disk write failure as failed without leaking the archive", async () => {
    const jobId = "exp_disk_failure";
    const job = Object.assign(new DocumentExportJob(), {
      id: jobId,
      invoiceId: "invoice-id",
      requesterId: "user-id",
      status: "queued" as const,
      zipPath: path.join(tempDir, `${jobId}.zip`),
      leaseOwner: "worker-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    rows.push(job);
    await fs.symlink("/dev/full", job.zipPath!);

    const servicePrototype = Object.getPrototypeOf(service) as {
      writeZip: (...args: unknown[]) => Promise<void>;
      runExport: (id: string, number: string) => Promise<void>;
    };
    jest.spyOn(servicePrototype, "writeZip").mockRejectedValue(new Error("disk write failed"));
    await servicePrototype.runExport.call(service, jobId, "INV-001");

    expect((await service.getJobStatus(jobId, "user-id"))?.status).toBe("failed");
    await expect(fs.lstat(job.zipPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains active jobs, expires abandoned jobs, and deletes expired metadata idempotently", async () => {
    const jobId = "exp_abandoned";
    const activeJob = Object.assign(new DocumentExportJob(), {
      id: jobId,
      invoiceId: "invoice-id",
      requesterId: "user-id",
      status: "running" as const,
      zipPath: path.join(tempDir, `${jobId}.zip`),
      leaseOwner: "worker-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    rows.push(activeJob);
    await service.cleanupExpiredJobs(new Date(Date.now() + 1_000));
    expect((await service.getJobStatus(jobId, "user-id"))?.status).toBe("running");

    activeJob.leaseExpiresAt = new Date(Date.now() - 1_000);
    await fs.writeFile(activeJob.zipPath!, "partial");
    await fs.stat(activeJob.zipPath!);
    const firstCleanup = await service.cleanupExpiredJobs(new Date());
    expect(firstCleanup.archivesDeleted).toBe(1);
    expect((await service.getJobStatus(jobId, "user-id"))?.status).toBe("failed");

    activeJob.expiresAt = new Date(Date.now() - 1_000);
    const expired = await service.cleanupExpiredJobs(new Date());
    expect(expired.jobsDeleted).toBe(1);
    expect(await service.cleanupExpiredJobs(new Date())).toEqual({ jobsDeleted: 0, archivesDeleted: 0 });
  });
});
