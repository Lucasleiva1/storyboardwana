import {
  AnalysisProposalSchema,
  CaptureEnvelopeSchema,
  type AnalysisProposal,
  type CaptureEnvelope,
  type WorkspaceProjectSummary,
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

type WorkspaceProjectRow = {
  id: string;
  project_number: number;
  name: string;
  description: string | null;
  updated_at: string;
  episode_count: number;
  scene_count: number;
  shot_count: number;
  special_shot_count: number;
  last_episode_number: number | null;
  last_scene_number: number | null;
  last_shot_number: number | null;
};

export async function publishWorkspaceContext() {
  const db = await database();
  if (!db || !isTauriRuntime()) return;
  const rows = await db.select<WorkspaceProjectRow[]>(
    `SELECT
       project.id,
       project.project_number,
       project.name,
       project.description,
       project.updated_at,
       (SELECT COUNT(*) FROM episodes episode WHERE episode.project_id = project.id) AS episode_count,
       (SELECT COUNT(*) FROM scenes scene WHERE scene.project_id = project.id) AS scene_count,
       (SELECT COUNT(*) FROM shots shot WHERE shot.project_id = project.id AND shot.shot_type = 'normal') AS shot_count,
       (SELECT COUNT(*) FROM shots shot WHERE shot.project_id = project.id AND shot.shot_type = 'special') AS special_shot_count,
       (SELECT MAX(episode.number) FROM episodes episode WHERE episode.project_id = project.id) AS last_episode_number,
       (SELECT MAX(scene.number) FROM scenes scene WHERE scene.project_id = project.id) AS last_scene_number,
       (SELECT MAX(shot.global_number) FROM shots shot WHERE shot.project_id = project.id AND shot.shot_type = 'normal') AS last_shot_number
     FROM projects project
     ORDER BY project.updated_at DESC`,
  );
  const projects: WorkspaceProjectSummary[] = rows.map((row) => {
    const lastShotNumber = row.last_shot_number ?? 0;
    return {
      id: row.id,
      projectNumber: row.project_number,
      name: row.name,
      description: row.description,
      episodeCount: row.episode_count,
      sceneCount: row.scene_count,
      shotCount: row.shot_count,
      specialShotCount: row.special_shot_count,
      lastEpisodeNumber: row.last_episode_number,
      lastSceneNumber: row.last_scene_number,
      lastShotNumber,
      nextShotNumber: lastShotNumber + 1,
      updatedAt: row.updated_at,
    };
  });
  await invoke("write_workspace_context", {
    context: {
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      projects,
    },
  });
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
       ON CONFLICT(id) DO NOTHING`,
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
         ON CONFLICT(id) DO NOTHING`,
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
         SELECT shot.id, stored_asset.id, $1, 0
         FROM shots shot
         JOIN assets stored_asset ON stored_asset.sha256 = $2
         WHERE shot.project_id = $3 AND shot.code = $4`,
        [asset.role, asset.sha256, projectId, asset.relatedShotCode],
      );
    }
  }
  await db.execute(
    `INSERT OR IGNORE INTO shot_assets (shot_id, asset_id, role, order_index)
     SELECT shot.id, asset.id, asset.role, 0
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
  for (const item of proposalItems(proposal)) {
    await db.execute(
      "UPDATE detected_items SET review_status = $1, payload_json = $2 WHERE id = $3",
      [item.reviewStatus, JSON.stringify(item), item.id],
    );
  }
  await db.execute("UPDATE capture_sources SET status = $1 WHERE id = $2", [
    status,
    captureId,
  ]);
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
  ]);
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

export async function importApproved(
  projectId: string,
  captureId: string,
  proposal: AnalysisProposal,
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
      item.reviewStatus === "approved" ||
      (item.reviewStatus !== "rejected" &&
        Boolean(item.code && requiredSceneCodes.has(item.code))),
  );

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
        item.id,
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
        item.id,
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
        `SELECT id, content_fingerprint, title, visual_description, action,
                framing, angle, movement, estimated_duration_ms, dialogue,
                image_prompt, video_prompt
         FROM shots
         WHERE project_id = $1 AND shot_type = 'normal' AND global_number = $2`,
        [projectId, globalNumber],
      );
      const existing = existingRows[0];
      if (existing) {
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

    const shotId = item.id;
    await db.execute(
      `INSERT INTO shots (
         id, project_id, scene_id, source_capture_id, code, global_number,
         shot_type, special_code, variant_of_shot_id, content_fingerprint,
         order_index, title, visual_description, action, framing, angle,
         movement, estimated_duration_ms, dialogue, image_prompt, video_prompt,
         status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, 'structured', $22, $22
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

  await db.execute(
    `INSERT OR IGNORE INTO shot_assets (shot_id, asset_id, role, order_index)
     SELECT shot.id, asset.id, asset.role, 0
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
  status: ProductionShot["status"];
  source_capture_id: string | null;
  first_frame_path: string | null;
  video_path: string | null;
  storyboard_asset_count: number;
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
    };
  }
  const [
    scriptRows,
    characterRows,
    locationRows,
    episodeRows,
    sceneRows,
    shotRows,
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
                shot.dialogue, shot.image_prompt, shot.video_prompt, shot.status,
                shot.source_capture_id,
                (
                  SELECT asset.local_path
                  FROM shot_assets link
                  JOIN assets asset ON asset.id = link.asset_id
                  WHERE link.shot_id = shot.id AND link.role = 'first_frame'
                  ORDER BY link.order_index LIMIT 1
                ) AS first_frame_path,
                (
                  SELECT asset.local_path
                  FROM shot_assets link
                  JOIN assets asset ON asset.id = link.asset_id
                  WHERE link.shot_id = shot.id AND link.role = 'video_final'
                  ORDER BY link.order_index LIMIT 1
                ) AS video_path,
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
      confidence: 1,
      extractionMethod: "manual",
      sourceMessageIds: row.source_capture_id ? [row.source_capture_id] : [],
      reviewStatus: "approved",
      status: row.status,
      firstFramePath: row.first_frame_path,
      videoPath: row.video_path,
      storyboardAssetCount: row.storyboard_asset_count,
    })),
  };
}

export async function updateShotRecord(shot: ProductionShot) {
  const db = await database();
  if (!db) return;
  await db.execute(
    `UPDATE shots SET
       title = $1,
       visual_description = $2,
       framing = $3,
       movement = $4,
       estimated_duration_ms = $5,
       status = $6,
       updated_at = $7
     WHERE id = $8`,
    [
      shot.title,
      shot.visualDescription,
      shot.framing,
      shot.movement,
      shot.estimatedDurationMs,
      shot.status,
      new Date().toISOString(),
      shot.id,
    ],
  );
}
