import { useEffect, useMemo, useState } from "react";
import type {
  BackgroundRequest,
  BackgroundResponse,
  CaptureDraft,
} from "../../lib/messages";

type Activity =
  | "idle"
  | "capturing"
  | "sending"
  | "sent"
  | "error";

async function requestBackground(
  request: BackgroundRequest,
): Promise<BackgroundResponse> {
  return chrome.runtime.sendMessage(request) as Promise<BackgroundResponse>;
}

export function App() {
  const [hostConnected, setHostConnected] = useState<boolean | null>(null);
  const [activity, setActivity] = useState<Activity>("idle");
  const [message, setMessage] = useState("Comprobando conexión local…");
  const [capture, setCapture] = useState<CaptureDraft | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);

  useEffect(() => {
    void requestBackground({ type: "host.ping" }).then((response) => {
      setHostConnected(response.ok);
      setMessage(
        response.ok
          ? "Host conectado y listo."
          : "Host no instalado o no autorizado.",
      );
    });
  }, []);

  const roleCounts = useMemo(() => {
    const counts = { user: 0, assistant: 0, unknown: 0 };
    for (const item of capture?.messages ?? []) counts[item.role] += 1;
    return counts;
  }, [capture]);

  async function capturePage(mode: "full" | "loaded" | "selection") {
    if (
      mode === "full" &&
      !window.confirm(
        "FrameSync moverá temporalmente el scroll para intentar cargar mensajes anteriores y luego restaurará tu posición. ¿Continuar?",
      )
    ) {
      return;
    }
    setActivity("capturing");
    setMessage("Leyendo contenido visible y preparando la vista previa…");
    const response = await requestBackground({ type: "capture.page", mode });
    if (!response.ok) {
      setActivity("error");
      setMessage(response.message);
      return;
    }
    if ("capture" in response) {
      setCapture(response.capture);
      setActivity("idle");
      setMessage(
        response.capture.messages.length > 0
          ? "Captura lista para revisar."
          : "La captura quedó vacía. Probá selección manual.",
      );
    }
  }

  async function controlSession(action: "start" | "stop") {
    setMessage(
      action === "start"
        ? "Activando seguimiento…"
        : "Cerrando la sesión y estabilizando mensajes…",
    );
    const response = await requestBackground({
      type: "session.control",
      action,
    });
    if (!response.ok || !("session" in response)) {
      setActivity("error");
      setMessage(response.ok ? "Respuesta de sesión incompleta." : response.message);
      return;
    }
    setSessionActive(response.session.active);
    setSessionCount(response.session.count);
    if (response.session.capture) setCapture(response.session.capture);
    setMessage(
      action === "start"
        ? "Seguimiento activo. Los mensajes se agregan cuando dejan de cambiar."
        : "Sesión detenida. Revisá el payload antes de enviarlo.",
    );
  }

  async function sendCapture() {
    if (!capture) return;
    setActivity("sending");
    setMessage("Transfiriendo fuente e imágenes al equipo…");
    const response = await requestBackground({
      type: "capture.send",
      capture,
    });
    if (!response.ok || !("sent" in response)) {
      setActivity("error");
      setMessage(response.ok ? "Respuesta de envío incompleta." : response.message);
      return;
    }
    setActivity("sent");
    setMessage(
      `Enviado. ${response.sent.transferredAssets} imágenes transferidas; ${response.sent.skippedAssets} conservaron solo su referencia.`,
    );
  }

  return (
    <main className="panel-shell">
      <header className="brand-row">
        <div className="brand-mark" aria-hidden="true">
          FS
        </div>
        <div>
          <p className="eyebrow">FRAMESYNC</p>
          <h1>CAPTURE</h1>
        </div>
        <span
          className={`host-dot ${hostConnected ? "online" : "offline"}`}
          title={hostConnected ? "Host conectado" : "Host sin conexión"}
        />
      </header>

      <section className="status-strip" aria-live="polite">
        <span className="status-label">HOST</span>
        <strong>
          {hostConnected === null
            ? "COMPROBANDO"
            : hostConnected
              ? "CONECTADO"
              : "SIN CONEXIÓN"}
        </strong>
        <p>{message}</p>
      </section>

      <section className="capture-actions">
        <div className="section-heading">
          <span>01</span>
          <h2>Capturar</h2>
        </div>
        <button
          className="primary"
          disabled={activity === "capturing"}
          onClick={() => void capturePage("full")}
        >
          Importar conversación completa
        </button>
        <div className="button-pair">
          <button
            disabled={activity === "capturing"}
            onClick={() => void capturePage("loaded")}
          >
            Contenido cargado
          </button>
          <button
            disabled={activity === "capturing"}
            onClick={() => void capturePage("selection")}
          >
            Selección
          </button>
        </div>
      </section>

      <section>
        <div className="section-heading">
          <span>02</span>
          <h2>Modo sesión</h2>
        </div>
        <div className="session-line">
          <div>
            <strong>{sessionActive ? "SIGUIENDO" : "INACTIVO"}</strong>
            <small>{sessionCount} mensajes nuevos</small>
          </div>
          <button
            className={sessionActive ? "danger" : ""}
            onClick={() =>
              void controlSession(sessionActive ? "stop" : "start")
            }
          >
            {sessionActive ? "Detener" : "Iniciar"}
          </button>
        </div>
      </section>

      <section className="payload">
        <div className="section-heading">
          <span>03</span>
          <h2>Revisar payload</h2>
        </div>
        {capture ? (
          <>
            <dl className="metrics">
              <div>
                <dt>Mensajes</dt>
                <dd>{capture.messages.length}</dd>
              </div>
              <div>
                <dt>Imágenes</dt>
                <dd>{capture.imageCandidates.length}</dd>
              </div>
              <div>
                <dt>Usuario</dt>
                <dd>{roleCounts.user}</dd>
              </div>
              <div>
                <dt>Asistente</dt>
                <dd>{roleCounts.assistant}</dd>
              </div>
            </dl>
            <div className="source-meta">
              <strong>{capture.conversationTitle ?? "Sin título"}</strong>
              <span>{capture.platform.toUpperCase()}</span>
              <p>{capture.sourceUrl}</p>
            </div>
            {capture.diagnostics.warnings.length > 0 && (
              <details>
                <summary>
                  {capture.diagnostics.warnings.length} advertencias
                </summary>
                <ul>
                  {capture.diagnostics.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : (
          <p className="empty">
            La captura aparecerá acá antes de enviarse. Nada se importa en
            silencio.
          </p>
        )}
      </section>

      <footer>
        <div>
          <span>DESTINO</span>
          <strong>Bandeja sin asignar</strong>
        </div>
        <button
          className="send"
          disabled={
            !capture ||
            capture.messages.length === 0 ||
            !hostConnected ||
            activity === "sending"
          }
          onClick={() => void sendCapture()}
        >
          {activity === "sending"
            ? "Enviando…"
            : activity === "sent"
              ? "Enviado ✓"
              : "Enviar a FrameSync"}
        </button>
      </footer>
    </main>
  );
}

