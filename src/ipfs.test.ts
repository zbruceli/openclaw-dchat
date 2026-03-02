import { describe, expect, it, vi, beforeEach } from "vitest";
import http from "http";
import { EventEmitter } from "events";
import { IpfsService, IPFS_FILE_TYPE, mimeToIpfsFileType, buildFileMetadata } from "./ipfs.js";
import { decryptAesGcm, encryptAesGcm, keyToByteArray, byteArrayToKey } from "./crypto.js";

describe("mimeToIpfsFileType", () => {
  it("maps image/* to IMAGE (1)", () => {
    expect(mimeToIpfsFileType("image/png")).toBe(IPFS_FILE_TYPE.IMAGE);
    expect(mimeToIpfsFileType("image/jpeg")).toBe(IPFS_FILE_TYPE.IMAGE);
    expect(mimeToIpfsFileType("image/gif")).toBe(IPFS_FILE_TYPE.IMAGE);
    expect(mimeToIpfsFileType("Image/WebP")).toBe(IPFS_FILE_TYPE.IMAGE);
  });

  it("maps audio/* to AUDIO (2)", () => {
    expect(mimeToIpfsFileType("audio/mpeg")).toBe(IPFS_FILE_TYPE.AUDIO);
    expect(mimeToIpfsFileType("audio/ogg")).toBe(IPFS_FILE_TYPE.AUDIO);
    expect(mimeToIpfsFileType("Audio/WAV")).toBe(IPFS_FILE_TYPE.AUDIO);
  });

  it("maps video/* to VIDEO (3)", () => {
    expect(mimeToIpfsFileType("video/mp4")).toBe(IPFS_FILE_TYPE.VIDEO);
    expect(mimeToIpfsFileType("Video/WebM")).toBe(IPFS_FILE_TYPE.VIDEO);
  });

  it("maps unknown types to FILE (0)", () => {
    expect(mimeToIpfsFileType("application/pdf")).toBe(IPFS_FILE_TYPE.FILE);
    expect(mimeToIpfsFileType("text/plain")).toBe(IPFS_FILE_TYPE.FILE);
  });

  it("defaults to IMAGE when undefined", () => {
    expect(mimeToIpfsFileType(undefined)).toBe(IPFS_FILE_TYPE.IMAGE);
  });
});

describe("IPFS_FILE_TYPE constants", () => {
  it("has correct values", () => {
    expect(IPFS_FILE_TYPE.FILE).toBe(0);
    expect(IPFS_FILE_TYPE.IMAGE).toBe(1);
    expect(IPFS_FILE_TYPE.AUDIO).toBe(2);
    expect(IPFS_FILE_TYPE.VIDEO).toBe(3);
  });
});

describe("IpfsService.buildMessageOptions", () => {
  const service = new IpfsService("10.0.0.1:5001");

  const fakeResult = {
    hash: "QmTestHash123",
    key: Buffer.alloc(16, 0xab),
    nonce: Buffer.alloc(12, 0xcd),
    nonceSize: 12,
  };

  it("produces correct wire format for IMAGE", () => {
    const opts = service.buildMessageOptions(fakeResult, IPFS_FILE_TYPE.IMAGE);

    expect(opts.ipfsHash).toBe("QmTestHash123");
    expect(opts.ipfsIp).toBe("10.0.0.1:5001");
    expect(opts.ipfsEncrypt).toBe(1);
    expect(opts.ipfsEncryptAlgorithm).toBe("AES/GCM/NoPadding");
    expect(opts.ipfsEncryptKeyBytes).toEqual(keyToByteArray(fakeResult.key));
    expect(opts.ipfsEncryptNonceSize).toBe(12);
    expect(opts.fileType).toBe(IPFS_FILE_TYPE.IMAGE);
  });

  it("produces correct wire format for AUDIO with duration", () => {
    const opts = service.buildMessageOptions(fakeResult, IPFS_FILE_TYPE.AUDIO, {
      mediaDuration: 5.3,
      fileMimeType: "audio/ogg",
    });

    expect(opts.fileType).toBe(IPFS_FILE_TYPE.AUDIO);
    expect(opts.mediaDuration).toBe(5.3);
    expect(opts.fileMimeType).toBe("audio/ogg");
  });

  it("produces correct wire format for FILE with name/ext", () => {
    const opts = service.buildMessageOptions(fakeResult, IPFS_FILE_TYPE.FILE, {
      fileName: "doc.pdf",
      fileExt: ".pdf",
      fileMimeType: "application/pdf",
      fileSize: 12345,
    });

    expect(opts.fileType).toBe(IPFS_FILE_TYPE.FILE);
    expect(opts.fileName).toBe("doc.pdf");
    expect(opts.fileExt).toBe(".pdf");
    expect(opts.fileMimeType).toBe("application/pdf");
    expect(opts.fileSize).toBe(12345);
  });

  it("omits optional extra fields when not provided", () => {
    const opts = service.buildMessageOptions(fakeResult, IPFS_FILE_TYPE.IMAGE);

    expect(opts.fileMimeType).toBeUndefined();
    expect(opts.fileName).toBeUndefined();
    expect(opts.fileExt).toBeUndefined();
    expect(opts.fileSize).toBeUndefined();
    expect(opts.mediaWidth).toBeUndefined();
    expect(opts.mediaHeight).toBeUndefined();
    expect(opts.mediaDuration).toBeUndefined();
  });

  it("includes image dimensions when provided", () => {
    const opts = service.buildMessageOptions(fakeResult, IPFS_FILE_TYPE.IMAGE, {
      mediaWidth: 1920,
      mediaHeight: 1080,
    });

    expect(opts.mediaWidth).toBe(1920);
    expect(opts.mediaHeight).toBe(1080);
  });
});

describe("IpfsService constructor", () => {
  it("parses host and port from gateway string", () => {
    const service = new IpfsService("192.168.1.1:8080");
    const opts = service.buildMessageOptions(
      { hash: "Qm", key: Buffer.alloc(16), nonce: Buffer.alloc(12), nonceSize: 12 },
      IPFS_FILE_TYPE.IMAGE,
    );
    expect(opts.ipfsIp).toBe("192.168.1.1:8080");
  });

  it("uses default gateway when none provided", () => {
    const service = new IpfsService();
    const opts = service.buildMessageOptions(
      { hash: "Qm", key: Buffer.alloc(16), nonce: Buffer.alloc(12), nonceSize: 12 },
      IPFS_FILE_TYPE.IMAGE,
    );
    expect(opts.ipfsIp).toBe("64.225.88.71:80");
  });
});

describe("encrypt → upload → download → decrypt round-trip", () => {
  it("data survives round-trip through encryption and key serialization", () => {
    // Simulate the full data flow without a real IPFS server:
    // 1. Encrypt (what upload does internally)
    const original = Buffer.from("Hello IPFS image data!");
    const { ciphertext, key, nonce } = encryptAesGcm(original);

    // 2. Serialize key to wire format (what buildMessageOptions does)
    const wireKeyBytes = keyToByteArray(key);
    const nonceSize = nonce.length;

    // 3. Deserialize and decrypt (what download does)
    const restoredKey = byteArrayToKey(wireKeyBytes);
    const decrypted = decryptAesGcm(ciphertext, restoredKey, nonceSize);

    expect(decrypted.toString()).toBe(original.toString());
  });
});

describe("IpfsService HTTP error handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects on non-200 response", async () => {
    // Mock http.request to return a 500 response
    const mockRes = new EventEmitter() as any;
    mockRes.statusCode = 500;

    const mockReq = new EventEmitter() as any;
    mockReq.write = vi.fn();
    mockReq.end = vi.fn();
    mockReq.destroy = vi.fn();

    vi.spyOn(http, "request").mockImplementation((_opts: any, callback: any) => {
      process.nextTick(() => {
        callback(mockRes);
        mockRes.emit("data", Buffer.from("Internal Server Error"));
        mockRes.emit("end");
      });
      return mockReq;
    });

    const service = new IpfsService("127.0.0.1:5001");
    await expect(service.upload(Buffer.from("test"))).rejects.toThrow("IPFS HTTP 500");
  });

  it("rejects on request timeout", async () => {
    const mockReq = new EventEmitter() as any;
    mockReq.write = vi.fn();
    mockReq.end = vi.fn();
    mockReq.destroy = vi.fn();

    vi.spyOn(http, "request").mockImplementation(() => {
      process.nextTick(() => {
        mockReq.emit("timeout");
      });
      return mockReq;
    });

    const service = new IpfsService("127.0.0.1:5001");
    await expect(service.upload(Buffer.from("test"))).rejects.toThrow("IPFS request timed out");
  });

  it("rejects on connection error", async () => {
    const mockReq = new EventEmitter() as any;
    mockReq.write = vi.fn();
    mockReq.end = vi.fn();
    mockReq.destroy = vi.fn();

    vi.spyOn(http, "request").mockImplementation(() => {
      process.nextTick(() => {
        mockReq.emit("error", new Error("ECONNREFUSED"));
      });
      return mockReq;
    });

    const service = new IpfsService("127.0.0.1:5001");
    await expect(service.upload(Buffer.from("test"))).rejects.toThrow("ECONNREFUSED");
  });

  it("download rejects on non-200 response", async () => {
    const mockRes = new EventEmitter() as any;
    mockRes.statusCode = 404;

    const mockReq = new EventEmitter() as any;
    mockReq.write = vi.fn();
    mockReq.end = vi.fn();
    mockReq.destroy = vi.fn();

    vi.spyOn(http, "request").mockImplementation((_opts: any, callback: any) => {
      process.nextTick(() => {
        callback(mockRes);
        mockRes.emit("data", Buffer.from("not found"));
        mockRes.emit("end");
      });
      return mockReq;
    });

    const service = new IpfsService("127.0.0.1:5001");
    await expect(
      service.download("QmMissing", { encrypt: 1, encryptKeyBytes: Array.from(Buffer.alloc(16)), encryptNonceSize: 12 }),
    ).rejects.toThrow("IPFS HTTP 404");
  });
});

describe("buildFileMetadata", () => {
  it("extracts extension from fileName", () => {
    const result = buildFileMetadata({
      buffer: Buffer.from("pdf content"),
      contentType: "application/pdf",
      fileName: "report.pdf",
    });
    expect(result.fileName).toBe("report.pdf");
    expect(result.fileExt).toBe("pdf");
    expect(result.fileSize).toBe(11);
  });

  it("derives extension from MIME when fileName has no extension", () => {
    const result = buildFileMetadata({
      buffer: Buffer.from("data"),
      contentType: "application/pdf",
      fileName: "report",
    });
    expect(result.fileName).toBe("report.pdf");
    expect(result.fileExt).toBe("pdf");
  });

  it("derives extension from MIME when no fileName", () => {
    const result = buildFileMetadata({
      buffer: Buffer.from("data"),
      contentType: "image/png",
    });
    expect(result.fileName).toBe("file.png");
    expect(result.fileExt).toBe("png");
  });

  it("falls back to bin for unknown MIME and no fileName", () => {
    const result = buildFileMetadata({
      buffer: Buffer.from("data"),
      contentType: "application/x-unknown",
    });
    expect(result.fileName).toBe("file.bin");
    expect(result.fileExt).toBe("bin");
  });

  it("handles docx MIME type", () => {
    const result = buildFileMetadata({
      buffer: Buffer.from("docx"),
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: "letter.docx",
    });
    expect(result.fileExt).toBe("docx");
    expect(result.fileName).toBe("letter.docx");
  });

  it("prefers fileName extension over MIME", () => {
    const result = buildFileMetadata({
      buffer: Buffer.from("data"),
      contentType: "application/octet-stream",
      fileName: "archive.tar.gz",
    });
    expect(result.fileExt).toBe("gz");
    expect(result.fileName).toBe("archive.tar.gz");
  });
});
