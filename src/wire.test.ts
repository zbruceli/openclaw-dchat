import { describe, expect, it } from "vitest";
import type { MessageData } from "./types.js";
import {
  extractDmAddressFromSessionKey,
  extractGroupIdFromSessionKey,
  extractTopicFromSessionKey,
  genTopicHash,
  isControlMessage,
  isDisplayableMessage,
  nknToInbound,
  parseInlineMediaDataUri,
  parseNknPayload,
  receiptToNkn,
  stripNknSubClientPrefix,
  textToNkn,
} from "./wire.js";

describe("genTopicHash", () => {
  it("generates topic hash with dchat prefix", () => {
    const hash = genTopicHash("general");
    expect(hash).toMatch(/^dchat[0-9a-f]{40}$/);
  });

  it("strips leading # characters", () => {
    expect(genTopicHash("#general")).toBe(genTopicHash("general"));
    expect(genTopicHash("##general")).toBe(genTopicHash("general"));
  });

  it("produces consistent hashes", () => {
    expect(genTopicHash("d-chat")).toBe(genTopicHash("d-chat"));
  });

  it("produces different hashes for different topics", () => {
    expect(genTopicHash("alpha")).not.toBe(genTopicHash("beta"));
  });
});

describe("parseNknPayload", () => {
  it("parses valid JSON message", () => {
    const msg: MessageData = {
      id: "test-123",
      contentType: "text",
      content: "hello",
      timestamp: Date.now(),
    };
    const result = parseNknPayload(JSON.stringify(msg));
    expect(result).toEqual(msg);
  });

  it("returns null for invalid JSON", () => {
    expect(parseNknPayload("not json")).toBeNull();
  });

  it("returns null for missing required fields", () => {
    expect(parseNknPayload(JSON.stringify({ id: "test" }))).toBeNull();
    expect(parseNknPayload(JSON.stringify({ contentType: "text" }))).toBeNull();
  });

  it("returns null for non-object values", () => {
    expect(parseNknPayload(JSON.stringify(42))).toBeNull();
    expect(parseNknPayload(JSON.stringify(null))).toBeNull();
  });
});

describe("isControlMessage / isDisplayableMessage", () => {
  it("identifies control messages", () => {
    expect(isControlMessage("receipt")).toBe(true);
    expect(isControlMessage("read")).toBe(true);
    expect(isControlMessage("contact")).toBe(true);
    expect(isControlMessage("topic:subscribe")).toBe(true);
    expect(isControlMessage("discovery:broadcast")).toBe(true);
  });

  it("identifies displayable messages", () => {
    expect(isDisplayableMessage("text")).toBe(true);
    expect(isDisplayableMessage("textExtension")).toBe(true);
    expect(isDisplayableMessage("ipfs")).toBe(true);
    expect(isDisplayableMessage("audio")).toBe(true);
  });

  it("control messages are not displayable", () => {
    expect(isDisplayableMessage("receipt")).toBe(false);
    expect(isControlMessage("text")).toBe(false);
  });
});

describe("nknToInbound", () => {
  const selfAddr = "self-address-abc123";

  it("translates direct text message", () => {
    const msg: MessageData = {
      id: "msg-1",
      contentType: "text",
      content: "Hello from NKN",
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender-addr-xyz789", msg, selfAddr);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("Hello from NKN");
    expect(result!.chatType).toBe("direct");
    expect(result!.sessionKey).toBe("dchat:dm:sender-addr-xyz789");
    expect(result!.senderId).toBe("sender-addr-xyz789");
  });

  it("scopes DM session key to account identity", () => {
    const msg: MessageData = {
      id: "msg-acct",
      contentType: "text",
      content: "multi-account test",
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender-addr", msg, selfAddr, { accountId: "work" });
    expect(result!.sessionKey).toBe("dchat:work:dm:sender-addr");

    // default account omits the account prefix for backwards compat
    const resultDefault = nknToInbound("sender-addr", msg, selfAddr, { accountId: "default" });
    expect(resultDefault!.sessionKey).toBe("dchat:dm:sender-addr");

    // no accountId also omits prefix
    const resultNone = nknToInbound("sender-addr", msg, selfAddr);
    expect(resultNone!.sessionKey).toBe("dchat:dm:sender-addr");
  });

  it("translates topic message", () => {
    const msg: MessageData = {
      id: "msg-2",
      contentType: "text",
      content: "Hello topic",
      topic: "general",
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender-addr", msg, selfAddr);
    expect(result).not.toBeNull();
    expect(result!.chatType).toBe("group");
    expect(result!.sessionKey).toBe("dchat:topic:general");
    expect(result!.groupSubject).toBe("#general");
  });

  it("translates IPFS image message", () => {
    const msg: MessageData = {
      id: "msg-3",
      contentType: "ipfs",
      content: "QmXyz...",
      options: { fileType: 1, ipfsHash: "QmXyz..." },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("[Image]");
    expect(result!.ipfsHash).toBe("QmXyz...");
  });

  it("translates IPFS file message", () => {
    const msg: MessageData = {
      id: "msg-4",
      contentType: "ipfs",
      content: "QmAbc...",
      options: { fileType: 0, fileName: "report.pdf" },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.body).toBe("[File: report.pdf]");
  });

  it("translates audio message", () => {
    const msg: MessageData = {
      id: "msg-5",
      contentType: "audio",
      content: "base64data...",
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.body).toBe("[Voice Message]");
  });

  it("extracts IPFS hash from audio message with options.ipfsHash", () => {
    const msg: MessageData = {
      id: "msg-audio-ipfs-1",
      contentType: "audio",
      content: "QmAudioHash...",
      options: {
        ipfsHash: "QmAudioHash...",
        ipfsEncrypt: 1,
        ipfsEncryptAlgorithm: "AES/GCM/NoPadding",
        ipfsEncryptKeyBytes: Array.from(Buffer.alloc(16, 0xab)),
        ipfsEncryptNonceSize: 12,
        fileType: 2,
        mediaDuration: 5.3,
      },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.body).toBe("[Voice Message]");
    expect(result!.ipfsHash).toBe("QmAudioHash...");
    expect(result!.ipfsOptions).toBeDefined();
    expect(result!.ipfsOptions!.ipfsEncrypt).toBe(1);
    expect(result!.ipfsOptions!.mediaDuration).toBe(5.3);
  });

  it("extracts IPFS hash from audio message content when options.ipfsHash is missing", () => {
    const msg: MessageData = {
      id: "msg-audio-ipfs-2",
      contentType: "audio",
      content: "QmAudioContentHash",
      options: {
        ipfsEncrypt: 1,
        ipfsEncryptKeyBytes: Array.from(Buffer.alloc(16, 0xcd)),
        ipfsEncryptNonceSize: 12,
      },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.ipfsHash).toBe("QmAudioContentHash");
    expect(result!.ipfsOptions).toBeDefined();
  });

  it("translates IPFS audio message (contentType ipfs, fileType 2)", () => {
    const msg: MessageData = {
      id: "msg-ipfs-audio",
      contentType: "ipfs",
      content: "QmIpfsAudio...",
      options: {
        ipfsHash: "QmIpfsAudio...",
        fileType: 2,
        mediaDuration: 12.5,
      },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.body).toBe("[Audio]");
    expect(result!.ipfsHash).toBe("QmIpfsAudio...");
    expect(result!.ipfsOptions!.mediaDuration).toBe(12.5);
  });

  it("returns null for control messages", () => {
    const receipt: MessageData = {
      id: "msg-6",
      contentType: "receipt",
      targetID: "msg-1",
      timestamp: Date.now(),
    };
    expect(nknToInbound("sender", receipt, selfAddr)).toBeNull();

    const readReceipt: MessageData = {
      id: "msg-7",
      contentType: "read",
      readIds: ["msg-1"],
      timestamp: Date.now(),
    };
    expect(nknToInbound("sender", readReceipt, selfAddr)).toBeNull();
  });

  it("handles textExtension content type", () => {
    const msg: MessageData = {
      id: "msg-8",
      contentType: "textExtension",
      content: "burn after read message",
      options: { deleteAfterSeconds: 3600 },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.body).toBe("burn after read message");
  });
});

describe("textToNkn", () => {
  it("creates text MessageData", () => {
    const msg = textToNkn("Hello world");
    expect(msg.contentType).toBe("text");
    expect(msg.content).toBe("Hello world");
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(msg.topic).toBeUndefined();
  });

  it("sets topic field for topic messages", () => {
    const msg = textToNkn("Hello topic", { topic: "general" });
    expect(msg.topic).toBe("general");
  });

  it("sets groupId for group messages", () => {
    const msg = textToNkn("Hello group", { groupId: "group-123" });
    expect(msg.groupId).toBe("group-123");
  });
});

describe("receiptToNkn", () => {
  it("creates receipt MessageData", () => {
    const msg = receiptToNkn("original-msg-id");
    expect(msg.contentType).toBe("receipt");
    expect(msg.targetID).toBe("original-msg-id");
  });
});

describe("session key extractors", () => {
  it("extracts topic from session key", () => {
    expect(extractTopicFromSessionKey("dchat:topic:general")).toBe("general");
    expect(extractTopicFromSessionKey("dchat:dm:addr")).toBeUndefined();
  });

  it("extracts group ID from session key", () => {
    expect(extractGroupIdFromSessionKey("dchat:group:abc123")).toBe("abc123");
    expect(extractGroupIdFromSessionKey("dchat:dm:addr")).toBeUndefined();
  });

  it("extracts DM address from session key", () => {
    expect(extractDmAddressFromSessionKey("dchat:dm:some-nkn-addr")).toBe("some-nkn-addr");
    expect(extractDmAddressFromSessionKey("dchat:topic:general")).toBeUndefined();
  });

  it("extracts DM address from account-scoped session key", () => {
    expect(extractDmAddressFromSessionKey("dchat:work:dm:some-nkn-addr")).toBe("some-nkn-addr");
  });
});

describe("stripNknSubClientPrefix", () => {
  it("strips __N__. prefix", () => {
    expect(stripNknSubClientPrefix("__0__.cd3530abcdef")).toBe("cd3530abcdef");
    expect(stripNknSubClientPrefix("__3__.cd3530abcdef")).toBe("cd3530abcdef");
    expect(stripNknSubClientPrefix("__12__.cd3530abcdef")).toBe("cd3530abcdef");
  });

  it("leaves plain addresses unchanged", () => {
    expect(stripNknSubClientPrefix("cd3530abcdef")).toBe("cd3530abcdef");
  });
});

describe("parseInlineMediaDataUri", () => {
  it("parses D-Chat markdown audio data-URI (audio/x-aac)", () => {
    const raw = "![audio](data:audio/x-aac;base64,AAAA)";
    const result = parseInlineMediaDataUri(raw);
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("audio/x-aac");
    expect(result!.buffer).toEqual(Buffer.from("AAAA", "base64"));
  });

  it("parses nMobile markdown audio data-URI (audio/aac)", () => {
    const b64 = Buffer.from("hello audio").toString("base64");
    const raw = `![audio](data:audio/aac;base64,${b64})`;
    const result = parseInlineMediaDataUri(raw);
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("audio/aac");
    expect(result!.buffer.toString()).toBe("hello audio");
  });

  it("parses raw data-URI without markdown wrapper", () => {
    const b64 = Buffer.from("raw data").toString("base64");
    const raw = `data:audio/ogg;base64,${b64}`;
    const result = parseInlineMediaDataUri(raw);
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("audio/ogg");
    expect(result!.buffer.toString()).toBe("raw data");
  });

  it("returns null for non-data-URI content", () => {
    expect(parseInlineMediaDataUri("QmSomeIpfsHash")).toBeNull();
    expect(parseInlineMediaDataUri("just plain text")).toBeNull();
    expect(parseInlineMediaDataUri("")).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(parseInlineMediaDataUri("data:audio/aac;utf8,notbase64")).toBeNull();
  });
});

describe("nknToInbound — inline audio", () => {
  const selfAddr = "self-address-abc123";

  it("sets inlineMediaDataUri for audio with data-URI content", () => {
    const b64 = Buffer.from("aac-audio-data").toString("base64");
    const msg: MessageData = {
      id: "msg-voice-1",
      contentType: "audio",
      content: `![audio](data:audio/x-aac;base64,${b64})`,
      options: { fileType: 2, fileExt: "aac", mediaDuration: 3.5 },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.body).toBe("[Voice Message]");
    expect(result!.inlineMediaDataUri).toBe(msg.content);
    // ipfsHash should also be set as fallback (content contains "data:" but also matches)
    // but IPFS download will fail gracefully — inline path takes priority in channel.ts
  });

  it("does not set inlineMediaDataUri for audio without data-URI", () => {
    const msg: MessageData = {
      id: "msg-voice-2",
      contentType: "audio",
      content: "QmSomeHash",
      options: { ipfsHash: "QmSomeHash" },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.inlineMediaDataUri).toBeUndefined();
    expect(result!.ipfsHash).toBe("QmSomeHash");
  });
});
