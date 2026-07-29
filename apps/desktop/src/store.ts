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
  deleteCaptureSource,
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
  createProject: (name: string) => Promise<void>;
  renameProject: (name: string) => Promise<void>;
  openProject: (project: Project) => Promise<void>;
  bootstrap: () => Promise<void>;
  setActiveView: (view: WorkspaceView) => void;
  selectSource: (captureId: string) => void;
  importDemo: () => Promise<void>;
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
  };
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

  async bootstrap() {
    set({ busy: true, error: null });
    try {
      const projects = await listProjects();
      await publishWorkspaceContext();
      set({ projects, ready: true, busy: false });
      if (projects[0]) await get().openProject(projects[0]);
    } catch (error) {
      set({
        ready: true,
        busy: false,
        error:
          error instanceof Error
            ? error.message
            : "No se pudo iniciar FrameSync.",
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
      description: "Producción audiovisual organizada con FrameSync.",
      createdAt: now,
      updatedAt: now,
    };
    await saveProject(project);
    set((state) => ({
      projects: [project, ...state.projects],
      project,
      sources: [],
      production: EMPTY_PRODUCTION,
      selectedSourceId: null,
      activeView: "sources",
      importResult: null,
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
    set((state) => ({
      project: updated,
      projects: state.projects.map((project) =>
        project.id === updated.id ? updated : project,
      ),
    }));
  },

  async openProject(project) {
    set({ busy: true, project, error: null });
    try {
      const [sources, production] = await Promise.all([
        listSources(project.id),
        loadProduction(project.id),
      ]);
      set({
        project,
        sources,
        production,
        selectedSourceId: sources[0]?.capture.captureId ?? null,
        importResult: null,
        busy: false,
      });
    } catch (error) {
      set({
        busy: false,
        error:
          error instanceof Error
            ? error.message
            : "No se pudo abrir el proyecto.",
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
      const proposal = proposalReadyToCreate(source.proposal);
      await updateAnalysis(captureId, proposal, statusAfterReview(proposal));
      const importResult = await importApproved(
        project.id,
        captureId,
        proposal,
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
