import { DEFAULT_MAX_PAUSE_MS, DEFAULT_PAUSE_STATUSES, type PauseOnRetryAfterConfig } from "../core/types.ts";

/** A partition's "do not send before" time, set by a `Retry-After` the host
 *  sent with a pushback status. It only moves forward: a later, shorter
 *  `Retry-After` never ends a pause early. */
export class PartitionPause {
	readonly statuses: readonly number[];
	readonly maxPauseMs: number;
	private _until = 0;

	constructor(config: PauseOnRetryAfterConfig) {
		this.statuses = config.statuses ?? DEFAULT_PAUSE_STATUSES;
		this.maxPauseMs = config.maxPauseMs ?? DEFAULT_MAX_PAUSE_MS;
	}

	/** Epoch ms the pause ends at; in the past (or 0) when none is active. */
	get until(): number {
		return this._until;
	}

	/** Push the end of the pause out to `now + min(ms, maxPauseMs)` if that is
	 *  later than it is now. Returns the (possibly unchanged) end. */
	extend(ms: number, now: number = Date.now()): number {
		this._until = Math.max(this._until, now + Math.min(ms, this.maxPauseMs));
		return this._until;
	}

	/** Ms left in the pause, 0 once it is over. */
	remaining(now: number = Date.now()): number {
		return Math.max(0, this._until - now);
	}
}
