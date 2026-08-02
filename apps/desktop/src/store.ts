import { analyzeCapture } from "@framesync/analysis-engine";
import { DEMO_CAPTURE } from "@framesync/contracts/fixture";
import {
  AnalysisProposalSchema,
  CaptureEnvelopeSchema,
  type AnalysisProposal,
} from "@framesync/contracts";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  importApproved,
  createManualShotRecords,
  deleteCaptureSource,
  deleteShotRecord,
  detachShotMediaRecord,
  isTauriRuntime,
  listProjects,
  listSources,
  loadProduction,
  saveAnalysis,
  saveCapture,
  saveProject,
  publishWorkspaceContext,
  updateAnalysis,
  updateShotRecord,
} from "./lib/repository";
import type { ImportResult } from "./lib/repository";
import {
  EMPTY_PRODUCTION,
  type ProductionData,
  type ProductionShot,
  type Project,
  type SourceEntry,
  type SourceStatus,
  type WorkspaceView,
} from "./types";

type InboxSummary = {
  captureId: string;
  conversationTitle: string | null;
  platform: string;
  capturedAt: string;
  messageCount: number;
  assetCount: number;
  processed: boolean;
};

type ProjectWorkspace = {
  rootPath: string;
  sourcesPath: string;
  storyboardsPath: string;
  firstFramesPath: string;
  videosPath: string;
  exportsPath: string;
};

type ImportedDocument = {
  originalFilename: string;
  storedPath: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  pageCount: number | null;
  text: string;
  warning: string | null;
};

type StoreState = {
  ready: boolean;
  busy: boolean;
  error: string | null;
  projects: Project[];
  project: Project | null;
  sources: SourceEntry[];
  selectedSourceId: string | null;
  activeView: WorkspaceView;
  production: ProductionData;
  expandedShotId: string | null;
  inboxCount: number;
  importResult: ImportResult | null;
  workspacePath: string | null;
  createProject: (name: string) => Promise<void>;
  renameProject: (name: string) => Promise<void>;
  openProject: (project: Project) => Promise<void>;
  bootstrap: () => Promise<void>;
  setActiveView: (view: WorkspaceView) => void;
  selectSource: (captureId: string) => void;
  importDemo: () => Promise<void>;
  importSourceFiles: (filePaths: string[]) => Promise<void>;
  rescanSource: (captureId: string) => Promise<void>;
  analyzeSource: (captureId: string) => Promise<void>;
  reviewItem: (
    captureId: string,
    itemId: string,
    status: "approved" | "rejected" | "needs_review",
  ) => Promise<void>;
  approveAllCertain: (captureId: string) => Promise<void>;
  createStoryboard: (captureId: string) => Promise<void>;
  importReviewed: (captureId: string) => Promise<void>;
  deleteSource: (
    captureId: string,
    removeImportedContent: boolean,
  ) => Promise<void>;
  pollInbox: () => Promise<void>;
  setExpandedShot: (shotId: string | null) => void;
  updateShot: (shot: ProductionShot) => Promise<void>;
  deleteShot: (shot: ProductionShot) => Promise<void>;
  createManualShots: (names: string[]) => Promise<void>;
  importShotImages: (
    shotId: string,
    filePaths: string[],
    role: "storyboard" | "first_frame" | "video_final",
    replaceExisting: boolean,
  ) => Promise<void>;
  detachShotMedia: (
    shotId: string,
    role: "storyboard" | "first_frame" | "video_final",
  ) => Promise<void>;
  syncProjectWorkspace: () => Promise<void>;
  openProjectWorkspace: () => Promise<void>;
  buildStressDataset: () => void;
  clearError: () => void;
};

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return fallback;
}

function compactStoreId(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "project";
}

async function prepareProjectWorkspace(project: Project) {
  return invoke<ProjectWorkspace>("prepare_project_workspace", {
    projectNumber: project.projectNumber,
    projectName: project.name,
  });
}

function replaceReviewStatus(
  proposal: AnalysisProposal,
  itemId: string,
  status: "approved" | "rejected" | "needs_review",
) {
  const copy = structuredClone(proposal);
  const groups = [
    copy.scriptCandidates,
    copy.episodes,
    copy.characters,
    copy.locations,
    copy.scenes,
    copy.shots,
    copy.imagePrompts,
    copy.videoPrompts,
    copy.corrections,
    copy.unclassified,
  ];
  for (const group of groups) {
    const item = group.find((candidate) => candidate.id === itemId);
    if (item) item.reviewStatus = status;
  }
  return AnalysisProposalSchema.parse(copy);
}

function statusAfterReview(proposal: AnalysisProposal): SourceStatus {
  const pending = [
    ...proposal.scriptCandidates,
    ...proposal.episodes,
    ...proposal.characters,
    ...proposal.locations,
    ...proposal.scenes,
    ...proposal.shots,
    ...proposal.imagePrompts,
    ...proposal.videoPrompts,
    ...proposal.corrections,
    ...proposal.unclassified,
  ].some(
    (item) =>
      item.reviewStatus === "pending" || item.reviewStatus === "needs_review",
  );
  return pending ? "analyzed" : "reviewed";
}

function proposalReadyToCreate(proposal: AnalysisProposal) {
  const copy = structuredClone(proposal);
  const structuredGroups = [
    copy.scriptCandidates,
    copy.episodes,
    copy.characters,
    copy.locations,
    copy.scenes,
    copy.shots,
    copy.imagePrompts,
    copy.videoPrompts,
  ];

  for (const group of structuredGroups) {
    for (const item of group) {
      if (item.reviewStatus !== "rejected" && item.confidence >= 0.75) {
        item.reviewStatus = "approved";
      }
    }
  }

  const requiredSceneCodes = new Set(
    copy.shots
      .filter((shot) => shot.reviewStatus === "approved")
      .map((shot) => shot.sceneCode)
      .filter((code): code is string => Boolean(code)),
  );
  for (const scene of copy.scenes) {
    if (
      scene.reviewStatus !== "rejected" &&
      scene.code &&
      requiredSceneCodes.has(scene.code)
    ) {
      scene.reviewStatus = "approved";
    }
  }

  return AnalysisProposalSchema.parse(copy);
}

function fallbackProductionFrom(proposal: AnalysisProposal): ProductionData {
  const approvedShots = proposal.shots.filter(
    (item) => item.reviewStatus === "approved",
  );
  const requiredSceneCodes = new Set(
    approvedShots
      .map((shot) => shot.sceneCode)
      .filter((code): code is string => Boolean(code)),
  );
  const usableScenes = proposal.scenes.filter(
    (item) =>
      item.reviewStatus === "approved" ||
      (item.reviewStatus !== "rejected" &&
        Boolean(item.code && requiredSceneCodes.has(item.code))),
  );

  return {
    scripts: proposal.scriptCandidates.filter(
      (item) => item.reviewStatus === "approved",
    ),
    characters: proposal.characters.filter(
      (item) => item.reviewStatus === "approved",
    ),
    locations: proposal.locations.filter(
      (item) => item.reviewStatus === "approved",
    ),
    episodes: proposal.episodes.filter(
      (item) => item.reviewStatus === "approved",
    ),
    scenes: usableScenes,
    shots: approvedShots.map((item) => ({ ...item, status: "structured" })),
    assets: [],
  };
}

function sourceWithMisclassifiedShots(
  production: ProductionData,
  sources: SourceEntry[],
) {
  const suspiciousShot = production.shots.find((shot) => {
    const title = shot.title.trim();
    return (
      /^(?:P|SH)\d{1,4}$/i.test(title) ||
      /t[ií]tulo\s+del\s+plano/i.test(title) ||
      /\.(?:png|jpe?g|webp|gif|mp4|mov|webm|avi|mkv)/i.test(title)
    );
  });
  const suspiciousScene = production.scenes.find(
    (scene) =>
      !scene.code ||
      /^(?:N|X|#)\s*[-–—:]\s*t[ií]tulo$/i.test(scene.title.trim()),
  );
  const suspicious = suspiciousShot ?? suspiciousScene;
  if (!suspicious) return null;
  return (
    suspicious.sourceMessageIds.find((captureId) =>
      sources.some((source) => source.capture.captureId === captureId),
    ) ?? null
  );
}

export const useFrameSyncStore = create<StoreState>((set, get) => ({
  ready: false,
  busy: false,
  error: null,
  projects: [],
  project: null,
  sources: [],
  selectedSourceId: null,
  activeView: "shots",
  production: EMPTY_PRODUCTION,
  expandedShotId: null,
  inboxCount: 0,
  importResult: null,
  workspacePath: null,

  async bootstrap() {
    set({ busy: true, error: null });
    try {
      const projects = await listProjects();
      await publishWorkspaceContext();
      set({ projects, ready: true, busy: false });
      if (projects[0]) {
        await get().openProject(projects[0]);
        const captureId = sourceWithMisclassifiedShots(
          get().production,
          get().sources,
        );
        if (captureId) await get().createStoryboard(captureId);
      }
    } catch (error) {
      set({
        ready: true,
        busy: false,
        error:
          error instanceof Error
            ? error.message
            : "No se pudo iniciar Storyboard Wana.",
      });
    }
  },

  async createProject(name) {
    const trimmed = name.trim();
    const projectNumber =
      Math.max(0, ...get().projects.map((project) => project.projectNumber)) +
      1;
    const now = new Date().toISOString();
    const project: Project = {
      id: crypto.randomUUID(),
      projectNumber,
      name: trimmed || `Proyecto sin título ${projectNumber}`,
      description: "Producción audiovisual organizada con Storyboard Wana.",
      createdAt: now,
      updatedAt: now,
    };
    await saveProject(project);
    const workspace = await prepareProjectWorkspace(project);
    set((state) => ({
      projects: [project, ...state.projects],
      project,
      sources: [],
      production: EMPTY_PRODUCTION,
      selectedSourceId: null,
      activeView: "sources",
      importResult: null,
      workspacePath: workspace.rootPath,
    }));
  },

  async renameProject(name) {
    const current = get().project;
    if (!current) return;
    const trimmed = name.trim();
    const updated: Project = {
      ...current,
      name: trimmed || `Proyecto sin título ${current.projectNumber}`,
      updatedAt: new Date().toISOString(),
    };
    await saveProject(updated);
    const workspace = await prepareProjectWorkspace(updated);
    set((state) => ({
      project: updated,
      projects: state.projects.map((project) =>
        project.id === updated.id ? updated : project,
      ),
      workspacePath: workspace.rootPath,
    }));
  },

  async openProject(project) {
    set({ busy: true, project, error: null });
    try {
      const workspace = await prepareProjectWorkspace(project);
      let syncWarning: string | null = null;
      try {
        await invoke("sync_project_workspace", {
          projectId: project.id,
          projectNumber: project.projectNumber,
          projectName: project.name,
        });
      } catch (error) {
        syncWarning = errorMessage(
          error,
          "El proyecto abrió, pero no se pudo sincronizar su carpeta.",
        );
      }
      let [sources, production] = await Promise.all([
        listSources(project.id),
        loadProduction(project.id),
      ]);
      let refreshedPdfPrompts = false;
      for (const source of sources) {
        if (
          source.status !== "imported" ||
          source.capture.diagnostics.adapterId !== "pdf-import" ||
          !source.proposal
        ) {
          continue;
        }
        const previousPromptCount = source.proposal.shots.filter(
          (shot) => shot.imagePrompt && shot.videoPrompt,
        ).length;
        const refreshedProposal = proposalReadyToCreate(
          analyzeCapture(source.capture),
        );
        const refreshedPromptCount = refreshedProposal.shots.filter(
          (shot) => shot.imagePrompt && shot.videoPrompt,
        ).length;
        if (refreshedPromptCount <= previousPromptCount) continue;
        await updateAnalysis(
          source.capture.captureId,
          refreshedProposal,
          statusAfterReview(refreshedProposal),
        );
        await importApproved(
          project.id,
          source.capture.captureId,
          refreshedProposal,
          { synchronizeSourceShots: true },
        );
        refreshedPdfPrompts = true;
      }
      if (refreshedPdfPrompts) {
        [sources, production] = await Promise.all([
          listSources(project.id),
          loadProduction(project.id),
        ]);
      }
      set({
        project,
        sources,
        production,
        selectedSourceId: sources[0]?.capture.captureId ?? null,
        importResult: null,
        busy: false,
        error: syncWarning,
        workspacePath: workspace.rootPath,
      });
    } catch (error) {
      set({
        busy: false,
        error: errorMessage(error, "No se pudo abrir el proyecto."),
      });
    }
  },

  setActiveView(activeView) {
    set({ activeView });
  },

  selectSource(selectedSourceId) {
    set({ selectedSourceId });
  },

  async importDemo() {
    let project = get().project;
    if (!project) {
      await get().createProject("La última frecuencia");
      project = get().project;
    }
    if (!project) return;
    if (
      get().sources.some(
        (source) => source.capture.captureId === DEMO_CAPTURE.captureId,
      )
    ) {
      set({
        selectedSourceId: DEMO_CAPTURE.captureId,
        activeView: "sources",
      });
      return;
    }
    set({ busy: true, error: null });
    try {
      await saveCapture(project.id, DEMO_CAPTURE);
      const entry: SourceEntry = {
        capture: DEMO_CAPTURE,
        proposal: null,
        status: "received",
      };
      set((state) => ({
        sources: [entry, ...state.sources],
        selectedSourceId: DEMO_CAPTURE.captureId,
        activeView: "sources",
      }));
      await get().analyzeSource(DEMO_CAPTURE.captureId);
    } catch (error) {
      set({
        busy: false,
        error:
          error instanceof Error
            ? error.message
            : "No se pudo importar la demostración.",
      });
    }
  },

  async importSourceFiles(filePaths) {
    const project = get().project;
    if (!project || filePaths.length === 0) return;
    set({ busy: true, error: null });
    try {
      const documents = await invoke<ImportedDocument[]>(
        "import_source_documents",
        {
          projectId: project.id,
          projectNumber: project.projectNumber,
          projectName: project.name,
          filePaths,
        },
      );
      let selectedSourceId: string | null = null;
      for (const document of documents) {
        const captureId = `document-${document.sha256.slice(0, 20)}-${compactStoreId(project.id)}`;
        const capturedAt = new Date().toISOString();
        const messageId = `${captureId}-content`;
        const content =
          document.text.trim() ||
          document.warning ||
          "Documento sin texto extraible.";
        const capture = CaptureEnvelopeSchema.parse({
          protocolVersion: 1,
          captureId,
          platform: "generic",
          sourceUrl: `https://local.framesync/source/${captureId}`,
          conversationTitle: document.originalFilename,
          captureMode: "full",
          capturedAt,
          destinationProjectId: project.id,
          destinationProjectName: project.name,
          selectedShotIds: null,
          messages: [
            {
              id: messageId,
              orderIndex: 0,
              role: "unknown",
              text: content,
              htmlSnapshot: null,
              messageFingerprint: document.sha256,
              sourceDomId: null,
              createdAt: capturedAt,
            },
          ],
          assets: [
            {
              id: `${captureId}-file`,
              messageFingerprint: document.sha256,
              kind: "document",
              role: "reference",
              originalFilename: document.originalFilename,
              sourceUrl: null,
              mimeType: document.mimeType,
              byteSize: document.byteSize,
              width: null,
              height: null,
              durationMs: null,
              relatedShotCode: null,
              localPath: document.storedPath,
              sha256: document.sha256,
              qualitySource: "local_file",
            },
          ],
          diagnostics: {
            adapterId:
              document.mimeType === "application/pdf"
                ? "pdf-import"
                : "text-file-import",
            detectedMessageCount: 1,
            skippedNodeCount: 0,
            warnings: document.warning ? [document.warning] : [],
          },
        });
        await saveCapture(project.id, capture);
        const proposal = analyzeCapture(capture);
        await saveAnalysis(captureId, proposal);
        selectedSourceId = captureId;
      }
      const sources = await listSources(project.id);
      set({ sources, selectedSourceId, activeView: "sources", busy: false });
    } catch (error) {
      set({
        busy: false,
        error: errorMessage(
          error,
          "No se pudieron importar los archivos fuente.",
        ),
      });
    }
  },

  async rescanSource(captureId) {
    const project = get().project;
    const source = get().sources.find(
      (item) => item.capture.captureId === captureId,
    );
    const documentAsset = source?.capture.assets.find(
      (asset) => asset.kind === "document" && asset.localPath,
    );
    if (!project || !source || !documentAsset?.localPath) return;
    set({ busy: true, error: null });
    try {
      const document = await invoke<ImportedDocument>(
        "rescan_source_document",
        { filePath: documentAsset.localPath },
      );
      const content =
        document.text.trim() ||
        document.warning ||
        "Documento sin texto extraible.";
      const capture = CaptureEnvelopeSchema.parse({
        ...source.capture,
        messages: source.capture.messages.map((message, index) =>
          index === 0
            ? {
                ...message,
                text: content,
                messageFingerprint: document.sha256,
              }
            : message,
        ),
        assets: source.capture.assets.map((asset) =>
          asset.id === documentAsset.id
            ? {
                ...asset,
                messageFingerprint: document.sha256,
                mimeType: document.mimeType,
                byteSize: document.byteSize,
                sha256: document.sha256,
                localPath: document.storedPath,
              }
            : asset,
        ),
        diagnostics: {
          ...source.capture.diagnostics,
          adapterId:
            document.mimeType === "application/pdf"
              ? "pdf-import"
              : "text-file-import",
          detectedMessageCount: 1,
          warnings: document.warning ? [document.warning] : [],
        },
      });
      await saveCapture(project.id, capture);
      const analyzedProposal = analyzeCapture(capture);
      const proposal =
        source.status === "imported"
          ? proposalReadyToCreate(analyzedProposal)
          : analyzedProposal;
      await saveAnalysis(captureId, proposal);
      let production = get().production;
      if (source.status === "imported") {
        await updateAnalysis(captureId, proposal, statusAfterReview(proposal));
        await importApproved(project.id, captureId, proposal, {
          synchronizeSourceShots: true,
        });
        production = await loadProduction(project.id);
      }
      const sources = await listSources(project.id);
      set({
        sources,
        production,
        selectedSourceId: captureId,
        busy: false,
      });
    } catch (error) {
      set({
        busy: false,
        error: errorMessage(error, "No se pudo reescanear el documento."),
      });
    }
  },

  async analyzeSource(captureId) {
    const source = get().sources.find(
      (item) => item.capture.captureId === captureId,
    );
    if (!source) return;
    set({ busy: true, error: null });
    try {
      const proposal = analyzeCapture(source.capture);
      await saveAnalysis(captureId, proposal);
      set((state) => ({
        sources: state.sources.map((item) =>
          item.capture.captureId === captureId
            ? { ...item, proposal, status: "analyzed" }
            : item,
        ),
        busy: false,
      }));
    } catch (error) {
      set({
        busy: false,
        error:
          error instanceof Error ? error.message : "El análisis local falló.",
      });
    }
  },

  async reviewItem(captureId, itemId, status) {
    const source = get().sources.find(
      (item) => item.capture.captureId === captureId,
    );
    if (!source?.proposal) return;
    const proposal = replaceReviewStatus(source.proposal, itemId, status);
    const sourceStatus = statusAfterReview(proposal);
    set((state) => ({
      sources: state.sources.map((item) =>
        item.capture.captureId === captureId
          ? { ...item, proposal, status: sourceStatus }
          : item,
      ),
    }));
    await updateAnalysis(captureId, proposal, sourceStatus);
  },

  async approveAllCertain(captureId) {
    const source = get().sources.find(
      (item) => item.capture.captureId === captureId,
    );
    if (!source?.proposal) return;
    const copy = structuredClone(source.proposal);
    const groups = [
      copy.scriptCandidates,
      copy.episodes,
      copy.characters,
      copy.locations,
      copy.scenes,
      copy.shots,
      copy.imagePrompts,
      copy.videoPrompts,
    ];
    for (const group of groups) {
      for (const item of group) {
        if (item.confidence >= 0.85) item.reviewStatus = "approved";
      }
    }
    const proposal = AnalysisProposalSchema.parse(copy);
    const status = statusAfterReview(proposal);
    set((state) => ({
      sources: state.sources.map((item) =>
        item.capture.captureId === captureId
          ? { ...item, proposal, status }
          : item,
      ),
    }));
    await updateAnalysis(captureId, proposal, status);
  },

  async createStoryboard(captureId) {
    const { project } = get();
    const source = get().sources.find(
      (item) => item.capture.captureId === captureId,
    );
    if (!project || !source?.proposal) return;
    set({ busy: true, error: null });
    try {
      // Always run the current deterministic engine before creating. This
      // prevents a proposal saved by an older detector from reintroducing
      // template examples, control lists, or media filenames as shots.
      const proposal = proposalReadyToCreate(analyzeCapture(source.capture));
      await updateAnalysis(captureId, proposal, statusAfterReview(proposal));
      const importResult = await importApproved(
        project.id,
        captureId,
        proposal,
        { synchronizeSourceShots: true },
      );
      const production = await loadProduction(project.id);
      const fallbackProduction = fallbackProductionFrom(proposal);
      set((state) => ({
        production:
          production.scripts.length > 0 ||
          production.scenes.length > 0 ||
          production.shots.length > 0
            ? production
            : fallbackProduction,
        sources: state.sources.map((item) =>
          item.capture.captureId === captureId
            ? { ...item, proposal, status: "imported" }
            : item,
        ),
        activeView: "shots",
        importResult,
        busy: false,
      }));
    } catch (error) {
      set({
        busy: false,
        error: errorMessage(
          error,
          "No se pudieron crear el guion y el storyboard.",
        ),
      });
    }
  },

  async importReviewed(captureId) {
    const { project } = get();
    const source = get().sources.find(
      (item) => item.capture.captureId === captureId,
    );
    if (!project || !source?.proposal) return;
    set({ busy: true, error: null });
    try {
      const importResult = await importApproved(
        project.id,
        captureId,
        source.proposal,
      );
      const production = await loadProduction(project.id);
      const fallbackProduction = fallbackProductionFrom(source.proposal);
      set((state) => ({
        production:
          production.scripts.length > 0 ||
          production.scenes.length > 0 ||
          production.shots.length > 0
            ? production
            : fallbackProduction,
        sources: state.sources.map((item) =>
          item.capture.captureId === captureId
            ? { ...item, status: "imported" }
            : item,
        ),
        activeView: "shots",
        importResult,
        busy: false,
      }));
    } catch (error) {
      set({
        busy: false,
        error:
          error instanceof Error
            ? error.message
            : "No se pudo importar la selección.",
      });
    }
  },

  async deleteSource(captureId, removeImportedContent) {
    const { project } = get();
    if (!project) return;
    set({ busy: true, error: null });
    try {
      await deleteCaptureSource(project.id, captureId, removeImportedContent);
      const production = await loadProduction(project.id);
      set((state) => {
        const sources = state.sources.filter(
          (source) => source.capture.captureId !== captureId,
        );
        return {
          sources,
          production,
          selectedSourceId:
            state.selectedSourceId === captureId
              ? (sources[0]?.capture.captureId ?? null)
              : state.selectedSourceId,
          importResult: null,
          busy: false,
        };
      });
    } catch (error) {
      set({
        busy: false,
        error: errorMessage(error, "No se pudo eliminar la fuente."),
      });
    }
  },

  async pollInbox() {
    if (!isTauriRuntime() || !get().project || get().busy) return;
    try {
      const summaries = await invoke<InboxSummary[]>("list_inbox_captures");
      set({ inboxCount: summaries.filter((item) => !item.processed).length });
      for (const summary of summaries) {
        if (
          summary.processed ||
          get().sources.some(
            (source) => source.capture.captureId === summary.captureId,
          )
        ) {
          continue;
        }
        const raw = await invoke<unknown>("read_inbox_capture", {
          captureId: summary.captureId,
        });
        const capture = CaptureEnvelopeSchema.parse(raw);
        const destinationProject = capture.destinationProjectId
          ? get().projects.find(
              (project) => project.id === capture.destinationProjectId,
            )
          : get().project;
        if (capture.destinationProjectId && !destinationProject) {
          set({
            error: `La captura apunta a un proyecto que ya no existe (${capture.destinationProjectName ?? capture.destinationProjectId}). No fue reasignada.`,
          });
          continue;
        }
        if (!destinationProject) continue;
        await saveCapture(destinationProject.id, capture);
        const proposal = analyzeCapture(capture);
        await saveAnalysis(capture.captureId, proposal);
        if (destinationProject.id === get().project?.id) {
          set((state) => ({
            sources: [
              { capture, proposal, status: "analyzed" },
              ...state.sources,
            ],
            selectedSourceId: capture.captureId,
          }));
        }
        await invoke("mark_inbox_capture_processed", {
          captureId: capture.captureId,
        });
      }
    } catch (error) {
      set({
        error: errorMessage(error, "No se pudo leer la bandeja local."),
      });
    }
  },

  setExpandedShot(expandedShotId) {
    set({ expandedShotId });
  },

  async updateShot(shot) {
    set((state) => ({
      production: {
        ...state.production,
        shots: state.production.shots.map((item) =>
          item.id === shot.id ? shot : item,
        ),
      },
      expandedShotId: null,
    }));
    await updateShotRecord(shot);
  },

  async deleteShot(shot) {
    const project = get().project;
    if (!project) return;
    set({ busy: true, error: null });
    try {
      await deleteShotRecord(project.id, shot.id);
      const production = isTauriRuntime()
        ? await loadProduction(project.id)
        : {
            ...get().production,
            shots: get()
              .production.shots.filter((item) => item.id !== shot.id)
              .map((item, index) => ({
                ...item,
                globalNumber:
                  item.shotType === "normal" ? index + 1 : item.globalNumber,
                code:
                  item.shotType === "normal"
                    ? `P${String(index + 1).padStart(3, "0")}`
                    : item.code,
              })),
          };
      set({
        production,
        expandedShotId: null,
        busy: false,
        importResult: null,
      });
    } catch (error) {
      set({
        busy: false,
        error: errorMessage(error, "No se pudo eliminar el plano."),
      });
    }
  },

  async createManualShots(names) {
    const project = get().project;
    if (!project) return;
    set({ busy: true, error: null });
    try {
      await createManualShotRecords(project.id, names);
      const production = await loadProduction(project.id);
      set({ production, activeView: "shots", busy: false, importResult: null });
    } catch (error) {
      set({
        busy: false,
        error: errorMessage(error, "No se pudieron crear los planos."),
      });
    }
  },

  async importShotImages(shotId, filePaths, role, replaceExisting) {
    const project = get().project;
    if (!project || filePaths.length === 0) return;
    set({ busy: true, error: null });
    try {
      await invoke("import_shot_media", {
        projectId: project.id,
        projectNumber: project.projectNumber,
        projectName: project.name,
        shotId,
        filePaths,
        role,
        replaceExisting,
      });
      const production = await loadProduction(project.id);
      set({ production, busy: false });
    } catch (error) {
      set({
        busy: false,
        error: errorMessage(error, "No se pudieron asignar las imagenes."),
      });
    }
  },

  async detachShotMedia(shotId, role) {
    const project = get().project;
    if (!project) return;
    set({ busy: true, error: null });
    try {
      await detachShotMediaRecord(shotId, role);
      const production = await loadProduction(project.id);
      set({ production, busy: false });
    } catch (error) {
      set({
        busy: false,
        error: errorMessage(error, "No se pudo quitar el archivo de la tarjeta."),
      });
    }
  },

  async syncProjectWorkspace() {
    const project = get().project;
    if (!project || get().busy || !isTauriRuntime()) return;
    try {
      const result = await invoke<{ assigned: number; imported: number }>(
        "sync_project_workspace",
        {
          projectId: project.id,
          projectNumber: project.projectNumber,
          projectName: project.name,
        },
      );
      if (result.assigned > 0 || result.imported > 0) {
        const production = await loadProduction(project.id);
        set({ production });
      }
    } catch (error) {
      set({
        error: errorMessage(
          error,
          "No se pudo sincronizar la carpeta del proyecto.",
        ),
      });
    }
  },

  async openProjectWorkspace() {
    const project = get().project;
    if (!project) return;
    try {
      await invoke("open_project_workspace", {
        projectNumber: project.projectNumber,
        projectName: project.name,
      });
    } catch (error) {
      set({
        error: errorMessage(error, "No se pudo abrir la carpeta del proyecto."),
      });
    }
  },

  buildStressDataset() {
    const { shots, scenes } = get().production;
    if (shots.length === 0 || scenes.length === 0) return;
    const expanded = Array.from({ length: 40 }, (_, index) => {
      const source = shots[index % shots.length]!;
      const scene = scenes[index % scenes.length]!;
      return {
        ...source,
        id: `stress-${index + 1}`,
        code: `${scene.code ?? "E00"}-P${String(index + 1).padStart(2, "0")}`,
        sceneCode: scene.code,
        orderIndex: index,
        title: `${source.title} · ${index + 1}`,
      };
    });
    set((state) => ({
      production: { ...state.production, shots: expanded },
      activeView: "shots",
    }));
  },

  clearError() {
    set({ error: null });
  },
}));
