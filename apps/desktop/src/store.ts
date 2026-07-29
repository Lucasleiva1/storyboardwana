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
  isTauriRuntime,
  listProjects,
  listSources,
  loadProduction,
  saveAnalysis,
  saveCapture,
  saveProject,
  updateAnalysis,
  updateShotRecord,
} from "./lib/repository";
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
  createProject: (name: string) => Promise<void>;
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
  importReviewed: (captureId: string) => Promise<void>;
  pollInbox: () => Promise<void>;
  setExpandedShot: (shotId: string | null) => void;
  updateShot: (shot: ProductionShot) => Promise<void>;
  buildStressDataset: () => void;
  clearError: () => void;
};

function replaceReviewStatus(
  proposal: AnalysisProposal,
  itemId: string,
  status: "approved" | "rejected" | "needs_review",
) {
  const copy = structuredClone(proposal);
  const groups = [
    copy.scriptCandidates,
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

  async bootstrap() {
    set({ busy: true, error: null });
    try {
      const projects = await listProjects();
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
    if (!trimmed) return;
    const now = new Date().toISOString();
    const project: Project = {
      id: crypto.randomUUID(),
      name: trimmed,
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

  async importReviewed(captureId) {
    const { project } = get();
    const source = get().sources.find(
      (item) => item.capture.captureId === captureId,
    );
    if (!project || !source?.proposal) return;
    set({ busy: true, error: null });
    try {
      await importApproved(project.id, captureId, source.proposal);
      const production = await loadProduction(project.id);
      const fallbackProduction: ProductionData = {
        scripts: source.proposal.scriptCandidates.filter(
          (item) => item.reviewStatus === "approved",
        ),
        characters: source.proposal.characters.filter(
          (item) => item.reviewStatus === "approved",
        ),
        locations: source.proposal.locations.filter(
          (item) => item.reviewStatus === "approved",
        ),
        scenes: source.proposal.scenes.filter(
          (item) => item.reviewStatus === "approved",
        ),
        shots: source.proposal.shots
          .filter((item) => item.reviewStatus === "approved")
          .map((item) => ({ ...item, status: "structured" })),
      };
      set((state) => ({
        production:
          production.scenes.length > 0 ? production : fallbackProduction,
        sources: state.sources.map((item) =>
          item.capture.captureId === captureId
            ? { ...item, status: "imported" }
            : item,
        ),
        activeView: "shots",
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
        await saveCapture(get().project!.id, capture);
        set((state) => ({
          sources: [
            { capture, proposal: null, status: "received" },
            ...state.sources,
          ],
          selectedSourceId: capture.captureId,
        }));
        await invoke("mark_inbox_capture_processed", {
          captureId: capture.captureId,
        });
      }
    } catch (error) {
      set({
        error:
          error instanceof Error
            ? error.message
            : "No se pudo leer la bandeja local.",
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
