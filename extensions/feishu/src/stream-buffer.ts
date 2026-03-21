/**
 * FeishuCardThrottle - Throttles Feishu card update API calls during streaming.
 *
 * Instead of calling updateCardFeishu() on every stream event,
 * this class batches updates based on time intervals and text size thresholds.
 */

export class FeishuCardThrottle {
  private _flushCallback: () => Promise<void>;
  private _pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private _charsSinceLastFlush = 0;
  private _lastFlushTime = 0;
  private _isFlushing = false;
  private _pendingFlushAfterCurrent = false;

  /** Minimum ms between card updates (higher than AgentChat's 500ms due to Feishu API latency) */
  readonly MIN_UPDATE_INTERVAL = 700;
  /** Character threshold for immediate flush */
  readonly IMMEDIATE_THRESHOLD = 2000;

  constructor(flushCallback: () => Promise<void>) {
    this._flushCallback = flushCallback;
  }

  /**
   * Request a card update. The throttle decides when to actually flush.
   * @param textLengthDelta - Number of new text characters added (0 for non-text events like tool_use)
   */
  requestUpdate(textLengthDelta: number): void {
    this._charsSinceLastFlush += textLengthDelta;

    // Immediate flush if text accumulated beyond threshold
    if (this._charsSinceLastFlush >= this.IMMEDIATE_THRESHOLD) {
      this._doFlush();
      return;
    }

    // If timer already scheduled, let it fire
    if (this._pendingTimer !== null) {
      return;
    }

    // Schedule a delayed flush
    const timeSinceLastFlush = Date.now() - this._lastFlushTime;
    const delay = Math.max(0, this.MIN_UPDATE_INTERVAL - timeSinceLastFlush);
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = null;
      this._doFlush();
    }, delay);
  }

  /**
   * Force flush and clean up. Call when stream completes.
   */
  async finishAll(): Promise<void> {
    this._clearTimer();
    await this._doFlush();
  }

  /**
   * Clean up timers without flushing. Call on abort/error paths.
   */
  cleanup(): void {
    this._clearTimer();
    this._pendingFlushAfterCurrent = false;
  }

  private _clearTimer(): void {
    if (this._pendingTimer !== null) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
  }

  private _doFlush(): void {
    this._clearTimer();

    // Guard against concurrent flushes (Feishu API call may be in-flight)
    if (this._isFlushing) {
      this._pendingFlushAfterCurrent = true;
      return;
    }

    this._isFlushing = true;
    this._charsSinceLastFlush = 0;
    this._lastFlushTime = Date.now();

    this._flushCallback()
      .catch((err) => {
        // Swallow errors - the caller's updateStreamingCard already logs failures
      })
      .finally(() => {
        this._isFlushing = false;

        // If another flush was requested while we were busy, do it now
        if (this._pendingFlushAfterCurrent) {
          this._pendingFlushAfterCurrent = false;
          this._doFlush();
        }
      });
  }
}
