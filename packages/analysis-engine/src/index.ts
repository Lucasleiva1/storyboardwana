import type {
  AnalysisProposal,
  CaptureEnvelope,
  CaptureMessage,
  DetectedCharacter,
  DetectedCorrection,
  DetectedEpisode,
  DetectedLocation,
  DetectedLooseItem,
  DetectedPrompt,
  DetectedScene,
  DetectedScript,
  DetectedShot,
  VideoTechnical,
} from "@framesync/contracts";

const sceneHeader = /^(?:ESCENA|SCENE)\b\s*(\d+)?\s*(?:[-—:]\s*)?(.+)?$/i;
const episodeHeader = /^(?:EPISODIO|EPISODE)\b\s*(\d+)?\s*(?:[-—:]\s*)?(.+)?$/i;
const codedShotHeader =
  /^((?:E|S)\d{1,3}-(?:P|SH)\d{1,3})\s*(?:[-—:]\s*)?(.+)?$/i;
const directShotHeader = /^((?:P|SH)\d{1,4})\s*(?:[-—:]\s*)?(.+)?$/i;
const plainShotHeader = /^(?:PLANO|SHOT)\s*(\d{1,3})\s*(?:[-—:]\s*)?(.+)?$/i;
const specialShotHeader =
  /^(?:PLANO|SHOT)\s+(?:ESPECIAL|SPECIAL)(?:\s+((?:ESP|SPECIAL)-?\d+))?\s*(?:[-—:]\s*)?(.+)?$/i;
const variantShotHeader =
  /^(?:VARIANTE|VARIANT)\s+(?:DE|OF)\s+(?:PLANO\s+)?(?:P|SH)?(\d{1,4})\s*(?:[-—:]\s*)?(.+)?$/i;
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
  /^(?:GUI[ÓO]N|SCRIPT|PERSONAJE(?=\s*:)|CHARACTER(?=\s*:)|ESCENARIO|LOCACI[ÓO]N|LOCATION|EPISODIO|EPISODE|ESCENA|SCENE|PLANO\s+(?:\d+|ESPECIAL)|SHOT\s+(?:\d+|SPECIAL)|(?:P|SH)\d{1,4}|(?:E|S)\d{1,3}-(?:P|SH)\d{1,3}|VARIANTE|VARIANT|PROMPT\s+DE\s+(?:IMAGEN|VIDEO)|(?:IMAGE|VIDEO)\s+PROMPT|NOTA|NOTE)\b/i;
const mediaFilenamePattern =
  /\b(?:P|SH)\d{1,4}_(?:PRIMER_FRAME|FIRST_FRAME|STORYBOARD|VIDEO(?:_V\d{1,3})?|LAST_FRAME)\.(?:png|jpe?g|webp|gif|mp4|mov|webm|avi|mkv)/i;
const structuralTemplatePattern =
  /^(?:EPISODIO|EPISODE|ESCENA|SCENE)\s+(?:N|X|#)\b/i;
const shotTitlePlaceholderPattern =
  /^(?:t[ií]tulo(?:\s+del\s+plano)?|shot\s+title|nombre(?:\s+del\s+plano)?)$/i;
const framesyncStartMarker = "INICIO_CONTENIDO_FRAMESYNC";
const framesyncEndMarker = "FIN_CONTENIDO_FRAMESYNC";
const declaredShotCountPattern = /^TOTAL_PLANOS_A_CARGAR\s*:\s*(\d{1,4})\s*$/im;
const declaredShotRangePattern =
  /^RANGO_PLANOS_A_CARGAR\s*:\s*(?:P|SH)?(\d{1,4})\s*[-–—]\s*(?:P|SH)?(\d{1,4})\s*$/im;

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

function videoPromptOnly(value: string | undefined | null) {
  const prompt = value?.trim();
  if (!prompt) return null;
  return compact(prompt.replace(/\s*---\s*P[ÁA]GINA\s+\d+\s*---[\s\S]*$/i, ""));
}

function technicalMessageText(message: CaptureMessage) {
  const start = message.text.indexOf(framesyncStartMarker);
  if (start < 0) return message.text;
  const contentStart = start + framesyncStartMarker.length;
  const end = message.text.indexOf(framesyncEndMarker, contentStart);
  return message.text.slice(contentStart, end < 0 ? undefined : end).trim();
}

function shotMatchTitle(...matches: Array<RegExpMatchArray | null>) {
  for (const match of matches) {
    const title = compact(match?.[2]);
    if (title) return title;
  }
  return null;
}

function isSubstantiveShotBlock(block: ParsedBlock, title: string | null) {
  if (mediaFilenamePattern.test(block.lines[0] ?? "")) return false;
  const normalizedTitle = title?.replace(/[.…]+$/g, "").trim();
  if (normalizedTitle && shotTitlePlaceholderPattern.test(normalizedTitle)) {
    return false;
  }
  if (normalizedTitle) return true;

  const bodyLines = block.lines.slice(1);
  const hasTechnicalFields = bodyLines.some((line) =>
    /^(?:DESCRIPCI[ÓO]N VISUAL|ACCI[ÓO]N|TIPO DE PLANO|ENCUADRE|[ÁA]NGULO|MOVIMIENTO|DURACI[ÓO]N|DI[ÁA]LOGO|CONTINUIDAD|PRIMER FRAME|PROMPT(?: PARA GENERAR)?|VIDEO|STORYBOARD)\b/i.test(
      line,
    ),
  );
  if (!hasTechnicalFields) return false;

  const body = bodyLines
    .join(" ")
    .replace(
      /\b(?:DESCRIPCI[ÓO]N VISUAL|ACCI[ÓO]N|TIPO DE PLANO|ENCUADRE|[ÁA]NGULO|MOVIMIENTO|DURACI[ÓO]N|DI[ÁA]LOGO|PRIMER FRAME|PROMPT(?: PARA GENERAR)?|VIDEO|STORYBOARD)\b\s*:?\s*/gi,
      " ",
    )
    .replace(/(?:\.{2,}|…)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

  return body.length >= 12;
}

function canonicalShotReference(value: string | undefined | null) {
  if (!value) return null;
  const match = value.match(/(?:(?:E|S)\d{1,3}-)?(?:P|SH)(\d{1,4})/i);
  if (!match?.[1]) return null;
  return `P${String(Number.parseInt(match[1], 10)).padStart(3, "0")}`;
}

function splitBlocks(capture: CaptureEnvelope): ParsedBlock[] {
  return capture.messages.flatMap((message) => {
    const paragraphs = technicalMessageText(message)
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
    "plano aéreo",
    "plano aereo",
    "plano americano",
    "plano entero",
    "plano subjetivo",
    "plano secuencia",
    "macro cinematográfico",
    "macro cinematografico",
    "close-up",
    "wide shot",
    "medium shot",
  ];

  return (
    framingTerms.find((term) => text.toLocaleLowerCase("es").includes(term)) ??
    null
  );
}

const shotVideoFieldBoundary =
  /^(?:TIEMPO DE MONTAJE|DURACI[ÓO]N|PERSONAJES?|UBICACI[ÓO]N|VESTUARIO|(?:VIDEO\s*[-—:]?\s*)?C[ÁA]MARA|(?:VIDEO\s*[-—:]?\s*)?(?:LENTE|[ÓO]PTICA)|(?:VIDEO\s*[-—:]?\s*)?TIPO DE PLANO|(?:VIDEO\s*[-—:]?\s*)?[ÁA]NGULO|(?:VIDEO\s*[-—:]?\s*)?MOVIMIENTO|(?:VIDEO\s*[-—:]?\s*)?ILUMINACI[ÓO]N|(?:VIDEO\s*[-—:]?\s*)?EFECTOS|(?:VIDEO\s*[-—:]?\s*)?TRANSICI[ÓO]N|(?:VIDEO\s*[-—:]?\s*)?INICIO|(?:VIDEO\s*[-—:]?\s*)?(?:DESARROLLO|PROGRESI[ÓO]N)|(?:VIDEO\s*[-—:]?\s*)?FINAL|CONTINUIDAD|CADENCIA|FPS|MUNDO ROXWANA|PRIMER FRAME|STORYBOARD|PROMPT DE VIDEO|MOVIMIENTO DEL VIDEO|--- PAGINA|•\s*•\s*•)\b/i;

function labeledShotSection(lines: string[], label: RegExp) {
  const start = lines.findIndex((line) => {
    const match = line.match(label);
    const inlineValue = match?.[1]?.trim();
    return Boolean(match && !inlineValue?.match(/^[.,;]/));
  });
  if (start < 0) return null;
  const firstMatch = lines[start]!.match(label);
  const values = [compact(firstMatch?.[1])].filter((value): value is string =>
    Boolean(value),
  );
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (shotVideoFieldBoundary.test(line)) break;
    values.push(line);
  }
  return compact(values.join(" "));
}

function detectLens(camera: string | null, explicitLens: string | null) {
  if (explicitLens) return explicitLens;
  if (!camera) return null;
  const labeled = camera.match(
    /\blente\s+([^.;]+?)(?=(?:\.|;|,\s*(?:travelling|slider|movimiento|paneo|dolly|zoom|retroceso|descenso|ascenso))|$)/i,
  )?.[1];
  if (labeled) return compact(labeled);
  const focal = camera.match(
    /\b((?:equivalente\s+a\s+)?\d{1,3}\s*mm(?:\s+anam[óo]rfico)?|split-diopter|fisheye|macro\s+perisc[óo]pico)\b/i,
  )?.[1];
  return compact(focal);
}

function detectVideoMovement(camera: string | null, explicit: string | null) {
  if (explicit) return explicit;
  if (!camera) return null;
  const movement = camera.match(
    /\b((?:travelling|slider|movimiento|paneo|tilt|dolly|zoom|retroceso|descenso|ascenso|acercamiento|alejamiento|rack focus)[^.;]*)/i,
  )?.[1];
  return compact(movement);
}

function extractVideoTechnical(
  lines: string[],
  videoPrompt: string | null,
): VideoTechnical {
  const legacyEnd = lines.findIndex((line) =>
    /^(?:PRIMER FRAME|STORYBOARD|PROMPT DE VIDEO|MOVIMIENTO DEL VIDEO)\b/i.test(
      line,
    ),
  );
  const legacyLines = lines.slice(0, legacyEnd < 0 ? lines.length : legacyEnd);
  const technicalSection = (explicit: RegExp, legacy?: RegExp) =>
    labeledShotSection(lines, explicit) ??
    (legacy ? labeledShotSection(legacyLines, legacy) : null);
  const camera = technicalSection(
    /^VIDEO\s*[-—:]?\s*C[ÁA]MARA\s*:?[\s]*(.*)$/i,
    /^C[ÁA]MARA\s*:?[\s]*(.*)$/i,
  );
  const explicitLens = technicalSection(
    /^VIDEO\s*[-—:]?\s*(?:LENTE|[ÓO]PTICA)\s*:?[\s]*(.*)$/i,
    /^(?:LENTE|[ÓO]PTICA)\s*:?[\s]*(.*)$/i,
  );
  const explicitShotType = technicalSection(
    /^VIDEO\s*[-—:]?\s*TIPO DE PLANO\s*:?[\s]*(.*)$/i,
  );
  const explicitAngle = technicalSection(
    /^VIDEO\s*[-—:]?\s*[ÁA]NGULO\s*:?[\s]*(.*)$/i,
  );
  const explicitMovement = technicalSection(
    /^VIDEO\s*[-—:]?\s*MOVIMIENTO(?:\s+DE\s+C[ÁA]MARA)?\s*:?[\s]*(.*)$/i,
  );
  return {
    camera,
    lens: detectLens(camera, explicitLens),
    shotType:
      explicitShotType ??
      detectFraming([videoPrompt, camera].filter(Boolean).join(" ")),
    angle:
      explicitAngle ??
      detectAngle([videoPrompt, camera].filter(Boolean).join(" ")),
    movement: detectVideoMovement(camera, explicitMovement),
    lighting: technicalSection(
      /^VIDEO\s*[-—:]?\s*ILUMINACI[ÓO]N\s*:?[\s]*(.*)$/i,
      /^ILUMINACI[ÓO]N\s*:?[\s]*(.*)$/i,
    ),
    effects: technicalSection(
      /^VIDEO\s*[-—:]?\s*EFECTOS(?:\s+VISUALES)?\s*:?[\s]*(.*)$/i,
      /^EFECTOS(?:\s+VISUALES)?\s*:?[\s]*(.*)$/i,
    ),
    transition: technicalSection(
      /^VIDEO\s*[-—:]?\s*TRANSICI[ÓO]N\s*:?[\s]*(.*)$/i,
      /^TRANSICI[ÓO]N\s*:?[\s]*(.*)$/i,
    ),
    start: technicalSection(
      /^VIDEO\s*[-—:]?\s*INICIO(?:\s+DEL\s+VIDEO)?\s*:?[\s]*(.*)$/i,
    ),
    development: technicalSection(
      /^VIDEO\s*[-—:]?\s*(?:DESARROLLO|PROGRESI[ÓO]N)(?:\s+DEL\s+VIDEO)?\s*:?[\s]*(.*)$/i,
    ),
    end: technicalSection(
      /^VIDEO\s*[-—:]?\s*FINAL(?:\s+DEL\s+VIDEO)?\s*:?[\s]*(.*)$/i,
    ),
    continuity: technicalSection(
      /^VIDEO\s*[-—:]?\s*CONTINUIDAD\s*:?[\s]*(.*)$/i,
    ),
    frameRate: technicalSection(
      /^VIDEO\s*[-—:]?\s*(?:CADENCIA|FPS|FRAME RATE)\s*:?[\s]*(.*)$/i,
    ),
  };
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
    proposal.episodes.length +
    proposal.scenes.length +
    proposal.shots.length +
    proposal.imagePrompts.length +
    proposal.videoPrompts.length;
  return `${entityCount} elementos estructurados, ${proposal.corrections.length} correcciones y ${proposal.unclassified.length} bloques para revisar.`;
}

export function analyzeCapture(capture: CaptureEnvelope): AnalysisProposal {
  const blocks = splitBlocks(capture);
  const scriptCandidates: DetectedScript[] = [];
  const episodes: DetectedEpisode[] = [];
  const characters: DetectedCharacter[] = [];
  const locations: DetectedLocation[] = [];
  const scenes: DetectedScene[] = [];
  const shots: DetectedShot[] = [];
  const imagePrompts: DetectedPrompt[] = [];
  const videoPrompts: DetectedPrompt[] = [];
  const corrections: DetectedCorrection[] = [];
  const unclassified: DetectedLooseItem[] = [];
  const warnings: AnalysisProposal["warnings"] = [];

  let currentEpisodeCode: string | null = null;
  let currentSceneCode: string | null = null;
  let currentShotCode: string | null = null;
  let sequence = 0;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    const firstLine = block.lines[0] ?? "";
    sequence += 1;

    if (
      declaredShotCountPattern.test(firstLine) ||
      declaredShotRangePattern.test(firstLine)
    ) {
      continue;
    }

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

    const episodeMatch = firstLine.match(episodeHeader);
    if (
      episodeMatch &&
      /^(?:EPISODIO|EPISODE)\b/i.test(firstLine) &&
      !structuralTemplatePattern.test(firstLine)
    ) {
      const episodeNumber = episodeMatch[1]
        ? Number.parseInt(episodeMatch[1], 10)
        : episodes.length + 1;
      currentEpisodeCode = `EP${String(episodeNumber).padStart(2, "0")}`;
      episodes.push({
        id: makeId("episode", block.message, sequence),
        kind: "episode",
        number: episodeNumber,
        code: currentEpisodeCode,
        title: compact(episodeMatch[2]) ?? `Episodio ${String(episodeNumber)}`,
        summary: compact(block.lines.slice(1).join(" ")),
        orderIndex: episodes.length,
        confidence: episodeMatch[1] ? 0.99 : 0.88,
        extractionMethod: episodeMatch[1] ? "explicit" : "inferred",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      continue;
    }

    const sceneMatch = firstLine.match(sceneHeader);
    if (
      sceneMatch &&
      /^(?:ESCENA|SCENE)\b/i.test(firstLine) &&
      !structuralTemplatePattern.test(firstLine)
    ) {
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
        episodeCode: currentEpisodeCode,
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

    const specialShotMatch = firstLine.match(specialShotHeader);
    const variantShotMatch = firstLine.match(variantShotHeader);
    const codedShotMatch = firstLine.match(codedShotHeader);
    const directShotMatch = firstLine.match(directShotHeader);
    const plainShotMatch = firstLine.match(plainShotHeader);
    const candidateShotTitle = shotMatchTitle(
      specialShotMatch,
      variantShotMatch,
      codedShotMatch,
      directShotMatch,
      plainShotMatch,
    );
    if (
      (specialShotMatch ||
        variantShotMatch?.[1] ||
        codedShotMatch?.[1] ||
        directShotMatch?.[1] ||
        plainShotMatch?.[1]) &&
      isSubstantiveShotBlock(block, candidateShotTitle)
    ) {
      const plainShotNumber = plainShotMatch?.[1]
        ? Number.parseInt(plainShotMatch[1], 10)
        : null;
      const directShotNumber = directShotMatch?.[1]
        ? Number.parseInt(directShotMatch[1].replace(/\D/g, ""), 10)
        : null;
      const codedShotNumber = codedShotMatch?.[1]
        ? Number.parseInt(
            codedShotMatch[1].match(/(?:P|SH)(\d+)/i)?.[1] ?? "",
            10,
          )
        : null;
      const variantOfShotNumber = variantShotMatch?.[1]
        ? Number.parseInt(variantShotMatch[1], 10)
        : null;
      const globalNumber =
        directShotNumber ?? codedShotNumber ?? plainShotNumber;
      if (!currentSceneCode) {
        currentSceneCode = "E01";
        scenes.push({
          id: makeId("scene", block.message, sequence),
          kind: "scene",
          number: 1,
          code: currentSceneCode,
          episodeCode: currentEpisodeCode,
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
      const shotType = specialShotMatch
        ? ("special" as const)
        : variantShotMatch
          ? ("variant" as const)
          : ("normal" as const);
      const specialCode = specialShotMatch?.[1]
        ? specialShotMatch[1].toUpperCase().replace(/^ESP(?=\d)/, "ESP-")
        : null;
      const code =
        shotType === "special"
          ? specialCode
          : shotType === "variant"
            ? variantOfShotNumber
              ? `P${String(variantOfShotNumber).padStart(3, "0")}-A`
              : null
            : globalNumber
              ? `P${String(globalNumber).padStart(3, "0")}`
              : null;
      const sceneCodeFromShot: string | null =
        codedShotMatch?.[1]?.match(/^((?:E|S)\d{1,3})-/i)?.[1]?.toUpperCase() ??
        null;
      currentSceneCode = sceneCodeFromShot ?? currentSceneCode;
      const sourceText = sourceLinesWithoutMetadata(block.lines);
      const fieldHeader =
        /^(?:DURACI[ÓO]N|TIPO DE PLANO|C[ÁA]MARA|PRIMER FRAME|PROMPT PARA GENERAR|PROMPT DE VIDEO|MOVIMIENTO DEL VIDEO|STORYBOARD|SONIDO|TRANSICI[ÓO]N|TEXTO|VOZ EN OFF)\b/i;
      const imagePrompt =
        sectionText(
          block.lines,
          /^PROMPT PARA GENERAR (?:EL )?PRIMER FRAME$/i,
          fieldHeader,
        ) ?? sectionText(block.lines, /^PRIMER FRAME$/i, fieldHeader);
      const videoPrompt = sectionText(
        block.lines,
        /^MOVIMIENTO DEL VIDEO$/i,
        fieldHeader,
      );
      shots.push({
        id: makeId("shot", block.message, sequence),
        kind: "shot",
        code,
        globalNumber: shotType === "normal" ? globalNumber : null,
        shotType,
        specialCode,
        variantOfShotNumber:
          shotType === "variant" ? variantOfShotNumber : null,
        episodeCode: currentEpisodeCode,
        sceneCode: currentSceneCode,
        orderIndex: shots.length,
        title: candidateShotTitle ?? code ?? "Plano especial",
        visualDescription: compact(sourceText),
        action: compact(sourceText),
        framing: detectFraming(sourceText),
        angle: detectAngle(sourceText),
        movement: parseMovement(block.lines),
        estimatedDurationMs: parseDuration(block.lines),
        dialogue: compact(sourceText.match(/["“](.+?)["”]/)?.[1]) ?? null,
        imagePrompt,
        videoPrompt,
        videoTechnical: extractVideoTechnical(block.lines, videoPrompt),
        confidence: 0.99,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      currentShotCode = code;
      continue;
    }

    const imagePromptMatch = firstLine.match(imagePromptHeader);
    if (imagePromptMatch) {
      const relatedShotCode =
        canonicalShotReference(imagePromptMatch[1]) ?? currentShotCode;
      const text = block.lines.slice(1).join("\n").trim();
      imagePrompts.push({
        id: makeId("image-prompt", block.message, sequence),
        kind: "image_prompt",
        title: compact(imagePromptMatch[1]),
        text,
        relatedShotCode,
        confidence: 0.99,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      const relatedShot = shots.find((shot) => shot.code === relatedShotCode);
      if (relatedShot && text) relatedShot.imagePrompt = text;
      continue;
    }

    const videoPromptMatch = firstLine.match(videoPromptHeader);
    if (videoPromptMatch) {
      const relatedShotCode =
        canonicalShotReference(videoPromptMatch[1]) ?? currentShotCode;
      const text = block.lines.slice(1).join("\n").trim();
      videoPrompts.push({
        id: makeId("video-prompt", block.message, sequence),
        kind: "video_prompt",
        title: compact(videoPromptMatch[1]),
        text,
        relatedShotCode,
        confidence: 0.99,
        extractionMethod: "explicit",
        sourceMessageIds: [block.message.id],
        reviewStatus: "pending",
      });
      const relatedShot = shots.find((shot) => shot.code === relatedShotCode);
      if (relatedShot && text) relatedShot.videoPrompt = text;
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

  // PDF text extractors can split a shot when a metadata line begins with a
  // structural word such as "PERSONAJE". Recover only missing prompt fields
  // from the explicit PLANO N section without overwriting parsed/manual data.
  for (const message of capture.messages) {
    const lines = technicalMessageText(message)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim());
    for (let index = 0; index < lines.length; index += 1) {
      const shotMatch = lines[index]?.match(plainShotHeader);
      if (!shotMatch?.[1]) continue;
      const number = Number.parseInt(shotMatch[1], 10);
      const nextShotOffset = lines
        .slice(index + 1)
        .findIndex((line) => plainShotHeader.test(line));
      const end =
        nextShotOffset < 0 ? lines.length : index + 1 + nextShotOffset;
      const shotLines = lines.slice(index, end);
      const shot = shots.find(
        (candidate) =>
          candidate.shotType === "normal" && candidate.globalNumber === number,
      );
      if (!shot) continue;
      const promptBoundary =
        /^(?:STORYBOARD|PROMPT DE VIDEO|MOVIMIENTO DEL VIDEO|ESCENA|PLANO\s+\d+|--- PAGINA)\b/i;
      shot.imagePrompt ??= sectionText(
        shotLines,
        /^PRIMER FRAME$/i,
        promptBoundary,
      );
      shot.videoPrompt ??= sectionText(
        shotLines,
        /^(?:PROMPT DE VIDEO|MOVIMIENTO DEL VIDEO)$/i,
        /^(?:ESCENA|PLANO\s+\d+|--- PAGINA|•\s*•\s*•)/i,
      );
      const extractedTechnical = extractVideoTechnical(
        shotLines,
        shot.videoPrompt,
      );
      shot.videoTechnical = Object.fromEntries(
        Object.entries(extractedTechnical).map(([key, value]) => [
          key,
          value ?? shot.videoTechnical[key as keyof VideoTechnical] ?? null,
        ]),
      ) as VideoTechnical;
    }
  }

  const declarations = capture.messages
    .flatMap((message) => {
      const text = technicalMessageText(message);
      const countMatch = text.match(declaredShotCountPattern);
      const rangeMatch = text.match(declaredShotRangePattern);
      if (!countMatch?.[1] && !rangeMatch?.[1]) return [];
      return [
        {
          message,
          count: countMatch?.[1] ? Number.parseInt(countMatch[1], 10) : null,
          first: rangeMatch?.[1] ? Number.parseInt(rangeMatch[1], 10) : null,
          last: rangeMatch?.[2] ? Number.parseInt(rangeMatch[2], 10) : null,
        },
      ];
    })
    .sort((left, right) => {
      const roleDifference =
        Number(left.message.role === "assistant") -
        Number(right.message.role === "assistant");
      return (
        roleDifference || left.message.orderIndex - right.message.orderIndex
      );
    });
  const declaration = declarations.at(-1);
  if (declaration) {
    const normalBeforeContract = shots.filter(
      (shot) => shot.shotType === "normal",
    );
    if (
      declaration.first !== null &&
      declaration.last !== null &&
      declaration.first <= declaration.last
    ) {
      const outsideRange = normalBeforeContract.filter(
        (shot) =>
          shot.globalNumber === null ||
          shot.globalNumber < declaration.first! ||
          shot.globalNumber > declaration.last!,
      );
      shots.splice(
        0,
        shots.length,
        ...shots.filter(
          (shot) =>
            shot.shotType !== "normal" ||
            (shot.globalNumber !== null &&
              shot.globalNumber >= declaration.first! &&
              shot.globalNumber <= declaration.last!),
        ),
      );
      if (outsideRange.length > 0) {
        warnings.push({
          code: "SHOTS_OUTSIDE_DECLARED_RANGE_IGNORED",
          message: `${outsideRange.length} referencias o bloques fuera del rango declarado no se cargarán como planos.`,
          sourceMessageIds: outsideRange.flatMap(
            (shot) => shot.sourceMessageIds,
          ),
        });
      }
    }

    if (declaration.count !== null) {
      const contractedNormals = shots.filter(
        (shot) => shot.shotType === "normal",
      );
      if (contractedNormals.length > declaration.count) {
        const acceptedIds = new Set(
          contractedNormals.slice(0, declaration.count).map((shot) => shot.id),
        );
        const ignored = contractedNormals.slice(declaration.count);
        shots.splice(
          0,
          shots.length,
          ...shots.filter(
            (shot) => shot.shotType !== "normal" || acceptedIds.has(shot.id),
          ),
        );
        warnings.push({
          code: "EXCESS_SHOTS_IGNORED",
          message: `Se declararon ${declaration.count} planos y se detectaron ${contractedNormals.length}. Los excedentes quedaron bloqueados.`,
          sourceMessageIds: ignored.flatMap((shot) => shot.sourceMessageIds),
        });
      } else if (contractedNormals.length < declaration.count) {
        warnings.push({
          code: "DECLARED_SHOT_COUNT_MISMATCH",
          message: `Se declararon ${declaration.count} planos, pero sólo ${contractedNormals.length} contienen datos técnicos válidos. La importación necesita revisión.`,
          sourceMessageIds: [declaration.message.id],
        });
      }
    }
  }

  if (capture.selectedShotIds !== null) {
    const selectedShotIds = new Set(capture.selectedShotIds);
    const selectedShots = shots.filter((shot) => selectedShotIds.has(shot.id));
    shots.splice(0, shots.length, ...selectedShots);
    const selectedCodes = new Set(
      selectedShots
        .map((shot) => shot.code)
        .filter((code): code is string => Boolean(code)),
    );
    imagePrompts.splice(
      0,
      imagePrompts.length,
      ...imagePrompts.filter(
        (prompt) =>
          !prompt.relatedShotCode || selectedCodes.has(prompt.relatedShotCode),
      ),
    );
    videoPrompts.splice(
      0,
      videoPrompts.length,
      ...videoPrompts.filter(
        (prompt) =>
          !prompt.relatedShotCode || selectedCodes.has(prompt.relatedShotCode),
      ),
    );
  }

  const normalShots = shots.filter(
    (shot) => shot.shotType === "normal" && shot.globalNumber,
  );
  const normalNumbers = normalShots.map((shot) => shot.globalNumber!);
  const legacyNumbering =
    new Set(normalNumbers).size !== normalNumbers.length ||
    normalNumbers.some(
      (number, index) => index > 0 && number <= (normalNumbers[index - 1] ?? 0),
    );
  if (legacyNumbering) {
    let nextNumber = 1;
    for (const shot of shots) {
      if (shot.shotType !== "normal") continue;
      shot.globalNumber = nextNumber;
      shot.code = `P${String(nextNumber).padStart(3, "0")}`;
      nextNumber += 1;
    }
    warnings.push({
      code: "LEGACY_SCENE_NUMBERING_NORMALIZED",
      message:
        "La numeración se reiniciaba por escena. FrameSync la normalizó a una secuencia global única.",
      sourceMessageIds: normalShots.flatMap((shot) => shot.sourceMessageIds),
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

  // Los marcadores de página pertenecen a la fuente, no al prompt que se
  // copia en un generador de video. Se limpia al final para cubrir todos los
  // formatos de captura (bloques explícitos, PDF y recuperación heredada).
  for (const shot of shots) {
    shot.videoPrompt = videoPromptOnly(shot.videoPrompt);
  }
  for (const prompt of videoPrompts) {
    prompt.text = videoPromptOnly(prompt.text) ?? "";
  }

  const resultWithoutSummary = {
    scriptCandidates,
    episodes,
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
