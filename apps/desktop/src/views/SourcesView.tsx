import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock3,
  FileInput,
  FileSearch,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { AnalysisProposal } from "@framesync/contracts";
import { useFrameSyncStore } from "../store";
import type { SourceEntry } from "../types";

type SourceTab = "original" | "summary" | "structure";
type ReviewGroup =
  | "all"
  | "script"
  | "episodes"
  | "characters"
  | "locations"
  | "scenes"
  | "shots"
  | "prompts"
  | "conflicts";

type ReviewItem = {
  id: string;
  kind: string;
  label: string;
  detail: string;
  confidence: number;
  method: string;
  reviewStatus: "pending" | "approved" | "rejected" | "needs_review";
  sourceMessageIds: string[];
};

function itemsFromProposal(
  proposal: AnalysisProposal,
  group: ReviewGroup,
): ReviewItem[] {
  const all: Array<ReviewItem & { group: ReviewGroup }> = [
    ...proposal.scriptCandidates.map((item) => ({
      ...item,
      group: "script" as const,
      label: item.title ?? "Guion detectado",
      detail: item.text,
      method: item.extractionMethod,
    })),
    ...proposal.episodes.map((item) => ({
      ...item,
      group: "episodes" as const,
      label: `${item.code} · ${item.title}`,
      detail: item.summary ?? "Sin resumen",
      method: item.extractionMethod,
    })),
    ...proposal.characters.map((item) => ({
      ...item,
      group: "characters" as const,
      label: item.name,
      detail: item.physicalDescription ?? "Sin descripción física",
      method: item.extractionMethod,
    })),
    ...proposal.locations.map((item) => ({
      ...item,
      group: "locations" as const,
      label: item.name,
      detail: item.description ?? "Sin descripción",
      method: item.extractionMethod,
    })),
    ...proposal.scenes.map((item) => ({
      ...item,
      group: "scenes" as const,
      label: `${item.code ?? "ESC"} · ${item.title}`,
      detail: item.summary ?? "Sin resumen",
      method: item.extractionMethod,
    })),
    ...proposal.shots.map((item) => ({
      ...item,
      group: "shots" as const,
      label: `${item.code ?? "SIN CÓDIGO"} · ${item.title}`,
      detail: item.visualDescription ?? "Sin descripción visual",
      method: item.extractionMethod,
    })),
    ...proposal.imagePrompts.map((item) => ({
      ...item,
      group: "prompts" as const,
      label: `Prompt de imagen · ${item.relatedShotCode ?? "sin asignar"}`,
      detail: item.text,
      method: item.extractionMethod,
    })),
    ...proposal.videoPrompts.map((item) => ({
      ...item,
      group: "prompts" as const,
      label: `Prompt de video · ${item.relatedShotCode ?? "sin asignar"}`,
      detail: item.text,
      method: item.extractionMethod,
    })),
    ...proposal.corrections.map((item) => ({
      ...item,
      group: "conflicts" as const,
      label: `Corrección · ${item.targetReference ?? "destino incierto"}`,
      detail: item.instruction,
      method: item.extractionMethod,
    })),
    ...proposal.unclassified.map((item) => ({
      ...item,
      group: "conflicts" as const,
      label: item.kind === "note" ? "Nota" : "Contenido no clasificado",
      detail: item.text,
      method: item.extractionMethod,
    })),
  ];
  return all.filter((item) => group === "all" || item.group === group);
}

const groups: Array<{ id: ReviewGroup; label: string }> = [
  { id: "all", label: "Todo" },
  { id: "script", label: "Guion" },
  { id: "episodes", label: "Episodios" },
  { id: "characters", label: "Personajes" },
  { id: "locations", label: "Escenarios" },
  { id: "scenes", label: "Escenas" },
  { id: "shots", label: "Planos" },
  { id: "prompts", label: "Prompts" },
  { id: "conflicts", label: "Conflictos" },
];

export function SourcesView() {
  const {
    sources,
    selectedSourceId,
    selectSource,
    analyzeSource,
    reviewItem,
    approveAllCertain,
    createStoryboard,
    importReviewed,
    deleteSource,
    production,
    busy,
  } = useFrameSyncStore();
  const [tab, setTab] = useState<SourceTab>("original");
  const [group, setGroup] = useState<ReviewGroup>("all");
  const [deleteTarget, setDeleteTarget] = useState<SourceEntry | null>(null);
  const selected =
    sources.find((source) => source.capture.captureId === selectedSourceId) ??
    sources[0];
  const reviewItems = useMemo(
    () =>
      selected?.proposal ? itemsFromProposal(selected.proposal, group) : [],
    [selected, group],
  );

  if (!selected) {
    return (
      <section className="empty-workspace">
        <FileInput size={32} />
        <h2>La bandeja está vacía</h2>
        <p>
          Importá la captura demo desde Agregar o enviá una conversación con la
          extensión de Edge.
        </p>
      </section>
    );
  }

  const approvedCount = selected.proposal
    ? itemsFromProposal(selected.proposal, "all").filter(
        (item) => item.reviewStatus === "approved",
      ).length
    : 0;
  const targetHasImportedContent = deleteTarget
    ? [
        ...production.scripts,
        ...production.characters,
        ...production.locations,
        ...production.episodes,
        ...production.scenes,
        ...production.shots,
      ].some((item) =>
        item.sourceMessageIds.includes(deleteTarget.capture.captureId),
      )
    : false;

  function confirmDelete(removeImportedContent: boolean) {
    if (!deleteTarget) return;
    const captureId = deleteTarget.capture.captureId;
    setDeleteTarget(null);
    void deleteSource(captureId, removeImportedContent);
  }

  return (
    <div className="sources-workspace">
      <div className="source-rail" role="list">
        {sources.map((source) => (
          <div
            role="listitem"
            key={source.capture.captureId}
            className={`source-rail-item ${
              source.capture.captureId === selected.capture.captureId
                ? "active"
                : ""
            }`}
          >
            <button
              className="source-open"
              onClick={() => selectSource(source.capture.captureId)}
            >
              <span className={`platform-mark ${source.capture.platform}`}>
                {source.capture.platform.slice(0, 2).toUpperCase()}
              </span>
              <span>
                <strong>
                  {source.capture.conversationTitle ?? "Captura sin título"}
                </strong>
                <small>
                  {source.capture.messages.length} mensajes ·{" "}
                  {source.capture.assets.length} medios
                </small>
              </span>
              <span className={`source-state ${source.status}`}>
                {source.status}
              </span>
              <ChevronRight size={14} />
            </button>
            <button
              className="source-delete"
              aria-label={`Eliminar ${source.capture.conversationTitle ?? "fuente"}`}
              title="Eliminar fuente"
              onClick={() => setDeleteTarget(source)}
              disabled={busy}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <section className="source-detail">
        <header className="section-titlebar">
          <div>
            <span className="section-code">FUENTE / {selected.status}</span>
            <h1>
              {selected.capture.conversationTitle ?? "Captura sin título"}
            </h1>
            <p>
              {selected.capture.platform.toUpperCase()} ·{" "}
              {new Date(selected.capture.capturedAt).toLocaleString("es-AR")} ·{" "}
              {selected.capture.captureMode}
            </p>
          </div>
          <div className="titlebar-actions">
            <button
              onClick={() => void analyzeSource(selected.capture.captureId)}
              disabled={busy}
            >
              <RotateCcw size={14} />
              {selected.proposal ? "Volver a analizar" : "1. Analizar fuente"}
            </button>
            <button
              className="solid-button create-storyboard-button"
              onClick={() => void createStoryboard(selected.capture.captureId)}
              disabled={!selected.proposal || busy}
            >
              <Sparkles size={14} />
              Crear guion y storyboard
            </button>
          </div>
        </header>

        <div className="source-workflow">
          <span>
            <b>1</b> Analizar
          </span>
          <ChevronRight size={13} />
          <span>
            <b>2</b> Revisar <em>opcional</em>
          </span>
          <ChevronRight size={13} />
          <span>
            <b>3</b> Crear guion y storyboard
          </span>
          <small>
            Crear envía el texto a Guion y genera las escenas y planos
            detectados.
          </small>
        </div>

        <div className="down-tabs" role="tablist">
          {(
            [
              ["original", "Fuente original"],
              ["summary", "Resumen"],
              ["structure", "Estructura detectada"],
            ] as Array<[SourceTab, string]>
          ).map(([id, label]) => (
            <button
              role="tab"
              aria-selected={tab === id}
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "original" && (
          <div className="original-feed">
            <div className="immutability-note">
              <FileSearch size={15} />
              <span>
                Esta fuente se conserva intacta. La edición ocurre solo sobre la
                estructura propuesta.
              </span>
              <code>{selected.capture.captureId}</code>
            </div>
            {selected.capture.messages.map((message) => (
              <article className="source-message" key={message.id}>
                <header>
                  <span className={`role ${message.role}`}>{message.role}</span>
                  <span>
                    #{String(message.orderIndex + 1).padStart(2, "0")}
                  </span>
                  <code>{message.messageFingerprint.slice(0, 12)}</code>
                </header>
                <pre>{message.text}</pre>
              </article>
            ))}
          </div>
        )}

        {tab === "summary" && (
          <div className="summary-panel">
            {selected.proposal ? (
              <>
                <span className="analysis-engine">
                  MOTOR LOCAL · RULES 0.1.0
                </span>
                <h2>{selected.proposal.summary}</h2>
                <div className="summary-grid">
                  {[
                    ["Guiones", selected.proposal.scriptCandidates.length],
                    ["Episodios", selected.proposal.episodes.length],
                    ["Personajes", selected.proposal.characters.length],
                    ["Escenarios", selected.proposal.locations.length],
                    ["Escenas", selected.proposal.scenes.length],
                    ["Planos", selected.proposal.shots.length],
                    [
                      "Conflictos",
                      selected.proposal.corrections.length +
                        selected.proposal.unclassified.length,
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <strong>{value}</strong>
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
                {selected.proposal.warnings.map((warning) => (
                  <p className="analysis-warning" key={warning.code}>
                    <AlertTriangle size={14} />
                    <span>
                      <strong>{warning.code}</strong>
                      {warning.message}
                    </span>
                  </p>
                ))}
              </>
            ) : (
              <div className="empty-analysis">
                <Clock3 size={28} />
                <h2>La fuente todavía no fue analizada</h2>
                <p>
                  El texto original ya está a salvo. Ejecutá el motor local
                  cuando quieras proponer una estructura.
                </p>
              </div>
            )}
          </div>
        )}

        {tab === "structure" && (
          <div className="review-panel">
            {!selected.proposal ? (
              <div className="empty-analysis">
                <Clock3 size={28} />
                <h2>Sin propuesta</h2>
                <button
                  className="solid-button"
                  onClick={() => void analyzeSource(selected.capture.captureId)}
                >
                  Analizar ahora
                </button>
              </div>
            ) : (
              <>
                <div className="review-bulk-actions">
                  <button
                    className="accent-button"
                    onClick={() =>
                      void approveAllCertain(selected.capture.captureId)
                    }
                    disabled={busy}
                  >
                    <Check size={14} />
                    Marcar alta confianza como aprobada
                  </button>
                  <button
                    onClick={() =>
                      void importReviewed(selected.capture.captureId)
                    }
                    disabled={approvedCount === 0 || busy}
                  >
                    <FileInput size={14} />
                    Importar sólo los {approvedCount} aprobados
                  </button>
                  <small>
                    Opciones avanzadas; no hacen falta para usar Crear guion y
                    storyboard.
                  </small>
                </div>
                <div className="review-filters">
                  {groups.map((item) => {
                    const count = itemsFromProposal(
                      selected.proposal!,
                      item.id,
                    ).length;
                    return (
                      <button
                        key={item.id}
                        className={group === item.id ? "active" : ""}
                        onClick={() => setGroup(item.id)}
                      >
                        {item.label}
                        <span>{count}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="review-list">
                  {reviewItems.map((item) => (
                    <article
                      className={`review-item ${item.reviewStatus}`}
                      key={item.id}
                    >
                      <div className="confidence">
                        <strong>{Math.round(item.confidence * 100)}</strong>
                        <span>%</span>
                        <i
                          style={
                            {
                              "--confidence": `${item.confidence * 100}%`,
                            } as React.CSSProperties
                          }
                        />
                      </div>
                      <div className="review-copy">
                        <header>
                          <span className="kind">{item.kind}</span>
                          <span className="method">{item.method}</span>
                          <span
                            className={`review-status ${item.reviewStatus}`}
                          >
                            {item.reviewStatus}
                          </span>
                        </header>
                        <h3>{item.label}</h3>
                        <p>{item.detail}</p>
                        <details>
                          <summary>Ver trazabilidad</summary>
                          <code>{item.sourceMessageIds.join(", ")}</code>
                        </details>
                      </div>
                      <div className="review-actions">
                        <button
                          title="Aprobar"
                          className="approve"
                          onClick={() =>
                            void reviewItem(
                              selected.capture.captureId,
                              item.id,
                              "approved",
                            )
                          }
                        >
                          <Check size={15} />
                        </button>
                        <button
                          title="Rechazar"
                          className="reject"
                          onClick={() =>
                            void reviewItem(
                              selected.capture.captureId,
                              item.id,
                              "rejected",
                            )
                          }
                        >
                          <X size={15} />
                        </button>
                        <button
                          title="Necesita revisión"
                          onClick={() =>
                            void reviewItem(
                              selected.capture.captureId,
                              item.id,
                              "needs_review",
                            )
                          }
                        >
                          <AlertTriangle size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </section>
      {deleteTarget && (
        <div
          className="source-delete-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDeleteTarget(null);
          }}
        >
          <section
            className="source-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-source-title"
          >
            <div className="delete-dialog-icon">
              <ShieldAlert size={22} />
            </div>
            <div>
              <span className="section-code">ELIMINAR FUENTE</span>
              <h2 id="delete-source-title">
                {deleteTarget.capture.conversationTitle ?? "Captura sin título"}
              </h2>
              <p>
                La captura dejará de aparecer en este proyecto. Elegí si querés
                conservar o retirar también la estructura que ya generó.
              </p>
            </div>
            <div className="source-delete-options">
              <button onClick={() => setDeleteTarget(null)}>Cancelar</button>
              <button onClick={() => confirmDelete(false)} disabled={busy}>
                Quitar sólo la fuente
                <small>
                  Conserva guion, episodios, escenas, planos y medios asignados.
                </small>
              </button>
              <button
                className="destructive"
                onClick={() => confirmDelete(true)}
                disabled={busy || !targetHasImportedContent}
              >
                <Trash2 size={14} />
                Eliminar fuente y contenido
                <small>
                  {targetHasImportedContent
                    ? "Retira lo que esta fuente importó. No se puede deshacer."
                    : "Esta fuente todavía no creó contenido de producción."}
                </small>
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
