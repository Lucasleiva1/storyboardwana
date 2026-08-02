import type {
  AnalysisProposal,
  AssetManifest,
  CaptureEnvelope,
  DetectedCharacter,
  DetectedEpisode,
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
  projectNumber: number;
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
  firstFramePath?: string | null;
  storyboardPaths?: string[];
  videoPath?: string | null;
  videoPaths?: string[];
  storyboardAssetCount?: number;
};

export type ProductionAsset = Pick<
  AssetManifest,
  | "id"
  | "kind"
  | "role"
  | "originalFilename"
  | "mimeType"
  | "byteSize"
  | "width"
  | "height"
  | "durationMs"
  | "relatedShotCode"
  | "localPath"
  | "sha256"
  | "qualitySource"
> & {
  shotCode: string | null;
  orderIndex: number | null;
};

export type ProductionData = {
  scripts: DetectedScript[];
  characters: DetectedCharacter[];
  locations: DetectedLocation[];
  episodes: DetectedEpisode[];
  scenes: DetectedScene[];
  shots: ProductionShot[];
  assets: ProductionAsset[];
};

export const EMPTY_PRODUCTION: ProductionData = {
  scripts: [],
  characters: [],
  locations: [],
  episodes: [],
  scenes: [],
  shots: [],
  assets: [],
};
