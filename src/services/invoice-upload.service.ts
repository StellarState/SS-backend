import { randomUUID } from "node:crypto";
import { DataSource, EntityManager } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceDocument, InvoiceDocumentType } from "../models/InvoiceDocument.model";
import { InvoiceUploadChunk, InvoiceUploadSession } from "../models/InvoiceUploadSession.model";
import { InvoiceStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { parseContentChecksum, verifyDocumentChecksum } from "../lib/document-checksum";
import type { IPFSService } from "./ipfs.service";

export const MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uploadSessionView(session: InvoiceUploadSession) {
  return {
    upload_session_id: session.id,
    invoice_id: session.invoiceId,
    filename: session.filename,
    mime_type: session.mimeType,
    file_size_bytes: session.fileSizeBytes,
    content_checksum: session.contentChecksum,
    received_bytes: session.receivedBytes,
    upload_complete: session.state === "complete",
    state: session.state,
    cid: session.cid,
    max_chunk_bytes: MAX_UPLOAD_CHUNK_BYTES,
  };
}

/** Durable sequential chunks. All writers lock invoice before session. */
export class InvoiceUploadService {
  constructor(
    private readonly source: DataSource,
    private readonly ipfs: IPFSService
  ) {}

  async start(invoiceId: string, sellerId: string, body: Record<string, unknown>) {
    const id = body.upload_session_id === undefined ? randomUUID() : body.upload_session_id;
    if (typeof id !== "string" || !UUID.test(id)) {
      throw new ServiceError("invalid_upload_session", "upload_session_id must be a UUID", 400);
    }
    const filename = this.text(body.filename, "filename", 255);
    const mimeType = this.text(body.mime_type, "mime_type", 128);
    const size = body.file_size_bytes;
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > 2_147_483_647) {
      throw new ServiceError(
        "invalid_file_size",
        "file_size_bytes must be a positive integer",
        400
      );
    }
    this.ipfs.validateUploadMetadata(size, mimeType);
    const checksum = parseContentChecksum(body.content_checksum);
    return this.source.transaction(async (manager) => {
      const invoice = await this.lockInvoice(manager, invoiceId, sellerId);
      const existing = await manager.findOneBy(InvoiceUploadSession, { id });
      if (existing) {
        if (
          existing.invoiceId !== invoiceId ||
          existing.filename !== filename ||
          existing.mimeType !== mimeType ||
          existing.fileSizeBytes !== size ||
          (existing.contentChecksum !== checksum &&
            !(existing.state === "complete" && checksum === null))
        ) {
          throw new ServiceError(
            "upload_metadata_conflict",
            "Session metadata cannot be changed; restart the upload",
            409
          );
        }
        return uploadSessionView(existing);
      }
      if (invoice.uploadComplete === false) {
        throw new ServiceError("upload_in_progress", "Resume or restart the existing upload", 409, {
          upload_session_id: invoice.uploadSessionId,
        });
      }
      const session = manager.create(InvoiceUploadSession, {
        id,
        invoiceId,
        filename,
        mimeType,
        fileSizeBytes: size,
        contentChecksum: checksum,
        receivedBytes: 0,
        state: "pending",
        cid: null,
      });
      await manager.save(session);
      invoice.uploadSessionId = id;
      invoice.uploadComplete = false;
      invoice.contentChecksum = checksum;
      invoice.checksumVerified = false;
      await manager.save(invoice);
      return uploadSessionView(session);
    });
  }

  async get(invoiceId: string, sellerId: string, sessionId: string) {
    return this.source.transaction(async (manager) => {
      await this.lockInvoice(manager, invoiceId, sellerId, false);
      return uploadSessionView(await this.lockSession(manager, invoiceId, sessionId));
    });
  }

  async append(
    invoiceId: string,
    sellerId: string,
    sessionId: string,
    offset: unknown,
    bytes: Buffer
  ) {
    if (
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0 ||
      bytes.length > MAX_UPLOAD_CHUNK_BYTES
    ) {
      throw new ServiceError(
        "invalid_chunk",
        "A nonempty chunk up to 1 MiB and a nonnegative integer offset are required",
        400
      );
    }
    return this.source.transaction(async (manager) => {
      const invoice = await this.lockInvoice(manager, invoiceId, sellerId);
      const session = await this.lockSession(manager, invoiceId, sessionId);
      this.assertCurrent(invoice, session);
      const existing = await manager.findOneBy(InvoiceUploadChunk, { sessionId, offset });
      if (existing && existing.bytes.equals(bytes)) return uploadSessionView(session);
      if (
        session.state !== "pending" ||
        offset !== session.receivedBytes ||
        offset + bytes.length > session.fileSizeBytes
      ) {
        throw new ServiceError(
          "upload_offset_conflict",
          "Chunk does not match the next upload offset",
          409,
          { received_bytes: session.receivedBytes }
        );
      }
      await manager.save(manager.create(InvoiceUploadChunk, { sessionId, offset, bytes }));
      session.receivedBytes += bytes.length;
      await manager.save(session);
      return uploadSessionView(session);
    });
  }

  async complete(invoiceId: string, sellerId: string, sessionId: string) {
    return this.source.transaction(async (manager) => {
      const invoice = await this.lockInvoice(manager, invoiceId, sellerId, false);
      const session = await this.lockSession(manager, invoiceId, sessionId);
      if (session.state === "complete") return uploadSessionView(session);
      this.assertCurrent(invoice, session);
      if (invoice.status !== InvoiceStatus.DRAFT)
        throw new ServiceError(
          "invalid_invoice_status",
          "Pending uploads require a draft invoice",
          409
        );
      if (session.receivedBytes !== session.fileSizeBytes) {
        throw new ServiceError(
          "upload_incomplete",
          "All bytes must be uploaded before completion",
          409,
          { received_bytes: session.receivedBytes }
        );
      }
      const chunks = await manager.find(InvoiceUploadChunk, {
        where: { sessionId },
        order: { offset: "ASC" },
      });
      const bytes = Buffer.concat(chunks.map((chunk) => chunk.bytes));
      if (bytes.length !== session.fileSizeBytes)
        throw new ServiceError("upload_incomplete", "Stored bytes do not match upload size", 409);
      const checksum = verifyDocumentChecksum(bytes, session.contentChecksum);
      const duplicate = await manager.getRepository(InvoiceDocument).findOneBy({
        invoiceId,
        contentChecksum: checksum,
      });
      if (duplicate) {
        throw new ServiceError(
          "duplicate_invoice_document",
          "This invoice document has already been uploaded",
          409,
          { document_id: duplicate.id, cid: duplicate.cid }
        );
      }
      // Failure rolls back completion only; acknowledged chunks remain resumable.
      const pinned = await this.ipfs.uploadFile(
        bytes,
        session.filename,
        session.mimeType,
        invoiceId
      );
      session.cid = pinned.hash;
      session.contentChecksum = checksum;
      session.state = "complete";
      await manager.save(session);
      invoice.ipfsHash = pinned.hash;
      invoice.contentChecksum = checksum;
      invoice.checksumVerified = true;
      invoice.uploadComplete = true;
      await manager.save(invoice);
      const documents = manager.getRepository(InvoiceDocument);
      const existing = await documents.findOneBy({ invoiceId, cid: pinned.hash });
      if (!existing) {
        await documents.save(
          documents.create({
            invoiceId,
            cid: pinned.hash,
            docType: InvoiceDocumentType.INVOICE_PDF,
            filename: session.filename,
            mimeType: session.mimeType,
            fileSize: bytes.length,
            contentChecksum: checksum,
            checksumVerified: true,
            uploadSessionId: session.id,
          })
        );
      }
      return uploadSessionView(session);
    });
  }

  async restart(
    invoiceId: string,
    sellerId: string,
    sessionId: string,
    body: Record<string, unknown> = {}
  ) {
    return this.source.transaction(async (manager) => {
      const invoice = await this.lockInvoice(manager, invoiceId, sellerId);
      const session = await this.lockSession(manager, invoiceId, sessionId);
      this.assertCurrent(invoice, session);
      if (session.state !== "pending")
        throw new ServiceError(
          "upload_state_conflict",
          "Only a pending upload can be restarted",
          409
        );
      const filename =
        body.filename === undefined ? session.filename : this.text(body.filename, "filename", 255);
      const mimeType =
        body.mime_type === undefined
          ? session.mimeType
          : this.text(body.mime_type, "mime_type", 128);
      const size =
        body.file_size_bytes === undefined ? session.fileSizeBytes : body.file_size_bytes;
      if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > 2_147_483_647)
        throw new ServiceError(
          "invalid_file_size",
          "file_size_bytes must be a positive integer",
          400
        );
      this.ipfs.validateUploadMetadata(size, mimeType);
      const checksum =
        body.content_checksum === undefined
          ? session.contentChecksum
          : parseContentChecksum(body.content_checksum);
      session.state = "restarted";
      await manager.save(session);
      await manager.delete(InvoiceUploadChunk, { sessionId });
      const replacement = manager.create(InvoiceUploadSession, {
        ...session,
        id: randomUUID(),
        filename,
        mimeType,
        fileSizeBytes: size,
        contentChecksum: checksum,
        state: "pending",
        receivedBytes: 0,
        cid: null,
      });
      await manager.save(replacement);
      invoice.uploadSessionId = replacement.id;
      invoice.contentChecksum = checksum;
      await manager.save(invoice);
      return uploadSessionView(replacement);
    });
  }

  private async lockInvoice(manager: EntityManager, id: string, sellerId: string, mutable = true) {
    if (!UUID.test(id)) throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    const invoice = await manager.findOne(Invoice, {
      where: { id },
      lock: { mode: "pessimistic_write" },
    });
    if (!invoice) throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    if (invoice.sellerId !== sellerId)
      throw new ServiceError(
        "unauthorized_invoice_access",
        "Only the invoice owner can upload documents",
        403
      );
    if (mutable && invoice.status !== InvoiceStatus.DRAFT)
      throw new ServiceError(
        "invalid_invoice_status",
        "Upload sessions require a draft invoice",
        409
      );
    return invoice;
  }

  private async lockSession(manager: EntityManager, invoiceId: string, id: string) {
    if (!UUID.test(id)) throw new ServiceError("upload_not_found", "Upload session not found", 404);
    const session = await manager.findOne(InvoiceUploadSession, {
      where: { id, invoiceId },
      lock: { mode: "pessimistic_write" },
    });
    if (!session) throw new ServiceError("upload_not_found", "Upload session not found", 404);
    return session;
  }

  private assertCurrent(invoice: Invoice, session: InvoiceUploadSession) {
    if (invoice.uploadSessionId !== session.id || session.state === "restarted")
      throw new ServiceError(
        "upload_state_conflict",
        "This session was superseded; use the current session",
        409,
        { upload_session_id: invoice.uploadSessionId }
      );
  }

  private text(value: unknown, field: string, max: number) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > max)
      throw new ServiceError(
        "invalid_upload_metadata",
        `${field} is required and must be at most ${max} characters`,
        400
      );
    return value.trim();
  }
}
