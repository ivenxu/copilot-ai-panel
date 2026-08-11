/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Duck-typed stream carrying the proposed `thinkingProgress` method from the
 * `chatParticipantAdditions` API (`vscode.proposed.chatParticipantAdditions.d.ts`).
 * The method is always present on the stream object — VS Code gates it at call
 * time, not by omitting the property — so its mere presence does not mean the
 * proposal is enabled. Only a successful call proves that.
 */
type ThinkingStream = {
	thinkingProgress: (d: { text?: string; id?: string; metadata?: Record<string, unknown> }) => void;
};

/**
 * Groups a role's streamed reasoning deltas into a single native "thinking" panel,
 * mirroring the pattern used by the Claude/Codex/Copilot participants in
 * feima-copilot-llms-extension. `thinkingProgress` REPLACES its displayed text on
 * every call rather than appending, so deltas are accumulated locally and the full
 * accumulated text is resent each time under one stable `id` — this is what keeps
 * the whole reasoning turn rendered as one growing panel instead of one bubble per
 * delta.
 *
 * Falls back to a single deduped "Thinking…" progress line when the proposed API
 * is unavailable (a packaged install without `--enable-proposed-api`) — detected
 * lazily, since the property-existence check alone can't tell.
 */
export class ThinkingPanelHelper {
	private readonly stream: vscode.ChatResponseStream;
	private readonly fallbackId: string;
	private available: boolean;
	private shownFallback = false;
	private _active = false;
	private accumulatedText = '';

	constructor(stream: vscode.ChatResponseStream, fallbackId: string) {
		this.stream = stream;
		this.fallbackId = fallbackId;
		this.available = typeof (stream as unknown as ThinkingStream).thinkingProgress === 'function';
	}

	/** Whether a thinking panel is currently open. */
	get isActive(): boolean {
		return this._active;
	}

	/**
	 * Open the panel with an initial header. Idempotent — only takes effect on
	 * the first call until the panel is closed again.
	 */
	open(): void {
		if (this._active) { return; }
		this._active = true;
		this.accumulatedText = '';
		this.emit({ text: 'Thinking…', id: this.fallbackId });
	}

	/**
	 * Append a reasoning delta. Resends the full accumulated text each time —
	 * the native panel replaces rather than appends.
	 */
	pushDelta(delta: string): void {
		if (!this._active) { this.open(); }
		this.accumulatedText += delta;
		this.emit({ text: this.accumulatedText, id: this.fallbackId });
	}

	/**
	 * Close the panel, signalling that reasoning has ended.
	 * @param stopReason 'text' when assistant text starts streaming, 'other' when
	 * tool calls start or the turn ends.
	 */
	close(stopReason: 'text' | 'other' = 'other'): void {
		if (!this._active) { return; }
		this._active = false;
		this.accumulatedText = '';
		this.emit({ id: '', text: '', metadata: { vscodeReasoningDone: true, stopReason } });
	}

	/** Alias for `close('text')` — assistant text content has started. */
	closeForText(): void {
		this.close('text');
	}

	/** Alias for `close('other')` — tool calls started, or the turn ended. */
	closeForAction(): void {
		this.close('other');
	}

	private emit(d: { text?: string; id?: string; metadata?: Record<string, unknown> }): void {
		if (this.available) {
			try {
				(this.stream as unknown as ThinkingStream).thinkingProgress(d);
				return;
			} catch {
				// Proposed API not enabled in this packaged install — fall back below.
				this.available = false;
			}
		}
		if (!this.shownFallback) {
			this.shownFallback = true;
			this.stream.progress('🧠 Thinking…');
		}
	}
}
