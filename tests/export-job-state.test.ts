import {
  advanceProgress,
  canTransitionExportState,
  clampProgress,
  EXPORT_JOB_TERMINAL_STATES,
  isTerminalExportState,
  progressForDocuments,
  type ExportJobState,
} from "../src/services/export-job-state";

const ALL: ExportJobState[] = ["queued", "running", "completed", "failed", "cancelled"];

describe("export job state transitions", () => {
  it("allows the forward path queued -> running -> completed", () => {
    expect(canTransitionExportState("queued", "running")).toBe(true);
    expect(canTransitionExportState("running", "completed")).toBe(true);
  });

  it("allows cancelling a queued or running job", () => {
    expect(canTransitionExportState("queued", "cancelled")).toBe(true);
    expect(canTransitionExportState("running", "cancelled")).toBe(true);
  });

  it("allows failing a queued or running job", () => {
    expect(canTransitionExportState("queued", "failed")).toBe(true);
    expect(canTransitionExportState("running", "failed")).toBe(true);
  });

  it("never leaves a terminal state", () => {
    for (const from of EXPORT_JOB_TERMINAL_STATES) {
      for (const to of ALL) {
        expect(canTransitionExportState(from, to)).toBe(false);
      }
    }
  });

  it("rejects skipping a state or moving backwards", () => {
    expect(canTransitionExportState("queued", "completed")).toBe(false);
    expect(canTransitionExportState("running", "queued")).toBe(false);
  });

  it("never transitions a state to itself", () => {
    for (const state of ALL) {
      expect(canTransitionExportState(state, state)).toBe(false);
    }
  });

  it("identifies terminal states", () => {
    expect(isTerminalExportState("completed")).toBe(true);
    expect(isTerminalExportState("failed")).toBe(true);
    expect(isTerminalExportState("cancelled")).toBe(true);
    expect(isTerminalExportState("queued")).toBe(false);
    expect(isTerminalExportState("running")).toBe(false);
  });
});

describe("export job progress", () => {
  it("clamps into whole numbers 0..100", () => {
    expect(clampProgress(-5)).toBe(0);
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(42.9)).toBe(42);
    expect(clampProgress(100)).toBe(100);
    expect(clampProgress(250)).toBe(100);
  });

  it("treats non-finite values as 0", () => {
    expect(clampProgress(NaN)).toBe(0);
    expect(clampProgress(Infinity)).toBe(0);
    expect(clampProgress(-Infinity)).toBe(0);
  });

  it("never moves backwards", () => {
    expect(advanceProgress(40, 30)).toBe(40);
    expect(advanceProgress(40, 40)).toBe(40);
    expect(advanceProgress(40, 55)).toBe(55);
  });

  it("stays bounded for out-of-range updates", () => {
    expect(advanceProgress(40, 500)).toBe(100);
    expect(advanceProgress(40, -500)).toBe(40);
    expect(advanceProgress(40, NaN)).toBe(40);
  });

  it("is monotonic across any sequence of updates", () => {
    let progress = 0;
    for (const next of [10, 5, 30, 30, 20, 99, 12, 150, 0]) {
      const updated = advanceProgress(progress, next);
      expect(updated).toBeGreaterThanOrEqual(progress);
      expect(updated).toBeLessThanOrEqual(100);
      progress = updated;
    }
    expect(progress).toBe(100);
  });

  it("derives progress from processed documents and holds 100 back", () => {
    expect(progressForDocuments(0, 10)).toBe(0);
    expect(progressForDocuments(5, 10)).toBe(50);
    expect(progressForDocuments(9, 10)).toBe(90);
    expect(progressForDocuments(10, 10)).toBe(99);
    expect(progressForDocuments(1, 3)).toBe(33);
  });

  it("bounds document progress for bad counts", () => {
    expect(progressForDocuments(15, 10)).toBe(99);
    expect(progressForDocuments(-3, 10)).toBe(0);
    expect(progressForDocuments(1, 0)).toBe(0);
    expect(progressForDocuments(1, NaN)).toBe(0);
  });
});
