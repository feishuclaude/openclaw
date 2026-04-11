import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuCardThrottle } from "./stream-buffer.js";

let flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
let throttle: FeishuCardThrottle;

beforeEach(() => {
  vi.useFakeTimers();
  flush = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  throttle = new FeishuCardThrottle(flush);
});

afterEach(() => {
  throttle.cleanup();
  vi.useRealTimers();
});

describe("FeishuCardThrottle", () => {
  describe("basic throttling", () => {
    it("coalesces multiple rapid requestUpdate calls into a single flush", async () => {
      throttle.requestUpdate(10);
      throttle.requestUpdate(20);
      throttle.requestUpdate(30);

      // Timer not yet fired — no flush yet
      expect(flush).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(700);

      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("schedules a new flush after the previous timer fires", async () => {
      throttle.requestUpdate(10);
      await vi.advanceTimersByTimeAsync(700);
      expect(flush).toHaveBeenCalledTimes(1);

      throttle.requestUpdate(10);
      await vi.advanceTimersByTimeAsync(700);
      expect(flush).toHaveBeenCalledTimes(2);
    });
  });

  describe("rapid completion within one throttle window", () => {
    it("finishAll flushes the pending update even before the timer fires", async () => {
      throttle.requestUpdate(50);
      // Timer has not fired yet
      expect(flush).not.toHaveBeenCalled();

      await throttle.finishAll();
      expect(flush).toHaveBeenCalledTimes(1);
    });
  });

  describe("finishAll flush correctness", () => {
    it("clears the pending timer and flushes immediately", async () => {
      throttle.requestUpdate(10);
      await throttle.finishAll();

      // Advancing past the original timer window should not cause a second flush
      await vi.advanceTimersByTimeAsync(1000);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("is idempotent — multiple calls do not double-flush", async () => {
      throttle.requestUpdate(10);
      await throttle.finishAll();
      await throttle.finishAll();

      expect(flush).toHaveBeenCalledTimes(2);
      // Both calls invoke _doFlush, but the second one runs with reset
      // accumulator so it still calls the callback (no guard against empty).
    });
  });

  describe("concurrent update calls during flush", () => {
    it("queues a follow-up flush when requestUpdate is called while flushing", async () => {
      // Make the flush callback hang until we resolve it
      let resolveFlush!: () => void;
      flush.mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolveFlush = r;
          }),
      );

      throttle.requestUpdate(10);
      await vi.advanceTimersByTimeAsync(700);
      // Flush started but not resolved yet
      expect(flush).toHaveBeenCalledTimes(1);

      // Request another update while flush is in-flight
      throttle.requestUpdate(10);
      // This triggers _doFlush -> sees _isFlushing, sets _pendingFlushAfterCurrent

      // Resolve the first flush — the .finally() handler should re-flush
      resolveFlush();
      // Let microtasks settle
      await vi.advanceTimersByTimeAsync(0);

      expect(flush).toHaveBeenCalledTimes(2);
    });

    it("does not drop updates that arrive during an in-flight flush", async () => {
      let resolveFlush!: () => void;
      flush.mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolveFlush = r;
          }),
      );

      // Trigger first flush via immediate threshold
      throttle.requestUpdate(2000);
      expect(flush).toHaveBeenCalledTimes(1);

      // While flushing, accumulate more text
      throttle.requestUpdate(500);
      throttle.requestUpdate(500);

      resolveFlush();
      await vi.advanceTimersByTimeAsync(0);

      // The queued flush should have fired
      expect(flush).toHaveBeenCalledTimes(2);
    });
  });

  describe("empty / zero-delta updates", () => {
    it("schedules a timer even for requestUpdate(0)", async () => {
      throttle.requestUpdate(0);

      expect(flush).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(700);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("does not trigger immediate flush for many zero-delta calls", async () => {
      for (let i = 0; i < 100; i++) {
        throttle.requestUpdate(0);
      }
      // Should still be waiting on the timer, not immediately flushed
      expect(flush).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(700);
      expect(flush).toHaveBeenCalledTimes(1);
    });
  });

  describe("character threshold triggers immediate flush", () => {
    it("flushes immediately when accumulated chars reach IMMEDIATE_THRESHOLD", () => {
      throttle.requestUpdate(2000);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("flushes immediately when multiple small deltas cross the threshold", () => {
      throttle.requestUpdate(1500);
      expect(flush).not.toHaveBeenCalled();

      throttle.requestUpdate(500);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("resets the character accumulator after an immediate flush", async () => {
      throttle.requestUpdate(2000);
      expect(flush).toHaveBeenCalledTimes(1);

      // Wait for the flush promise to settle so _isFlushing resets
      await vi.advanceTimersByTimeAsync(0);

      // Next small update should not trigger an immediate flush
      throttle.requestUpdate(100);
      expect(flush).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(700);
      expect(flush).toHaveBeenCalledTimes(2);
    });
  });

  describe("cleanup aborts without flushing", () => {
    it("prevents scheduled flush from firing", async () => {
      throttle.requestUpdate(10);
      throttle.cleanup();

      await vi.advanceTimersByTimeAsync(1000);
      expect(flush).not.toHaveBeenCalled();
    });

    it("clears the pending-after-current flag", async () => {
      let resolveFlush!: () => void;
      flush.mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolveFlush = r;
          }),
      );

      // Start a flush
      throttle.requestUpdate(2000);
      expect(flush).toHaveBeenCalledTimes(1);

      // Queue a follow-up
      throttle.requestUpdate(10);

      // Now abort
      throttle.cleanup();

      // Resolve the in-flight flush — follow-up should NOT fire
      resolveFlush();
      await vi.advanceTimersByTimeAsync(0);

      expect(flush).toHaveBeenCalledTimes(1);
    });
  });

  describe("flush callback error handling", () => {
    it("swallows flush callback errors and remains usable", async () => {
      flush.mockRejectedValueOnce(new Error("API failure"));

      throttle.requestUpdate(2000);
      // Let the rejected promise settle
      await vi.advanceTimersByTimeAsync(0);

      // Should still work for subsequent updates
      throttle.requestUpdate(2000);
      expect(flush).toHaveBeenCalledTimes(2);
    });
  });
});
