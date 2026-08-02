import { describe, expect, it } from "vitest";
import { DEMO_CAPTURE } from "./fixture";
import {
  CaptureEnvelopeSchema,
  NativeRequestSchema,
  NativeResponseSchema,
} from "./index";

describe("shared contracts", () => {
  it("validates the demo capture", () => {
    expect(CaptureEnvelopeSchema.parse(DEMO_CAPTURE).messages).toHaveLength(4);
  });

  it("rejects unsupported native protocol versions", () => {
    expect(() =>
      NativeRequestSchema.parse({
        protocolVersion: 2,
        type: "ping",
        requestId: "request-1",
      }),
    ).toThrow();
  });

  it("accepts a structured native response", () => {
    const response = NativeResponseSchema.parse({
      protocolVersion: 1,
      requestId: "request-1",
      ok: true,
      code: "OK",
      message: "pong",
    });

    expect(response.ok).toBe(true);
  });

  it("accepts copying a Markdown file through the native host", () => {
    const request = NativeRequestSchema.parse({
      protocolVersion: 1,
      type: "clipboard.file",
      requestId: "clipboard-1",
      filename: "FrameSync-reglas.md",
      content: "# Reglas",
    });

    expect(request.type).toBe("clipboard.file");
  });
});
