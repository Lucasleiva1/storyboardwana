import {
  AssetManifestSchema,
  CaptureEnvelopeSchema,
  NativeRequestSchema,
  NativeResponseSchema,
  type AssetManifest,
  type ImageCandidate,
  type NativeRequest,
  type NativeResponse,
} from "@framesync/contracts";
import {
  captureDocumentInjected,
  manageSessionInjected,
} from "../lib/injected";
import type {
  BackgroundRequest,
  BackgroundResponse,
  CaptureDraft,
  InjectedCapture,
} from "../lib/messages";

const HOST_NAME = "com.framesync.capture";
const RAW_CHUNK_BYTES = 256 * 1024;
const MAX_EXTENSION_ASSET_BYTES = 50 * 1024 * 1024;

type PreparedAsset = {
  manifest: AssetManifest;
  bytes: Uint8Array;
};

function errorResponse(
  error: unknown,
  recoverable = true,
): BackgroundResponse {
  const message =
    error instanceof Error ? error.message : "Ocurrió un error desconocido.";
  return { ok: false, message, recoverable };
}

function requestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function activeHttpTab() {
  return chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      if (!tab?.id || !tab.url?.startsWith("http")) {
        throw new Error(
          "Abrí una página web normal antes de capturar. Chrome no permite inyectar en esta pestaña.",
        );
      }
      return tab;
    });
}

function toDraft(
  injected: InjectedCapture,
  mode: "full" | "loaded" | "selection" | "session",
): CaptureDraft {
  const capture = CaptureEnvelopeSchema.parse({
    protocolVersion: 1,
    captureId: crypto.randomUUID(),
    platform: injected.platform,
    sourceUrl: injected.sourceUrl,
    conversationTitle: injected.conversationTitle,
    captureMode: mode,
    capturedAt: new Date().toISOString(),
    messages: injected.messages,
    assets: [],
    diagnostics: {
      adapterId: injected.adapterId,
      detectedMessageCount: injected.messages.length,
      skippedNodeCount: injected.skippedNodeCount,
      warnings: injected.warnings,
    },
  });
  return { ...capture, imageCandidates: injected.imageCandidates };
}

async function capturePage(
  mode: "full" | "loaded" | "selection",
): Promise<CaptureDraft> {
  const tab = await activeHttpTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    world: "ISOLATED",
    func: captureDocumentInjected,
    args: [mode],
  });
  const injected = results[0]?.result;
  if (!injected) {
    throw new Error(
      "La página no devolvió una captura. Recargala y volvé a intentarlo.",
    );
  }
  return toDraft(injected, mode);
}

function nativeConnection() {
  const port = chrome.runtime.connectNative(HOST_NAME);
  const pending = new Map<
    string,
    {
      resolve: (response: NativeResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  let disconnectedError: Error | null = null;

  port.onMessage.addListener((message: unknown) => {
    const parsed = NativeResponseSchema.safeParse(message);
    if (!parsed.success) return;
    const waiter = pending.get(parsed.data.requestId);
    if (!waiter) return;
    pending.delete(parsed.data.requestId);
    waiter.resolve(parsed.data);
  });
  port.onDisconnect.addListener(() => {
    const detail =
      chrome.runtime.lastError?.message ??
      "El host nativo cerró la conexión.";
    disconnectedError = new Error(detail);
    for (const waiter of pending.values()) waiter.reject(disconnectedError);
    pending.clear();
  });

  return {
    async send(request: NativeRequest) {
      if (disconnectedError) throw disconnectedError;
      const validated = NativeRequestSchema.parse(request);
      return new Promise<NativeResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(validated.requestId);
          reject(new Error("El host nativo no respondió a tiempo."));
        }, 20_000);
        pending.set(validated.requestId, {
          resolve(response) {
            clearTimeout(timer);
            if (!response.ok) {
              reject(new Error(response.message));
              return;
            }
            resolve(response);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        port.postMessage(validated);
      });
    },
    disconnect() {
      port.disconnect();
    },
  };
}

async function pingHost() {
  const connection = nativeConnection();
  try {
    return await connection.send({
      protocolVersion: 1,
      type: "ping",
      requestId: requestId("ping"),
    });
  } finally {
    connection.disconnect();
  }
}

function chooseCandidateUrl(candidate: ImageCandidate) {
  const byWidth = [...candidate.srcsetCandidates].sort(
    (a, b) => (b.width ?? b.density ?? 0) - (a.width ?? a.density ?? 0),
  );
  return (
    byWidth[0]?.url ??
    candidate.sourceUrl ??
    candidate.currentSrc ??
    null
  );
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array) {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const buffer = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function prepareAsset(
  candidate: ImageCandidate,
): Promise<PreparedAsset | null> {
  const url = chooseCandidateUrl(candidate);
  if (!url || url.startsWith("blob:")) return null;
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) return null;
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_EXTENSION_ASSET_BYTES) return null;
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_EXTENSION_ASSET_BYTES) return null;
  const bytes = new Uint8Array(buffer);
  const mimeType =
    response.headers.get("content-type")?.split(";")[0]?.trim() ??
    "application/octet-stream";
  if (!mimeType.startsWith("image/")) return null;
  const hash = await sha256(bytes);
  const filename = (() => {
    try {
      const value = new URL(url).pathname.split("/").pop();
      return value ? decodeURIComponent(value).slice(0, 160) : null;
    } catch {
      return null;
    }
  })();
  const manifest = AssetManifestSchema.parse({
    id: candidate.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 128),
    messageFingerprint: candidate.messageFingerprint,
    kind: "image",
    role: "unassigned",
    originalFilename: filename,
    sourceUrl: url,
    mimeType,
    byteSize: bytes.byteLength,
    width:
      candidate.displayedWidth > 0
        ? Math.round(candidate.displayedWidth)
        : null,
    height:
      candidate.displayedHeight > 0
        ? Math.round(candidate.displayedHeight)
        : null,
    durationMs: null,
    sha256: hash,
    qualitySource:
      candidate.srcsetCandidates.length > 0
        ? "largest_dom_candidate"
        : "original",
  });
  return { manifest, bytes };
}

async function sendCapture(capture: CaptureDraft) {
  if (capture.messages.length === 0) {
    throw new Error("La captura está vacía y no se enviará.");
  }
  const preparedResults = await Promise.allSettled(
    capture.imageCandidates.slice(0, 24).map(prepareAsset),
  );
  const preparedAssets = preparedResults.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
  const skippedAssets = capture.imageCandidates.length - preparedAssets.length;
  const connection = nativeConnection();
  try {
    const { assets: _assets, imageCandidates: _candidates, ...captureHeader } =
      capture;
    await connection.send({
      protocolVersion: 1,
      type: "capture.begin",
      requestId: requestId("capture-begin"),
      capture: captureHeader,
    });

    for (const prepared of preparedAssets) {
      await connection.send({
        protocolVersion: 1,
        type: "asset.begin",
        requestId: requestId("asset-begin"),
        captureId: capture.captureId,
        asset: prepared.manifest,
      });
      let index = 0;
      for (
        let offset = 0;
        offset < prepared.bytes.length;
        offset += RAW_CHUNK_BYTES
      ) {
        await connection.send({
          protocolVersion: 1,
          type: "asset.chunk",
          requestId: requestId("asset-chunk"),
          captureId: capture.captureId,
          assetId: prepared.manifest.id,
          index,
          dataBase64: bytesToBase64(
            prepared.bytes.subarray(offset, offset + RAW_CHUNK_BYTES),
          ),
        });
        index += 1;
      }
      await connection.send({
        protocolVersion: 1,
        type: "asset.end",
        requestId: requestId("asset-end"),
        captureId: capture.captureId,
        assetId: prepared.manifest.id,
        sha256: prepared.manifest.sha256,
      });
    }
    const native = await connection.send({
      protocolVersion: 1,
      type: "capture.commit",
      requestId: requestId("capture-commit"),
      captureId: capture.captureId,
    });
    return {
      captureId: capture.captureId,
      transferredAssets: preparedAssets.length,
      skippedAssets,
      native,
    };
  } finally {
    connection.disconnect();
  }
}

async function controlSession(
  action: "start" | "status" | "stop",
): Promise<BackgroundResponse> {
  const tab = await activeHttpTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    world: "ISOLATED",
    func: manageSessionInjected,
    args: [action],
  });
  const snapshot = results[0]?.result;
  if (!snapshot) throw new Error("No se pudo consultar la sesión.");

  if (action !== "stop") {
    return {
      ok: true,
      session: { active: snapshot.active, count: snapshot.count },
    };
  }

  const injected: InjectedCapture = {
    platform: snapshot.platform,
    sourceUrl: snapshot.sourceUrl,
    conversationTitle: snapshot.conversationTitle,
    messages: snapshot.messages,
    imageCandidates: [],
    adapterId: `${snapshot.platform}.session.v1`,
    skippedNodeCount: 0,
    warnings: [
      "La sesión envía mensajes estabilizados; las imágenes se pueden capturar después desde Contenido cargado.",
    ],
  };
  const capture = toDraft(injected, "session");
  return {
    ok: true,
    session: {
      active: false,
      count: snapshot.count,
      capture,
    },
  };
}

export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  chrome.runtime.onMessage.addListener(
    (
      request: BackgroundRequest,
      _sender,
      sendResponse: (response: BackgroundResponse) => void,
    ) => {
      const task = (async (): Promise<BackgroundResponse> => {
        try {
          switch (request.type) {
            case "host.ping":
              return { ok: true, native: await pingHost() };
            case "capture.page":
              return {
                ok: true,
                capture: await capturePage(request.mode),
              };
            case "capture.send":
              return {
                ok: true,
                sent: await sendCapture(request.capture),
              };
            case "session.control":
              return controlSession(request.action);
          }
        } catch (error) {
          return errorResponse(error);
        }
      })();
      void task.then(sendResponse);
      return true;
    },
  );
});
