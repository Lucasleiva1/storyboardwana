import {
  AnalysisProposalSchema,
  CaptureEnvelopeSchema,
  VideoTechnicalSchema,
  type AnalysisProposal,
  type CaptureEnvelope,
  type VideoTechnical,
} from "@framesync/contracts";
import { invoke } from "@tauri-apps/api/core";
import type DatabaseType from "@tauri-apps/plugin-sql";
import type {
  ProductionData,
  ProductionShot,
  Project,
  SourceEntry,
  SourceStatus,
} from "../types";

type SourceRow = {
  original_json: string;
  status: SourceStatus;
  proposal_json: string | null;
};

type ProjectRow = {
  id: string;
  project_number: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

let databasePromise: Promise<DatabaseType | null> | null = null;

export type ImportResult = {
  created: number;
  repeated: number;
  conflicts: number;
  specialCreated: number;
  variantsCreated: number;
};

export function isTauriRuntime() {
  return Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

async function database() {
  if (!isTauriRuntime()) return null;
  databasePromise ??= import("@tauri-apps/plugin-sql").then(
    ({ default: Database }) => Database.load("sqlite:framesync.db"),
  );
  const db = await databasePromise;
  if (db) {
    await db.execute("PRAGMA foreign_keys = ON");
    await db.execute("PRAGMA busy_timeout = 5000");
  }
  return db;
}

export async function listProjects(): Promise<Project[]> {
  const db = await database();
  if (!db) return [];
  const rows = await db.select<ProjectRow[]>(
    "SELECT id, project_number, name, description, created_at, updated_at FROM projects ORDER BY updated_at DESC",
  );
  return rows.map((row) => ({
    id: row.id,
    projectNumber: row.project_number,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function publishWorkspaceContext() {
  if (!isTauriRuntime()) return;
  await invoke("refresh_workspace_context");
}

export async function saveProject(project: Project) {
  const db = await database();
  if (!db) return;
  await db.execute(
    `INSERT INTO projects (
       id, project_number, name, description, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(id) DO UPDATE SET
       project_number = excluded.project_number,
       name = excluded.name,
       description = excluded.description,
       updated_at = excluded.updated_at`,
    [
      project.id,
      project.projectNumber,
      project.name,
      project.description,
      project.createdAt,
      project.updatedAt,
    ],
  );
  await publishWorkspaceContext();
}

export async function listSources(projectId: string): Promise<SourceEntry[]> {
  const db = await database();
  if (!db) return [];
  const rows = await db.select<SourceRow[]>(
    `SELECT
       source.original_json,
       source.status,
       (
         SELECT run.proposal_json
         FROM analysis_runs run
         WHERE run.capture_source_id = source.id
         ORDER BY run.started_at DESC
         LIMIT 1
       ) AS proposal_json
     FROM capture_sources source
     WHERE source.project_id = $1
     ORDER BY source.captured_at DESC`,
    [projectId],
  );
  return rows.flatMap((row) => {
    const parsedCapture = CaptureEnvelopeSchema.safeParse(
      JSON.parse(row.original_json) as unknown,
    );
    if (!parsedCapture.success) return [];
    const parsedProposal = row.proposal_json
      ? AnalysisProposalSchema.safeParse(
          JSON.parse(row.proposal_json) as unknown,
        )
      : null;
    return [
      {
        capture: parsedCapture.data,
        proposal: parsedProposal?.success ? parsedProposal.data : null,
        status: row.status,
      },
    ];
  });
}

export async function deleteCaptureSource(
  projectId: string,
  captureId: string,
  removeImportedContent: boolean,
) {
  await invoke("delete_capture_source", {
    projectId,
    captureId,
    removeImportedContent,
  });
  await publishWorkspaceContext();
}

export async function saveCapture(projectId: string, capture: CaptureEnvelope) {
  const db = await database();
  if (!db) return;
  const rawText = capture.messages
    .map((message) => `[${message.role}]\n${message.text}`)
    .join("\n\n");
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO capture_sources (
         id, project_id, platform, source_url, conversation_title, captured_at,
         capture_mode, status, fingerprint, raw_text, original_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'received', $8, $9, $10, $11)
       ON CONFLICT(id) DO UPDATE SET
         platform = excluded.platform,
         source_url = excluded.source_url,
         conversation_title = excluded.conversation_title,
         captured_at = excluded.captured_at,
         capture_mode = excluded.capture_mode,
         status = 'received',
         fingerprint = excluded.fingerprint,
         raw_text = excluded.raw_text,
         original_json = excluded.original_json`,
    [
      capture.captureId,
      projectId,
      capture.platform,
      capture.sourceUrl,
      capture.conversationTitle,
      capture.capturedAt,
      capture.captureMode,
      capture.captureId,
      rawText,
      JSON.stringify(capture),
      now,
    ],
  );
  for (const message of capture.messages) {
    await db.execute(
      `INSERT INTO capture_messages (
           id, capture_source_id, order_index, role, text, html_snapshot,
           message_fingerprint, source_dom_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT(id) DO UPDATE SET
           order_index = excluded.order_index,
           role = excluded.role,
           text = excluded.text,
           html_snapshot = excluded.html_snapshot,
           message_fingerprint = excluded.message_fingerprint,
           source_dom_id = excluded.source_dom_id`,
      [
        message.id,
        capture.captureId,
        message.orderIndex,
        message.role,
        message.text,
        message.htmlSnapshot,
        message.messageFingerprint,
        message.sourceDomId,
        message.createdAt,
      ],
    );
  }
  for (const asset of capture.assets) {
    if (!asset.localPath) continue;
    await db.execute(
      `INSERT INTO assets (
         id, project_id, capture_source_id, kind, role, original_filename,
         stored_path, local_path, related_shot_code, source_url, mime_type,
         byte_size, width, height, duration_ms, sha256, quality_source, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17
       )
       ON CONFLICT(sha256) DO UPDATE SET
         local_path = excluded.local_path`,
      [
        asset.id,
        projectId,
        capture.captureId,
        asset.kind,
        asset.role,
        asset.originalFilename,
        asset.localPath,
        asset.relatedShotCode,
        asset.sourceUrl,
        asset.mimeType,
        asset.byteSize,
        asset.width,
        asset.height,
        asset.durationMs,
        asset.sha256,
        asset.qualitySource,
        now,
      ],
    );
    if (asset.relatedShotCode) {
      await db.execute(
        `INSERT OR IGNORE INTO shot_assets (
           shot_id, asset_id, role, order_index
         )
         SELECT shot.id, stored_asset.id, $1,
                COALESCE((
                  SELECT MAX(existing.order_index) + 1
                  FROM shot_assets existing
                  WHERE existing.shot_id = shot.id AND existing.role = $1
                ), 0)
         FROM shots shot
         JOIN assets stored_asset ON stored_asset.sha256 = $2
         WHERE shot.project_id = $3 AND shot.code = $4`,
        [asset.role, asset.sha256, projectId, asset.relatedShotCode],
      );
    }
  }
  await db.execute(
    `INSERT OR IGNORE INTO shot_assets (shot_id, asset_id, role, order_index)
     SELECT shot.id, asset.id, asset.role,
            COALESCE((
              SELECT MAX(existing.order_index) + 1
              FROM shot_assets existing
              WHERE existing.shot_id = shot.id
                AND existing.role = asset.role
            ), 0)
     FROM assets asset
     JOIN shots shot
       ON shot.project_id = asset.project_id
      AND shot.code = asset.related_shot_code
     WHERE asset.capture_source_id = $1
       AND asset.related_shot_code IS NOT NULL`,
    [capture.captureId],
  );
  await db.execute(
    `UPDATE shots
     SET status = CASE
       WHEN EXISTS (
         SELECT 1 FROM shot_assets link
         WHERE link.shot_id = shots.id AND link.role = 'video_final'
       ) THEN 'video'
       WHEN EXISTS (
         SELECT 1 FROM shot_assets link
         WHERE link.shot_id = shots.id AND link.role IN ('first_frame', 'last_frame')
       ) THEN 'first_frame'
       WHEN EXISTS (
         SELECT 1 FROM shot_assets link
         WHERE link.shot_id = shots.id AND link.role = 'storyboard'
       ) THEN 'storyboard'
       ELSE status
     END,
     updated_at = $1
     WHERE project_id = $2`,
    [now, projectId],
  );
  await publishWorkspaceContext();
}

function proposalItems(proposal: AnalysisProposal) {
  return [
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
  ];
}

function itemTitle(item: ReturnType<typeof proposalItems>[number]) {
  if ("name" in item) return item.name;
  if ("title" in item) return item.title;
  if ("code" in item) return item.code;
  if ("targetReference" in item) return item.targetReference;
  return null;
}

export async function saveAnalysis(
  captureId: string,
  proposal: AnalysisProposal,
) {
  const db = await database();
  if (!db) return;
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO analysis_runs (
         id, capture_source_id, engine_version, started_at, completed_at,
         status, summary, proposal_json
       ) VALUES ($1, $2, 'rules-0.1.0', $3, $3, 'completed', $4, $5)`,
    [runId, captureId, now, proposal.summary, JSON.stringify(proposal)],
  );
  for (const item of proposalItems(proposal)) {
    await db.execute(
      `INSERT INTO detected_items (
           id, analysis_run_id, kind, title, payload_json, confidence,
           extraction_method, source_message_ids_json, review_status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        item.id,
        runId,
        item.kind,
        itemTitle(item),
        JSON.stringify(item),
        item.confidence,
        item.extractionMethod,
        JSON.stringify(item.sourceMessageIds),
        item.reviewStatus,
      ],
    );
  }
  await db.execute(
    "UPDATE capture_sources SET status = 'analyzed' WHERE id = $1",
    [captureId],
  );
  await publishWorkspaceContext();
}

export async function updateAnalysis(
  captureId: string,
  proposal: AnalysisProposal,
  status: SourceStatus,
) {
  const db = await database();
  if (!db) return;
  await db.execute(
    `UPDATE analysis_runs
     SET proposal_json = $1, summary = $2
     WHERE id = (
       SELECT id FROM analysis_runs
       WHERE capture_source_id = $3
       ORDER BY started_at DESC LIMIT 1
     )`,
    [JSON.stringify(proposal), proposal.summary, captureId],
  );
  const currentItems = proposalItems(proposal);
  for (const item of currentItems) {
    await db.execute(
      "UPDATE detected_items SET review_status = $1, payload_json = $2 WHERE id = $3",
      [item.reviewStatus, JSON.stringify(item), item.id],
    );
  }
  if (currentItems.length > 0) {
    const placeholders = currentItems.map(() => "?").join(", ");
    await db.execute(
      `DELETE FROM detected_items
       WHERE analysis_run_id = (
         SELECT id FROM analysis_runs
         WHERE capture_source_id = ?
         ORDER BY started_at DESC LIMIT 1
       )
       AND id NOT IN (${placeholders})`,
      [captureId, ...currentItems.map((item) => item.id)],
    );
  } else {
    await db.execute(
      `DELETE FROM detected_items
       WHERE analysis_run_id = (
         SELECT id FROM analysis_runs
         WHERE capture_source_id = ?
         ORDER BY started_at DESC LIMIT 1
       )`,
      [captureId],
    );
  }
  await db.execute("UPDATE capture_sources SET status = $1 WHERE id = $2", [
    status,
    captureId,
  ]);
  await publishWorkspaceContext();
}

function shotContentValue(shot: {
  title: string;
  visualDescription: string | null;
  action: string | null;
  framing: string | null;
  angle: string | null;
  movement: string | null;
  estimatedDurationMs: number | null;
  dialogue: string | null;
  imagePrompt: string | null;
  videoPrompt: string | null;
  videoTechnical: VideoTechnical;
}) {
  return JSON.stringify([
    shot.title.trim(),
    shot.visualDescription?.trim() ?? null,
    shot.action?.trim() ?? null,
    shot.framing?.trim() ?? null,
    shot.angle?.trim() ?? null,
    shot.movement?.trim() ?? null,
    shot.estimatedDurationMs,
    shot.dialogue?.trim() ?? null,
    shot.imagePrompt?.trim() ?? null,
    shot.videoPrompt?.trim() ?? null,
    shot.videoTechnical,
  ]);
}

function parseVideoTechnical(value: string | null | undefined) {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return VideoTechnicalSchema.parse(parsed);
  } catch {
    return VideoTechnicalSchema.parse({});
  }
}

function compactFingerprint(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function scopedStorageId(
  kind: "episode" | "scene" | "shot",
  projectId: string,
  detectedId: string,
) {
  return `${kind}-${compactFingerprint(`${projectId}\u0000${detectedId}`)}`;
}

export async function importApproved(
  projectId: string,
  captureId: string,
  proposal: AnalysisProposal,
  options: { synchronizeSourceShots?: boolean } = {},
): Promise<ImportResult> {
  const db = await database();
  const result: ImportResult = {
    created: 0,
    repeated: 0,
    conflicts: 0,
    specialCreated: 0,
    variantsCreated: 0,
  };
  if (!db) return result;
  const now = new Date().toISOString();
  const approvedScripts = proposal.scriptCandidates.filter(
    (item) => item.reviewStatus === "approved",
  );
  const approvedCharacters = proposal.characters.filter(
    (item) => item.reviewStatus === "approved",
  );
  const approvedLocations = proposal.locations.filter(
    (item) => item.reviewStatus === "approved",
  );
  const approvedEpisodes = proposal.episodes.filter(
    (item) => item.reviewStatus === "approved",
  );
  const approvedShots = proposal.shots.filter(
    (item) => item.reviewStatus === "approved",
  );
  const requiredSceneCodes = new Set(
    approvedShots
      .map((shot) => shot.sceneCode)
      .filter((code): code is string => Boolean(code)),
  );
  const approvedScenes = proposal.scenes.filter(
    (item) =>
      Boolean(item.code) &&
      (item.reviewStatus === "approved" ||
        (item.reviewStatus !== "rejected" &&
          Boolean(item.code && requiredSceneCodes.has(item.code)))),
  );

  const retainedNormalNumbers = approvedShots
    .filter((item) => item.shotType === "normal" && item.globalNumber !== null)
    .map((item) => item.globalNumber!);

  for (const item of approvedScripts) {
    await db.execute(
      `INSERT OR IGNORE INTO scripts (id, project_id, created_at)
         VALUES ($1, $2, $3)`,
      [item.id, projectId, now],
    );
    await db.execute(
      `INSERT OR IGNORE INTO script_versions (
           id, script_id, version_number, title, text, source_capture_id,
           approved_at, created_at
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, $6)`,
      [`${item.id}-v1`, item.id, item.title, item.text, captureId, now],
    );
    await db.execute(
      "UPDATE scripts SET canonical_version_id = $1 WHERE id = $2",
      [`${item.id}-v1`, item.id],
    );
  }

  for (const item of approvedCharacters) {
    await db.execute(
      `INSERT INTO characters (
           id, project_id, canonical_name, status, source_capture_id,
           created_at, updated_at
         ) VALUES ($1, $2, $3, 'approved', $4, $5, $5)
         ON CONFLICT(project_id, canonical_name) DO UPDATE SET
           status = 'approved', updated_at = excluded.updated_at`,
      [item.id, projectId, item.name, captureId, now],
    );
    await db.execute(
      `INSERT OR IGNORE INTO character_versions (
           id, character_id, version_number, aliases_json,
           narrative_function, physical_description, wardrobe, accessories,
           attitude, master_prompt, source_capture_id, created_at
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        `${item.id}-v1`,
        scopedStorageId("episode", projectId, item.id),
        JSON.stringify(item.aliases),
        item.narrativeFunction,
        item.physicalDescription,
        item.wardrobe,
        item.accessories,
        item.attitude,
        item.masterPrompt,
        captureId,
        now,
      ],
    );
    await db.execute(
      "UPDATE characters SET canonical_version_id = $1 WHERE id = $2",
      [`${item.id}-v1`, item.id],
    );
  }

  for (const item of approvedLocations) {
    await db.execute(
      `INSERT INTO locations (
           id, project_id, canonical_name, status, source_capture_id,
           created_at, updated_at
         ) VALUES ($1, $2, $3, 'approved', $4, $5, $5)
         ON CONFLICT(project_id, canonical_name) DO UPDATE SET
           status = 'approved', updated_at = excluded.updated_at`,
      [item.id, projectId, item.name, captureId, now],
    );
    await db.execute(
      `INSERT OR IGNORE INTO location_versions (
           id, location_id, version_number, description, atmosphere, lighting,
           permanent_elements_json, time_of_day, weather, master_prompt,
           source_capture_id, created_at
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        `${item.id}-v1`,
        scopedStorageId("scene", projectId, item.id),
        item.description,
        item.atmosphere,
        item.lighting,
        JSON.stringify(item.permanentElements),
        item.timeOfDay,
        item.weather,
        item.masterPrompt,
        captureId,
        now,
      ],
    );
    await db.execute(
      "UPDATE locations SET canonical_version_id = $1 WHERE id = $2",
      [`${item.id}-v1`, item.id],
    );
  }

  for (const item of approvedEpisodes) {
    await db.execute(
      `INSERT INTO episodes (
         id, project_id, source_capture_id, number, code, title, summary,
         order_index, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT(project_id, number) DO UPDATE SET
         code = excluded.code,
         title = excluded.title,
         summary = excluded.summary,
         order_index = excluded.order_index,
         updated_at = excluded.updated_at`,
      [
        item.id,
        projectId,
        captureId,
        item.number,
        item.code,
        item.title,
        item.summary,
        item.orderIndex,
        now,
      ],
    );
  }

  const episodeRows = await db.select<Array<{ id: string; code: string }>>(
    "SELECT id, code FROM episodes WHERE project_id = $1",
    [projectId],
  );

  for (const item of approvedScenes) {
    const matchingLocation = approvedLocations.find(
      (location) => location.name === item.locationName,
    );
    const matchingEpisode = episodeRows.find(
      (episode) => episode.code === item.episodeCode,
    );
    const storedSceneCode =
      item.episodeCode && item.code
        ? `${item.episodeCode}-${item.code}`
        : item.code;
    await db.execute(
      `INSERT INTO scenes (
           id, project_id, source_capture_id, number, code, title, summary,
           script_fragment, location_id, episode_id, order_index, created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         ON CONFLICT(project_id, code) DO UPDATE SET
           title = excluded.title,
           summary = excluded.summary,
           script_fragment = excluded.script_fragment,
           location_id = excluded.location_id,
           episode_id = excluded.episode_id,
           order_index = excluded.order_index,
           updated_at = excluded.updated_at`,
      [
        item.id,
        projectId,
        captureId,
        item.number,
        storedSceneCode,
        item.title,
        item.summary,
        item.scriptFragment,
        matchingLocation?.id ?? null,
        matchingEpisode?.id ?? null,
        item.orderIndex,
        now,
      ],
    );
  }

  const sceneRows = await db.select<Array<{ id: string; code: string | null }>>(
    "SELECT id, code FROM scenes WHERE project_id = $1",
    [projectId],
  );
  type ExistingShotRow = {
    id: string;
    source_capture_id: string | null;
    content_fingerprint: string | null;
    title: string;
    visual_description: string | null;
    action: string | null;
    framing: string | null;
    angle: string | null;
    movement: string | null;
    estimated_duration_ms: number | null;
    dialogue: string | null;
    image_prompt: string | null;
    video_prompt: string | null;
    video_technical_json: string;
  };
  const maxRows = await db.select<Array<{ maximum: number }>>(
    `SELECT COALESCE(MAX(global_number), 0) AS maximum
     FROM shots
     WHERE project_id = $1 AND shot_type = 'normal'`,
    [projectId],
  );
  let expectedNextNumber = (maxRows[0]?.maximum ?? 0) + 1;

  for (const item of approvedShots) {
    const storedSceneCode =
      item.episodeCode && item.sceneCode
        ? `${item.episodeCode}-${item.sceneCode}`
        : item.sceneCode;
    const matchingScene = sceneRows.find(
      (scene) => scene.code === storedSceneCode,
    );
    if (!matchingScene) continue;
    const contentValue = shotContentValue(item);
    const fingerprint = compactFingerprint(contentValue);
    let code = item.code;
    let globalNumber = item.globalNumber;
    let specialCode = item.specialCode;
    let variantOfShotId: string | null = null;
    let action = "created";

    if (item.shotType === "normal") {
      if (!globalNumber) continue;
      code = `P${String(globalNumber).padStart(3, "0")}`;
      const existingRows = await db.select<ExistingShotRow[]>(
        `SELECT id, source_capture_id, content_fingerprint, title, visual_description, action,
                framing, angle, movement, estimated_duration_ms, dialogue,
                image_prompt, video_prompt, video_technical_json
         FROM shots
         WHERE project_id = $1 AND shot_type = 'normal' AND global_number = $2`,
        [projectId, globalNumber],
      );
      const existing = existingRows[0];
      if (existing) {
        if (
          options.synchronizeSourceShots &&
          existing.source_capture_id === captureId
        ) {
          await db.execute(
            `UPDATE shots SET
               scene_id = $1,
               source_capture_id = $2,
               code = $3,
               content_fingerprint = $4,
               order_index = $5,
               title = $6,
               visual_description = $7,
               action = $8,
               framing = $9,
               angle = $10,
               movement = $11,
               estimated_duration_ms = $12,
               dialogue = $13,
               image_prompt = $14,
               video_prompt = $15,
               video_technical_json = $16,
               status = 'structured',
               updated_at = $17
             WHERE id = $18`,
            [
              matchingScene.id,
              captureId,
              code,
              fingerprint,
              globalNumber - 1,
              item.title,
              item.visualDescription,
              item.action,
              item.framing,
              item.angle,
              item.movement,
              item.estimatedDurationMs,
              item.dialogue,
              item.imagePrompt,
              item.videoPrompt,
              JSON.stringify(item.videoTechnical),
              now,
              existing.id,
            ],
          );
          await db.execute(
            `INSERT INTO shot_import_events (
               id, project_id, capture_source_id, detected_item_id, action,
               global_number, shot_id, payload_json, created_at
             ) VALUES ($1, $2, $3, $4, 'updated', $5, $6, $7, $8)`,
            [
              crypto.randomUUID(),
              projectId,
              captureId,
              item.id,
              globalNumber,
              existing.id,
              JSON.stringify(item),
              now,
            ],
          );
          continue;
        }
        const existingFingerprint =
          existing.content_fingerprint ??
          compactFingerprint(
            shotContentValue({
              title: existing.title,
              visualDescription: existing.visual_description,
              action: existing.action,
              framing: existing.framing,
              angle: existing.angle,
              movement: existing.movement,
              estimatedDurationMs: existing.estimated_duration_ms,
              dialogue: existing.dialogue,
              imagePrompt: existing.image_prompt,
              videoPrompt: existing.video_prompt,
              videoTechnical: parseVideoTechnical(
                existing.video_technical_json,
              ),
            }),
          );
        if (existingFingerprint === fingerprint) {
          result.repeated += 1;
          action = "repeated";
        } else {
          result.conflicts += 1;
          action = "conflict";
          await db.execute(
            "UPDATE shots SET status = 'conflict', updated_at = $1 WHERE id = $2",
            [now, existing.id],
          );
        }
        await db.execute(
          `INSERT INTO shot_import_events (
             id, project_id, capture_source_id, detected_item_id, action,
             global_number, shot_id, payload_json, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            crypto.randomUUID(),
            projectId,
            captureId,
            item.id,
            action,
            globalNumber,
            existing.id,
            JSON.stringify(item),
            now,
          ],
        );
        continue;
      }
      if (globalNumber !== expectedNextNumber) {
        result.conflicts += 1;
        await db.execute(
          `INSERT INTO shot_import_events (
             id, project_id, capture_source_id, detected_item_id, action,
             global_number, shot_id, payload_json, created_at
           ) VALUES ($1, $2, $3, $4, 'conflict', $5, NULL, $6, $7)`,
          [
            crypto.randomUUID(),
            projectId,
            captureId,
            item.id,
            globalNumber,
            JSON.stringify({
              ...item,
              continuityError: `Se esperaba P${String(expectedNextNumber).padStart(3, "0")}.`,
            }),
            now,
          ],
        );
        continue;
      }
      result.created += 1;
    } else if (item.shotType === "special") {
      if (!specialCode) {
        const rows = await db.select<Array<{ next_number: number }>>(
          `SELECT COALESCE(MAX(CAST(SUBSTR(special_code, 5) AS INTEGER)), 0) + 1 AS next_number
           FROM shots
           WHERE project_id = $1 AND shot_type = 'special'`,
          [projectId],
        );
        specialCode = `ESP-${String(rows[0]?.next_number ?? 1).padStart(3, "0")}`;
      }
      code = specialCode;
      const duplicate = await db.select<Array<{ id: string }>>(
        `SELECT id FROM shots
         WHERE project_id = $1 AND shot_type = 'special'
           AND (special_code = $2 OR content_fingerprint = $3)
         LIMIT 1`,
        [projectId, specialCode, fingerprint],
      );
      if (duplicate[0]) {
        result.repeated += 1;
        await db.execute(
          `INSERT INTO shot_import_events (
             id, project_id, capture_source_id, detected_item_id, action,
             global_number, shot_id, payload_json, created_at
           ) VALUES ($1, $2, $3, $4, 'repeated', NULL, $5, $6, $7)`,
          [
            crypto.randomUUID(),
            projectId,
            captureId,
            item.id,
            duplicate[0].id,
            JSON.stringify(item),
            now,
          ],
        );
        continue;
      }
      action = "special_created";
      result.specialCreated += 1;
      globalNumber = null;
    } else {
      const parent = item.variantOfShotNumber
        ? (
            await db.select<Array<{ id: string }>>(
              `SELECT id FROM shots
               WHERE project_id = $1 AND shot_type = 'normal' AND global_number = $2`,
              [projectId, item.variantOfShotNumber],
            )
          )[0]
        : null;
      if (!parent) {
        result.conflicts += 1;
        continue;
      }
      variantOfShotId = parent.id;
      const duplicate = await db.select<Array<{ id: string }>>(
        `SELECT id FROM shots
         WHERE project_id = $1
           AND shot_type = 'variant'
           AND variant_of_shot_id = $2
           AND content_fingerprint = $3
         LIMIT 1`,
        [projectId, variantOfShotId, fingerprint],
      );
      if (duplicate[0]) {
        result.repeated += 1;
        await db.execute(
          `INSERT INTO shot_import_events (
             id, project_id, capture_source_id, detected_item_id, action,
             global_number, shot_id, payload_json, created_at
           ) VALUES ($1, $2, $3, $4, 'repeated', NULL, $5, $6, $7)`,
          [
            crypto.randomUUID(),
            projectId,
            captureId,
            item.id,
            duplicate[0].id,
            JSON.stringify(item),
            now,
          ],
        );
        continue;
      }
      const variantCountRows = await db.select<Array<{ total: number }>>(
        `SELECT COUNT(*) AS total FROM shots
         WHERE project_id = $1
           AND shot_type = 'variant'
           AND variant_of_shot_id = $2`,
        [projectId, variantOfShotId],
      );
      code = `P${String(item.variantOfShotNumber).padStart(3, "0")}-V${String(
        (variantCountRows[0]?.total ?? 0) + 1,
      ).padStart(3, "0")}`;
      action = "variant_created";
      result.variantsCreated += 1;
      globalNumber = null;
    }

    const shotId = scopedStorageId("shot", projectId, item.id);
    await db.execute(
      `INSERT INTO shots (
         id, project_id, scene_id, source_capture_id, code, global_number,
         shot_type, special_code, variant_of_shot_id, content_fingerprint,
         order_index, title, visual_description, action, framing, angle,
         movement, estimated_duration_ms, dialogue, image_prompt, video_prompt,
         video_technical_json, status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22, 'structured', $23, $23
       )`,
      [
        shotId,
        projectId,
        matchingScene.id,
        captureId,
        code,
        globalNumber,
        item.shotType,
        specialCode,
        variantOfShotId,
        fingerprint,
        globalNumber ? globalNumber - 1 : item.orderIndex,
        item.title,
        item.visualDescription,
        item.action,
        item.framing,
        item.angle,
        item.movement,
        item.estimatedDurationMs,
        item.dialogue,
        item.imagePrompt,
        item.videoPrompt,
        JSON.stringify(item.videoTechnical),
        now,
      ],
    );
    if (item.shotType === "normal") {
      expectedNextNumber += 1;
    }
    await db.execute(
      `INSERT INTO shot_import_events (
         id, project_id, capture_source_id, detected_item_id, action,
         global_number, shot_id, payload_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        crypto.randomUUID(),
        projectId,
        captureId,
        item.id,
        action,
        item.globalNumber,
        shotId,
        JSON.stringify(item),
        now,
      ],
    );
  }

  if (options.synchronizeSourceShots && retainedNormalNumbers.length > 0) {
    const placeholders = retainedNormalNumbers.map(() => "?").join(", ");
    await db.execute(
      `DELETE FROM shots
       WHERE project_id = ?
         AND source_capture_id = ?
         AND shot_type = 'normal'
         AND global_number NOT IN (${placeholders})`,
      [projectId, captureId, ...retainedNormalNumbers],
    );
  }
  if (options.synchronizeSourceShots) {
    const retainedSceneCodes = approvedScenes.flatMap((scene) => {
      if (!scene.code) return [];
      return [
        scene.episodeCode ? `${scene.episodeCode}-${scene.code}` : scene.code,
      ];
    });
    if (retainedSceneCodes.length > 0) {
      const placeholders = retainedSceneCodes.map(() => "?").join(", ");
      await db.execute(
        `DELETE FROM scenes
         WHERE project_id = ?
           AND source_capture_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM shots shot WHERE shot.scene_id = scenes.id
           )
           AND (code IS NULL OR code NOT IN (${placeholders}))`,
        [projectId, captureId, ...retainedSceneCodes],
      );
    }
  }

  await db.execute(
    `INSERT OR IGNORE INTO shot_assets (shot_id, asset_id, role, order_index)
     SELECT shot.id, asset.id, asset.role,
            COALESCE((
              SELECT MAX(existing.order_index) + 1
              FROM shot_assets existing
              WHERE existing.shot_id = shot.id
                AND existing.role = asset.role
            ), 0)
     FROM assets asset
     JOIN shots shot
       ON shot.project_id = asset.project_id
      AND shot.code = asset.related_shot_code
     WHERE asset.capture_source_id = $1
       AND asset.related_shot_code IS NOT NULL`,
    [captureId],
  );

  await db.execute(
    "UPDATE capture_sources SET status = 'imported' WHERE id = $1",
    [captureId],
  );
  await db.execute("UPDATE projects SET updated_at = $1 WHERE id = $2", [
    now,
    projectId,
  ]);
  await publishWorkspaceContext();
  return result;
}

type JsonRow = { payload_json: string };
type ScriptRow = {
  id: string;
  title: string | null;
  text: string;
  source_capture_id: string | null;
};
type SceneRow = {
  id: string;
  number: number | null;
  code: string | null;
  title: string;
  summary: string | null;
  script_fragment: string | null;
  canonical_name: string | null;
  episode_code: string | null;
  order_index: number;
  source_capture_id: string | null;
};
type EpisodeRow = {
  id: string;
  number: number;
  code: string;
  title: string;
  summary: string | null;
  order_index: number;
  source_capture_id: string | null;
};
type ShotRow = {
  id: string;
  code: string | null;
  global_number: number | null;
  shot_type: "normal" | "special" | "variant";
  special_code: string | null;
  variant_of_shot_number: number | null;
  scene_code: string | null;
  order_index: number;
  title: string;
  visual_description: string | null;
  action: string | null;
  framing: string | null;
  angle: string | null;
  movement: string | null;
  estimated_duration_ms: number | null;
  dialogue: string | null;
  image_prompt: string | null;
  video_prompt: string | null;
  video_technical_json: string;
  status: ProductionShot["status"];
  source_capture_id: string | null;
  first_frame_path: string | null;
  storyboard_paths_json: string;
  video_path: string | null;
  video_paths_json: string;
  storyboard_asset_count: number;
};

type AssetRow = {
  id: string;
  kind: "image" | "video" | "document";
  role:
    | "storyboard"
    | "first_frame"
    | "last_frame"
    | "reference"
    | "video_final"
    | "unassigned";
  original_filename: string | null;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  related_shot_code: string | null;
  local_path: string | null;
  sha256: string;
  quality_source:
    | "original"
    | "largest_dom_candidate"
    | "expanded_view"
    | "screenshot_fallback"
    | "local_file";
  shot_code: string | null;
  order_index: number | null;
};

export async function loadProduction(
  projectId: string,
): Promise<ProductionData> {
  const db = await database();
  if (!db) {
    return {
      scripts: [],
      characters: [],
      locations: [],
      episodes: [],
      scenes: [],
      shots: [],
      assets: [],
    };
  }
  const [
    scriptRows,
    characterRows,
    locationRows,
    episodeRows,
    sceneRows,
    shotRows,
    assetRows,
  ] = await Promise.all([
    db.select<ScriptRow[]>(
      `SELECT script.id, version.title, version.text, version.source_capture_id
         FROM scripts script
         JOIN script_versions version ON version.id = script.canonical_version_id
         WHERE script.project_id = $1`,
      [projectId],
    ),
    db.select<JsonRow[]>(
      `SELECT item.payload_json
         FROM detected_items item
         JOIN analysis_runs run ON run.id = item.analysis_run_id
         JOIN capture_sources source ON source.id = run.capture_source_id
         WHERE source.project_id = $1
           AND item.kind = 'character'
           AND item.review_status = 'approved'`,
      [projectId],
    ),
    db.select<JsonRow[]>(
      `SELECT item.payload_json
         FROM detected_items item
         JOIN analysis_runs run ON run.id = item.analysis_run_id
         JOIN capture_sources source ON source.id = run.capture_source_id
         WHERE source.project_id = $1
           AND item.kind = 'location'
           AND item.review_status = 'approved'`,
      [projectId],
    ),
    db.select<EpisodeRow[]>(
      `SELECT id, number, code, title, summary, order_index, source_capture_id
         FROM episodes
         WHERE project_id = $1
         ORDER BY order_index, number`,
      [projectId],
    ),
    db.select<SceneRow[]>(
      `SELECT scene.id, scene.number, scene.code, scene.title, scene.summary,
                scene.script_fragment, location.canonical_name,
                episode.code AS episode_code, scene.order_index,
                scene.source_capture_id
         FROM scenes scene
         LEFT JOIN locations location ON location.id = scene.location_id
         LEFT JOIN episodes episode ON episode.id = scene.episode_id
         WHERE scene.project_id = $1
         ORDER BY COALESCE(episode.order_index, -1), scene.order_index`,
      [projectId],
    ),
    db.select<ShotRow[]>(
      `SELECT shot.id, shot.code, shot.global_number, shot.shot_type,
                shot.special_code,
                parent.global_number AS variant_of_shot_number,
                scene.code AS scene_code, shot.order_index,
                shot.title, shot.visual_description, shot.action, shot.framing,
                shot.angle, shot.movement, shot.estimated_duration_ms,
                shot.dialogue, shot.image_prompt, shot.video_prompt,
                shot.video_technical_json, shot.status,
                shot.source_capture_id,
                (
                  SELECT asset.local_path
                  FROM shot_assets link
                  JOIN assets asset ON asset.id = link.asset_id
                  WHERE link.shot_id = shot.id AND link.role = 'first_frame'
                  ORDER BY link.order_index LIMIT 1
                ) AS first_frame_path,
                COALESCE((
                  SELECT json_group_array(storyboard.local_path)
                  FROM (
                    SELECT asset.local_path
                    FROM shot_assets link
                    JOIN assets asset ON asset.id = link.asset_id
                    WHERE link.shot_id = shot.id
                      AND link.role = 'storyboard'
                      AND asset.local_path IS NOT NULL
                    ORDER BY link.order_index, asset.created_at, asset.id
                  ) storyboard
                ), '[]') AS storyboard_paths_json,
                (
                  SELECT asset.local_path
                  FROM shot_assets link
                  JOIN assets asset ON asset.id = link.asset_id
                  WHERE link.shot_id = shot.id AND link.role = 'video_final'
                  ORDER BY link.order_index LIMIT 1
                ) AS video_path,
                COALESCE((
                  SELECT json_group_array(video.local_path)
                  FROM (
                    SELECT asset.local_path
                    FROM shot_assets link
                    JOIN assets asset ON asset.id = link.asset_id
                    WHERE link.shot_id = shot.id
                      AND link.role = 'video_final'
                      AND asset.local_path IS NOT NULL
                    ORDER BY link.order_index, asset.created_at, asset.id
                  ) video
                ), '[]') AS video_paths_json,
                (
                  SELECT COUNT(*)
                  FROM shot_assets link
                  WHERE link.shot_id = shot.id AND link.role = 'storyboard'
                ) AS storyboard_asset_count
         FROM shots shot
         JOIN scenes scene ON scene.id = shot.scene_id
         LEFT JOIN shots parent ON parent.id = shot.variant_of_shot_id
         WHERE scene.project_id = $1
         ORDER BY
           CASE WHEN shot.global_number IS NULL THEN 1 ELSE 0 END,
           shot.global_number,
           shot.order_index`,
      [projectId],
    ),
    db.select<AssetRow[]>(
      `SELECT asset.id, asset.kind, asset.role, asset.original_filename,
              asset.mime_type, asset.byte_size, asset.width, asset.height,
              asset.duration_ms, asset.related_shot_code, asset.local_path,
              asset.sha256, asset.quality_source, shot.code AS shot_code,
              link.order_index
       FROM assets asset
       LEFT JOIN shot_assets link ON link.asset_id = asset.id
       LEFT JOIN shots shot ON shot.id = link.shot_id
       WHERE asset.project_id = $1
       ORDER BY
         CASE WHEN shot.global_number IS NULL THEN 1 ELSE 0 END,
         shot.global_number,
         link.role,
         link.order_index,
         asset.created_at`,
      [projectId],
    ),
  ]);

  const parseItems = (rows: JsonRow[]) =>
    rows.map((row) => JSON.parse(row.payload_json) as unknown);
  const characterItems = parseItems(characterRows).flatMap((item) => {
    const parsed =
      AnalysisProposalSchema.shape.characters.element.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  const locationItems = parseItems(locationRows).flatMap((item) => {
    const parsed =
      AnalysisProposalSchema.shape.locations.element.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });

  return {
    scripts: scriptRows.map((row) => ({
      id: row.id,
      kind: "script",
      title: row.title,
      text: row.text,
      confidence: 1,
      extractionMethod: "manual",
      sourceMessageIds: row.source_capture_id ? [row.source_capture_id] : [],
      reviewStatus: "approved",
    })),
    characters: characterItems,
    locations: locationItems,
    episodes: episodeRows.map((row) => ({
      id: row.id,
      kind: "episode",
      number: row.number,
      code: row.code,
      title: row.title,
      summary: row.summary,
      orderIndex: row.order_index,
      confidence: 1,
      extractionMethod: "manual",
      sourceMessageIds: row.source_capture_id ? [row.source_capture_id] : [],
      reviewStatus: "approved",
    })),
    scenes: sceneRows.map((row) => ({
      id: row.id,
      kind: "scene",
      number: row.number,
      code: row.code,
      episodeCode: row.episode_code,
      title: row.title,
      summary: row.summary,
      scriptFragment: row.script_fragment,
      locationName: row.canonical_name,
      orderIndex: row.order_index,
      confidence: 1,
      extractionMethod: "manual",
      sourceMessageIds: row.source_capture_id ? [row.source_capture_id] : [],
      reviewStatus: "approved",
    })),
    shots: shotRows.map((row) => ({
      id: row.id,
      kind: "shot",
      code: row.code,
      globalNumber: row.global_number,
      shotType: row.shot_type,
      specialCode: row.special_code,
      variantOfShotNumber: row.variant_of_shot_number,
      episodeCode: row.scene_code?.match(/^(EP\d+)-/)?.[1] ?? null,
      sceneCode: row.scene_code,
      orderIndex: row.order_index,
      title: row.title,
      visualDescription: row.visual_description,
      action: row.action,
      framing: row.framing,
      angle: row.angle,
      movement: row.movement,
      estimatedDurationMs: row.estimated_duration_ms,
      dialogue: row.dialogue,
      imagePrompt: row.image_prompt,
      videoPrompt: row.video_prompt,
      videoTechnical: parseVideoTechnical(row.video_technical_json),
      confidence: 1,
      extractionMethod: "manual",
      sourceMessageIds: row.source_capture_id ? [row.source_capture_id] : [],
      reviewStatus: "approved",
      status: row.status,
      firstFramePath: row.first_frame_path,
      storyboardPaths: (() => {
        try {
          const parsed = JSON.parse(row.storyboard_paths_json) as unknown;
          return Array.isArray(parsed)
            ? parsed.filter(
                (path): path is string => typeof path === "string" && !!path,
              )
            : [];
        } catch {
          return [];
        }
      })(),
      videoPath: row.video_path,
      videoPaths: (() => {
        try {
          const parsed = JSON.parse(row.video_paths_json) as unknown;
          return Array.isArray(parsed)
            ? parsed.filter(
                (path): path is string => typeof path === "string" && !!path,
              )
            : [];
        } catch {
          return row.video_path ? [row.video_path] : [];
        }
      })(),
      storyboardAssetCount: row.storyboard_asset_count,
    })),
    assets: assetRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      role: row.role,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      width: row.width,
      height: row.height,
      durationMs: row.duration_ms,
      relatedShotCode: row.related_shot_code,
      localPath: row.local_path,
      sha256: row.sha256,
      qualitySource: row.quality_source,
      shotCode: row.shot_code,
      orderIndex: row.order_index,
    })),
  };
}

export async function updateShotRecord(shot: ProductionShot) {
  const db = await database();
  if (!db) return;
  const contentFingerprint = compactFingerprint(shotContentValue(shot));
  await db.execute(
    `UPDATE shots SET
       title = $1,
       visual_description = $2,
       action = $3,
       framing = $4,
       angle = $5,
       movement = $6,
       estimated_duration_ms = $7,
       dialogue = $8,
       image_prompt = $9,
       video_prompt = $10,
       video_technical_json = $11,
       status = $12,
       content_fingerprint = $13,
       updated_at = $14
     WHERE id = $15`,
    [
      shot.title,
      shot.visualDescription,
      shot.action,
      shot.framing,
      shot.angle,
      shot.movement,
      shot.estimatedDurationMs,
      shot.dialogue,
      shot.imagePrompt,
      shot.videoPrompt,
      JSON.stringify(shot.videoTechnical),
      shot.status,
      contentFingerprint,
      new Date().toISOString(),
      shot.id,
    ],
  );
}

export async function detachShotMediaRecord(
  shotId: string,
  role: "storyboard" | "first_frame" | "video_final",
) {
  const db = await database();
  if (!db) return;
  await db.execute(
    `INSERT OR IGNORE INTO detached_shot_assets (shot_id, asset_id, role)
     SELECT shot_id, asset_id, role FROM shot_assets
      WHERE shot_id = $1 AND role = $2`,
    [shotId, role],
  );
  await db.execute(
    `DELETE FROM shot_assets WHERE shot_id = $1 AND role = $2`,
    [shotId, role],
  );
  await db.execute(
    `UPDATE shots SET
       status = CASE
         WHEN EXISTS (
           SELECT 1 FROM shot_assets
            WHERE shot_id = $1 AND role = 'first_frame'
         ) THEN 'first_frame'
         WHEN EXISTS (
           SELECT 1 FROM shot_assets
            WHERE shot_id = $1 AND role = 'storyboard'
         ) THEN 'storyboard'
         ELSE 'structured'
       END,
       updated_at = $2
     WHERE id = $1`,
    [shotId, new Date().toISOString()],
  );
}

export async function deleteShotRecord(projectId: string, shotId: string) {
  if (!isTauriRuntime()) return;
  await invoke("delete_shot", { projectId, shotId });
}

export async function createManualShotRecords(
  projectId: string,
  names: string[],
) {
  const db = await database();
  if (!db) return 0;
  const cleanNames = names.map((name) => name.trim()).filter(Boolean);
  if (cleanNames.length === 0) return 0;
  type IdRow = { id: string };
  type NumberRow = { value: number };
  let scene = (
    await db.select<IdRow[]>(
      "SELECT id FROM scenes WHERE project_id = $1 AND code = 'MANUAL' LIMIT 1",
      [projectId],
    )
  )[0];
  const now = new Date().toISOString();
  if (!scene) {
    const sceneId = `manual-scene-${compactFingerprint(projectId)}`;
    const orderRow = (
      await db.select<NumberRow[]>(
        "SELECT COALESCE(MAX(order_index), -1) + 1 AS value FROM scenes WHERE project_id = $1",
        [projectId],
      )
    )[0];
    await db.execute(
      `INSERT INTO scenes (
         id, project_id, source_capture_id, number, code, title, summary,
         script_fragment, location_id, order_index, created_at, updated_at
       ) VALUES ($1, $2, NULL, NULL, 'MANUAL', 'Storyboard manual',
         'Planos agregados manualmente', NULL, NULL, $3, $4, $4)`,
      [sceneId, projectId, orderRow?.value ?? 0, now],
    );
    scene = { id: sceneId };
  }
  const maxRow = (
    await db.select<NumberRow[]>(
      `SELECT COALESCE(MAX(global_number), 0) AS value
       FROM shots WHERE project_id = $1 AND shot_type = 'normal'`,
      [projectId],
    )
  )[0];
  let nextNumber = (maxRow?.value ?? 0) + 1;
  for (const name of cleanNames) {
    const code = `P${String(nextNumber).padStart(3, "0")}`;
    const shotId = crypto.randomUUID();
    const fingerprint = compactFingerprint(
      JSON.stringify([
        name,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ]),
    );
    await db.execute(
      `INSERT INTO shots (
         id, scene_id, project_id, source_capture_id, code, global_number,
         shot_type, special_code, variant_of_shot_id, order_index, title,
         visual_description, action, framing, angle, movement,
         estimated_duration_ms, dialogue, image_prompt, video_prompt, status,
         content_fingerprint, created_at, updated_at
       ) VALUES (
         $1, $2, $3, NULL, $4, $5, 'normal', NULL, NULL, $6, $7,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'incomplete',
         $8, $9, $9
       )`,
      [
        shotId,
        scene.id,
        projectId,
        code,
        nextNumber,
        nextNumber - 1,
        name,
        fingerprint,
        now,
      ],
    );
    nextNumber += 1;
  }
  await publishWorkspaceContext();
  return cleanNames.length;
}
