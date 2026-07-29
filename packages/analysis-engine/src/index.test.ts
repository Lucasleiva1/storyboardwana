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
    const shot = result.shots.find((item) => item.code === "E01-P03");

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
          item.kind === "unclassified" &&
          item.reviewStatus === "needs_review",
      ),
    ).toBe(true);
  });
});

