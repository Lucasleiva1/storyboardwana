import type { CaptureMode } from "@framesync/contracts";
import type { InjectedCapture } from "./messages";

export async function captureDocumentInjected(
  mode: CaptureMode,
): Promise<InjectedCapture> {
  type MessageWithElement = {
    element: Element;
    message: InjectedCapture["messages"][number];
  };

  const isChatGpt =
    location.hostname === "chatgpt.com" ||
    location.hostname === "chat.openai.com";
  const platform = isChatGpt ? "chatgpt" : "generic";
  const warnings: string[] = [];
  let skippedNodeCount = 0;

  function visible(element: Element) {
    const htmlElement = element as HTMLElement;
    const style = getComputedStyle(htmlElement);
    const rect = htmlElement.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function normalizeText(value: string) {
    return value
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function fingerprint(value: string) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function cleanHtml(element: Element) {
    const clone = element.cloneNode(true) as Element;
    clone
      .querySelectorAll("script,style,button,textarea,input,video,audio")
      .forEach((node) => node.remove());
    const html = clone.innerHTML;
    return html.length <= 300_000 ? html : null;
  }

  function roleFor(element: Element): "user" | "assistant" | "unknown" {
    const role =
      element.getAttribute("data-message-author-role") ??
      element
        .querySelector("[data-message-author-role]")
        ?.getAttribute("data-message-author-role");
    if (role === "user" || role === "assistant") return role;
    const testId = element.getAttribute("data-testid") ?? "";
    if (/user/i.test(testId)) return "user";
    if (/assistant/i.test(testId)) return "assistant";
    return "unknown";
  }

  function chatGptElements() {
    const usable = (element: Element) => {
      if (element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element as HTMLElement);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        normalizeText((element as HTMLElement).innerText ?? "").length > 0
      );
    };
    const firstUsefulGroup = [
      'main [data-testid^="conversation-turn-"]',
      "main [data-message-author-role]",
      "main article",
    ]
      .map((selector) =>
        Array.from(document.querySelectorAll(selector)).filter(usable),
      )
      .find((elements) => elements.length > 0);
    if (firstUsefulGroup) return Array.from(new Set(firstUsefulGroup));

    const main = document.querySelector("main");
    if (main && usable(main)) {
      warnings.push(
        "ChatGPT no expuso sus contenedores habituales; se usó el contenido textual completo del área principal.",
      );
      return [main];
    }
    return [];
  }

  function genericElements() {
    const root =
      document.querySelector("main,[role='main'],article") ?? document.body;
    const articleLike = Array.from(
      root.querySelectorAll(":scope > article,:scope > section,article"),
    ).filter(visible);
    if (articleLike.length > 1) return articleLike.slice(0, 200);
    return [root];
  }

  async function collectMessages() {
    const selected = normalizeText(getSelection()?.toString() ?? "");
    if (mode === "selection") {
      if (!selected) {
        warnings.push("No hay texto seleccionado en la página activa.");
        return [] as MessageWithElement[];
      }
      const anchor = getSelection()?.anchorNode?.parentElement ?? document.body;
      const messageFingerprint = await fingerprint(
        `unknown\n${selected}\n${location.href}`,
      );
      return [
        {
          element: anchor,
          message: {
            id: `selection-${messageFingerprint.slice(0, 16)}`,
            orderIndex: 0,
            role: "unknown" as const,
            text: selected,
            htmlSnapshot: null,
            messageFingerprint,
            sourceDomId: anchor.id || null,
            createdAt: null,
          },
        },
      ];
    }

    const elements = isChatGpt ? chatGptElements() : genericElements();
    const collected: MessageWithElement[] = [];
    for (const element of elements) {
      const text = normalizeText((element as HTMLElement).innerText ?? "");
      if (!text) {
        skippedNodeCount += 1;
        continue;
      }
      const role = isChatGpt ? roleFor(element) : "unknown";
      const messageFingerprint = await fingerprint(
        `${role}\n${text}\n${location.origin}`,
      );
      collected.push({
        element,
        message: {
          id: `message-${messageFingerprint.slice(0, 20)}`,
          orderIndex: collected.length,
          role,
          text,
          htmlSnapshot: cleanHtml(element),
          messageFingerprint,
          sourceDomId:
            element.id ||
            element.getAttribute("data-testid") ||
            element.getAttribute("data-message-id"),
          createdAt: element.querySelector("time")?.dateTime ?? null,
        },
      });
    }
    return collected;
  }

  async function collectImages(messages: MessageWithElement[]) {
    const candidates: InjectedCapture["imageCandidates"] = [];
    const imageElements = Array.from(document.querySelectorAll("img")).filter(
      (image) =>
        visible(image) && image.naturalWidth >= 96 && image.naturalHeight >= 96,
    );
    for (const [index, image] of imageElements.entries()) {
      const currentSrc = image.currentSrc || image.src || null;
      const srcsetCandidates = (image.srcset || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .flatMap((part) => {
          const [url, descriptor] = part.split(/\s+/);
          if (!url) return [];
          try {
            const normalizedUrl = new URL(url, location.href).href;
            return [
              {
                url: normalizedUrl,
                width: descriptor?.endsWith("w")
                  ? Number.parseInt(descriptor, 10) || null
                  : null,
                density: descriptor?.endsWith("x")
                  ? Number.parseFloat(descriptor) || null
                  : null,
              },
            ];
          } catch {
            return [];
          }
        });
      let sourceUrl: string | null = null;
      try {
        sourceUrl = currentSrc ? new URL(currentSrc, location.href).href : null;
      } catch {
        sourceUrl = null;
      }
      if (!sourceUrl) {
        skippedNodeCount += 1;
        continue;
      }
      const owner = messages.find(
        ({ element }) =>
          element.contains(image) ||
          image.closest("[data-message-author-role],article") === element,
      );
      const nearbyText = normalizeText(
        image.closest("figure")?.querySelector("figcaption")?.textContent ??
          image.alt ??
          "",
      );
      const sourceKey = `${sourceUrl}\n${owner?.message.messageFingerprint ?? ""}`;
      const imageFingerprint = await fingerprint(sourceKey);
      candidates.push({
        id: `image-${index}-${imageFingerprint.slice(0, 16)}`,
        kind: "image",
        messageFingerprint: owner?.message.messageFingerprint ?? null,
        sourceUrl,
        currentSrc: sourceUrl,
        srcsetCandidates,
        displayedWidth: image.getBoundingClientRect().width,
        displayedHeight: image.getBoundingClientRect().height,
        alt: image.alt || null,
        nearbyText: nearbyText || owner?.message.text.slice(0, 2_000) || null,
        durationMs: null,
        captureStrategy:
          srcsetCandidates.length > 0 ? "srcset" : "direct_fetch",
      });
    }
    const videos = Array.from(document.querySelectorAll("video")).filter(
      (video) => visible(video) && video.getBoundingClientRect().width >= 96,
    );
    for (const [index, video] of videos.entries()) {
      const rawUrl =
        video.currentSrc ||
        video.src ||
        video.querySelector("source")?.src ||
        "";
      let sourceUrl: string | null = null;
      try {
        sourceUrl = rawUrl ? new URL(rawUrl, location.href).href : null;
      } catch {
        sourceUrl = null;
      }
      if (!sourceUrl) {
        skippedNodeCount += 1;
        continue;
      }
      const owner = messages.find(
        ({ element }) =>
          element.contains(video) ||
          video.closest("[data-message-author-role],article") === element,
      );
      const nearbyText = normalizeText(
        video.closest("figure")?.querySelector("figcaption")?.textContent ??
          video.getAttribute("aria-label") ??
          owner?.message.text.slice(0, 2_000) ??
          "",
      );
      const videoFingerprint = await fingerprint(
        `${sourceUrl}\n${owner?.message.messageFingerprint ?? ""}`,
      );
      candidates.push({
        id: `video-${index}-${videoFingerprint.slice(0, 16)}`,
        kind: "video",
        messageFingerprint: owner?.message.messageFingerprint ?? null,
        sourceUrl,
        currentSrc: sourceUrl,
        srcsetCandidates: [],
        displayedWidth: video.getBoundingClientRect().width,
        displayedHeight: video.getBoundingClientRect().height,
        alt: video.getAttribute("aria-label"),
        nearbyText: nearbyText || null,
        durationMs:
          Number.isFinite(video.duration) && video.duration > 0
            ? Math.round(video.duration * 1_000)
            : null,
        captureStrategy: "direct_fetch",
      });
    }
    return candidates;
  }

  async function collectWithControlledScroll() {
    const scrollElement = document.scrollingElement ?? document.documentElement;
    const originalTop = scrollElement.scrollTop;
    const byFingerprint = new Map<string, MessageWithElement>();
    let stagnantCycles = 0;
    for (let cycle = 0; cycle < 18 && stagnantCycles < 3; cycle += 1) {
      const before = byFingerprint.size;
      for (const item of await collectMessages()) {
        byFingerprint.set(item.message.messageFingerprint, item);
      }
      stagnantCycles = byFingerprint.size === before ? stagnantCycles + 1 : 0;
      scrollElement.scrollTo({ top: 0, behavior: "auto" });
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    scrollElement.scrollTo({ top: originalTop, behavior: "auto" });
    const collected = Array.from(byFingerprint.values());
    collected.forEach((item, index) => {
      item.message.orderIndex = index;
    });
    warnings.push(
      "La captura completa incluye solo contenido que la página llegó a renderizar y hacer accesible.",
    );
    return collected;
  }

  const messageElements =
    mode === "full"
      ? await collectWithControlledScroll()
      : await collectMessages();
  const imageCandidates = await collectImages(messageElements);
  if (
    isChatGpt &&
    messageElements.every(({ message }) => message.role === "unknown")
  ) {
    warnings.push(
      "ChatGPT fue detectado, pero sus roles no pudieron determinarse de forma segura.",
    );
  }
  if (messageElements.length === 0) {
    warnings.push("No se detectaron mensajes para enviar.");
  }

  return {
    platform,
    sourceUrl: location.href,
    conversationTitle: document.title || null,
    messages: messageElements.map(({ message }) => message),
    imageCandidates,
    adapterId: isChatGpt ? "chatgpt.semantic.v1" : "generic.visible.v1",
    skippedNodeCount,
    warnings,
  };
}

export function manageSessionInjected(action: "start" | "status" | "stop"): {
  active: boolean;
  count: number;
  platform: "chatgpt" | "generic";
  sourceUrl: string;
  conversationTitle: string | null;
  messages: Array<{
    id: string;
    orderIndex: number;
    role: "user" | "assistant" | "unknown";
    text: string;
    htmlSnapshot: null;
    messageFingerprint: string;
    sourceDomId: string | null;
    createdAt: null;
  }>;
} {
  type SessionMessage = {
    id: string;
    orderIndex: number;
    role: "user" | "assistant" | "unknown";
    text: string;
    htmlSnapshot: null;
    messageFingerprint: string;
    sourceDomId: string | null;
    createdAt: null;
  };
  type SessionState = {
    active: boolean;
    seen: Set<string>;
    messages: SessionMessage[];
    observer: MutationObserver;
    timer: number | null;
  };
  type SessionWindow = Window & {
    __frameSyncCaptureSession?: SessionState;
  };

  const sessionWindow = window as SessionWindow;
  const isChatGpt =
    location.hostname === "chatgpt.com" ||
    location.hostname === "chat.openai.com";
  const platform = isChatGpt ? "chatgpt" : "generic";

  function normalize(value: string) {
    return value
      .replace(/\u00a0/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function fingerprint(value: string) {
    let hashA = 0x811c9dc5;
    let hashB = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      hashA = Math.imul(hashA ^ code, 0x01000193);
      hashB = Math.imul(hashB ^ code, 0x85ebca6b);
    }
    return `${(hashA >>> 0).toString(16).padStart(8, "0")}${(hashB >>> 0)
      .toString(16)
      .padStart(8, "0")}`;
  }

  function roleFor(element: Element): "user" | "assistant" | "unknown" {
    const role =
      element.getAttribute("data-message-author-role") ??
      element
        .querySelector("[data-message-author-role]")
        ?.getAttribute("data-message-author-role");
    return role === "user" || role === "assistant" ? role : "unknown";
  }

  function scan(state: SessionState, seedOnly: boolean) {
    const selector = isChatGpt
      ? "main [data-message-author-role],main [data-testid^='conversation-turn-'],main article"
      : "main article,main section,[role='main'] article";
    const nodes = Array.from(document.querySelectorAll(selector)).filter(
      (element, index, all) =>
        !all.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index && candidate.contains(element),
        ),
    );
    for (const element of nodes) {
      const text = normalize((element as HTMLElement).innerText ?? "");
      if (!text) continue;
      const role = isChatGpt ? roleFor(element) : "unknown";
      const value = fingerprint(`${role}\n${text}\n${location.origin}`);
      if (state.seen.has(value)) continue;
      state.seen.add(value);
      if (!seedOnly) {
        state.messages.push({
          id: `session-${value}`,
          orderIndex: state.messages.length,
          role,
          text,
          htmlSnapshot: null,
          messageFingerprint: value,
          sourceDomId:
            element.id ||
            element.getAttribute("data-testid") ||
            element.getAttribute("data-message-id"),
          createdAt: null,
        });
      }
    }
  }

  if (action === "start") {
    if (!sessionWindow.__frameSyncCaptureSession?.active) {
      const placeholder = {
        active: true,
        seen: new Set<string>(),
        messages: [],
        observer: null,
        timer: null,
      } as unknown as SessionState;
      const observer = new MutationObserver(() => {
        if (placeholder.timer !== null) {
          window.clearTimeout(placeholder.timer);
        }
        placeholder.timer = window.setTimeout(() => {
          scan(placeholder, false);
          placeholder.timer = null;
        }, 900);
      });
      placeholder.observer = observer;
      scan(placeholder, true);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      sessionWindow.__frameSyncCaptureSession = placeholder;
    }
  }

  const state = sessionWindow.__frameSyncCaptureSession;
  if (action === "stop" && state) {
    if (state.timer !== null) window.clearTimeout(state.timer);
    scan(state, false);
    state.observer.disconnect();
    state.active = false;
  }

  return {
    active: state?.active ?? false,
    count: state?.messages.length ?? 0,
    platform,
    sourceUrl: location.href,
    conversationTitle: document.title || null,
    messages: state?.messages ?? [],
  };
}
