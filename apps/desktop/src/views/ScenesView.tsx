import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  Film,
  Image,
  ListFilter,
  MoreVertical,
  Pencil,
  Play,
  Search,
  StepForward,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FormEvent, useMemo, useRef, useState } from "react";
import { useFrameSyncStore } from "../store";
import type { DetectedScene } from "@framesync/contracts";
import type { ProductionShot } from "../types";
import { TimelineView } from "./TimelineView";

type FlatRow =
  | { kind: "scene"; key: string; scene: DetectedScene; shotCount: number }
  | { kind: "shot"; key: string; shot: ProductionShot };

function formatDuration(milliseconds: number | null) {
  if (!milliseconds) return "—";
  return `${(milliseconds / 1_000).toFixed(
    milliseconds % 1_000 === 0 ? 0 : 1,
  )}s`;
}

function flattenRows(
  scenes: DetectedScene[],
  shots: ProductionShot[],
  collapsed: Set<string>,
  query: string,
  status: string,
): FlatRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("es");
  return scenes.flatMap((scene) => {
    const sceneShots = shots.filter((shot) => {
      const inScene = shot.sceneCode === scene.code;
      const matchesSearch =
        !normalizedQuery ||
        `${shot.code ?? ""} ${shot.title} ${shot.visualDescription ?? ""}`
          .toLocaleLowerCase("es")
          .includes(normalizedQuery);
      const matchesStatus = status === "all" || shot.status === status;
      return inScene && matchesSearch && matchesStatus;
    });
    const header: FlatRow = {
      kind: "scene",
      key: `scene-${scene.id}`,
      scene,
      shotCount: sceneShots.length,
    };
    if (scene.code && collapsed.has(scene.code)) return [header];
    return [
      header,
      ...sceneShots.map((shot): FlatRow => ({
        kind: "shot",
        key: `shot-${shot.id}`,
        shot,
      })),
    ];
  });
}

export function ScenesView() {
  const { production, expandedShotId, setExpandedShot, updateShot } =
    useFrameSyncStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [timelineOpen, setTimelineOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      flattenRows(
        production.scenes,
        production.shots,
        collapsed,
        query,
        status,
      ),
    [production.scenes, production.shots, collapsed, query, status],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row?.kind === "scene") return 44;
      if (row?.kind === "shot" && row.shot.id === expandedShotId) return 360;
      return 104;
    },
    overscan: 7,
  });

  function toggleScene(code: string | null) {
    if (!code) return;
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function nextIncomplete() {
    const shot = production.shots.find(
      (item) =>
        item.status === "incomplete" ||
        !item.visualDescription ||
        !item.estimatedDurationMs,
    );
    if (!shot) return;
    setExpandedShot(shot.id);
    const rowIndex = rows.findIndex(
      (row) => row.kind === "shot" && row.shot.id === shot.id,
    );
    if (rowIndex >= 0) {
      virtualizer.scrollToIndex(rowIndex, { align: "center" });
    }
  }

  if (production.scenes.length === 0) {
    return (
      <section className="empty-workspace">
        <Film size={34} />
        <h2>No hay escenas importadas</h2>
        <p>
          En Fuentes, aprobá escenas y planos de alta confianza y elegí
          Importar.
        </p>
      </section>
    );
  }

  return (
    <section className="shot-workspace">
      <header className="shot-toolbar">
        <div>
          <span className="section-code">MESA DE PRODUCCIÓN</span>
          <h1>Escenas y planos</h1>
        </div>
        <div className="shot-stats">
          <span>
            <strong>{production.scenes.length}</strong> escenas
          </span>
          <span>
            <strong>{production.shots.length}</strong> planos
          </span>
          <span>
            <strong>
              {Math.round(
                production.shots.reduce(
                  (sum, shot) => sum + (shot.estimatedDurationMs ?? 0),
                  0,
                ) / 1_000,
              )}
              s
            </strong>{" "}
            estimados
          </span>
        </div>
        <div className="shot-tools">
          <label className="search-box">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar plano…"
            />
          </label>
          <label className="select-box">
            <ListFilter size={14} />
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">Todos los estados</option>
              <option value="structured">Estructurado</option>
              <option value="storyboard">Con storyboard</option>
              <option value="first_frame">Con primer frame</option>
              <option value="video">Con video</option>
              <option value="approved">Aprobado</option>
              <option value="conflict">Conflicto</option>
              <option value="incomplete">Incompleto</option>
            </select>
          </label>
          <button onClick={nextIncomplete}>
            <StepForward size={14} />
            <span>Siguiente incompleto</span>
          </button>
        </div>
      </header>

      <div className="shot-table-shell">
        <div className="shot-grid shot-column-header">
          <span>PLANO</span>
          <span>DESCRIPCIÓN</span>
          <span>STORYBOARD</span>
          <span>PRIMER FRAME</span>
          <span>VIDEO</span>
          <span>DURACIÓN</span>
          <span>ESTADO</span>
          <span />
        </div>
        <div className="shot-scroll" ref={scrollRef}>
          <div
            className="virtual-shot-list"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={row.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="virtual-shot-row"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.kind === "scene" ? (
                    <button
                      className="scene-band"
                      onClick={() => toggleScene(row.scene.code)}
                    >
                      {row.scene.code && collapsed.has(row.scene.code) ? (
                        <ChevronRight size={16} />
                      ) : (
                        <ChevronDown size={16} />
                      )}
                      <span>{row.scene.code ?? "ESC"}</span>
                      <strong>{row.scene.title}</strong>
                      <small>{row.scene.locationName ?? "Sin escenario"}</small>
                      <i>{row.shotCount} planos</i>
                    </button>
                  ) : (
                    <ShotRow
                      shot={row.shot}
                      expanded={expandedShotId === row.shot.id}
                      onToggle={() =>
                        setExpandedShot(
                          expandedShotId === row.shot.id ? null : row.shot.id,
                        )
                      }
                      onSave={(shot) => void updateShot(shot)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className={`timeline-drawer ${timelineOpen ? "open" : ""}`}>
        <button
          className="timeline-drawer-handle"
          onClick={() => setTimelineOpen((open) => !open)}
        >
          <Film size={14} />
          TIMELINE
          <span>{production.shots.length} clips</span>
          <ChevronDown size={14} />
        </button>
        {timelineOpen && <TimelineView compact />}
      </div>
    </section>
  );
}

function ShotRow({
  shot,
  expanded,
  onToggle,
  onSave,
}: {
  shot: ProductionShot;
  expanded: boolean;
  onToggle: () => void;
  onSave: (shot: ProductionShot) => void;
}) {
  return (
    <article className={`shot-row ${expanded ? "expanded" : ""}`}>
      <div className="shot-grid shot-summary">
        <button className="shot-identity" onClick={onToggle}>
          <strong>{shot.code ?? "SIN CÓDIGO"}</strong>
          <span>{shot.title}</span>
          <small>
            {shot.framing ?? "Encuadre pendiente"}
            {shot.movement ? ` · ${shot.movement}` : ""}
          </small>
        </button>
        <button className="shot-description" onClick={onToggle}>
          <p>{shot.visualDescription ?? "Descripción visual pendiente."}</p>
          {shot.dialogue && <q>{shot.dialogue}</q>}
        </button>
        <StoryboardCell />
        <MediaPlaceholder type="frame" />
        <MediaPlaceholder type="video" />
        <div className="duration-cell">
          <Clock3 size={13} />
          <strong>{formatDuration(shot.estimatedDurationMs)}</strong>
        </div>
        <StatusCell status={shot.status} />
        <button className="row-menu" onClick={onToggle} title="Editar plano">
          {expanded ? <Pencil size={15} /> : <MoreVertical size={16} />}
        </button>
      </div>
      {expanded && (
        <ShotEditor shot={shot} onSave={onSave} onClose={onToggle} />
      )}
    </article>
  );
}

function StoryboardCell() {
  return (
    <div className="storyboard-cell">
      {[1, 2, 3].map((frame) => (
        <div key={frame}>
          <span>{String(frame).padStart(2, "0")}</span>
          <Image size={13} />
        </div>
      ))}
    </div>
  );
}

function MediaPlaceholder({ type }: { type: "frame" | "video" }) {
  return (
    <div className={`media-cell ${type}`}>
      <div className="safe-frame" />
      {type === "video" ? <Play size={17} /> : <Image size={16} />}
      <span>{type === "video" ? "SIN VIDEO" : "SIN FRAME"}</span>
    </div>
  );
}

function StatusCell({ status }: { status: ProductionShot["status"] }) {
  const Icon =
    status === "approved"
      ? CheckCircle2
      : status === "incomplete" || status === "conflict"
        ? CircleDashed
        : CheckCircle2;
  return (
    <div className={`status-cell ${status}`}>
      <Icon size={12} />
      <span>{status.replace("_", " ")}</span>
    </div>
  );
}

function ShotEditor({
  shot,
  onSave,
  onClose,
}: {
  shot: ProductionShot;
  onSave: (shot: ProductionShot) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(shot);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave(draft);
  }

  return (
    <form className="shot-editor" onSubmit={submit}>
      <header>
        <div>
          <span>EDITOR DE PLANO / {shot.code}</span>
          <h3>Los campos vacíos permanecen vacíos hasta que los completes.</h3>
        </div>
        <button type="button" onClick={onClose}>
          Cerrar
        </button>
      </header>
      <div className="shot-editor-grid">
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
            placeholder="Sin inventar"
            onChange={(event) =>
              setDraft({
                ...draft,
                framing: event.target.value || null,
              })
            }
          />
        </label>
        <label>
          Movimiento
          <input
            value={draft.movement ?? ""}
            placeholder="Sin especificar"
            onChange={(event) =>
              setDraft({
                ...draft,
                movement: event.target.value || null,
              })
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
              draft.estimatedDurationMs ? draft.estimatedDurationMs / 1_000 : ""
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
            <option value="structured">Estructurado</option>
            <option value="storyboard">Con storyboard</option>
            <option value="first_frame">Con primer frame</option>
            <option value="video">Con video</option>
            <option value="approved">Aprobado</option>
            <option value="conflict">Conflicto</option>
            <option value="incomplete">Incompleto</option>
          </select>
        </label>
      </div>
      <footer>
        <span>ORIGEN: {shot.extractionMethod}</span>
        <button className="solid-button">Guardar cambios</button>
      </footer>
    </form>
  );
}
