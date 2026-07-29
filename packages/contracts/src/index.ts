import { z } from "zod";

export const ProtocolVersionSchema = z.literal(1);
export const PlatformSchema = z.enum(["chatgpt", "gemini", "generic"]);
export const CaptureModeSchema = z.enum([
  "full",
  "loaded",
  "selection",
  "session",
]);
export const CaptureRoleSchema = z.enum(["user", "assistant", "unknown"]);

export const CaptureMessageSchema = z.object({
  id: z.string().min(1),
  orderIndex: z.number().int().nonnegative(),
  role: CaptureRoleSchema,
  text: z.string(),
  htmlSnapshot: z.string().nullable().default(null),
  messageFingerprint: z.string().min(8),
  sourceDomId: z.string().nullable().default(null),
  createdAt: z.string().datetime().nullable().default(null),
});

export const SrcsetCandidateSchema = z.object({
  url: z.string().url(),
  width: z.number().positive().nullable(),
  density: z.number().positive().nullable(),
});

export const ImageCandidateSchema = z.object({
  id: z.string().min(1),
  messageFingerprint: z.string().nullable(),
  sourceUrl: z.string().url().nullable(),
  currentSrc: z.string().url().nullable(),
  srcsetCandidates: z.array(SrcsetCandidateSchema),
  displayedWidth: z.number().nonnegative(),
  displayedHeight: z.number().nonnegative(),
  alt: z.string().nullable(),
  nearbyText: z.string().nullable(),
  captureStrategy: z.enum(["direct_fetch", "srcset", "expanded", "screenshot"]),
});

export const AssetManifestSchema = z.object({
  id: z.string().min(1),
  messageFingerprint: z.string().nullable(),
  kind: z.enum(["image", "video", "document"]),
  role: z
    .enum([
      "storyboard",
      "first_frame",
      "last_frame",
      "reference",
      "video_final",
      "unassigned",
    ])
    .default("unassigned"),
  originalFilename: z.string().nullable(),
  sourceUrl: z.string().url().nullable(),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  qualitySource: z.enum([
    "original",
    "largest_dom_candidate",
    "expanded_view",
    "screenshot_fallback",
    "local_file",
  ]),
});

export const CaptureEnvelopeSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  captureId: z.string().min(1),
  platform: PlatformSchema,
  sourceUrl: z.string().url(),
  conversationTitle: z.string().nullable(),
  captureMode: CaptureModeSchema,
  capturedAt: z.string().datetime(),
  messages: z.array(CaptureMessageSchema),
  assets: z.array(AssetManifestSchema),
  diagnostics: z.object({
    adapterId: z.string().min(1),
    detectedMessageCount: z.number().int().nonnegative(),
    skippedNodeCount: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  }),
});

export const CaptureEnvelopeWithoutAssetsSchema = CaptureEnvelopeSchema.omit({
  assets: true,
});

export const NativeRequestSchema = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("ping"),
    requestId: z.string().min(1),
  }),
  z.object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("capture.begin"),
    requestId: z.string().min(1),
    capture: CaptureEnvelopeWithoutAssetsSchema,
  }),
  z.object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("asset.begin"),
    requestId: z.string().min(1),
    captureId: z.string().min(1),
    asset: AssetManifestSchema,
  }),
  z.object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("asset.chunk"),
    requestId: z.string().min(1),
    captureId: z.string().min(1),
    assetId: z.string().min(1),
    index: z.number().int().nonnegative(),
    dataBase64: z.string(),
  }),
  z.object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("asset.end"),
    requestId: z.string().min(1),
    captureId: z.string().min(1),
    assetId: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }),
  z.object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("capture.commit"),
    requestId: z.string().min(1),
    captureId: z.string().min(1),
  }),
]);

export const NativeResponseCodeSchema = z.enum([
  "OK",
  "INVALID_PAYLOAD",
  "UNSUPPORTED_PROTOCOL",
  "ASSET_HASH_MISMATCH",
  "WRITE_FAILED",
  "HOST_NOT_CONFIGURED",
  "INTERNAL_ERROR",
]);

export const NativeResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: z.string(),
  ok: z.boolean(),
  code: NativeResponseCodeSchema,
  message: z.string(),
  data: z.unknown().optional(),
});

export const ExtractionMethodSchema = z.enum([
  "explicit",
  "rule",
  "inferred",
  "manual",
]);
export const ReviewStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "needs_review",
]);
export const DetectedItemKindSchema = z.enum([
  "script",
  "character",
  "location",
  "scene",
  "shot",
  "image_prompt",
  "video_prompt",
  "note",
  "correction",
  "unclassified",
]);

const ProvenanceSchema = z.object({
  id: z.string(),
  confidence: z.number().min(0).max(1),
  extractionMethod: ExtractionMethodSchema,
  sourceMessageIds: z.array(z.string()),
  reviewStatus: ReviewStatusSchema.default("pending"),
});

export const DetectedScriptSchema = ProvenanceSchema.extend({
  kind: z.literal("script"),
  title: z.string().nullable(),
  text: z.string(),
});

export const DetectedCharacterSchema = ProvenanceSchema.extend({
  kind: z.literal("character"),
  name: z.string(),
  aliases: z.array(z.string()),
  narrativeFunction: z.string().nullable(),
  physicalDescription: z.string().nullable(),
  wardrobe: z.string().nullable(),
  accessories: z.string().nullable(),
  attitude: z.string().nullable(),
  masterPrompt: z.string().nullable(),
});

export const DetectedLocationSchema = ProvenanceSchema.extend({
  kind: z.literal("location"),
  name: z.string(),
  description: z.string().nullable(),
  atmosphere: z.string().nullable(),
  lighting: z.string().nullable(),
  permanentElements: z.array(z.string()),
  timeOfDay: z.string().nullable(),
  weather: z.string().nullable(),
  masterPrompt: z.string().nullable(),
});

export const DetectedSceneSchema = ProvenanceSchema.extend({
  kind: z.literal("scene"),
  number: z.number().int().positive().nullable(),
  code: z.string().nullable(),
  title: z.string(),
  summary: z.string().nullable(),
  scriptFragment: z.string().nullable(),
  locationName: z.string().nullable(),
  orderIndex: z.number().int().nonnegative(),
});

export const DetectedShotSchema = ProvenanceSchema.extend({
  kind: z.literal("shot"),
  code: z.string().nullable(),
  sceneCode: z.string().nullable(),
  orderIndex: z.number().int().nonnegative(),
  title: z.string(),
  visualDescription: z.string().nullable(),
  action: z.string().nullable(),
  framing: z.string().nullable(),
  angle: z.string().nullable(),
  movement: z.string().nullable(),
  estimatedDurationMs: z.number().int().positive().nullable(),
  dialogue: z.string().nullable(),
  imagePrompt: z.string().nullable(),
  videoPrompt: z.string().nullable(),
});

export const DetectedPromptSchema = ProvenanceSchema.extend({
  kind: z.enum(["image_prompt", "video_prompt"]),
  title: z.string().nullable(),
  text: z.string(),
  relatedShotCode: z.string().nullable(),
});

export const DetectedCorrectionSchema = ProvenanceSchema.extend({
  kind: z.literal("correction"),
  targetReference: z.string().nullable(),
  instruction: z.string(),
});

export const DetectedLooseItemSchema = ProvenanceSchema.extend({
  kind: z.enum(["note", "unclassified"]),
  title: z.string().nullable(),
  text: z.string(),
});

export const AnalysisWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  sourceMessageIds: z.array(z.string()),
});

export const AnalysisProposalSchema = z.object({
  summary: z.string(),
  scriptCandidates: z.array(DetectedScriptSchema),
  characters: z.array(DetectedCharacterSchema),
  locations: z.array(DetectedLocationSchema),
  scenes: z.array(DetectedSceneSchema),
  shots: z.array(DetectedShotSchema),
  imagePrompts: z.array(DetectedPromptSchema),
  videoPrompts: z.array(DetectedPromptSchema),
  corrections: z.array(DetectedCorrectionSchema),
  unclassified: z.array(DetectedLooseItemSchema),
  warnings: z.array(AnalysisWarningSchema),
});

export type Platform = z.infer<typeof PlatformSchema>;
export type CaptureMode = z.infer<typeof CaptureModeSchema>;
export type CaptureMessage = z.infer<typeof CaptureMessageSchema>;
export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;
export type AssetManifest = z.infer<typeof AssetManifestSchema>;
export type CaptureEnvelope = z.infer<typeof CaptureEnvelopeSchema>;
export type CaptureEnvelopeWithoutAssets = z.infer<
  typeof CaptureEnvelopeWithoutAssetsSchema
>;
export type NativeRequest = z.infer<typeof NativeRequestSchema>;
export type NativeResponse = z.infer<typeof NativeResponseSchema>;
export type DetectedScript = z.infer<typeof DetectedScriptSchema>;
export type DetectedCharacter = z.infer<typeof DetectedCharacterSchema>;
export type DetectedLocation = z.infer<typeof DetectedLocationSchema>;
export type DetectedScene = z.infer<typeof DetectedSceneSchema>;
export type DetectedShot = z.infer<typeof DetectedShotSchema>;
export type DetectedPrompt = z.infer<typeof DetectedPromptSchema>;
export type DetectedCorrection = z.infer<typeof DetectedCorrectionSchema>;
export type DetectedLooseItem = z.infer<typeof DetectedLooseItemSchema>;
export type AnalysisWarning = z.infer<typeof AnalysisWarningSchema>;
export type AnalysisProposal = z.infer<typeof AnalysisProposalSchema>;

