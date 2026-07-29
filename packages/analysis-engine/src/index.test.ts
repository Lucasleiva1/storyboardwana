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
});
