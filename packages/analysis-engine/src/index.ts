import type {
  AnalysisProposal,
  CaptureEnvelope,
  CaptureMessage,
  DetectedCharacter,
  DetectedCorrection,
  DetectedLocation,
  DetectedLooseItem,
  DetectedPrompt,
  DetectedScene,
  DetectedScript,
  DetectedShot,
} from "@framesync/contracts";

const sceneHeader = /^(?:ESCENA|SCENE)\b\s*(\d+)?\s*(?:[-—:]\s*)?(.+)?$/i;
const codedShotHeader =
  /^((?:E|S)\d{1,3}-(?:P|SH)\d{1,3})\s*(?:[-—:]\s*)?(.+)?$/i;
const plainShotHeader = /^(?:PLANO|SHOT)\s*(\d{1,3})\s*(?:[-—:]\s*)?(.+)?$/i;
const characterHeader = /^(?:PERSONAJE|CHARACTER)\s*:\s*(.+)$/i;
const locationHeader = /^(?:ESCENARIO|LOCACI[ÓO]N|LOCATION)\s*:\s*(.+)$/i;
const imagePromptHeader =
  /^(?:PROMPT\s+DE\s+IMAGEN|IMAGE\s+PROMPT)(?:\s*[-—:]\s*(.+))?$/i;
const videoPromptHeader =
  /^(?:PROMPT\s+DE\s+VIDEO|VIDEO\s+PROMPT)(?:\s*[-—:]\s*(.+))?$/i;
const scriptHeader =
  /^(?:GUI[ÓO]N|SCRIPT)(?:\s+(?:PUBLICITARIO|NARRATIVO|T[ÉE]CNICO|MAESTRO))?(?:\s*[-—:]\s*(.+))?$/i;
const noteHeader = /^(?:NOTA|NOTE)\s*:\s*(.*)$/i;
const correctionPattern =
  /\b(cambi[áa]|cambio|reemplaz[áa]|replace|elimin[áa]|delete|divid[íi]|split)\b/i;
const durationPattern =
  /^(?:DURACI[ÓO]N|DURATION)(?:\s*:\s*(\d+(?:[.,]\d+)?)\s*(?:s|seg|seconds?)?)?$/i;
const movementPattern =
  /^(?:MOVIMIENTO|MOVEMENT|C[ÁA]MARA|CAMERA)\s*:\s*(.+)$/i;
const sceneLocationPattern = /^(?:ESCENARIO|LOCACI[ÓO]N|LOCATION)\s*:\s*(.+)$/i;
const explicitHeaderPattern =
  /^(?:GUI[ÓO]N|SCRIPT|PERSONAJE|CHARACTER|ESCENARIO|LOCACI[ÓO]N|LOCATION|ESCENA|SCENE|PLANO\s*\d+|SHOT\s*\d+|(?:E|S)\d{1,3}-(?:P|SH)\d{1,3}|PROMPT\s+DE\s+(?:IMAGEN|VIDEO)|(?:IMAGE|VIDEO)\s+PROMPT|NOTA|NOTE)\b/i;

type ParsedBlock = {
  message: CaptureMessage;
  text: string;
  lines: string[];
};

function makeId(kind: string, message: CaptureMessage, sequence: number) {
  const safeMessage = message.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${kind}-${safeMessage}-${sequence}`;
}

function compact(value: string | undefined | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function splitBlocks(capture: CaptureEnvelope): ParsedBlock[] {
  return capture.messages.flatMap((message) => {
    const paragraphs = message.text
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n+/)
      .map((paragraph) =>
        paragraph
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      )
      .filter((lines) => lines.length > 0);
    const grouped: ParsedBlock[] = [];
    let current: string[] = [];
    const flush = () => {
      if (current.length === 0) return;
      grouped.push({
        message,
        text: current.join("\n"),
        lines: current,
      });
      current = [];
    };
    for (const lines of paragraphs) {
      for (const line of lines) {
        const sceneLocationMetadata =
          current.length > 0 &&
          sceneHeader.test(current[0] ?? "") &&
          sceneLocationPattern.test(line);
        const startsStructure = explicitHeaderPattern.test(line);
        const extendsStructure =
          current.length > 0 && explicitHeaderPattern.test(current[0] ?? "");
        if (startsStructure && current.length > 0 && !sceneLocationMetadata) {
          flush();
        }
        if (!startsStructure && !extendsStructure && current.length > 0) {
          flush();
        }
        current.push(line);
      }
      if (current.length > 0 && !explicitHeaderPattern.test(current[0] ?? "")) {
        flush();
      }
    }
    flush();
    return grouped;
  });
}

function detectFraming(text: string) {
  const framingTerms = [
    "primerísimo primer plano",
    "primerisimo primer plano",
    "gran plano general",
    "plano general",
    "plano conjunto",
    "plano medio",
    "primer plano",
    "plano detalle",
    "plano cenital",
    "close-up",
    "wide shot",
    "medium shot",
  ];

  return (
    framingTerms.find((term) => text.toLocaleLowerCase("es").includes(term)) ??
    null
  );
}

function detectAngle(text: string) {
  const normalized = text.toLocaleLowerCase("es");
  if (normalized.includes("cenital")) return "cenital";
  if (normalized.includes("contrapicado")) return "contrapicado";
  if (normalized.includes("picado")) return "picado";
  if (normalized.includes("a ras del suelo")) return "ras del suelo";
  return null;
}

function parseDuration(lines: string[]) {
  for (const [index, line] of lines.entries()) {
    const match = line.match(durationPattern);
    const raw = match?.[1];
    if (raw) {
      const seconds = Number.parseFloat(raw.replace(",", "."));
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.round(seconds * 1_000);
      }
    }
    if (match) {
      const range = lines[index + 1]?.match(
        /^(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})$/,
      );
      if (range) {
        const start =
          Number.parseInt(range[1]!, 10) * 60 + Number.parseInt(range[2]!, 10);
        const end =
          Number.parseInt(range[3]!, 10) * 60 + Number.parseInt(range[4]!, 10);
        if (end > start) return (end - start) * 1_000;
      }
    }
  }
  return null;
}

function sectionText(lines: string[], header: RegExp, nextHeaders: RegExp) {
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return null;
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (nextHeaders.test(line)) break;
    values.push(line);
  }
  return compact(values.join(" "));
}

function parseMovement(lines: string[]) {
  for (const line of lines) {
    const match = line.match(movementPattern);
    if (match?.[1]) return match[1].trim();
  }

  const text = lines.join(" ").toLocaleLowerCase("es");
  const knownMovements = [
    "travelling",
    "acercamiento lento",
    "paneo",
    "tilt",
    "cámara en mano",
    "camara en mano",
  ];
  return knownMovements.find((term) => text.includes(term)) ?? null;
}

function sourceLinesWithoutMetadata(lines: string[]) {
  return lines
    .slice(1)
    .filter(
      (line) =>
        !durationPattern.test(line) &&
        !movementPattern.test(line) &&
        !sceneLocationPattern.test(line),
    )
    .join(" ")
    .trim();
}

function proposalSummary(proposal: Omit<AnalysisProposal, "summary">) {
  const entityCount =
    proposal.characters.length +
    proposal.locations.length +
    proposal.scenes.length +
    proposal.shots.length +
    proposal.imagePrompts.length +
    proposal.videoPrompts.length;
  return `${entityCount} elementos estructurados, ${proposal.corrections.length} correcciones y ${proposal.unclassified.length} bloques para revisar.`;
}

export function analyzeCapture(capture: CaptureEnvelope): AnalysisProposal {
  const blocks = splitBlocks(capture);
  const scriptCandidates: DetectedScript[] = [];
  const characters: DetectedCharacter[] = [];
  const locations: DetectedLocation[] = [];
  const scenes: DetectedScene[] = [];
  const shots: DetectedShot[] = [];
  const imagePrompts: DetectedPrompt[] = [];
  const videoPrompts: DetectedPrompt[] = [];
  const corrections: DetectedCorrection[] = [];
  const unclassified: DetectedLooseItem[] = [];
  const warnings: AnalysisProposal["warnings"] = [];

  let currentSceneCode: string | null = null;
  let sequence = 0;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    const firstLine = block.lines[0] ?? "";
    sequence += 1;

    const scriptMatch = firstLine.match(scriptHeader);
    if (scriptMatch) {
      let scriptText = block.lines.slice(1).join("\n").trim();
      const nextBlock = blocks[index + 1];
      if (
        !scriptText &&
        nextBlock &&
        !explicitHeaderPattern.test(nextBlock.lines[0] ?? "")
      ) {
        scriptText = nextBlock.text;
        index += 1;
      }
      if (!scriptText) continue;
      scriptCandidates.push({
        id: makeId("script", block.message, sequence),
        kind: "script",
        title: compact(scriptMatch[1]),
        text: scriptText,
        confidence: 0.98,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      continue;
    }

    const characterMatch = firstLine.match(characterHeader);
    if (characterMatch?.[1]) {
      const description = compact(block.lines.slice(1).join(" "));
      characters.push({
        id: makeId("character", block.message, sequence),
        kind: "character",
        name: characterMatch[1].trim(),
        aliases: [],
        narrativeFunction: null,
        physicalDescription: description,
        wardrobe: null,
        accessories: null,
        attitude: null,
        masterPrompt: null,
        confidence: 0.96,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      continue;
    }

    const locationMatch = firstLine.match(locationHeader);
    if (locationMatch?.[1]) {
      const description = compact(block.lines.slice(1).join(" "));
      locations.push({
        id: makeId("location", block.message, sequence),
        kind: "location",
        name: locationMatch[1].trim(),
        description,
        atmosphere: null,
        lighting: null,
        permanentElements: [],
        timeOfDay: null,
        weather: null,
        masterPrompt: null,
        confidence: 0.96,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      continue;
    }

    const sceneMatch = firstLine.match(sceneHeader);
    if (sceneMatch && /^(?:ESCENA|SCENE)\b/i.test(firstLine)) {
      const sceneNumber = sceneMatch[1]
        ? Number.parseInt(sceneMatch[1], 10)
        : null;
      currentSceneCode = sceneNumber
        ? `E${String(sceneNumber).padStart(2, "0")}`
        : null;
      const body = block.lines.slice(1);
      const locationLine = body.find((line) => sceneLocationPattern.test(line));
      const locationName = locationLine?.match(sceneLocationPattern)?.[1];
      const scriptFragment = body
        .filter((line) => !sceneLocationPattern.test(line))
        .join(" ")
        .trim();
      scenes.push({
        id: makeId("scene", block.message, sequence),
        kind: "scene",
        number: sceneNumber,
        code: currentSceneCode,
        title: compact(sceneMatch[2]) ?? `Escena ${scenes.length + 1}`,
        summary: compact(scriptFragment),
        scriptFragment: compact(scriptFragment),
        locationName: compact(locationName),
        orderIndex: scenes.length,
        confidence: sceneNumber ? 0.98 : 0.88,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      continue;
    }

    const codedShotMatch = firstLine.match(codedShotHeader);
    const plainShotMatch = firstLine.match(plainShotHeader);
    if (codedShotMatch?.[1] || plainShotMatch?.[1]) {
      const plainShotNumber = plainShotMatch?.[1]
        ? Number.parseInt(plainShotMatch[1], 10)
        : null;
      if (!currentSceneCode && plainShotNumber) {
        currentSceneCode = "E01";
        scenes.push({
          id: makeId("scene", block.message, sequence),
          kind: "scene",
          number: 1,
          code: currentSceneCode,
          title: "Storyboard importado",
          summary:
            "Escena creada para organizar planos numerados sin escena explícita.",
          scriptFragment: null,
          locationName: null,
          orderIndex: scenes.length,
          confidence: 0.78,
          extractionMethod: "inferred",
          sourceMessageIds: [block.message.id],
          reviewStatus: "needs_review",
        });
      }
      const code: string = codedShotMatch?.[1]
        ? codedShotMatch[1].toUpperCase()
        : `${currentSceneCode ?? "E01"}-P${String(plainShotNumber).padStart(2, "0")}`;
      const sceneCodeFromShot: string | null =
        code.match(/^((?:E|S)\d{1,3})-/i)?.[1]?.toUpperCase() ?? null;
      currentSceneCode = sceneCodeFromShot ?? currentSceneCode;
      const sourceText = sourceLinesWithoutMetadata(block.lines);
      const fieldHeader =
        /^(?:DURACI[ÓO]N|TIPO DE PLANO|C[ÁA]MARA|PRIMER FRAME|PROMPT PARA GENERAR|MOVIMIENTO DEL VIDEO|SONIDO|TRANSICI[ÓO]N|TEXTO|VOZ EN OFF)\b/i;
      const imagePrompt = sectionText(
        block.lines,
        /^PROMPT PARA GENERAR (?:EL )?PRIMER FRAME$/i,
        fieldHeader,
      );
      const videoPrompt = sectionText(
        block.lines,
        /^MOVIMIENTO DEL VIDEO$/i,
        fieldHeader,
      );
      shots.push({
        id: makeId("shot", block.message, sequence),
        kind: "shot",
        code,
        sceneCode: currentSceneCode,
        orderIndex: shots.length,
        title: compact(codedShotMatch?.[2] ?? plainShotMatch?.[2]) ?? code,
        visualDescription: compact(sourceText),
        action: compact(sourceText),
        framing: detectFraming(sourceText),
        angle: detectAngle(sourceText),
        movement: parseMovement(block.lines),
        estimatedDurationMs: parseDuration(block.lines),
        dialogue: compact(sourceText.match(/["“](.+?)["”]/)?.[1]) ?? null,
        imagePrompt,
        videoPrompt,
        confidence: 0.99,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      continue;
    }

    const imagePromptMatch = firstLine.match(imagePromptHeader);
    if (imagePromptMatch) {
      imagePrompts.push({
        id: makeId("image-prompt", block.message, sequence),
        kind: "image_prompt",
        title: compact(imagePromptMatch[1]),
        text: block.lines.slice(1).join("\n").trim(),
        relatedShotCode: compact(
          imagePromptMatch[1]?.match(/(?:E|S)\d{1,3}-(?:P|SH)\d{1,3}/i)?.[0],
        ),
        confidence: 0.99,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      continue;
    }

    const videoPromptMatch = firstLine.match(videoPromptHeader);
    if (videoPromptMatch) {
      videoPrompts.push({
        id: makeId("video-prompt", block.message, sequence),
        kind: "video_prompt",
        title: compact(videoPromptMatch[1]),
        text: block.lines.slice(1).join("\n").trim(),
        relatedShotCode: compact(
          videoPromptMatch[1]?.match(/(?:E|S)\d{1,3}-(?:P|SH)\d{1,3}/i)?.[0],
        ),
        confidence: 0.99,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      continue;
    }

    const noteMatch = firstLine.match(noteHeader);
    if (noteMatch) {
      unclassified.push({
        id: makeId("note", block.message, sequence),
        kind: "note",
        title: "Nota",
        text: [noteMatch[1], ...block.lines.slice(1)]
          .filter(Boolean)
          .join(" ")
          .trim(),
        confidence: 0.99,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      continue;
    }

    if (correctionPattern.test(block.text)) {
      const targetReference =
        block.text.match(/(?:E|S)\d{1,3}-(?:P|SH)\d{1,3}/i)?.[0] ?? null;
      corrections.push({
        id: makeId("correction", block.message, sequence),
        kind: "correction",
        targetReference: compact(targetReference)?.toUpperCase() ?? null,
        instruction: block.text,
        confidence: targetReference ? 0.94 : 0.72,
        extractionMethod: "rule",
        sourceMessageIds: [block.message.id],
        reviewStatus: "needs_review",
      });
      continue;
    }

    unclassified.push({
      id: makeId("unclassified", block.message, sequence),
      kind: "unclassified",
      title: null,
      text: block.text,
      confidence: 0.35,
      extractionMethod: "inferred",
      sourceMessageIds: [block.message.id],
      reviewStatus: "needs_review",
    });
  }

  const duplicateShotCodes = new Set<string>();
  const seenShotCodes = new Set<string>();
  for (const shot of shots) {
    if (!shot.code) continue;
    if (seenShotCodes.has(shot.code)) duplicateShotCodes.add(shot.code);
    seenShotCodes.add(shot.code);
  }
  for (const code of duplicateShotCodes) {
    warnings.push({
      code: "DUPLICATE_SHOT_CODE",
      message: `El código ${code} aparece más de una vez y necesita revisión.`,
      sourceMessageIds: shots
        .filter((shot) => shot.code === code)
        .flatMap((shot) => shot.sourceMessageIds),
    });
  }

  if (shots.some((shot) => !shot.estimatedDurationMs)) {
    warnings.push({
      code: "MISSING_DURATION",
      message:
        "Hay planos sin duración. FrameSync conserva el campo vacío y no inventa un valor.",
      sourceMessageIds: shots
        .filter((shot) => !shot.estimatedDurationMs)
        .flatMap((shot) => shot.sourceMessageIds),
    });
  }

  const resultWithoutSummary = {
    scriptCandidates,
    characters,
    locations,
    scenes,
    shots,
    imagePrompts,
    videoPrompts,
    corrections,
    unclassified,
    warnings,
  };

  return {
    summary: proposalSummary(resultWithoutSummary),
    ...resultWithoutSummary,
  };
}
