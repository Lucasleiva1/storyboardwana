import type {
  CaptureEnvelope,
  CaptureMessage,
  ImageCandidate,
  NativeResponse,
} from "@framesync/contracts";

export type CaptureDraft = CaptureEnvelope & {
  imageCandidates: ImageCandidate[];
};

export type SessionSnapshot = {
  active: boolean;
  count: number;
  capture?: CaptureDraft;
};

export type BackgroundRequest =
  | { type: "host.ping" }
  | {
      type: "capture.page";
      mode: "full" | "loaded" | "selection";
    }
  | {
      type: "capture.send";
      capture: CaptureDraft;
    }
  | {
      type: "session.control";
      action: "start" | "status" | "stop";
    };

export type BackgroundResponse =
  | { ok: true; native?: NativeResponse }
  | { ok: true; capture: CaptureDraft }
  | { ok: true; session: SessionSnapshot }
  | {
      ok: true;
      sent: {
        captureId: string;
        transferredAssets: number;
        skippedAssets: number;
        native: NativeResponse;
      };
    }
  | { ok: false; message: string; recoverable: boolean };

export type InjectedCapture = {
  platform: "chatgpt" | "generic";
  sourceUrl: string;
  conversationTitle: string | null;
  messages: CaptureMessage[];
  imageCandidates: ImageCandidate[];
  adapterId: string;
  skippedNodeCount: number;
  warnings: string[];
};

