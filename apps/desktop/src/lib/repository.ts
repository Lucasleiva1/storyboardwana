import {
  AnalysisProposalSchema,
  CaptureEnvelopeSchema,
  type AnalysisProposal,
  type CaptureEnvelope,
} from "@framesync/contracts";
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
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

let databasePromise: Promise<DatabaseType | null> | null = null;

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
    "SELECT id, name, description, created_at, updated_at FROM projects ORDER BY updated_at DESC",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function saveProject(project: Project) {
  const db = await database();
  if (!db) return;
  await db.execute(
    `INSERT INTO projects (id, name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       updated_at = excluded.updated_at`,
    [
      project.id,
      project.name,
      project.description,
      project.createdAt,
      project.updatedAt,
    ],
  );
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

export async function saveCapture(projectId: string, capture: CaptureEnvelope) {
  const db = await database();
  if (!db) return;
  const rawText = capture.messages
    .map((message) => `[${message.role}]\n${message.text}`)
    .join("\n\n");
  const now = new Date().toISOString();
  await db.execute("BEGIN IMMEDIATE");
  try {
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
    await db.execute("COMMIT");
  } catch (error) {
    await db.execute("ROLLBACK");
    throw error;
  }
}

function proposalItems(proposal: AnalysisProposal) {
  return [
    ...proposal.scriptCandidates,
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
  await db.execute("BEGIN IMMEDIATE");
  try {
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
    await db.execute("COMMIT");
  } catch (error) {
    await db.execute("ROLLBACK");
    throw error;
  }
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

export async function importApproved(
  projectId: string,
  captureId: string,
  proposal: AnalysisProposal,
) {
  const db = await database();
  if (!db) return;
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
  const approvedScenes = proposal.scenes.filter(
    (item) => item.reviewStatus === "approved",
  );
  const approvedShots = proposal.shots.filter(
    (item) => item.reviewStatus === "approved",
  );

  await db.execute("BEGIN IMMEDIATE");
  try {
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

    for (const item of approvedScenes) {
      const matchingLocation = approvedLocations.find(
        (location) => location.name === item.locationName,
      );
      await db.execute(
        `INSERT INTO scenes (
           id, project_id, source_capture_id, number, code, title, summary,
           script_fragment, location_id, order_index, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         ON CONFLICT(project_id, code) DO UPDATE SET
           title = excluded.title,
           summary = excluded.summary,
           script_fragment = excluded.script_fragment,
           location_id = excluded.location_id,
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
          item.scriptFragment,
          matchingLocation?.id ?? null,
          item.orderIndex,
          now,
        ],
      );
    }

    for (const item of approvedShots) {
      const matchingScene = approvedScenes.find(
        (scene) => scene.code === item.sceneCode,
      );
      if (!matchingScene) continue;
      await db.execute(
        `INSERT INTO shots (
           id, scene_id, source_capture_id, code, order_index, title,
           visual_description, action, framing, angle, movement,
           estimated_duration_ms, dialogue, image_prompt, video_prompt,
           status, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, 'structured', $16, $16
         )
         ON CONFLICT(scene_id, code) DO UPDATE SET
           title = excluded.title,
           visual_description = excluded.visual_description,
           action = excluded.action,
           framing = excluded.framing,
           angle = excluded.angle,
           movement = excluded.movement,
           estimated_duration_ms = excluded.estimated_duration_ms,
           dialogue = excluded.dialogue,
           image_prompt = excluded.image_prompt,
           video_prompt = excluded.video_prompt,
           updated_at = excluded.updated_at`,
        [
          item.id,
          matchingScene.id,
          captureId,
          item.code,
          item.orderIndex,
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
    }

    await db.execute(
      "UPDATE capture_sources SET status = 'imported' WHERE id = $1",
      [captureId],
    );
    await db.execute("COMMIT");
  } catch (error) {
    await db.execute("ROLLBACK");
    throw error;
  }
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
  order_index: number;
  source_capture_id: string | null;
};
type ShotRow = {
  id: string;
  code: string | null;
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
      scenes: [],
      shots: [],
    };
  }
  const [scriptRows, characterRows, locationRows, sceneRows, shotRows] =
    await Promise.all([
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
      db.select<SceneRow[]>(
        `SELECT scene.id, scene.number, scene.code, scene.title, scene.summary,
                scene.script_fragment, location.canonical_name,
                scene.order_index, scene.source_capture_id
         FROM scenes scene
         LEFT JOIN locations location ON location.id = scene.location_id
         WHERE scene.project_id = $1
         ORDER BY scene.order_index`,
        [projectId],
      ),
      db.select<ShotRow[]>(
        `SELECT shot.id, shot.code, scene.code AS scene_code, shot.order_index,
                shot.title, shot.visual_description, shot.action, shot.framing,
                shot.angle, shot.movement, shot.estimated_duration_ms,
                shot.dialogue, shot.image_prompt, shot.video_prompt, shot.status,
                shot.source_capture_id
         FROM shots shot
         JOIN scenes scene ON scene.id = shot.scene_id
         WHERE scene.project_id = $1
         ORDER BY scene.order_index, shot.order_index`,
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
    scenes: sceneRows.map((row) => ({
      id: row.id,
      kind: "scene",
      number: row.number,
      code: row.code,
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
