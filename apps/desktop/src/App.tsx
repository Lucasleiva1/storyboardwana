import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { useEffect } from "react";
import { ProjectGate } from "./components/ProjectGate";
import { TopBar } from "./components/TopBar";
import { useFrameSyncStore } from "./store";
import { CharactersView, LocationsView, ScriptView } from "./views/EntityViews";
import { MediaView } from "./views/MediaView";
import { ScenesView } from "./views/ScenesView";
import { SourcesView } from "./views/SourcesView";
import { TimelineView } from "./views/TimelineView";
import { SettingsView } from "./views/SettingsView";

export function App() {
  const {
    bootstrap,
    pollInbox,
    ready,
    busy,
    error,
    clearError,
    project,
    activeView,
  } = useFrameSyncStore();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!project) return;
    void pollInbox();
    const interval = window.setInterval(() => void pollInbox(), 4_000);
    return () => window.clearInterval(interval);
  }, [project, pollInbox]);

  if (!ready) {
    return (
      <main className="app-loading">
        <LoaderCircle size={30} className="spin" />
        <span>PREPARANDO MESA LOCAL</span>
      </main>
    );
  }

  if (!project && activeView !== "settings") {
    return (
      <>
        <ProjectGate />
        {error && <ErrorToast message={error} onClose={clearError} />}
      </>
    );
  }

  return (
    <div className="app-shell">
      <TopBar />
      {busy && (
        <div className="busy-line">
          <span />
        </div>
      )}
      <main className="workspace-main">
        {activeView === "sources" && <SourcesView />}
        {activeView === "script" && <ScriptView />}
        {activeView === "characters" && <CharactersView />}
        {activeView === "locations" && <LocationsView />}
        {activeView === "shots" && <ScenesView />}
        {activeView === "media" && <MediaView />}
        {activeView === "timeline" && <TimelineView />}
        {activeView === "settings" && <SettingsView />}
      </main>
      <footer className="status-bar">
        <span>LOCAL</span>
        <strong>{project?.name ?? "Sin proyecto"}</strong>
        <i />
        <span>SQLITE · WAL</span>
        <i />
        <span>ANÁLISIS SIN NUBE</span>
        <b>FrameSync 0.1.2</b>
      </footer>
      {error && <ErrorToast message={error} onClose={clearError} />}
    </div>
  );
}

function ErrorToast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="error-toast" role="alert">
      <AlertTriangle size={17} />
      <span>
        <strong>No se pudo completar la operación</strong>
        {message}
      </span>
      <button onClick={onClose} aria-label="Cerrar error">
        <X size={14} />
      </button>
    </div>
  );
}
