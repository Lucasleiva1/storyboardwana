import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  FileImage,
  FolderOpen,
  Inbox,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useFrameSyncStore } from "../store";

type MediaRole = "storyboard" | "first_frame" | "video_final";

type MultimediaInboxItem = {
  id: string;
  originalFilename: string;
  stagedPath: string;
  kind: "image" | "video";
  mimeType: string;
  byteSize: number;
  sha256: string;
  shotId: string | null;
  shotCode: string | null;
  shotTitle: string | null;
  role: MediaRole | null;
  status: "ready" | "needs_review" | "error";
  detectionNote: string;
  errorMessage: string | null;
};

type MultimediaStageResult = {
  discovered: number;
  staged: number;
  duplicates: number;
  ignored: number;
  ready: number;
  needsReview: number;
  items: MultimediaInboxItem[];
};

type MultimediaProcessResult = {
  processed: number;
  failed: number;
  errors: string[];
};

type InboxDraft = {
  shotId: string;
  role: MediaRole | "";
};

function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return fallback;
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function MediaView() {
  const setActiveView = useFrameSyncStore((state) => state.setActiveView);
  const project = useFrameSyncStore((state) => state.project);
  const production = useFrameSyncStore((state) => state.production);
  const openProject = useFrameSyncStore((state) => state.openProject);
  const [inboxItems, setInboxItems] = useState<MultimediaInboxItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, InboxDraft>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [processResult, setProcessResult] =
    useState<MultimediaProcessResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function adoptInbox(items: MultimediaInboxItem[]) {
    setInboxItems(items);
    setDrafts((current) =>
      Object.fromEntries(
        items.map((item) => {
          const previous = current[item.id];
          return [
            item.id,
            {
              shotId: item.shotId ?? previous?.shotId ?? "",
              role:
                item.role ??
                previous?.role ??
                (item.kind === "video" ? "video_final" : ""),
            },
          ];
        }),
      ),
    );
  }

  async function loadInbox() {
    if (!project) return;
    const items = await invoke<MultimediaInboxItem[]>("list_multimedia_inbox", {
      projectId: project.id,
    });
    adoptInbox(items);
  }

  useEffect(() => {
    let cancelled = false;
    if (!project) {
      setInboxItems([]);
      return;
    }
    void invoke<MultimediaInboxItem[]>("list_multimedia_inbox", {
      projectId: project.id,
    })
      .then((items) => {
        if (!cancelled) adoptInbox(items);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            errorMessage(reason, "No se pudo abrir la bandeja multimedia."),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  async function chooseMedia(directory: boolean) {
    if (!project || working) return;
    setError(null);
    setNotice(null);
    setProcessResult(null);
    const selected = await open({
      directory,
      multiple: !directory,
      title: directory
        ? "Elegí una carpeta de imágenes y videos"
        : "Elegí imágenes y videos",
      filters: directory
        ? undefined
        : [
            {
              name: "Imágenes y videos",
              extensions: [
                "png",
                "jpg",
                "jpeg",
                "webp",
                "gif",
                "avif",
                "mp4",
                "webm",
                "mov",
                "m4v",
              ],
            },
          ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setWorking("stage");
    try {
      const staged = await invoke<MultimediaStageResult>(
        "stage_multimedia_paths",
        {
          projectId: project.id,
          projectNumber: project.projectNumber,
          projectName: project.name,
          paths,
        },
      );
      adoptInbox(staged.items);
      setNotice(
        `${staged.staged} copiados a la bandeja · ${staged.ready} listos · ${staged.needsReview} para revisar · ${staged.duplicates} repetidos`,
      );
    } catch (reason) {
      setError(errorMessage(reason, "No se pudieron preparar los medios."));
      try {
        await loadInbox();
      } catch {
        // La causa original es la más útil para el usuario.
      }
    } finally {
      setWorking(null);
    }
  }

  async function saveAssignment(item: MultimediaInboxItem) {
    if (!project || working) return;
    const draft = drafts[item.id];
    if (!draft?.shotId || !draft.role) {
      setError("Elegí el plano y el uso del archivo antes de confirmarlo.");
      return;
    }
    setWorking(item.id);
    setError(null);
    try {
      const items = await invoke<MultimediaInboxItem[]>(
        "update_multimedia_inbox_assignment",
        {
          projectId: project.id,
          itemId: item.id,
          shotId: draft.shotId,
          role: draft.role,
        },
      );
      adoptInbox(items);
      setNotice("Asignación confirmada. El archivo quedó listo para importar.");
    } catch (reason) {
      setError(errorMessage(reason, "No se pudo guardar la asignación."));
    } finally {
      setWorking(null);
    }
  }

  async function removeInboxItem(item: MultimediaInboxItem) {
    if (!project || working) return;
    if (
      !window.confirm(
        `¿Quitar “${item.originalFilename}” de la bandeja? El archivo original no se borrará.`,
      )
    ) {
      return;
    }
    setWorking(item.id);
    setError(null);
    try {
      const items = await invoke<MultimediaInboxItem[]>(
        "remove_multimedia_inbox_item",
        { projectId: project.id, itemId: item.id },
      );
      adoptInbox(items);
      setNotice("Se quitó la copia de la bandeja; el original sigue intacto.");
    } catch (reason) {
      setError(errorMessage(reason, "No se pudo quitar el archivo."));
    } finally {
      setWorking(null);
    }
  }

  async function processReadyItems() {
    if (!project || working) return;
    const itemIds = inboxItems
      .filter((item) => item.status === "ready")
      .map((item) => item.id);
    if (!itemIds.length) return;
    setWorking("process");
    setError(null);
    setNotice(null);
    try {
      const result = await invoke<MultimediaProcessResult>(
        "process_multimedia_inbox",
        {
          projectId: project.id,
          projectNumber: project.projectNumber,
          projectName: project.name,
          itemIds,
        },
      );
      setProcessResult(result);
      await loadInbox();
      await openProject(project);
      setNotice(
        result.failed
          ? `${result.processed} importados y ${result.failed} pendientes por resolver.`
          : `${result.processed} archivos importados y verificados.`,
      );
    } catch (reason) {
      setError(errorMessage(reason, "No se pudo completar la importación."));
      try {
        await loadInbox();
      } catch {
        // La causa original es la más útil para el usuario.
      }
    } finally {
      setWorking(null);
    }
  }

  const readyCount = inboxItems.filter(
    (item) => item.status === "ready",
  ).length;
  const reviewCount = inboxItems.length - readyCount;

  return (
    <section className="entity-workspace">
      <header className="section-titlebar">
        <div>
          <span className="section-code">BANDEJA MULTIMEDIA</span>
          <h1>Importación segura y revisable</h1>
          <p>
            Los originales no se modifican y cada copia se verifica antes de
            entrar al proyecto.
          </p>
        </div>
        <div className="media-header-actions">
          <button
            className="solid-button"
            onClick={() => void chooseMedia(false)}
            disabled={Boolean(working)}
          >
            <Upload size={14} />
            {working === "stage" ? "Preparando…" : "Añadir archivos"}
          </button>
          <button
            onClick={() => void chooseMedia(true)}
            disabled={Boolean(working)}
          >
            <FolderOpen size={14} /> Añadir carpeta
          </button>
          <button onClick={() => setActiveView("shots")}>
            <ArrowLeft size={14} /> Volver a planos
          </button>
        </div>
      </header>

      <div className="media-import-guide">
        <strong>FLUJO CONTROLADO</strong>
        <span>
          1. Copiar a bandeja · 2. Detectar plano y uso · 3. Revisar dudas · 4.
          Importar los listos
        </span>
        <small>
          Reconoce nombres como P001_STORYBOARD.png, P001_PRIMER_FRAME.png y
          P001_VIDEO_V01.mp4, incluso dentro de carpetas del plano.
        </small>
      </div>

      {notice && (
        <div className="media-import-result">
          <CheckCircle2 size={17} />
          <span>
            <strong>Operación completada</strong>
            {notice}
          </span>
        </div>
      )}
      {processResult && processResult.errors.length > 0 && (
        <div className="media-process-warnings">
          <AlertTriangle size={16} />
          <details open={processResult.failed > 0}>
            <summary>
              {processResult.errors.length} avisos de importación
            </summary>
            <ul>
              {processResult.errors.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
      {error && <div className="media-import-error">{error}</div>}

      <section className="multimedia-inbox-panel">
        <header>
          <div>
            <Inbox size={18} />
            <span>
              <strong>Bandeja pendiente</strong>
              <small>
                {inboxItems.length} archivos · {readyCount} listos ·{" "}
                {reviewCount} para revisar
              </small>
            </span>
          </div>
          <button
            className="accent-button"
            onClick={() => void processReadyItems()}
            disabled={!readyCount || Boolean(working)}
          >
            <Check size={14} />
            {working === "process"
              ? "Importando…"
              : `Importar listos (${readyCount})`}
          </button>
        </header>

        {inboxItems.length > 0 ? (
          <div className="multimedia-inbox-list">
            {inboxItems.map((item) => {
              const draft = drafts[item.id] ?? { shotId: "", role: "" };
              return (
                <article
                  className={`multimedia-inbox-item ${item.status}`}
                  key={item.id}
                >
                  <div className="multimedia-inbox-preview">
                    {item.kind === "video" ? (
                      <video
                        src={convertFileSrc(item.stagedPath)}
                        preload="metadata"
                      />
                    ) : (
                      <img
                        src={convertFileSrc(item.stagedPath)}
                        alt={item.originalFilename}
                      />
                    )}
                    <span>
                      {item.kind === "video" ? <Video /> : <FileImage />}
                    </span>
                  </div>
                  <div className="multimedia-inbox-copy">
                    <header>
                      <strong title={item.originalFilename}>
                        {item.originalFilename}
                      </strong>
                      <b>
                        {item.status === "ready"
                          ? "LISTO"
                          : item.status === "error"
                            ? "ERROR"
                            : "REVISAR"}
                      </b>
                    </header>
                    <p>
                      <strong>
                        {item.status === "ready" ? "Detección:" : "Motivo:"}
                      </strong>{" "}
                      {item.errorMessage ?? item.detectionNote}
                    </p>
                    {item.errorMessage && <small>{item.detectionNote}</small>}
                    <small>
                      {formatBytes(item.byteSize)} · SHA-256{" "}
                      {item.sha256.slice(0, 12)}…
                    </small>
                  </div>
                  <label>
                    <span>Plano</span>
                    <select
                      value={draft.shotId}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [item.id]: {
                            ...draft,
                            shotId: event.target.value,
                          },
                        }))
                      }
                    >
                      <option value="">Elegir plano…</option>
                      {production.shots.map((shot) => (
                        <option key={shot.id} value={shot.id}>
                          {shot.code} · {shot.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Uso</span>
                    <select
                      value={draft.role}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [item.id]: {
                            ...draft,
                            role: event.target.value as MediaRole | "",
                          },
                        }))
                      }
                    >
                      <option value="">Elegir uso…</option>
                      {item.kind === "video" ? (
                        <option value="video_final">Video</option>
                      ) : (
                        <>
                          <option value="storyboard">Storyboard</option>
                          <option value="first_frame">Primer frame</option>
                        </>
                      )}
                    </select>
                  </label>
                  <div className="multimedia-inbox-actions">
                    <button
                      onClick={() => void saveAssignment(item)}
                      disabled={working === item.id}
                    >
                      <Check size={13} /> Confirmar
                    </button>
                    <button
                      className="destructive"
                      onClick={() => void removeInboxItem(item)}
                      disabled={working === item.id}
                      title="Quitar de la bandeja"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="multimedia-inbox-empty">
            <Inbox size={24} />
            <span>
              <strong>La bandeja está vacía</strong>
              <small>
                Añadí archivos o una carpeta para preparar la importación.
              </small>
            </span>
          </div>
        )}
      </section>
    </section>
  );
}
