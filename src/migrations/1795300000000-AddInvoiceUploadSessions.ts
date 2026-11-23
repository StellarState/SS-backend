import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInvoiceUploadSessions1795300000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE invoices
      ADD COLUMN content_checksum varchar(64),
      ADD COLUMN upload_session_id uuid,
      ADD COLUMN upload_complete boolean NOT NULL DEFAULT true,
      ADD COLUMN checksum_verified boolean NOT NULL DEFAULT false`);
    await runner.query(`ALTER TABLE invoice_documents
      ADD COLUMN content_checksum varchar(64),
      ADD COLUMN upload_session_id uuid,
      ADD COLUMN checksum_verified boolean NOT NULL DEFAULT false`);
    await runner.query(`CREATE TABLE invoice_upload_sessions (
      id uuid PRIMARY KEY,
      invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      filename varchar(255) NOT NULL,
      mime_type varchar(128) NOT NULL,
      file_size_bytes integer NOT NULL CHECK (file_size_bytes > 0),
      content_checksum varchar(64) CHECK (content_checksum ~ '^[a-f0-9]{64}$'),
      received_bytes integer NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= file_size_bytes),
      state varchar(16) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete', 'restarted')),
      cid varchar(128)
    )`);
    await runner.query(
      `CREATE INDEX idx_upload_sessions_invoice ON invoice_upload_sessions(invoice_id)`
    );
    await runner.query(`CREATE TABLE invoice_upload_chunks (
      session_id uuid NOT NULL REFERENCES invoice_upload_sessions(id) ON DELETE CASCADE,
      "offset" integer NOT NULL CHECK ("offset" >= 0),
      bytes bytea NOT NULL,
      PRIMARY KEY (session_id, "offset")
    )`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE invoice_upload_chunks`);
    await runner.query(`DROP TABLE invoice_upload_sessions`);
    await runner.query(
      `ALTER TABLE invoice_documents DROP COLUMN content_checksum, DROP COLUMN upload_session_id, DROP COLUMN checksum_verified`
    );
    await runner.query(
      `ALTER TABLE invoices DROP COLUMN content_checksum, DROP COLUMN upload_session_id, DROP COLUMN upload_complete, DROP COLUMN checksum_verified`
    );
  }
}
