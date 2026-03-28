import type { AppConfig } from "../config/env";
import { ServiceError } from "../utils/service-error";

export interface IPFSUploadResult {
  hash: string;
  size: number;
  timestamp: string;
}

export interface IPFSServiceDependencies {
  config: AppConfig["ipfs"];
  fetchImplementation?: typeof fetch;
}

export interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

export class IPFSService {
  private readonly config: AppConfig["ipfs"];
  private readonly fetchImplementation: typeof fetch;

  constructor(dependencies: IPFSServiceDependencies) {
    this.config = dependencies.config;
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
  }

  async uploadFile(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<IPFSUploadResult> {
    // Validate file size
    const fileSizeMB = fileBuffer.length / (1024 * 1024);
    if (fileSizeMB > this.config.maxFileSizeMB) {
      throw new ServiceError(
        "file_too_large",
        `File size ${fileSizeMB.toFixed(2)}MB exceeds maximum allowed size of ${this.config.maxFileSizeMB}MB`,
        400,
      );
    }

    // Validate MIME type
    if (!this.config.allowedMimeTypes.includes(mimeType)) {
      throw new ServiceError(
        "invalid_file_type",
        `File type ${mimeType} is not allowed. Allowed types: ${this.config.allowedMimeTypes.join(", ")}`,
        400,
      );
    }

    try {
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: mimeType });
      formData.append("file", blob, filename);

      const response = await this.fetchImplementation(
        `${this.config.apiUrl}/pinning/pinFileToIPFS`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.jwt}`,
          },
          body: formData,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new ServiceError(
          "ipfs_upload_failed",
          `IPFS upload failed: ${response.status} ${response.statusText} - ${errorText}`,
          502,
        );
      }

      const result = await response.json() as PinataResponse;

      return {
        hash: result.IpfsHash,
        size: result.PinSize,
        timestamp: result.Timestamp,
      };
    } catch (error) {
      if (error instanceof ServiceError) {
        throw error;
      }

      throw new ServiceError(
        "ipfs_upload_error",
        `Failed to upload file to IPFS: ${error instanceof Error ? error.message : "Unknown error"}`,
        500,
      );
    }
  }
}

export function createIPFSService(config: AppConfig["ipfs"]): IPFSService {
  return new IPFSService({ config });
}