import { describe, expect, it } from "vitest";
import { DEMO_CAPTURE } from "@framesync/contracts/fixture";
import { analyzeCapture } from "./index";

describe("deterministic analysis engine", () => {
  it("extracts the structured demo without inventing fields", () => {
    const result = analyzeCapture(DEMO_CAPTURE);

    expect(result.characters.map((item) => item.name)).toEqual(["Mara", "Teo"]);
    expect(result.locations.map((item) => item.name)).toEqual([
      "Estudio Aurora",
      "Azotea",
    ]);
    expect(result.scenes).toHaveLength(3);
    expect(result.shots).toHaveLength(8);
    expect(result.imagePrompts).toHaveLength(1);
    expect(result.videoPrompts).toHaveLength(1);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]?.targetReference).toBe("E02-P02");
  });

  it("leaves missing duration empty", () => {
    const result = analyzeCapture(DEMO_CAPTURE);
    const shot = result.shots.find((item) => item.code === "P003");

    expect(shot?.estimatedDurationMs).toBeNull();
    expect(
      result.warnings.some((warning) => warning.code === "MISSING_DURATION"),
    ).toBe(true);
  });

  it("keeps ambiguous prose for human review", () => {
    const result = analyzeCapture(DEMO_CAPTURE);

    expect(
      result.unclassified.some(
        (item) =>
          item.kind === "unclassified" && item.reviewStatus === "needs_review",
      ),
    ).toBe(true);
  });

  it("keeps only the shots explicitly selected before capture import", () => {
    const preview = analyzeCapture(DEMO_CAPTURE);
    const capture = structuredClone(DEMO_CAPTURE);
    capture.selectedShotIds = [preview.shots[1]!.id, preview.shots[4]!.id];

    const selected = analyzeCapture(capture);

    expect(selected.shots.map((shot) => shot.title)).toEqual([
      preview.shots[1]!.title,
      preview.shots[4]!.title,
    ]);

    capture.selectedShotIds = [];
    expect(analyzeCapture(capture).shots).toHaveLength(0);
  });

  it("extracts ChatGPT-style plain numbered shots and their prompt sections", () => {
    const capture = structuredClone(DEMO_CAPTURE);
    capture.captureId = "chatgpt-plain-shot-format";
    capture.messages = [
      {
        ...capture.messages[0]!,
        id: "chatgpt-plain-shot-message",
        text: `GUIÓN PUBLICITARIO — UNA IDEA SE CONVIERTE EN MARCA

Concepto general

Una identidad visual se transforma en un sistema completo.

PLANO 1 — EL PUNTO DE PARTIDA

Duración

00:00–00:03

Tipo de plano

Plano general gráfico, frontal y simétrico.

Primer frame

Pantalla negra con un punto blanco centrado.

Prompt para generar el primer frame

Composición minimalista tecnológica, fondo negro y punto blanco central, formato 16:9.

Movimiento del video

El punto vibra y dibuja una línea luminosa.

PLANO 2 — CONSTRUCCIÓN DEL LOGOTIPO

Duración: 4 s

Tipo de plano

Plano cenital de una mesa de diseño.

Movimiento del video

Los nodos se alinean hasta construir el símbolo.`,
      },
    ];
    capture.diagnostics.detectedMessageCount = 1;

    const result = analyzeCapture(capture);

    expect(result.scriptCandidates).toHaveLength(1);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]?.code).toBe("E01");
    expect(result.shots.map((shot) => shot.code)).toEqual(["P001", "P002"]);
    expect(result.shots.map((shot) => shot.globalNumber)).toEqual([1, 2]);
    expect(result.shots.map((shot) => shot.estimatedDurationMs)).toEqual([
      3_000, 4_000,
    ]);
    expect(result.shots[0]?.imagePrompt).toContain("fondo negro");
    expect(result.shots[0]?.videoPrompt).toContain("línea luminosa");
  });

  it("assigns PDF-style first-frame and video prompts to the current shot", () => {
    const capture = structuredClone(DEMO_CAPTURE);
    capture.captureId = "pdf-shot-prompt-format";
    capture.messages = [
      {
        ...capture.messages[0]!,
        id: "pdf-shot-prompt-message",
        text: `ESCENA 1 — ROXWANA HOUSE DESPIERTA

PLANO 1 — LA MANSIÓN FRENTE AL OCÉANO
Duración 8 segundos
Cámara Cámara virtual tipo ARRI Alexa 35, 24 mm anamórfico. Travelling frontal lento.
Iluminación Amanecer azul y frío. Interior con luz ámbar tenue.
Efectos El océano pulsa sutilmente con la primera nota.
PRIMER FRAME
Vista aérea amplia del océano antes del amanecer. La mansión aparece abajo.
STORYBOARD / DESARROLLO
1. La cámara desciende hacia la propiedad.
PROMPT DE VIDEO
Plano aéreo cinematográfico. La cámara FPV desciende suavemente desde el mar hacia la mansión.

PLANO 2 — ENTRADA AL SALÓN
Duración 6 segundos
PRIMER FRAME
Puerta monumental cerrada, encuadre frontal y simétrico.
STORYBOARD / DESARROLLO
1. La puerta comienza a abrirse.
PROMPT DE VIDEO
La puerta se abre y la cámara avanza lentamente hacia el interior.`,
      },
    ];
    capture.diagnostics.detectedMessageCount = 1;

    const result = analyzeCapture(capture);

    expect(result.shots.map((shot) => shot.code)).toEqual(["P001", "P002"]);
    expect(result.shots[0]?.imagePrompt).toContain("Vista aérea amplia");
    expect(result.shots[0]?.imagePrompt).not.toContain("STORYBOARD");
    expect(result.shots[1]?.imagePrompt).toContain("Puerta monumental");
    expect(result.videoPrompts).toHaveLength(2);
    expect(result.videoPrompts[0]?.relatedShotCode).toBe("P001");
    expect(result.videoPrompts[1]?.relatedShotCode).toBe("P002");
    expect(result.shots[0]?.videoPrompt).toContain("cámara FPV");
    expect(result.shots[1]?.videoPrompt).toContain("puerta se abre");
    expect(result.shots[0]?.videoTechnical.camera).toContain("ARRI Alexa 35");
    expect(result.shots[0]?.videoTechnical.lens).toBe("24 mm anamórfico");
    expect(result.shots[0]?.videoTechnical.shotType).toBe("plano aéreo");
    expect(result.shots[0]?.videoTechnical.movement).toContain("Travelling");
    expect(result.shots[0]?.videoTechnical.lighting).toContain("Amanecer azul");
    expect(result.shots[0]?.videoTechnical.effects).toContain("océano pulsa");
    expect(result.shots[1]?.videoTechnical.camera).toBeNull();
  });

  it("removes PDF page provenance from video prompts", () => {
    const capture = structuredClone(DEMO_CAPTURE);
    capture.captureId = "video-prompt-page-boundary";
    capture.messages = [
      {
        ...capture.messages[0]!,
        id: "video-prompt-page-boundary-message",
        text: `PLANO 1 — APERTURA
Duración 6 segundos
PROMPT DE VIDEO
La cámara avanza lentamente mientras la puerta se abre.
--- PAGINA 7 ---
ROXWANA — NO SIGNAL · Desglose cinematográfico PLANOS 1–30`,
      },
    ];
    capture.diagnostics.detectedMessageCount = 1;

    const result = analyzeCapture(capture);

    expect(result.shots[0]?.videoPrompt).toBe(
      "La cámara avanza lentamente mientras la puerta se abre.",
    );
    expect(result.videoPrompts[0]?.text).not.toContain("PAGINA");
    expect(result.videoPrompts[0]?.text).not.toContain("ROXWANA");
  });

  it("keeps episodes and normalizes scene-local shot numbers globally", () => {
    const capture = structuredClone(DEMO_CAPTURE);
    capture.captureId = "episode-global-numbering";
    capture.messages = [
      {
        ...capture.messages[0]!,
        id: "episode-global-numbering-message",
        text: `EPISODIO 1 — Inicio

ESCENA 1 — Exterior

PLANO 1 — Llegada
La protagonista llega.

PLANO 2 — Puerta
Abre la puerta.

ESCENA 2 — Interior

PLANO 1 — Pasillo
Entra al pasillo.

PLANO 2 — Habitación
Mira la habitación.`,
      },
    ];
    capture.diagnostics.detectedMessageCount = 1;

    const result = analyzeCapture(capture);

    expect(result.episodes.map((episode) => episode.code)).toEqual(["EP01"]);
    expect(result.scenes.map((scene) => scene.episodeCode)).toEqual([
      "EP01",
      "EP01",
    ]);
    expect(result.shots.map((shot) => shot.code)).toEqual([
      "P001",
      "P002",
      "P003",
      "P004",
    ]);
    expect(result.shots.map((shot) => shot.episodeCode)).toEqual([
      "EP01",
      "EP01",
      "EP01",
      "EP01",
    ]);
    expect(
      result.warnings.some(
        (warning) => warning.code === "LEGACY_SCENE_NUMBERING_NORMALIZED",
      ),
    ).toBe(true);
  });

  it("separates special shots and variants from the normal sequence", () => {
    const capture = structuredClone(DEMO_CAPTURE);
    capture.captureId = "special-and-variant-shots";
    capture.messages = [
      {
        ...capture.messages[0]!,
        id: "special-and-variant-message",
        text: `ESCENA 1 — Prueba

P001 — Plano normal
Acción principal.

PLANO ESPECIAL — Inserto
Textura abstracta.

VARIANTE DE PLANO 1 — Alternativa
La misma acción desde otro ángulo.`,
      },
    ];
    capture.diagnostics.detectedMessageCount = 1;

    const result = analyzeCapture(capture);

    expect(result.shots.map((shot) => shot.shotType)).toEqual([
      "normal",
      "special",
      "variant",
    ]);
    expect(result.shots.map((shot) => shot.globalNumber)).toEqual([
      1,
      null,
      null,
    ]);
    expect(result.shots[2]?.variantOfShotNumber).toBe(1);
  });

  it("keeps only real technical shots, not templates, control lists, or filenames", () => {
    const capture = structuredClone(DEMO_CAPTURE);
    capture.captureId = "ten-real-shots-with-noisy-references";
    capture.messages = [
      {
        ...capture.messages[0]!,
        id: "rules-message",
        role: "user",
        text: `REGLAS

EPISODIO N — Título
ESCENA N — Título
P001 — Título del plano
DESCRIPCIÓN VISUAL: ...
ACCIÓN: ...
DURACIÓN: ... s`,
      },
      {
        ...capture.messages[1]!,
        id: "answer-message",
        role: "assistant",
        text: `INICIO_CONTENIDO_FRAMESYNC
TOTAL_PLANOS_A_CARGAR: 10
RANGO_PLANOS_A_CARGAR: P001-P010

EPISODIO 1 — Marca
ESCENA 1 — Inicio

${Array.from(
  { length: 10 },
  (
    _,
    index,
  ) => `P${String(index + 1).padStart(3, "0")} — Plano real ${index + 1}
DESCRIPCIÓN VISUAL: Acción narrativa completa del plano ${index + 1}.
DURACIÓN: 4 s`,
).join("\n\n")}

CONTROL FINAL DE NUMERACIÓN

P001
P002
P003
P004
P005
P006
P007
P008
P009
P010

ARCHIVOS RESULTANTES

P001_PRIMER_FRAME.png
P001_STORYBOARD.png
P001_VIDEO_V01.mp4
FIN_CONTENIDO_FRAMESYNC`,
      },
      {
        ...capture.messages[2]!,
        id: "filename-question",
        role: "user",
        text: `P001_PRIMER_FRAME.png
P001_STORYBOARD.png
P001_VIDEO_V01.mp4
¿Qué son estos archivos?`,
      },
    ];
    capture.diagnostics.detectedMessageCount = capture.messages.length;

    const result = analyzeCapture(capture);

    expect(result.episodes.map((episode) => episode.code)).toEqual(["EP01"]);
    expect(result.scenes.map((scene) => scene.code)).toEqual(["E01"]);
    expect(result.shots).toHaveLength(10);
    expect(result.shots.map((shot) => shot.code)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `P${String(index + 1).padStart(3, "0")}`,
      ),
    );
    expect(result.shots.map((shot) => shot.title)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Plano real ${index + 1}`),
    );
  });

  it("enforces the declared range when an AI emits extra real shot blocks", () => {
    const capture = structuredClone(DEMO_CAPTURE);
    capture.captureId = "declared-shot-range";
    capture.messages = [
      {
        ...capture.messages[1]!,
        id: "range-answer",
        role: "assistant",
        text: `INICIO_CONTENIDO_FRAMESYNC
TOTAL_PLANOS_A_CARGAR: 10
RANGO_PLANOS_A_CARGAR: P001-P010
ESCENA 1 — Única

${Array.from(
  { length: 20 },
  (_, index) => `P${String(index + 1).padStart(3, "0")} — Bloque ${index + 1}
DESCRIPCIÓN VISUAL: Contenido técnico narrativo válido ${index + 1}.`,
).join("\n\n")}
FIN_CONTENIDO_FRAMESYNC`,
      },
    ];
    capture.diagnostics.detectedMessageCount = 1;

    const result = analyzeCapture(capture);

    expect(result.shots).toHaveLength(10);
    expect(result.shots.at(-1)?.code).toBe("P010");
    expect(
      result.warnings.some(
        (warning) => warning.code === "SHOTS_OUTSIDE_DECLARED_RANGE_IGNORED",
      ),
    ).toBe(true);
  });
});
