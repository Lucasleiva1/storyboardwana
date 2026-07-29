import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  PanelsTopLeft,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { useEffect, useState } from "react";
import { isTauriRuntime } from "../lib/repository";

type BrowserIntegrationStatus = {
  mode: "development" | "installed";
  extensionId: string;
  extensionPath: string | null;
  extensionAvailable: boolean;
  hostPath: string | null;
  hostAvailable: boolean;
  hostRegistered: boolean;
  edgeRegistered: boolean;
  chromeRegistered: boolean;
  manifestPath: string;
};

type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "downloading"
  | "ready"
  | "error";

export function SettingsView() {
  const [version, setVersion] = useState("0.1.2");
  const [integration, setIntegration] =
    useState<BrowserIntegrationStatus | null>(null);
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [integrationMessage, setIntegrationMessage] = useState(
    "Comprobando el puente local…",
  );
  const [update, setUpdate] = useState<Update | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [updateMessage, setUpdateMessage] = useState(
    "Buscá una versión nueva cuando quieras.",
  );
  const [progress, setProgress] = useState(0);

  async function refreshIntegration(prepare = false) {
    if (!isTauriRuntime()) {
      setIntegrationMessage(
        "Abrí esta pantalla dentro de la aplicación de escritorio.",
      );
      return;
    }
    setIntegrationBusy(true);
    try {
      const status = await invoke<BrowserIntegrationStatus>(
        prepare
          ? "prepare_browser_integration"
          : "get_browser_integration_status",
      );
      setIntegration(status);
      setIntegrationMessage(
        status.edgeRegistered && status.extensionAvailable
          ? "Edge está registrado y la extensión está lista para cargar."
          : "La integración necesita preparación.",
      );
    } catch (error) {
      setIntegrationMessage(
        error instanceof Error
          ? error.message
          : "No se pudo preparar la integración con Edge.",
      );
    } finally {
      setIntegrationBusy(false);
    }
  }

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void getVersion().then(setVersion);
    void refreshIntegration();
  }, []);

  async function checkForUpdates() {
    if (import.meta.env.DEV) {
      setUpdatePhase("current");
      setUpdateMessage(
        "El actualizador está desactivado en desarrollo. Se prueba desde la aplicación instalada.",
      );
      return;
    }
    setUpdatePhase("checking");
    setUpdateMessage("Consultando el canal estable de GitHub…");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const available = await check({ timeout: 20_000 });
      setUpdate(available);
      if (!available) {
        setUpdatePhase("current");
        setUpdateMessage("FrameSync está actualizado.");
        return;
      }
      setUpdatePhase("available");
      setUpdateMessage(
        `La versión ${available.version} está lista para descargar.`,
      );
    } catch (error) {
      setUpdatePhase("error");
      setUpdateMessage(
        error instanceof Error
          ? error.message
          : "No se pudo consultar GitHub Releases.",
      );
    }
  }

  async function installUpdate() {
    if (!update) return;
    setUpdatePhase("downloading");
    setProgress(0);
    setUpdateMessage(`Descargando FrameSync ${update.version}…`);
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        }
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress(total > 0 ? Math.round((downloaded / total) * 100) : 0);
        }
        if (event.event === "Finished") setProgress(100);
      });
      setUpdatePhase("ready");
      setUpdateMessage(
        "Actualización instalada. FrameSync se reiniciará para aplicarla.",
      );
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      setUpdatePhase("error");
      setUpdateMessage(
        error instanceof Error
          ? error.message
          : "No se pudo instalar la actualización.",
      );
    }
  }

  async function copyExtensionPath() {
    if (!integration?.extensionPath) return;
    await navigator.clipboard.writeText(integration.extensionPath);
    setIntegrationMessage("Ruta de la extensión copiada.");
  }

  async function openIntegrationTarget(
    command: "open_extension_folder" | "open_edge_extensions",
  ) {
    try {
      await invoke(command);
    } catch (error) {
      setIntegrationMessage(
        error instanceof Error ? error.message : "No se pudo abrir Windows.",
      );
    }
  }

  const integrationReady =
    integration?.edgeRegistered && integration.extensionAvailable;

  return (
    <section className="settings-workspace">
      <header className="section-titlebar">
        <div>
          <span className="section-code">SISTEMA / CONFIGURACIÓN</span>
          <h1>Aplicación, extensión y actualizaciones</h1>
          <p>
            Todo lo necesario para mantener FrameSync y el puente de Edge
            funcionando en este equipo.
          </p>
        </div>
        <span className="version-plate">VERSIÓN {version}</span>
      </header>

      <div className="settings-grid">
        <article className="settings-card update-card">
          <header>
            <div className="settings-icon">
              <RefreshCw size={19} />
            </div>
            <div>
              <span className="section-code">ACTUALIZACIÓN FIRMADA</span>
              <h2>Canal estable</h2>
            </div>
            <span className="settings-state secure">
              <ShieldCheck size={13} />
              FIRMA VERIFICADA
            </span>
          </header>

          <div className="settings-status">
            {updatePhase === "checking" || updatePhase === "downloading" ? (
              <LoaderCircle className="spin" size={20} />
            ) : updatePhase === "available" ? (
              <Download size={20} />
            ) : (
              <CheckCircle2 size={20} />
            )}
            <div>
              <strong>
                {updatePhase === "available"
                  ? `FrameSync ${update?.version}`
                  : `FrameSync ${version}`}
              </strong>
              <p>{updateMessage}</p>
            </div>
          </div>

          {updatePhase === "downloading" && (
            <div className="update-progress">
              <span style={{ width: `${progress}%` }} />
              <strong>{progress > 0 ? `${progress}%` : "DESCARGANDO"}</strong>
            </div>
          )}

          {update?.body && updatePhase === "available" && (
            <div className="release-notes">
              <span>NOTAS DE LA VERSIÓN</span>
              <p>{update.body}</p>
            </div>
          )}

          <footer className="settings-actions">
            <button
              onClick={() => void checkForUpdates()}
              disabled={
                updatePhase === "checking" || updatePhase === "downloading"
              }
            >
              <RefreshCw size={14} />
              Buscar actualización
            </button>
            {updatePhase === "available" && (
              <button
                className="solid-button"
                onClick={() => void installUpdate()}
              >
                <Download size={14} />
                Descargar e instalar
              </button>
            )}
          </footer>
        </article>

        <article className="settings-card extension-card">
          <header>
            <div className="settings-icon">
              <PanelsTopLeft size={19} />
            </div>
            <div>
              <span className="section-code">MICROSOFT EDGE · CHROMIUM</span>
              <h2>FrameSync Capture para Edge</h2>
            </div>
            <span
              className={`settings-state ${integrationReady ? "online" : "offline"}`}
            >
              {integrationReady ? (
                <CheckCircle2 size={13} />
              ) : (
                <Unplug size={13} />
              )}
              {integrationReady ? "LISTA" : "REVISAR"}
            </span>
          </header>

          <div className="integration-metrics">
            <div>
              <span>MODO</span>
              <strong>
                {integration?.mode === "development"
                  ? "DESARROLLO"
                  : "INSTALADO"}
              </strong>
            </div>
            <div>
              <span>HOST</span>
              <strong>
                {integration?.edgeRegistered ? "EDGE OK" : "PENDIENTE"}
              </strong>
            </div>
            <div>
              <span>EXTENSIÓN</span>
              <strong>
                {integration?.extensionAvailable ? "DISPONIBLE" : "AUSENTE"}
              </strong>
            </div>
          </div>

          <p className="integration-message">{integrationMessage}</p>

          <div className="extension-path">
            <span>CARPETA PARA “CARGAR DESCOMPRIMIDA”</span>
            <code>{integration?.extensionPath ?? "Preparando ubicación…"}</code>
            <button
              onClick={() => void copyExtensionPath()}
              disabled={!integration?.extensionPath}
              title="Copiar ruta"
            >
              <Clipboard size={14} />
            </button>
          </div>

          <ol className="extension-steps">
            <li>
              Abrí <strong>edge://extensions</strong>.
            </li>
            <li>
              Activá <strong>Modo de desarrollador</strong>.
            </li>
            <li>
              Elegí <strong>Cargar descomprimida</strong> y usá la carpeta
              indicada arriba.
            </li>
          </ol>

          <footer className="settings-actions">
            <button
              onClick={() => void refreshIntegration(true)}
              disabled={integrationBusy}
            >
              {integrationBusy ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <ShieldCheck size={14} />
              )}
              Preparar conexión
            </button>
            <button
              onClick={() =>
                void openIntegrationTarget("open_extension_folder")
              }
              disabled={!integration?.extensionPath}
            >
              <FolderOpen size={14} />
              Abrir carpeta
            </button>
            <button
              className="accent-button"
              onClick={() => void openIntegrationTarget("open_edge_extensions")}
            >
              <ExternalLink size={14} />
              Abrir Edge
            </button>
          </footer>
        </article>

        <article className="settings-card compact-card">
          <span className="section-code">IDENTIDAD ESTABLE</span>
          <h3>ID de la extensión</h3>
          <code>{integration?.extensionId ?? "Comprobando…"}</code>
          <p>
            Es el mismo ID en desarrollo y en la versión distribuida. El host
            nativo sólo acepta capturas de esta extensión.
          </p>
        </article>

        <article className="settings-card compact-card">
          <span className="section-code">PRIVACIDAD</span>
          <h3>Datos locales</h3>
          <p>
            Las conversaciones, imágenes y proyectos permanecen en este equipo.
            La red sólo se utiliza para consultar y descargar releases firmados
            desde GitHub.
          </p>
        </article>
      </div>
    </section>
  );
}
