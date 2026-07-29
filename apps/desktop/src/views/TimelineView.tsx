import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useMemo } from "react";
import { useFrameSyncStore } from "../store";

function duration(shotDuration: number | null) {
  return shotDuration ?? 3_000;
}

export function TimelineView({ compact = false }: { compact?: boolean }) {
  const { shots, scenes } = useFrameSyncStore((state) => state.production);
  const total = useMemo(
    () =>
      shots.reduce((sum, shot) => sum + duration(shot.estimatedDurationMs), 0),
    [shots],
  );

  if (shots.length === 0 && compact) return null;

  return (
    <section
      className={compact ? "timeline compact-timeline" : "timeline full"}
    >
      {!compact && (
        <header className="section-titlebar">
          <div>
            <span className="section-code">TIMELINE DE PREPRODUCCIÓN</span>
            <h1>Orden y duración estimada</h1>
            <p>Representación funcional; no es un editor de video.</p>
          </div>
        </header>
      )}
      <div className="timeline-ruler">
        <span>00:00</span>
        <span>{Math.round(total / 2_000)}s</span>
        <span>{Math.round(total / 1_000)}s</span>
      </div>
      <div className="timeline-scenes">
        {scenes.map((scene, index) => {
          const count = shots.filter(
            (shot) => shot.sceneCode === scene.code,
          ).length;
          return (
            <div
              key={scene.id}
              className={`scene-strip tone-${index % 3}`}
              style={{
                flexGrow: Math.max(count, 1),
              }}
            >
              <strong>{scene.code}</strong>
              <span>{scene.title}</span>
            </div>
          );
        })}
      </div>
      <div className="timeline-clips">
        {shots.map((shot) => (
          <button
            key={shot.id}
            style={{
              flexGrow: Math.max(duration(shot.estimatedDurationMs) / 1_000, 1),
            }}
          >
            <span>{shot.code}</span>
            <strong>{shot.title}</strong>
          </button>
        ))}
      </div>
      <div className="timeline-controls">
        <button title="Anterior">
          <SkipBack size={14} />
        </button>
        <button className="play" title="Reproducir">
          <Play size={15} />
        </button>
        <button title="Pausa">
          <Pause size={14} />
        </button>
        <button title="Siguiente">
          <SkipForward size={14} />
        </button>
        <time>00:00 / {Math.round(total / 1_000)}s</time>
      </div>
    </section>
  );
}
