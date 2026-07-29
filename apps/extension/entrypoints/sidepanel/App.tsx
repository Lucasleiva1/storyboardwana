import { useEffect, useMemo, useState } from "react";
import type {
  WorkspaceContext,
  WorkspaceProjectSummary,
} from "@framesync/contracts";
import type {
  BackgroundRequest,
  BackgroundResponse,
  CaptureDraft,
} from "../../lib/messages";

type Activity = "idle" | "capturing" | "sending" | "sent" | "error";

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
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");

  useEffect(() => {
    void (async () => {
      const host = await requestBackground({ type: "host.ping" });
      setHostConnected(host.ok);
      if (!host.ok) {
        setMessage("Host no instalado o no autorizado.");
        return;
      }
      const response = await requestBackground({ type: "workspace.list" });
      if (!response.ok || !("workspace" in response)) {
        setMessage(
          response.ok
            ? "No se recibió la lista de proyectos."
            : response.message,
        );
        return;
      }
      setWorkspace(response.workspace);
      const stored = await chrome.storage.local.get(
        "framesyncSelectedProjectId",
      );
      const storedId =
        typeof stored.framesyncSelectedProjectId === "string"
          ? stored.framesyncSelectedProjectId
          : "";
      const selected =
        response.workspace.projects.find((item) => item.id === storedId) ??
        response.workspace.projects[0] ??
        null;
      setSelectedProjectId(selected?.id ?? "");
      setMessage(
        selected
          ? "Host conectado. Proyecto sincronizado."
          : "Host conectado. Creá un proyecto en FrameSync y actualizá esta lista.",
      );
    })();
  }, []);

  const selectedProject = useMemo(
    () =>
      workspace?.projects.find((item) => item.id === selectedProjectId) ?? null,
    [workspace, selectedProjectId],
  );

  async function refreshWorkspace() {
    const response = await requestBackground({ type: "workspace.list" });
    if (!response.ok || !("workspace" in response)) {
      setMessage(
        response.ok ? "No se recibió la lista de proyectos." : response.message,
      );
      return;
    }
    setWorkspace(response.workspace);
    const selected =
      response.workspace.projects.find(
        (item) => item.id === selectedProjectId,
      ) ??
      response.workspace.projects[0] ??
      null;
    setSelectedProjectId(selected?.id ?? "");
    setMessage(
      selected
        ? "Lista de proyectos actualizada."
        : "Todavía no hay proyectos creados en FrameSync.",
    );
  }

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId);
    void chrome.storage.local.set({
      framesyncSelectedProjectId: projectId,
    });
  }

  function projectRules(project: WorkspaceProjectSummary) {
    const projectLabel = `PRJ-${String(project.projectNumber).padStart(4, "0")}`;
    return `REGLAS DE ESTRUCTURA PARA FRAMESYNC

Proyecto: ${projectLabel} · ${project.name}
Identificador interno: ${project.id}

1. EPISODIO es opcional. Usar "EPISODIO 1 — Título".
2. Dentro del episodio, dividir el contenido en "ESCENA 1 — Título", "ESCENA 2 — Título", etc.
3. Los PLANOS son globales para todo el proyecto: nunca reiniciar su numeración al cambiar de escena o episodio.
4. Este proyecto ya contiene planos normales hasta P${String(project.lastShotNumber).padStart(3, "0")}.
5. El próximo plano nuevo debe ser P${String(project.nextShotNumber).padStart(3, "0")}; continuar P${String(project.nextShotNumber + 1).padStart(3, "0")}, P${String(project.nextShotNumber + 2).padStart(3, "0")}, sin saltos ni repeticiones.
6. Formato de plano normal: "PLANO ${project.nextShotNumber} — Título" o "P${String(project.nextShotNumber).padStart(3, "0")} — Título".
7. Un plano especial sin número debe indicarse como "PLANO ESPECIAL — Título". No reutilizar un número normal.
8. Una variante debe indicarse como "VARIANTE DE PLANO N — Título".
9. Para cada plano incluir, cuando corresponda: descripción visual, acción, encuadre, ángulo, movimiento, duración, diálogo, prompt de imagen y prompt de video.
10. Para asociar medios posteriores, escribir siempre el código exacto del plano: "PRIMER FRAME PNNN", "STORYBOARD PNNN" o "VIDEO FINAL PNNN".

PLANTILLA RECOMENDADA:

EPISODIO N — Título (opcional)
ESCENA N — Título
P${String(project.nextShotNumber).padStart(3, "0")} — Título del plano
DESCRIPCIÓN VISUAL: ...
ACCIÓN: ...
TIPO DE PLANO: ...
ÁNGULO: ...
MOVIMIENTO: ...
DURACIÓN: ... s
DIÁLOGO: ...
PROMPT PARA GENERAR EL PRIMER FRAME: ...
MOVIMIENTO DEL VIDEO: ...

No renumeres ni reescribas los planos existentes salvo que se pida expresamente una corrección.`;
  }

  async function copyRules() {
    if (!selectedProject) return;
    await navigator.clipboard.writeText(projectRules(selectedProject));
    setMessage(
      `Reglas copiadas para PRJ-${String(selectedProject.projectNumber).padStart(4, "0")}.`,
    );
  }

  function downloadRules() {
    if (!selectedProject) return;
    const blob = new Blob([projectRules(selectedProject)], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `FrameSync-PRJ-${String(selectedProject.projectNumber).padStart(4, "0")}-reglas.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("Reglas guardadas como archivo Markdown.");
  }

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
      setMessage(
        response.ok ? "Respuesta de sesión incompleta." : response.message,
      );
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
    if (!capture || !selectedProject) return;
    setActivity("sending");
    setMessage("Transfiriendo fuente e imágenes al equipo…");
    const response = await requestBackground({
      type: "capture.send",
      capture,
      destinationProjectId: selectedProject.id,
      destinationProjectName: selectedProject.name,
    });
    if (!response.ok || !("sent" in response)) {
      setActivity("error");
      setMessage(
        response.ok ? "Respuesta de envío incompleta." : response.message,
      );
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

      <section className="project-target">
        <div className="section-heading">
          <span>00</span>
          <h2>Proyecto de destino</h2>
        </div>
        <div className="project-select-row">
          <select
            value={selectedProjectId}
            onChange={(event) => selectProject(event.target.value)}
            disabled={!workspace || workspace.projects.length === 0}
          >
            {workspace?.projects.length ? (
              workspace.projects.map((project) => (
                <option value={project.id} key={project.id}>
                  PRJ-{String(project.projectNumber).padStart(4, "0")} ·{" "}
                  {project.name}
                </option>
              ))
            ) : (
              <option value="">Sin proyectos disponibles</option>
            )}
          </select>
          <button onClick={() => void refreshWorkspace()}>Actualizar</button>
        </div>
        {selectedProject && (
          <div className="project-memory">
            <span>
              {selectedProject.episodeCount} episodios ·{" "}
              {selectedProject.sceneCount} escenas
            </span>
            <strong>
              {selectedProject.shotCount} planos · próximo P
              {String(selectedProject.nextShotNumber).padStart(3, "0")}
            </strong>
            <button onClick={() => void copyRules()}>
              Copiar reglas para la IA
            </button>
            <button onClick={downloadRules}>Descargar reglas .md</button>
          </div>
        )}
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
          <strong>
            {selectedProject
              ? `PRJ-${String(selectedProject.projectNumber).padStart(4, "0")} · ${selectedProject.name}`
              : "Seleccioná un proyecto"}
          </strong>
        </div>
        <button
          className="send"
          disabled={
            !capture ||
            capture.messages.length === 0 ||
            !selectedProject ||
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
