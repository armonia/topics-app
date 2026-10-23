/**
 * The histogram the shell reports its slow interactions in, and the percentile
 * read back from it.
 * @covers INTERACTION-01
 */
import { describe, expect, test } from "bun:test";
import {
  INTERACTION_BUCKET_EDGES,
  SLOW_INTERACTION_MS,
  addInteraction,
  emptyInteractionHistogram,
  interactionBucket,
  interactionPercentile,
  mergeInteractionHistograms,
} from "./interaction-histogram";

describe("interactionBucket", () => {
  test("a fast interaction is not kept", () => {
    expect(interactionBucket(0)).toBe(-1);
    expect(interactionBucket(8)).toBe(-1);
    expect(interactionBucket(15.9)).toBe(-1);
    expect(interactionBucket(Number.NaN)).toBe(-1);
  });

  test("the lower edge belongs to its own bucket", () => {
    expect(interactionBucket(SLOW_INTERACTION_MS)).toBe(0);
    expect(interactionBucket(23)).toBe(0);
    expect(interactionBucket(24)).toBe(1);
    expect(interactionBucket(48)).toBe(4);
    expect(interactionBucket(63)).toBe(4);
    expect(interactionBucket(64)).toBe(5);
  });

  test("the last bucket is open on top", () => {
    const last = INTERACTION_BUCKET_EDGES.length - 1;
    expect(interactionBucket(512)).toBe(last);
    expect(interactionBucket(60_000)).toBe(last);
  });
});

describe("interactionPercentile", () => {
  test("nothing counted is not fast, it is unknown", () => {
    expect(interactionPercentile(emptyInteractionHistogram(), 0, 0.95)).toBeNull();
  });

  test("fewer slow interactions than the tail asks for: under the reporting threshold", () => {
    const histogram = emptyInteractionHistogram();
    addInteraction(histogram, 300);
    // 1 slow of 100: the slowest 5 are 4 fast ones and the slow one, so the p95 is under 16.
    expect(interactionPercentile(histogram, 100, 0.95)).toBe(SLOW_INTERACTION_MS);
  });

  test("enough slow interactions: the upper edge of the bucket holding the tail", () => {
    const histogram = emptyInteractionHistogram();
    for (let i = 0; i < 5; i++) addInteraction(histogram, 100); // bucket [96, 128)
    for (let i = 0; i < 3; i++) addInteraction(histogram, 20); // bucket [16, 24)
    // 100 interactions, the slowest ceil(0.05 * 100) = 5 are all in [96, 128).
    expect(interactionPercentile(histogram, 100, 0.95)).toBe(128);
    // With only 40 interactions the tail is 2: still the same bucket.
    expect(interactionPercentile(histogram, 40, 0.95)).toBe(128);
    // With 20 the tail is 1.
    expect(interactionPercentile(histogram, 20, 0.95)).toBe(128);
  });

  test("the tail can reach into a faster bucket", () => {
    const histogram = emptyInteractionHistogram();
    for (let i = 0; i < 2; i++) addInteraction(histogram, 300); // [256, 320)
    for (let i = 0; i < 4; i++) addInteraction(histogram, 40); // [40, 48)
    // 40 interactions: tail of 2 stays in the slow bucket, tail of 5 reaches the next one.
    expect(interactionPercentile(histogram, 40, 0.95)).toBe(320);
    expect(interactionPercentile(histogram, 100, 0.95)).toBe(48);
  });

  test("the open top bucket answers with its lower edge", () => {
    const histogram = emptyInteractionHistogram();
    addInteraction(histogram, 4000);
    expect(interactionPercentile(histogram, 10, 0.95)).toBe(512);
  });
});

describe("mergeInteractionHistograms", () => {
  test("adds page loads bucket by bucket and ignores a short row", () => {
    const first = emptyInteractionHistogram();
    addInteraction(first, 30);
    const second = emptyInteractionHistogram();
    addInteraction(second, 30);
    addInteraction(second, 600);
    // A row shorter than the others (an older client) still adds up where it has a slot.
    const merged = mergeInteractionHistograms([first, second, [1]]);
    expect(merged[0]).toBe(1);
    expect(merged[1]).toBe(2);
    expect(merged[merged.length - 1]).toBe(1);
  });
});
