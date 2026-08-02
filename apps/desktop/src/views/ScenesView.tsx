import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  Check,
  Clipboard,
  Copy,
  Eye,
  FileVideo,
  Film,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  Maximize2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { DetectedScene } from "@framesync/contracts";
import { useFrameSyncStore } from "../store";
import type { ProductionShot } from "../types";

type ImageRole = "storyboard" | "first_frame";
type MediaRole = ImageRole | "video_final";
type ViewerState = {
  path: string;
  label: string;
  shot: ProductionShot;
  role: MediaRole;
  kind: "image" | "video";
};

function formatDuration(milliseconds: number | null) {
  if (!milliseconds) return "Pendiente";
  return `${(milliseconds / 1_000).toFixed(milliseconds % 1_000 ? 1 : 0)} s`;
}

function CardRotateIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5.5 15.5 7v10L9 18.5z" />
      <path d="M6.8 8.1C4.9 9 4 10.3 4 12s.9 3 2.8 3.9" />
      <path d="m5.2 14.7 1.6 1.2-1.4 1.4" />
      <path d="M17.2 8.1C19.1 9 20 10.3 20 12s-.9 3-2.8 3.9" />
      <path d="m18.8 14.7-1.6 1.2 1.4 1.4" />
    </svg>
  );
}

function sceneForShot(scenes: DetectedScene[], shot: ProductionShot) {
  return scenes.find((scene) => scene.code === shot.sceneCode) ?? null;
}

export function ScenesView() {
  const {
    production,
    updateShot,
    deleteShot,
    createManualShots,
    importShotImages,
    detachShotMedia,
    syncProjectWorkspace,
    openProjectWorkspace,
    openShotWorkspace,
    workspacePath,
    busy,
  } = useFrameSyncStore();
  const [query, setQuery] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualNames, setManualNames] = useState("");
  const [advancedShot, setAdvancedShot] = useState<ProductionShot | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const visibleShots = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("es");
    if (!normalized) return production.shots;
    return production.shots.filter((shot) =>
      `${shot.code ?? ""} ${shot.title} ${shot.visualDescription ?? ""}`
        .toLocaleLowerCase("es")
        .includes(normalized),
    );
  }, [production.shots, query]);

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2_200);
  }

  async function chooseShotImages(
    shot: ProductionShot,
    role: MediaRole,
    replaceExisting: boolean,
  ) {
    const selected = await open({
      multiple: role === "storyboard",
      directory: false,
      title:
        role === "storyboard"
          ? `Storyboard de ${shot.code}`
          : role === "first_frame"
            ? `Primer frame de ${shot.code}`
            : `Video de ${shot.code}`,
      filters: [
        role === "video_final"
          ? { name: "Videos", extensions: ["mp4", "webm", "mov", "m4v"] }
          : {
              name: "Imágenes",
              extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"],
            },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await importShotImages(shot.id, paths, role, replaceExisting);
    showNotice(
      role === "storyboard"
        ? "Storyboard actualizado"
        : role === "first_frame"
          ? "Primer frame actualizado"
          : "Video actualizado",
    );
  }

  async function submitManualShots() {
    const names = manualNames
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length) return;
    await createManualShots(names);
    setManualNames("");
    setManualOpen(false);
  }

  async function copyText(value: string | null, label: string) {
    if (!value?.trim()) {
      showNotice(`${label} pendiente`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showNotice(`${label} copiado`);
    } catch {
      showNotice("No se pudo copiar al portapapeles");
    }
  }

  async function copyImage(path: string) {
    try {
      const response = await fetch(convertFileSrc(path));
      const source = await response.blob();
      const bitmap = await createImageBitmap(source);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas no disponible");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("Conversión fallida")),
          "image/png",
        ),
      );
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": png }),
      ]);
      showNotice("Imagen copiada");
    } catch {
      showNotice("No se pudo copiar la imagen");
    }
  }

  return (
    <section className="visual-shots-workspace">
      <header className="visual-shots-header">
        <div>
          <span className="section-code">STORYBOARD WANA / PRODUCCIÓN</span>
          <h1>Planos visuales</h1>
          <p>
            Storyboard, primer frame y prompt de video conectados por plano.
          </p>
        </div>
        <div className="visual-header-actions">
          <label className="search-box">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar plano…"
            />
          </label>
          <button onClick={() => void syncProjectWorkspace()} disabled={busy}>
            <RefreshCw size={14} /> Sincronizar
          </button>
          <button onClick={() => void openProjectWorkspace()}>
            <FolderOpen size={14} /> Abrir carpeta
          </button>
          <button className="solid-button" onClick={() => setManualOpen(true)}>
            <Plus size={14} /> Agregar planos
          </button>
        </div>
        <div className="project-folder-strip">
          <FolderOpen size={13} />
          <span>{workspacePath ?? "Documentos / Storyboard Wana"}</span>
          <strong>{production.shots.length} planos</strong>
          <strong>
            {production.shots.filter((shot) => shot.firstFramePath).length}{" "}
            primeros frames
          </strong>
        </div>
      </header>

      {production.shots.length === 0 ? (
        <div className="visual-empty-state">
          <Film size={34} />
          <h2>Prepará tu primera fila de producción</h2>
          <p>Agregá un nombre o pegá todos los planos, uno por línea.</p>
          <button className="solid-button" onClick={() => setManualOpen(true)}>
            <Plus size={15} /> Agregar planos manualmente
          </button>
        </div>
      ) : (
        <div className="production-shot-list">
          {visibleShots.map((shot) => (
            <ProductionShotRow
              key={shot.id}
              shot={shot}
              scene={sceneForShot(production.scenes, shot)}
              onCopyText={copyText}
              onCopyImage={copyImage}
              onChooseImages={chooseShotImages}
              onViewMedia={(path, label, role, kind) =>
                setViewer({ path, label, shot, role, kind })
              }
              onAdvanced={() => setAdvancedShot(shot)}
              onOpenFolder={() => void openShotWorkspace(shot.id)}
              onOpenVideoFolder={() => void openShotWorkspace(shot.id, true)}
              onChangePrompt={(role, value) => {
                const updated = {
                  ...shot,
                  [role === "storyboard"
                    ? "visualDescription"
                    : role === "image"
                      ? "imagePrompt"
                      : "videoPrompt"]: value.trim() || null,
                };
                void updateShot(updated);
                showNotice("Prompt actualizado");
              }}
              onRemoveMedia={(role) => {
                void detachShotMedia(shot.id, role);
                showNotice(
                  `${role === "video_final" ? "Video" : "Imagen"} quitado de la tarjeta; el archivo se conserva`,
                );
              }}
            />
          ))}
        </div>
      )}

      {manualOpen && (
        <ManualShotsDialog
          value={manualNames}
          busy={busy}
          onChange={setManualNames}
          onCancel={() => setManualOpen(false)}
          onSubmit={() => void submitManualShots()}
        />
      )}

      {advancedShot && (
        <AdvancedShotDialog
          shot={advancedShot}
          onClose={() => setAdvancedShot(null)}
          onSave={(shot) => {
            void updateShot(shot);
            setAdvancedShot(null);
            showNotice("Plano actualizado");
          }}
          onDelete={(shot) => {
            if (window.confirm(`¿Eliminar ${shot.code} · ${shot.title}?`)) {
              void deleteShot(shot);
              setAdvancedShot(null);
            }
          }}
        />
      )}

      {viewer && (
        <MediaViewer
          state={viewer}
          onClose={() => setViewer(null)}
          onCopy={
            viewer.kind === "image"
              ? () => void copyImage(viewer.path)
              : undefined
          }
          onReplace={() =>
            void chooseShotImages(viewer.shot, viewer.role, true)
          }
        />
      )}

      {notice && (
        <div className="copy-notice" role="status">
          <Check size={14} /> {notice}
        </div>
      )}
    </section>
  );
}

function ProductionShotRow({
  shot,
  scene,
  onCopyText,
  onCopyImage,
  onChooseImages,
  onViewMedia,
  onAdvanced,
  onOpenFolder,
  onOpenVideoFolder,
  onChangePrompt,
  onRemoveMedia,
}: {
  shot: ProductionShot;
  scene: DetectedScene | null;
  onCopyText: (text: string | null, label: string) => Promise<void>;
  onCopyImage: (path: string) => Promise<void>;
  onChooseImages: (
    shot: ProductionShot,
    role: MediaRole,
    replace: boolean,
  ) => Promise<void>;
  onViewMedia: (
    path: string,
    label: string,
    role: MediaRole,
    kind: "image" | "video",
  ) => void;
  onAdvanced: () => void;
  onOpenFolder: () => void;
  onOpenVideoFolder: () => void;
  onChangePrompt: (
    role: "storyboard" | "image" | "video",
    value: string,
  ) => void;
  onRemoveMedia: (role: MediaRole) => void;
}) {
  const [flipped, setFlipped] = useState(false);
  const storyboard = shot.storyboardPaths?.[0] ?? null;

  return (
    <article className={`production-shot-row ${flipped ? "flipped" : ""}`}>
      <div className="shot-row-stage">
        <section className="shot-row-face shot-row-front">
          <header className="production-shot-heading">
            <div>
              <span>{scene?.code ?? "SIN ESCENA"}</span>
              <h2>
                <strong>{shot.code ?? "SIN CÓDIGO"}</strong> {shot.title}
              </h2>
            </div>
            <div>
              <span className={`shot-progress-chip ${shot.status}`}>
                {shot.firstFramePath
                  ? "PRIMER FRAME LISTO"
                  : "PRIMER FRAME PENDIENTE"}
              </span>
              <button
                type="button"
                className="shot-heading-icon-button"
                onClick={onOpenFolder}
                aria-label="Abrir carpeta del plano"
                title="Abrir carpeta del plano"
              >
                <FolderOpen size={17} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="shot-heading-icon-button"
                onClick={() => setFlipped(true)}
                aria-label="Girar fila del plano"
                title="Girar"
              >
                <CardRotateIcon size={25} />
              </button>
              <button
                type="button"
                className="shot-heading-icon-button advanced-button"
                onClick={onAdvanced}
                aria-label="Abrir información avanzada"
                title="Avanzado"
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className="production-card-grid">
            <VisualCard
              eyebrow="STORYBOARD"
              title="Referencia visual"
              path={storyboard}
              empty="Agregá la imagen del storyboard"
              badge={`${shot.storyboardPaths?.length ?? 0} imágenes`}
              onAdd={() => void onChooseImages(shot, "storyboard", false)}
              onReplace={() => void onChooseImages(shot, "storyboard", true)}
              onView={
                storyboard
                  ? () =>
                      onViewMedia(
                        storyboard,
                        `${shot.code} · Storyboard`,
                        "storyboard",
                        "image",
                      )
                  : undefined
              }
              onCopy={
                storyboard ? () => void onCopyImage(storyboard) : undefined
              }
              fit="contain"
              promptLabel={
                shot.visualDescription?.trim()
                  ? "INFORMACIÓN DEL STORYBOARD"
                  : undefined
              }
              prompt={shot.visualDescription}
              onChangePrompt={(value) =>
                onChangePrompt("storyboard", value)
              }
              onAdvanced={onAdvanced}
              onRemove={() => onRemoveMedia("storyboard")}
            />

            <VisualCard
              eyebrow="PRIMER FRAME"
              title="Imagen de partida"
              path={shot.firstFramePath ?? null}
              empty="Generá o agregá el primer frame"
              badge={shot.firstFramePath ? "Imagen lista" : "Pendiente"}
              promptLabel="PROMPT PRIMER FRAME"
              prompt={shot.imagePrompt}
              onCopyPrompt={() =>
                void onCopyText(shot.imagePrompt, "Prompt de imagen")
              }
              onAdvanced={onAdvanced}
              onChangePrompt={(value) => onChangePrompt("image", value)}
              onAdd={() => void onChooseImages(shot, "first_frame", true)}
              onReplace={() => void onChooseImages(shot, "first_frame", true)}
              onView={
                shot.firstFramePath
                  ? () =>
                      onViewMedia(
                        shot.firstFramePath!,
                        `${shot.code} · Primer frame`,
                        "first_frame",
                        "image",
                      )
                  : undefined
              }
              onCopy={
                shot.firstFramePath
                  ? () => void onCopyImage(shot.firstFramePath!)
                  : undefined
              }
              onRemove={() => onRemoveMedia("first_frame")}
            />

            <VideoPromptCard
              shot={shot}
              onCopy={() =>
                void onCopyText(shot.videoPrompt, "Prompt de video")
              }
              onUploadVideo={() =>
                void onChooseImages(shot, "video_final", true)
              }
              onRemoveVideo={() => onRemoveMedia("video_final")}
              onChangePrompt={(value) => onChangePrompt("video", value)}
              onViewVideo={
                shot.videoPath
                  ? () =>
                      onViewMedia(
                        shot.videoPath!,
                        `${shot.code} · Video`,
                        "video_final",
                        "video",
                      )
                  : undefined
              }
              onAdvanced={onAdvanced}
              onOpenFolder={onOpenVideoFolder}
            />
          </div>
        </section>

        <section className="shot-row-face shot-row-back">
          <header>
            <div>
              <span className="section-code">
                REVERSO TÉCNICO / {shot.code}
              </span>
              <h2>{shot.title}</h2>
            </div>
            <button onClick={() => setFlipped(false)}>
              <ArrowLeft size={14} /> Volver al frente
            </button>
          </header>
          <div className="technical-summary-grid">
            <TechnicalField
              label="Escena"
              value={scene?.title ?? shot.sceneCode}
            />
            <TechnicalField label="Encuadre" value={shot.framing} />
            <TechnicalField label="Ángulo" value={shot.angle} />
            <TechnicalField label="Movimiento" value={shot.movement} />
            <TechnicalField
              label="Duración"
              value={formatDuration(shot.estimatedDurationMs)}
            />
            <TechnicalField
              label="Estado"
              value={shot.status.replace("_", " ")}
            />
            <TechnicalField
              label="Descripción"
              value={shot.visualDescription}
              wide
            />
            <TechnicalField label="Acción" value={shot.action} wide />
          </div>
          <button className="solid-button" onClick={onAdvanced}>
            <Pencil size={14} /> Abrir información avanzada
          </button>
        </section>
      </div>
    </article>
  );
}

function VisualCard({
  eyebrow,
  title,
  path,
  empty,
  badge,
  promptLabel,
  prompt,
  onCopyPrompt,
  onChangePrompt,
  onAdvanced,
  onAdd,
  onReplace,
  onRemove,
  onView,
  onCopy,
  fit = "cover",
}: {
  eyebrow: string;
  title: string;
  path: string | null;
  empty: string;
  badge: string;
  promptLabel?: string;
  prompt?: string | null;
  onCopyPrompt?: () => void;
  onChangePrompt?: (value: string) => void;
  onAdvanced?: () => void;
  onAdd: () => void;
  onReplace: () => void;
  onRemove: () => void;
  onView?: () => void;
  onCopy?: () => void;
  fit?: "cover" | "contain";
}) {
  return (
    <section className="production-visual-card">
      <header>
        <div>
          <span>{eyebrow}</span>
          <strong>{title}</strong>
        </div>
        <small>{badge}</small>
      </header>
      <div
        className={`production-image-frame ${path ? "has-image" : "empty"} ${fit === "contain" ? "contain-media" : ""}`}
      >
        {path ? (
          <img
            src={convertFileSrc(path)}
            alt={title}
            width={1600}
            height={900}
            loading="lazy"
          />
        ) : (
          <div>
            <ImageIcon size={28} />
            <span>{empty}</span>
          </div>
        )}
        <div className="media-overlay-actions">
          <button
            type="button"
            onClick={path ? onReplace : onAdd}
            aria-label={path ? "Reemplazar imagen" : "Cargar imagen"}
            title={path ? "Reemplazar imagen" : "Cargar imagen"}
          >
            <Upload size={15} aria-hidden="true" />
          </button>
          {path && (
            <>
            <button
              type="button"
              onClick={onCopy}
              aria-label="Copiar imagen"
              title="Copiar imagen"
            >
              <Copy size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              aria-label="Quitar imagen de la tarjeta"
              title="Quitar de la interfaz (el archivo se conserva)"
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onView}
              aria-label="Ampliar imagen"
              title="Ampliar imagen"
            >
              <Maximize2 size={15} aria-hidden="true" />
            </button>
            </>
          )}
        </div>
      </div>
      {promptLabel && (
        <PromptBlock
          label={promptLabel}
          prompt={prompt}
          empty="Prompt pendiente. Hacé doble clic para escribirlo."
          onCopy={onCopyPrompt}
          onAdvanced={onAdvanced}
          onChange={onChangePrompt}
        />
      )}
    </section>
  );
}

function VideoPromptCard({
  shot,
  onCopy,
  onUploadVideo,
  onRemoveVideo,
  onChangePrompt,
  onViewVideo,
  onAdvanced,
  onOpenFolder,
}: {
  shot: ProductionShot;
  onCopy: () => void;
  onUploadVideo: () => void;
  onRemoveVideo: () => void;
  onChangePrompt: (value: string) => void;
  onViewVideo?: () => void;
  onAdvanced: () => void;
  onOpenFolder: () => void;
}) {
  const [flipped, setFlipped] = useState(false);
  const technical = shot.videoTechnical;
  const technicalDetails = [
    { label: "Cámara", value: technical.camera },
    { label: "Lente / óptica", value: technical.lens },
    { label: "Tipo de plano", value: technical.shotType },
    { label: "Ángulo", value: technical.angle },
    { label: "Movimiento", value: technical.movement },
    { label: "Cadencia", value: technical.frameRate },
    { label: "Iluminación", value: technical.lighting },
    { label: "Efectos", value: technical.effects },
    { label: "Transición", value: technical.transition },
    { label: "Inicio", value: technical.start },
    { label: "Desarrollo", value: technical.development },
    { label: "Final", value: technical.end },
    { label: "Continuidad", value: technical.continuity },
    {
      label: "Duración",
      value: shot.estimatedDurationMs
        ? formatDuration(shot.estimatedDurationMs)
        : null,
    },
  ];

  return (
    <div className={`video-card-flip ${flipped ? "flipped" : ""}`}>
      <div className="video-card-flip-inner">
        <section
          className="production-visual-card video-prompt-card video-card-face video-card-front"
          aria-hidden={flipped}
          inert={flipped ? true : undefined}
        >
          <header>
            <div>
              <span>VIDEO</span>
              <strong>Resultado del plano</strong>
            </div>
            <div className="video-card-header-actions">
              <small>
                {shot.videoPath
                  ? `${shot.videoPaths?.length ?? 1} VIDEO(S)`
                  : "PENDIENTE"}
              </small>
              <button
                type="button"
                onClick={onOpenFolder}
                aria-label="Abrir carpeta de video del plano"
                title="Abrir carpeta de video"
              >
                <FolderOpen size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setFlipped(true)}
                aria-label="Ver detalles técnicos del video"
                title="Girar tarjeta"
              >
                <CardRotateIcon size={25} />
              </button>
            </div>
          </header>
          <div
            className={`production-image-frame video-frame ${shot.videoPath ? "has-video" : "empty"}`}
          >
            {shot.videoPath ? (
              <video
                src={convertFileSrc(shot.videoPath)}
                preload="metadata"
                controls
                muted
                playsInline
              />
            ) : (
              <div>
                <FileVideo size={28} aria-hidden="true" />
                <span>Agregá el video generado para este plano</span>
              </div>
            )}
            <div className="media-overlay-actions">
              <button
                type="button"
                onClick={onUploadVideo}
                aria-label={
                  shot.videoPath ? "Reemplazar video" : "Cargar video"
                }
                title={shot.videoPath ? "Reemplazar video" : "Cargar video"}
              >
                <Upload size={15} aria-hidden="true" />
              </button>
              {shot.videoPath && (
                <>
                  <button
                    type="button"
                    onClick={onRemoveVideo}
                    aria-label="Quitar video de la tarjeta"
                    title="Quitar de la interfaz (el archivo se conserva)"
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={onViewVideo}
                    aria-label="Ampliar video"
                    title="Ampliar video"
                  >
                    <Maximize2 size={15} aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          </div>
          <PromptBlock
            label="PROMPT DE VIDEO"
            prompt={shot.videoPrompt}
            empty="Escribí el movimiento, progresión y final del plano en Avanzado."
            onCopy={onCopy}
            onAdvanced={onAdvanced}
            onChange={onChangePrompt}
          />
        </section>

        <section
          className="production-visual-card video-card-face video-card-back"
          aria-hidden={!flipped}
          inert={!flipped ? true : undefined}
        >
          <header>
            <div>
              <span>DETALLE TÉCNICO</span>
              <strong>{shot.code ?? "Video"}</strong>
            </div>
            <button
              type="button"
              className="video-card-back-button"
              onClick={() => setFlipped(false)}
              aria-label="Volver al video"
              title="Volver al frente"
            >
              <CardRotateIcon size={25} />
            </button>
          </header>
          <dl className="video-technical-list">
            {technicalDetails.map((detail) => (
              <div key={detail.label}>
                <dt>{detail.label}</dt>
                <dd>{detail.value || "\u00a0"}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}

function PromptBlock({
  label,
  prompt,
  empty,
  onCopy,
  onAdvanced,
  onChange,
}: {
  label: string;
  prompt?: string | null;
  empty: string;
  onCopy?: () => void;
  onAdvanced?: () => void;
  onChange?: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(prompt ?? "");
  const displayedValue = prompt?.trim() || empty;

  function beginEditing(element: HTMLTextAreaElement) {
    setDraft(prompt ?? "");
    setEditing(true);
    window.requestAnimationFrame(() => element.focus());
  }

  function savePrompt() {
    if (!editing) return;
    setEditing(false);
    if (draft.trim() !== (prompt ?? "").trim()) onChange?.(draft);
  }

  return (
    <div className="card-prompt-block">
      <div className="card-prompt-heading">
        <span>{label}</span>
        <div className="prompt-compact-actions">
          {onCopy && (
            <button
              type="button"
              onClick={onCopy}
              disabled={!prompt?.trim()}
              aria-label="Copiar prompt"
              title="Copiar prompt"
            >
              <Copy size={14} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onAdvanced}
            aria-label="Abrir información avanzada"
            title="Avanzado"
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <textarea
        className={`prompt-inline-editor ${editing ? "editing" : ""}`}
        aria-label={`${label}. Doble clic para editar.`}
        title={editing ? "Editando prompt" : "Doble clic para editar"}
        readOnly={!editing}
        value={editing ? draft : displayedValue}
        onDoubleClick={(event) => beginEditing(event.currentTarget)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={savePrompt}
        onKeyDown={(event) => {
          if (!editing && event.key === "Enter") {
            event.preventDefault();
            beginEditing(event.currentTarget);
          }
          if (editing && event.key === "Escape") {
            setDraft(prompt ?? "");
            setEditing(false);
          }
          if (editing && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function TechnicalField({
  label,
  value,
  wide = false,
}: {
  label: string;
  value?: string | null;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "wide" : ""}>
      <span>{label}</span>
      <strong>{value || "Pendiente"}</strong>
    </div>
  );
}

function MediaViewer({
  state,
  onClose,
  onCopy,
  onReplace,
}: {
  state: ViewerState;
  onClose: () => void;
  onCopy?: () => void;
  onReplace: () => void;
}) {
  return (
    <div className="image-viewer-backdrop" role="presentation">
      <section className="image-viewer" role="dialog" aria-modal="true">
        <header>
          <div>
            <span className="section-code">VISOR / {state.shot.code}</span>
            <h2>{state.label}</h2>
          </div>
          <button onClick={onClose} aria-label="Cerrar visor">
            <X size={18} />
          </button>
        </header>
        <div className="image-viewer-canvas">
          {state.kind === "video" ? (
            <video
              src={convertFileSrc(state.path)}
              controls
              autoPlay
              playsInline
            />
          ) : (
            <img
              src={convertFileSrc(state.path)}
              alt={state.label}
              width={1600}
              height={900}
            />
          )}
        </div>
        <footer>
          <span>{state.path}</span>
          <div>
            <button onClick={onReplace}>
              {state.kind === "video" ? (
                <FileVideo size={14} />
              ) : (
                <ImagePlus size={14} />
              )}
              Cambiar {state.kind === "video" ? "video" : "imagen"}
            </button>
            {onCopy && (
              <button className="solid-button" onClick={onCopy}>
                <Clipboard size={14} /> Copiar imagen
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

function ManualShotsDialog({
  value,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const count = value.split(/\r?\n/).filter((line) => line.trim()).length;
  return (
    <div className="manual-shot-backdrop" role="presentation">
      <section className="manual-shot-dialog" role="dialog" aria-modal="true">
        <header>
          <span className="section-code">MODO MANUAL</span>
          <h2>Agregar planos independientes</h2>
          <p>
            Un nombre por línea. Cada plano tendrá su propia fila y sus tres
            tarjetas.
          </p>
        </header>
        <textarea
          autoFocus
          rows={12}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            "Remera sobre fondo negro\nDetalle del estampado\nModelo caminando hacia cámara"
          }
        />
        <small>
          {count} {count === 1 ? "plano listo" : "planos listos"}
        </small>
        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            className="solid-button"
            onClick={onSubmit}
            disabled={busy || !count}
          >
            {busy ? "Creando…" : `Crear ${count || ""} planos`}
          </button>
        </footer>
      </section>
    </div>
  );
}

function AdvancedShotDialog({
  shot,
  onClose,
  onSave,
  onDelete,
}: {
  shot: ProductionShot;
  onClose: () => void;
  onSave: (shot: ProductionShot) => void;
  onDelete: (shot: ProductionShot) => void;
}) {
  const [draft, setDraft] = useState(shot);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave(draft);
  }

  return (
    <div className="advanced-shot-backdrop" role="presentation">
      <form className="advanced-shot-dialog" onSubmit={submit}>
        <header>
          <div>
            <span className="section-code">AVANZADO / {shot.code}</span>
            <h2>Información completa del plano</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </header>
        <div className="advanced-shot-fields">
          <label>
            Título
            <input
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label>
            Encuadre
            <input
              value={draft.framing ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, framing: event.target.value || null })
              }
            />
          </label>
          <label>
            Ángulo
            <input
              value={draft.angle ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, angle: event.target.value || null })
              }
            />
          </label>
          <label>
            Movimiento
            <input
              value={draft.movement ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, movement: event.target.value || null })
              }
            />
          </label>
          <label>
            Duración (segundos)
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={
                draft.estimatedDurationMs
                  ? draft.estimatedDurationMs / 1_000
                  : ""
              }
              onChange={(event) =>
                setDraft({
                  ...draft,
                  estimatedDurationMs: event.target.value
                    ? Math.round(Number(event.target.value) * 1_000)
                    : null,
                })
              }
            />
          </label>
          <label>
            Estado
            <select
              value={draft.status}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  status: event.target.value as ProductionShot["status"],
                })
              }
            >
              <option value="incomplete">Incompleto</option>
              <option value="structured">Estructurado</option>
              <option value="storyboard">Con storyboard</option>
              <option value="first_frame">Con primer frame</option>
              <option value="video">Con video</option>
              <option value="approved">Aprobado</option>
              <option value="conflict">Conflicto</option>
            </select>
          </label>
          <label className="wide">
            Descripción visual
            <textarea
              rows={3}
              value={draft.visualDescription ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  visualDescription: event.target.value || null,
                })
              }
            />
          </label>
          <label className="wide">
            Acción
            <textarea
              rows={3}
              value={draft.action ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, action: event.target.value || null })
              }
            />
          </label>
          <label className="wide priority-field">
            Prompt del primer frame
            <textarea
              rows={5}
              value={draft.imagePrompt ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, imagePrompt: event.target.value || null })
              }
            />
          </label>
          <label className="wide priority-field video-field">
            Prompt de video
            <textarea
              rows={5}
              value={draft.videoPrompt ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, videoPrompt: event.target.value || null })
              }
            />
          </label>
          <label className="wide">
            Diálogo / texto
            <textarea
              rows={2}
              value={draft.dialogue ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, dialogue: event.target.value || null })
              }
            />
          </label>
        </div>
        <footer>
          <button
            type="button"
            className="delete-shot-button"
            onClick={() => onDelete(shot)}
          >
            <Trash2 size={14} /> Eliminar plano
          </button>
          <div>
            <button type="button" onClick={onClose}>
              Cancelar
            </button>
            <button className="solid-button">
              <Check size={14} /> Guardar cambios
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
