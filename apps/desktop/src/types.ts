import type {
  AnalysisProposal,
  CaptureEnvelope,
  DetectedCharacter,
  DetectedLocation,
  DetectedScene,
  DetectedScript,
  DetectedShot,
} from "@framesync/contracts";

export type WorkspaceView =
  | "sources"
  | "script"
  | "characters"
  | "locations"
  | "shots"
  | "media"
  | "timeline"
  | "settings";

export type Project = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SourceStatus =
  "received" | "analyzed" | "reviewed" | "imported" | "failed";

export type SourceEntry = {
  capture: CaptureEnvelope;
  proposal: AnalysisProposal | null;
  status: SourceStatus;
};

export type ProductionShot = DetectedShot & {
  status:
    | "empty"
    | "structured"
    | "storyboard"
    | "first_frame"
    | "video"
    | "approved"
    | "conflict"
    | "incomplete";
};

export type ProductionData = {
  scripts: DetectedScript[];
  characters: DetectedCharacter[];
  locations: DetectedLocation[];
  scenes: DetectedScene[];
  shots: ProductionShot[];
};

export const EMPTY_PRODUCTION: ProductionData = {
  scripts: [],
  characters: [],
  locations: [],
  scenes: [],
  shots: [],
};
