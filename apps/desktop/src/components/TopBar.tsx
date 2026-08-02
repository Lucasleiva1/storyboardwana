import {
  Archive,
  ChevronDown,
  Clapperboard,
  Database,
  FileText,
  Images,
  MapPin,
  Pencil,
  Plus,
  Radio,
  Rows3,
  ScanLine,
  Settings,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFrameSyncStore } from "../store";
import type { WorkspaceView } from "../types";

const navigation: Array<{
  id: WorkspaceView;
  label: string;
  icon: typeof Database;
}> = [
  { id: "sources", label: "Fuentes", icon: Database },
  { id: "script", label: "Guion", icon: FileText },
  { id: "characters", label: "Personajes", icon: Users },
  { id: "locations", label: "Escenarios", icon: MapPin },
  { id: "shots", label: "Escenas y planos", icon: Rows3 },
  { id: "media", label: "Multimedia", icon: Images },
  { id: "timeline", label: "Timeline", icon: Clapperboard },
  { id: "settings", label: "Configuración", icon: Settings },
];

export function TopBar() {
  const {
    project,
    projects,
    activeView,
    setActiveView,
    openProject,
    createProject,
    renameProject,
    importDemo,
    buildStressDataset,
    sources,
    inboxCount,
  } = useFrameSyncStore();
  const [projectMenu, setProjectMenu] = useState(false);
  const [createMenu, setCreateMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function closeMenus(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setProjectMenu(false);
        setCreateMenu(false);
      }
    }
    window.addEventListener("pointerdown", closeMenus);
    return () => window.removeEventListener("pointerdown", closeMenus);
  }, []);

  return (
    <header className="workspace-header">
      <div className="top-line">
        <div className="brand">
          <span className="brand-symbol" aria-hidden="true">
            <ScanLine size={22} />
          </span>
          <div>
            <strong>STORYBOARD WANA</strong>
            <small>VISUAL PRODUCTION DESK</small>
          </div>
        </div>

        <nav className="top-navigation" aria-label="Navegación principal">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={activeView === id ? "active" : ""}
              onClick={() => setActiveView(id)}
            >
              <Icon size={14} aria-hidden="true" />
              {label}
              {id === "sources" && inboxCount > 0 && (
                <span className="nav-count">{inboxCount}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="header-actions" ref={menuRef}>
          <button
            className="header-button project-picker"
            onClick={() => {
              setProjectMenu((open) => !open);
              setCreateMenu(false);
            }}
            aria-expanded={projectMenu}
          >
            <span>
              <small>PROYECTO</small>
              <strong>
                {project
                  ? `PRJ-${String(project.projectNumber).padStart(4, "0")} · ${project.name}`
                  : "Sin proyecto"}
              </strong>
            </span>
            <ChevronDown size={14} />
          </button>
          <button
            className="header-button accent"
            onClick={() => {
              setCreateMenu((open) => !open);
              setProjectMenu(false);
            }}
            aria-expanded={createMenu}
          >
            <Plus size={14} />
            Agregar
            <ChevronDown size={12} />
          </button>

          {projectMenu && (
            <div className="drop-panel project-drop">
              <div className="drop-heading">
                <span>PROYECTOS RECIENTES</span>
                <small>{projects.length}</small>
              </div>
              <button
                onClick={() => {
                  const name = window.prompt(
                    "Nombre del nuevo proyecto (podés dejarlo vacío):",
                    "",
                  );
                  if (name !== null) void createProject(name);
                  setProjectMenu(false);
                }}
              >
                <Plus size={14} />
                <span>
                  <strong>Nuevo proyecto</strong>
                  <small>Nombre opcional y número automático</small>
                </span>
              </button>
              {project && (
                <button
                  onClick={() => {
                    const name = window.prompt(
                      "Nuevo nombre del proyecto:",
                      project.name,
                    );
                    if (name !== null) void renameProject(name);
                    setProjectMenu(false);
                  }}
                >
                  <Pencil size={14} />
                  <span>
                    <strong>Renombrar proyecto actual</strong>
                    <small>El número y el identificador no cambian</small>
                  </span>
                </button>
              )}
              {projects.map((item) => (
                <button
                  key={item.id}
                  className={item.id === project?.id ? "selected" : ""}
                  onClick={() => {
                    void openProject(item);
                    setProjectMenu(false);
                  }}
                >
                  <Archive size={14} />
                  <span>
                    <strong>
                      PRJ-{String(item.projectNumber).padStart(4, "0")} ·{" "}
                      {item.name}
                    </strong>
                    <small>
                      {item.id === project?.id
                        ? `${sources.length} fuentes`
                        : "Abrir proyecto"}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}

          {createMenu && (
            <div className="drop-panel create-drop">
              <button
                onClick={() => {
                  void importDemo();
                  setCreateMenu(false);
                }}
              >
                <Radio size={15} />
                <span>
                  <strong>Importar captura demo</strong>
                  <small>Recorre el pipeline real local</small>
                </span>
              </button>
              <button
                onClick={() => {
                  buildStressDataset();
                  setCreateMenu(false);
                }}
              >
                <Rows3 size={15} />
                <span>
                  <strong>Probar con 40 planos</strong>
                  <small>Dataset visual de carga</small>
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
