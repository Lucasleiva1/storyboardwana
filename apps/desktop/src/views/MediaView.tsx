import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  CheckCircle2,
  FolderOpen,
  ImageOff,
  Link2,
  Maximize2,
  Video,
} from "lucide-react";
import { useState } from "react";
import { useFrameSyncStore } from "../store";

type MediaImportResult = {
  discovered: number;
  imported: number;
  duplicates: number;
  assigned: number;
  unassigned: number;
  images: number;
  videos: number;
  warnings: string[];
};

export function MediaView() {
  const setActiveView = useFrameSyncStore((state) => state.setActiveView);
  const project = useFrameSyncStore((state) => state.project);
  const production = useFrameSyncStore((state) => state.production);
  const openProject = useFrameSyncStore((state) => state.openProject);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<MediaImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assets = production.assets;

  async function chooseMediaFolder() {
    if (!project || importing) return;
    setError(null);
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Elegí una carpeta de imágenes y videos",
    });
    if (!selected || Array.isArray(selected)) return;
    setImporting(true);
    try {
      const imported = await invoke<MediaImportResult>("import_media_folder", {
        projectId: project.id,
        projectNumber: project.projectNumber,
        projectName: project.name,
        folderPath: selected,
      });
      setResult(imported);
      await openProject(project);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "No se pudo importar la carpeta.",
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="entity-workspace">
      <header className="section-titlebar">
        <div>
          <span className="section-code">BANDEJA DE MEDIOS</span>
          <h1>Assets sin degradación</h1>
          <p>
            Resolución, hash, origen y estrategia de calidad permanecen
            trazables.
          </p>
        </div>
        <div className="media-header-actions">
          <button
            className="solid-button"
            onClick={() => void chooseMediaFolder()}
            disabled={importing}
          >
            <FolderOpen size={14} />
            {importing ? "Importando…" : "Cargar carpeta de medios"}
          </button>
          <button onClick={() => setActiveView("shots")}>
            <ArrowLeft size={14} />
            Volver a escenas y planos
          </button>
        </div>
      </header>
      <div className="media-import-guide">
        <strong>ASIGNACIÓN AUTOMÁTICA POR NOMBRE</strong>
        <span>
          Primer frame: P001_PRIMER_FRAME.png · Videos: P001_VIDEO_V01.mp4,
          P001_VIDEO_V02.mp4
        </span>
        <small>
          Todos los V01, V02 y V03 quedan como alternativas del mismo plano; no
          crean planos nuevos.
        </small>
      </div>
      {result && (
        <div className="media-import-result">
          <CheckCircle2 size={17} />
          <span>
            <strong>{result.discovered} archivos encontrados</strong>
            {result.images} imágenes · {result.videos} videos ·{" "}
            {result.assigned} asignados · {result.unassigned} sin asignar
          </span>
          {result.warnings.length > 0 && (
            <details>
              <summary>{result.warnings.length} avisos</summary>
              <ul>
                {result.warnings.slice(0, 20).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {error && <div className="media-import-error">{error}</div>}
      {assets.length > 0 ? (
        <div className="media-grid">
          {assets.map((asset) => (
            <article
              key={`${asset.id}-${asset.shotCode ?? "unassigned"}-${asset.orderIndex ?? 0}`}
            >
              <div className="media-preview">
                {asset.kind === "video" ? (
                  <Video size={28} />
                ) : (
                  <ImageOff size={28} />
                )}
                <span>PREVIEW LOCAL</span>
              </div>
              <header>
                <strong>{asset.originalFilename ?? asset.id}</strong>
                <Maximize2 size={14} />
              </header>
              <dl>
                <div>
                  <dt>Resolución</dt>
                  <dd>
                    {asset.width ?? "?"} × {asset.height ?? "?"}
                  </dd>
                </div>
                <div>
                  <dt>Calidad</dt>
                  <dd>{asset.qualitySource}</dd>
                </div>
                <div>
                  <dt>Asignación</dt>
                  <dd>
                    {asset.shotCode ?? asset.relatedShotCode ?? "Sin plano"} ·{" "}
                    {asset.role}
                    {asset.kind === "video" &&
                    asset.orderIndex !== null &&
                    asset.shotCode
                      ? `.${asset.orderIndex + 1} · V${String(asset.orderIndex + 1).padStart(2, "0")}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>Fuente</dt>
                  <dd>
                    <Link2 size={11} />
                    {asset.qualitySource === "local_file"
                      ? "Carpeta local"
                      : "Extensión del navegador"}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-workspace compact">
          <ImageOff size={28} />
          <h2>No hay medios binarios en el proyecto</h2>
          <p>
            Usá “Cargar carpeta de medios” o capturá imágenes y videos desde la
            extensión de Edge.
          </p>
        </div>
      )}
    </section>
  );
}
