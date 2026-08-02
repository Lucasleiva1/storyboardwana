import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { analyzeCapture } from "@framesync/analysis-engine";
import { CaptureEnvelopeSchema } from "@framesync/contracts";
import { captureDocumentInjected } from "./injected";

function installPage(html: string) {
  const { document, window } = parseHTML(html);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("location", new URL("https://chatgpt.com/c/test-scan"));
  vi.stubGlobal("Element", window.Element);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("getSelection", () => null);
  vi.stubGlobal("getComputedStyle", () => ({
    display: "block",
    visibility: "visible",
  }));
  return document;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser page scanner", () => {
  it("rescans from scratch and replaces prior shots with zero on an empty page", async () => {
    const document = installPage(`
      <html>
        <head><title>Conversación de prueba</title></head>
        <body>
          <main>
            <article data-testid="conversation-turn-0">
              <div data-message-author-role="user">Creá dos planos.</div>
            </article>
            <article data-testid="conversation-turn-1">
              <div data-message-author-role="assistant">
                <p>ESCENA 1 — Prueba</p>
                <p>P001 — Inicio</p>
                <p>La persona espera antes de caminar.</p>
                <p>P002 — Movimiento</p>
                <p>La persona comienza a caminar.</p>
              </div>
            </article>
          </main>
        </body>
      </html>
    `);

    const firstScan = await captureDocumentInjected("loaded");
    const firstCapture = CaptureEnvelopeSchema.parse({
      protocolVersion: 1,
      captureId: "first-scan",
      platform: firstScan.platform,
      sourceUrl: firstScan.sourceUrl,
      conversationTitle: firstScan.conversationTitle,
      captureMode: "loaded",
      capturedAt: new Date().toISOString(),
      messages: firstScan.messages,
      assets: [],
      diagnostics: {
        adapterId: firstScan.adapterId,
        detectedMessageCount: firstScan.messages.length,
        skippedNodeCount: firstScan.skippedNodeCount,
        warnings: firstScan.warnings,
      },
    });
    expect(analyzeCapture(firstCapture).shots).toHaveLength(2);

    document.body.innerHTML = "<main></main>";
    const secondScan = await captureDocumentInjected("loaded");
    const secondCapture = CaptureEnvelopeSchema.parse({
      ...firstCapture,
      captureId: "second-scan",
      messages: secondScan.messages,
      diagnostics: {
        adapterId: secondScan.adapterId,
        detectedMessageCount: secondScan.messages.length,
        skippedNodeCount: secondScan.skippedNodeCount,
        warnings: secondScan.warnings,
      },
    });

    expect(secondScan.messages).toHaveLength(0);
    expect(analyzeCapture(secondCapture).shots).toHaveLength(0);
  });
});
