import { ArrowLeft, ImageOff, Link2, Maximize2 } from "lucide-react";
import { useMemo } from "react";
import { useFrameSyncStore } from "../store";

export function MediaView() {
  const setActiveView = useFrameSyncStore((state) => state.setActiveView);
  const sources = useFrameSyncStore((state) => state.sources);
  const assets = useMemo(
    () =>
      sources.flatMap((source) =>
        source.capture.assets.map((asset) => ({
          ...asset,
          captureTitle: source.capture.conversationTitle,
        })),
      ),
    [sources],
  );

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
        <button onClick={() => setActiveView("shots")}>
          <ArrowLeft size={14} />
          Volver a escenas y planos
        </button>
      </header>
      {assets.length > 0 ? (
        <div className="media-grid">
          {assets.map((asset) => (
            <article key={asset.id}>
              <div className="media-preview">
                <ImageOff size={28} />
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
                    {asset.relatedShotCode ?? "Sin plano"} · {asset.role}
                  </dd>
                </div>
                <div>
                  <dt>Fuente</dt>
                  <dd>
                    <Link2 size={11} />
                    {asset.captureTitle ?? "Sin título"}
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
            La captura demo no contiene imágenes. La extensión agregará acá los
            assets que pueda transferir y verificar.
          </p>
        </div>
      )}
    </section>
  );
}
