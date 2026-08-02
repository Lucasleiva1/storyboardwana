import { analyzeCapture } from "@framesync/analysis-engine";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DetectedShot,
  WorkspaceContext,
  WorkspaceProjectSummary,
} from "@framesync/contracts";
import type {
  BackgroundRequest,
  BackgroundResponse,
  CaptureDraft,
} from "../../lib/messages";

type Activity = "idle" | "capturing" | "sending" | "sent" | "error";

function detectedShots(capture: CaptureDraft) {
  return analyzeCapture({ ...capture, selectedShotIds: null }).shots;
}

function isAlreadyStored(
  shot: DetectedShot,
  project: WorkspaceProjectSummary | null,
) {
  return Boolean(
    project &&
    shot.shotType === "normal" &&
    shot.globalNumber &&
    shot.globalNumber <= project.lastShotNumber,
  );
}

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
  const [selectedShotIds, setSelectedShotIds] = useState<Set<string>>(
    () => new Set(),
  );
  const scanGeneration = useRef(0);

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

  useEffect(() => {
    if (!capture) return;
    const invalidateIfPageChanged = async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.url && tab.url !== capture.sourceUrl) {
        scanGeneration.current += 1;
        setCapture(null);
        setSelectedShotIds(new Set());
        setActivity("idle");
        setMessage(
          "Cambiaste de página. La vista previa anterior se descartó; usá “Reiniciar y reescanear”.",
        );
      }
    };
    const handleActivated = () => void invalidateIfPageChanged();
    const handleUpdated: Parameters<
      typeof chrome.tabs.onUpdated.addListener
    >[0] = (_tabId, changeInfo, tab) => {
      if (tab.active && changeInfo.url) void invalidateIfPageChanged();
    };
    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, [capture]);

  const selectedProject = useMemo(
    () =>
      workspace?.projects.find((item) => item.id === selectedProjectId) ?? null,
    [workspace, selectedProjectId],
  );
  const previewShots = useMemo(
    () => (capture ? detectedShots(capture) : []),
    [capture],
  );
  const selectableShots = useMemo(
    () =>
      previewShots.filter((shot) => !isAlreadyStored(shot, selectedProject)),
    [previewShots, selectedProject],
  );
  const existingPreviewCount = previewShots.length - selectableShots.length;
  const selectedPreviewCount = selectableShots.filter((shot) =>
    selectedShotIds.has(shot.id),
  ).length;
  const selectionConflictIds = useMemo(() => {
    const conflicts = new Set<string>();
    let expected = selectedProject?.nextShotNumber ?? 1;
    const selectedNormals = selectableShots
      .filter(
        (shot) =>
          selectedShotIds.has(shot.id) &&
          shot.shotType === "normal" &&
          shot.globalNumber,
      )
      .sort((a, b) => (a.globalNumber ?? 0) - (b.globalNumber ?? 0));
    for (const shot of selectedNormals) {
      if (shot.globalNumber !== expected) conflicts.add(shot.id);
      else expected += 1;
    }
    return conflicts;
  }, [selectableShots, selectedProject, selectedShotIds]);

  function selectLoadableShots(
    nextCapture: CaptureDraft,
    project: WorkspaceProjectSummary | null,
  ) {
    setSelectedShotIds(
      new Set(
        detectedShots(nextCapture)
          .filter((shot) => !isAlreadyStored(shot, project))
          .map((shot) => shot.id),
      ),
    );
  }

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
    if (capture) selectLoadableShots(capture, selected);
    setMessage(
      selected
        ? "Lista de proyectos actualizada."
        : "Todavía no hay proyectos creados en FrameSync.",
    );
  }

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId);
    const project =
      workspace?.projects.find((item) => item.id === projectId) ?? null;
    if (capture) selectLoadableShots(capture, project);
    void chrome.storage.local.set({
      framesyncSelectedProjectId: projectId,
    });
  }

  function projectRules(project: WorkspaceProjectSummary) {
    const projectLabel = `PRJ-${String(project.projectNumber).padStart(4, "0")}`;
    return `CONTRATO TÉCNICO DE ENTREGA PARA FRAMESYNC

Proyecto: ${projectLabel} · ${project.name}
Identificador interno: ${project.id}
Último plano normal guardado: ${project.lastShotNumber}
Siguiente plano para una continuación: ${project.nextShotNumber}

OBJETIVO
Entregar únicamente los bloques técnicos que FrameSync debe cargar. No escribir ejemplos, listas de control, índices, nombres de archivos ni explicaciones que repitan códigos de planos: FrameSync podría interpretarlos como planos adicionales. Cada código de plano debe aparecer una sola vez y únicamente como encabezado de su bloque técnico real.

CONTRATO DE CANTIDAD
1. Antes de escribir los bloques, determinar exactamente cuántos planos pidió el usuario.
2. La respuesta importable debe comenzar con el marcador INICIO_CONTENIDO_FRAMESYNC.
3. Inmediatamente después debe declarar:
   TOTAL_PLANOS_A_CARGAR: [cantidad exacta solicitada]
   RANGO_PLANOS_A_CARGAR: [primer número solicitado]-[último número solicitado]
4. La cantidad declarada debe coincidir con la cantidad de bloques técnicos reales.
5. Si el usuario pide del plano 1 al 10, entregar exactamente diez bloques, numerados del 1 al 10. No comenzar en 34, 35 ni usar la continuidad guardada, porque el rango explícito del usuario tiene prioridad.
6. Si el usuario pide agregar planos y no indica un número inicial, continuar desde ${project.nextShotNumber}. Declarar cuántos se agregarán y el rango consecutivo completo. Nunca repetir los ya guardados.
7. Si más adelante se retoma el proyecto, volver a declarar el total de esa nueva tanda y su rango. El primer número debe ser el siguiente al último plano guardado, salvo que el usuario ordene expresamente rehacer o sustituir un rango anterior.
8. Si la cantidad pedida, el rango y el contenido disponible se contradicen, detenerse y pedir aclaración. No inventar bloques adicionales.

ESTRUCTURA IMPORTABLE
1. EPISODIO es opcional y las escenas se numeran consecutivamente.
2. La numeración de los planos es global y no se reinicia al cambiar de escena o episodio.
3. Cada bloque técnico real debe tener un único encabezado con su número y título.
4. Dentro de cada bloque incluir: descripción visual, acción, tipo de plano, encuadre, ángulo, movimiento de cámara, duración, diálogo, continuidad, storyboard, prompt del primer frame y prompt de video.
5. PLANO, PRIMER FRAME y VIDEO son elementos diferentes:
   - El plano define la unidad narrativa y lo que sucede.
   - El primer frame es la imagen inicial exacta anterior al primer movimiento.
   - El video desarrolla la acción desde ese primer frame.
6. El primer frame nunca debe mostrar una acción ya iniciada. Si alguien va a saltar una escalera, debe estar detrás o al pie de ella, preparado para saltar, nunca en el aire.
7. El prompt del primer frame debe fijar posición, pose previa, mirada, cámara, luz, escenario y continuidad sin anticipar el resultado.
8. El prompt de video debe comenzar exactamente desde ese estado inicial y describir en orden cómo empieza, progresa y termina la acción.
9. Puede haber varias variantes de video dentro del mismo bloque. Son alternativas del mismo plano y nunca crean números nuevos.

FICHA TÉCNICA OBLIGATORIA DEL VIDEO
Antes del PROMPT DE VIDEO, incluir siempre estos rótulos dentro de cada plano. Completar únicamente lo que esté definido; si un dato no fue decidido, dejar el valor vacío y no inventarlo:
VIDEO CÁMARA: cuerpo, cámara virtual, dron, FPV o sistema de captura.
VIDEO LENTE: óptica, distancia focal y característica relevante (macro, anamórfica, fisheye, split-diopter, etc.).
VIDEO TIPO DE PLANO: tamaño cinematográfico exacto (gran plano general, plano general, plano americano, plano medio, primer plano, primerísimo primer plano, plano detalle, etc.).
VIDEO ÁNGULO: posición de cámara (frontal, perfil, tres cuartos, picado, contrapicado, cenital, nadir, ras del suelo, POV, etc.).
VIDEO MOVIMIENTO DE CÁMARA: desplazamiento y comportamiento exactos, incluyendo velocidad, dirección, estabilización y foco cuando corresponda.
VIDEO CADENCIA: FPS o cadencia si fue definida.
VIDEO ILUMINACIÓN: dirección, calidad, temperatura, contraste, fuentes y cambios de luz durante el plano.
VIDEO EFECTOS: efectos prácticos, atmosféricos, ópticos o VFX necesarios.
VIDEO TRANSICIÓN: entrada o salida del plano si fue definida.
VIDEO INICIO: estado exacto heredado del primer frame, antes del primer movimiento.
VIDEO DESARROLLO: progresión temporal y orden de las acciones.
VIDEO FINAL: estado visual exacto donde termina el clip.
VIDEO CONTINUIDAD: identidad, vestuario, utilería, posición, dirección de mirada, eje y restricciones que deben conservarse.

El PROMPT DE VIDEO se redacta después de esta ficha y debe respetar todos sus valores. No trasladar a esta ficha información exclusiva del storyboard ni completar campos por intuición.

PROHIBICIONES
- No agregar una lista final de numeración.
- No agregar una sección de archivos resultantes.
- No escribir nombres terminados en .png, .jpg, .mp4, .mov o similares.
- No repetir códigos en resúmenes, explicaciones, storyboard, primer frame o video.
- No incluir plantillas con códigos de ejemplo.
- No mencionar planos que no vayan a cargarse.
- No renumerar silenciosamente.
- No producir más bloques que el total declarado.

CIERRE
Después del último bloque técnico escribir una sola vez FIN_CONTENIDO_FRAMESYNC. Fuera de esos marcadores no repetir números ni códigos de planos.`;
  }

  async function copyRules() {
    if (!selectedProject) return;
    const projectCode = `PRJ-${String(selectedProject.projectNumber).padStart(4, "0")}`;
    const response = await requestBackground({
      type: "rules.copyFile",
      filename: `FrameSync-${projectCode}-reglas.md`,
      content: projectRules(selectedProject),
    });
    if (!response.ok) {
      setMessage(response.message);
      return;
    }
    setMessage(
      `Archivo de reglas copiado. Pegalo en la IA con Ctrl+V para adjuntarlo.`,
    );
  }

  const roleCounts = useMemo(() => {
    const counts = { user: 0, assistant: 0, unknown: 0 };
    for (const item of capture?.messages ?? []) counts[item.role] += 1;
    return counts;
  }, [capture]);
  const mediaCounts = useMemo(() => {
    const counts = { images: 0, videos: 0 };
    for (const item of capture?.imageCandidates ?? []) {
      if (item.kind === "video") counts.videos += 1;
      else counts.images += 1;
    }
    return counts;
  }, [capture]);

  async function capturePage(
    mode: "full" | "loaded" | "selection",
    requestedGeneration?: number,
  ) {
    if (
      mode === "full" &&
      !window.confirm(
        "FrameSync moverá temporalmente el scroll para intentar cargar mensajes anteriores y luego restaurará tu posición. ¿Continuar?",
      )
    ) {
      return;
    }
    const generation = requestedGeneration ?? scanGeneration.current + 1;
    scanGeneration.current = generation;
    setCapture(null);
    setSelectedShotIds(new Set());
    setActivity("capturing");
    setMessage("Contadores reiniciados en cero. Escaneando la página actual…");
    const response = await requestBackground({ type: "capture.page", mode });
    if (generation !== scanGeneration.current) return;
    if (!response.ok) {
      setActivity("error");
      setMessage(response.message);
      return;
    }
    if ("capture" in response) {
      setCapture(response.capture);
      selectLoadableShots(response.capture, selectedProject);
      setActivity("idle");
      setMessage(
        response.capture.messages.length > 0 ||
          response.capture.imageCandidates.length > 0
          ? `Vista previa lista: ${detectedShots(response.capture).length} planos detectados. Revisalos antes de enviar.`
          : "La captura quedó vacía. Probá selección manual o una página con medios visibles.",
      );
    }
  }

  async function restartAndRescan() {
    const generation = scanGeneration.current + 1;
    scanGeneration.current = generation;
    setCapture(null);
    setSelectedShotIds(new Set());
    setActivity("idle");
    setMessage("Reiniciando y leyendo la pestaña actual desde cero…");
    if (sessionActive) {
      await requestBackground({ type: "session.control", action: "stop" });
      setSessionActive(false);
      setSessionCount(0);
    }
    await capturePage("loaded", generation);
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
    if (response.session.capture) {
      setCapture(response.session.capture);
      selectLoadableShots(response.session.capture, selectedProject);
    }
    setMessage(
      action === "start"
        ? "Seguimiento activo. Los mensajes se agregan cuando dejan de cambiar."
        : "Sesión detenida. Revisá el payload antes de enviarlo.",
    );
  }

  async function sendCapture() {
    if (!capture || !selectedProject) return;
    if (
      previewShots.length > 0 &&
      selectedPreviewCount === 0 &&
      !window.confirm(
        "No seleccionaste ningÃºn plano. Se enviarÃ¡ solamente la fuente y los medios, sin planos. Â¿Continuar?",
      )
    ) {
      return;
    }
    setActivity("sending");
    setMessage(
      `Transfiriendo fuente con ${selectedPreviewCount} planos elegidos…`,
    );
    const response = await requestBackground({
      type: "capture.send",
      capture: {
        ...capture,
        selectedShotIds: selectableShots
          .filter((shot) => selectedShotIds.has(shot.id))
          .map((shot) => shot.id),
      },
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
      `Enviado: ${selectedPreviewCount} planos elegidos y ${response.sent.transferredAssets} medios transferidos; ${response.sent.skippedAssets} conservaron sólo su referencia.`,
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

      <div className="restart-scan">
        <button
          type="button"
          disabled={activity === "capturing" || activity === "sending"}
          onClick={() => void restartAndRescan()}
        >
          <span aria-hidden="true">↻</span>
          Reiniciar y reescanear página actual
        </button>
        <small>
          Descarta la captura anterior y vuelve a contar desde cero.
        </small>
      </div>

      <div className={`current-scan ${capture ? "ready" : "empty"}`}>
        <span>PÁGINA ACTUAL · RESULTADO DEL ÚLTIMO ESCANEO</span>
        <strong>{previewShots.length} planos detectados en esta página</strong>
        <small>
          {capture
            ? `${capture.messages.length} mensajes · ${mediaCounts.images} imágenes · ${mediaCounts.videos} videos`
            : "Todavía no hay una captura válida de la pestaña actual."}
        </small>
        {capture && <code>{capture.sourceUrl}</code>}
      </div>

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
            <details className="stored-project-details">
              <summary>Ver datos ya guardados en la aplicación</summary>
              <span className="stored-data-label">
                ESTOS NÚMEROS NO PERTENECEN AL ESCANEO DE LA PÁGINA ACTUAL
              </span>
              <dl className="project-metrics">
                <div>
                  <dt>Ya importados</dt>
                  <dd>
                    {selectedProject.episodeCount ?? 0} episodios ·{" "}
                    {selectedProject.sceneCount ?? 0} escenas ·{" "}
                    {selectedProject.shotCount ?? 0} planos
                  </dd>
                </div>
                <div>
                  <dt>Medios</dt>
                  <dd>
                    {selectedProject.imageCount ?? 0} imágenes ·{" "}
                    {selectedProject.videoCount ?? 0} videos
                  </dd>
                </div>
                <div>
                  <dt>Cobertura</dt>
                  <dd>
                    {selectedProject.shotsWithFirstFrameCount ?? 0}/
                    {selectedProject.shotCount ?? 0} primeros frames ·{" "}
                    {selectedProject.shotsWithVideoCount ?? 0}/
                    {selectedProject.shotCount ?? 0} planos con video
                  </dd>
                </div>
              </dl>
              <strong>
                Próximo plano nuevo: P
                {String(selectedProject.nextShotNumber ?? 1).padStart(3, "0")}
              </strong>
              {(selectedProject.unassignedImageCount > 0 ||
                selectedProject.unassignedVideoCount > 0) && (
                <span className="metric-warning">
                  Sin asignar: {selectedProject.unassignedImageCount} imágenes ·{" "}
                  {selectedProject.unassignedVideoCount} videos
                </span>
              )}
            </details>
            <button onClick={() => void copyRules()}>
              Copiar archivo de reglas para la IA
            </button>
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
                <dd>{mediaCounts.images}</dd>
              </div>
              <div>
                <dt>Videos</dt>
                <dd>{mediaCounts.videos}</dd>
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
            <div className="shot-preview">
              <div className="shot-preview-heading">
                <div>
                  <strong>PLANOS EN ESTA CAPTURA</strong>
                  <span>
                    {previewShots.length} detectados · {existingPreviewCount} ya
                    guardados · {selectableShots.length} disponibles para cargar
                  </span>
                </div>
                <div className="shot-preview-actions">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedShotIds(
                        new Set(selectableShots.map((shot) => shot.id)),
                      )
                    }
                  >
                    Elegir todos
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedShotIds(new Set())}
                  >
                    Ninguno
                  </button>
                </div>
              </div>
              <div className="selection-total">
                <strong>{selectedPreviewCount}</strong> planos elegidos para
                enviar
              </div>
              {previewShots.length > 0 ? (
                <div className="shot-preview-list">
                  {previewShots.map((shot) => {
                    const stored = isAlreadyStored(shot, selectedProject);
                    const numberingConflict = selectionConflictIds.has(shot.id);
                    return (
                      <label
                        className={`shot-choice ${stored ? "stored" : ""} ${
                          numberingConflict ? "conflict" : ""
                        }`}
                        key={shot.id}
                      >
                        <input
                          type="checkbox"
                          checked={!stored && selectedShotIds.has(shot.id)}
                          disabled={stored}
                          onChange={(event) =>
                            setSelectedShotIds((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(shot.id);
                              else next.delete(shot.id);
                              return next;
                            })
                          }
                        />
                        <span>
                          <strong>
                            {shot.code ?? shot.specialCode ?? "SIN NÚMERO"}
                          </strong>
                          <small>
                            {shot.sceneCode ?? "Sin escena"} · {shot.title}
                          </small>
                        </span>
                        <em>
                          {stored
                            ? "YA EXISTE"
                            : numberingConflict
                              ? "REVISAR NÚMERO"
                              : "NUEVO"}
                        </em>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="empty compact">
                  No se detectaron planos en el contenido capturado.
                </p>
              )}
              <p className="selection-help">
                Nada de esta lista se crea todavía. FrameSync enviará solamente
                los planos marcados; después los revisás en la aplicación antes
                de importarlos.
              </p>
            </div>
            <div className="source-meta">
              <small className="capture-page-label">
                CAPTURA CORRESPONDIENTE A ESTA PÁGINA
              </small>
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
            (capture.messages.length === 0 &&
              capture.imageCandidates.length === 0) ||
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
              : previewShots.length > 0
                ? `Enviar ${selectedPreviewCount} planos`
                : "Enviar fuente a FrameSync"}
        </button>
      </footer>
    </main>
  );
}
