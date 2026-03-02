import http from "http";
import https from "https";
import { encryptAesGcm, decryptAesGcm, keyToByteArray, byteArrayToKey } from "./crypto.js";
import type { MessageOptions } from "./types.js";

/** IPFS file type constants matching nMobile wire format. */
export const IPFS_FILE_TYPE = {
  FILE: 0,
  IMAGE: 1,
  AUDIO: 2,
  VIDEO: 3,
} as const;

/** Map a MIME type string to an nMobile IPFS file type number. */
export function mimeToIpfsFileType(mime?: string): number {
  if (!mime) return IPFS_FILE_TYPE.IMAGE; // default to image
  const lower = mime.toLowerCase();
  if (lower.startsWith("image/")) return IPFS_FILE_TYPE.IMAGE;
  if (lower.startsWith("audio/")) return IPFS_FILE_TYPE.AUDIO;
  if (lower.startsWith("video/")) return IPFS_FILE_TYPE.VIDEO;
  return IPFS_FILE_TYPE.FILE;
}

/** Common MIME → extension mappings for file transfers. */
const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/xml": "xml",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/**
 * Build file metadata (fileName, fileExt, fileSize) for outbound media.
 * Derives extension from the original filename or MIME type.
 */
export function buildFileMetadata(media: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
}): { fileName: string; fileExt: string; fileSize: number } {
  let ext: string | undefined;
  let name = media.fileName;

  // Try to get extension from filename
  if (name) {
    const dotIdx = name.lastIndexOf(".");
    if (dotIdx > 0) {
      ext = name.substring(dotIdx + 1).toLowerCase();
    }
  }

  // Fall back to MIME type
  if (!ext && media.contentType) {
    ext = MIME_TO_EXT[media.contentType.toLowerCase()];
  }

  ext = ext || "bin";

  // Ensure filename has extension
  if (!name) {
    name = `file.${ext}`;
  } else if (!name.includes(".")) {
    name = `${name}.${ext}`;
  }

  return { fileName: name, fileExt: ext, fileSize: media.buffer.length };
}

export interface IpfsUploadResult {
  hash: string;
  key: Buffer;
  nonce: Buffer;
  nonceSize: number;
}

const DEFAULT_TIMEOUT = 60_000;

/**
 * IPFS service for uploading/downloading encrypted media
 * via an IPFS HTTP API gateway (compatible with nMobile).
 */
export class IpfsService {
  private host: string;
  private port: number;
  private protocol: "http" | "https";

  constructor(gateway?: string) {
    const gw = gateway ?? "64.225.88.71:80";
    const parts = gw.split(":");
    this.host = parts[0];
    this.port = parseInt(parts[1] ?? "80", 10);
    this.protocol = this.port === 443 ? "https" : "http";
  }

  /**
   * Encrypt plaintext with AES-128-GCM, then upload to IPFS via /api/v0/add.
   */
  async upload(plaintext: Buffer): Promise<IpfsUploadResult> {
    const { ciphertext, key, nonce } = encryptAesGcm(plaintext);

    const boundary = "----IpfsBoundary" + Date.now().toString(36);
    const fieldName = "file";
    const fileName = "upload";

    // Build multipart form-data manually
    const header = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, ciphertext, footer]);

    const responseBody = await this._request("POST", "/api/v0/add", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });

    const result = JSON.parse(responseBody);
    const hash = result.Hash;
    if (!hash) {
      throw new Error(`IPFS add response missing Hash: ${responseBody}`);
    }

    return { hash, key, nonce, nonceSize: nonce.length };
  }

  /**
   * Download from IPFS via /api/v0/cat, then decrypt with AES-128-GCM.
   */
  async download(
    hash: string,
    encryptOpts: {
      encrypt?: number;
      encryptKeyBytes?: number[];
      encryptNonceSize?: number;
    },
  ): Promise<Buffer> {
    const responseBody = await this._requestRaw("POST", `/api/v0/cat?arg=${hash}`);

    if (!encryptOpts.encrypt || !encryptOpts.encryptKeyBytes) {
      // Not encrypted — return raw
      return responseBody;
    }

    const key = byteArrayToKey(encryptOpts.encryptKeyBytes);
    const nonceSize = encryptOpts.encryptNonceSize ?? 12;
    return decryptAesGcm(responseBody, key, nonceSize);
  }

  /**
   * Build nMobile-compatible MessageOptions from an upload result.
   */
  buildMessageOptions(
    uploadResult: IpfsUploadResult,
    fileType: number,
    extra?: {
      fileMimeType?: string;
      fileName?: string;
      fileExt?: string;
      fileSize?: number;
      mediaWidth?: number;
      mediaHeight?: number;
      mediaDuration?: number;
    },
  ): MessageOptions {
    const options: MessageOptions = {
      ipfsHash: uploadResult.hash,
      ipfsIp: `${this.host}:${this.port}`,
      ipfsEncrypt: 1,
      ipfsEncryptAlgorithm: "AES/GCM/NoPadding",
      ipfsEncryptKeyBytes: keyToByteArray(uploadResult.key),
      ipfsEncryptNonceSize: uploadResult.nonceSize,
      fileType,
    };

    if (extra?.fileMimeType) options.fileMimeType = extra.fileMimeType;
    if (extra?.fileName) options.fileName = extra.fileName;
    if (extra?.fileExt) options.fileExt = extra.fileExt;
    if (extra?.fileSize !== undefined) options.fileSize = extra.fileSize;
    if (extra?.mediaWidth !== undefined) options.mediaWidth = extra.mediaWidth;
    if (extra?.mediaHeight !== undefined) options.mediaHeight = extra.mediaHeight;
    if (extra?.mediaDuration !== undefined) options.mediaDuration = extra.mediaDuration;

    return options;
  }

  /** HTTP request returning text response. */
  private _request(
    method: string,
    path: string,
    body?: Buffer,
    headers?: Record<string, string>,
  ): Promise<string> {
    return this._requestRaw(method, path, body, headers).then((buf) => buf.toString("utf-8"));
  }

  /** HTTP request returning raw Buffer response. */
  private _requestRaw(
    method: string,
    path: string,
    body?: Buffer,
    headers?: Record<string, string>,
  ): Promise<Buffer> {
    const transport = this.protocol === "https" ? https : http;

    return new Promise<Buffer>((resolve, reject) => {
      const req = transport.request(
        {
          hostname: this.host,
          port: this.port,
          path,
          method,
          headers: {
            ...headers,
            ...(body ? { "Content-Length": body.length.toString() } : {}),
          },
          timeout: DEFAULT_TIMEOUT,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const result = Buffer.concat(chunks);
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              reject(
                new Error(
                  `IPFS HTTP ${res.statusCode}: ${result.toString("utf-8").slice(0, 200)}`,
                ),
              );
              return;
            }
            resolve(result);
          });
          res.on("error", reject);
        },
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("IPFS request timed out"));
      });
      req.on("error", reject);

      if (body) req.write(body);
      req.end();
    });
  }
}
