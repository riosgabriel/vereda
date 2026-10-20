// The shared demo player. It owns time and nothing else a page could get
// wrong: one clock where 1x is real time, play/pause/replay, the speed menu,
// the scenario timeline, and guided mode (show each phase's caption and slow
// down briefly when the phase starts). A page supplies `build(options) -> DemoTrace` and
// `render(trace, simT, col)`, and calls `rerun(patch)` when a control changes.
//
// Expected elements, by id: play, replay, speed, guided, clock, timeline,
// caption. Missing ones are skipped.

import { readColors } from "./draw.js";

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const SLOW_SPAN = 1.5; // sim seconds of slow motion after a phase starts or a moment happens
const SLOW_FACTOR = 0.35;
const MOMENT_LEAD = 0.5; // sim seconds of slow motion before a moment, so it doesn't arrive unannounced
const MOMENT_SHOWN = 3; // sim seconds a moment stays in the caption
const MOMENTS_STACKED = 3; // most recent moments shown at once

/**
 * @param {object} spec
 * @param {(options: object) => import("./trace.js").DemoTrace} spec.build
 * @param {(trace: import("./trace.js").DemoTrace, simT: number, col: Record<string, string>) => void} spec.render
 * @param {object} spec.options Initial options passed to `build`.
 * @param {number} [spec.speed] Default speed as a multiple of real time.
 * @param {number} [spec.settle] Sim seconds the page's drawing trails the trace: how long a dot
 *   keeps moving after its attempt has ended (e.g. the trip back to the client).
 */
export function mountDemo({ build, render, options, speed = 1, settle = 0 }) {
	const $ = (id) => document.getElementById(id);
	const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

	let opts = { ...options };
	let trace = build(opts);
	let simT = 0;
	let playing = false;
	let guided = true;
	let last = performance.now();
	let col = readColors();

	// The run stops once everything on screen has come to rest, not at `duration`: traffic runs
	// to the scenario's last second, so requests sent then are still in flight, or their dots
	// still travelling, when the timeline ends. The timeline and captions still end at `duration`.
	// Only what the client sees counts: `hostEnd` is host work after the client gave up, which
	// nothing on screen waits for.
	const runEnd = () => {
		let t = trace.duration;
		for (const lane of [trace.lanes.without, trace.lanes.with]) {
			for (const a of lane.attempts) t = Math.max(t, a.end);
			for (const r of lane.results) t = Math.max(t, r.t);
		}
		return t + settle;
	};

	const refreshColors = () => {
		col = readColors();
	};
	matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshColors);
	new MutationObserver(refreshColors).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});

	// ---- controls -----------------------------------------------------------
	const playBtn = $("play");
	const setPlaying = (on) => {
		playing = on;
		if (!playBtn) return;
		const atStop = !on && simT > 0 && simT < runEnd();
		playBtn.textContent = on ? "Pause" : atStop ? "Continue" : "Play";
	};
	playBtn?.addEventListener("click", () => {
		if (simT >= runEnd()) restart(true);
		else setPlaying(!playing);
	});
	$("replay")?.addEventListener("click", () => restart(true));

	const speedSel = $("speed");
	if (speedSel) {
		speedSel.innerHTML = SPEEDS.map(
			(s) => `<option value="${s}"${s === speed ? " selected" : ""}>${s}×${s === 1 ? " real time" : ""}</option>`,
		).join("");
		speedSel.addEventListener("change", (e) => {
			speed = Number(e.target.value);
		});
	}

	const guidedBox = $("guided");
	if (guidedBox) {
		guidedBox.checked = guided;
		guidedBox.addEventListener("change", (e) => {
			guided = e.target.checked;
		});
	}

	// ---- timeline and captions ----------------------------------------------
	function drawTimeline() {
		const tl = $("timeline");
		if (!tl) return;
		tl.style.gridTemplateColumns = trace.phases.map((p) => `${p.to - p.from}fr`).join(" ");
		tl.innerHTML =
			trace.phases.map((p) => `<div class="${p.tone}">${p.label}</div>`).join("") +
			`<span class="playhead" id="playhead"></span>`;
	}

	function phaseIndexAt(t) {
		let i = 0;
		while (i + 1 < trace.phases.length && trace.phases[i + 1].from <= t) i++;
		return i;
	}

	// Slow-motion windows scale with the run, so a 7 s scenario isn't slowed
	// almost end to end. Capped at the values that suit a ~30 s run.
	const span = () => Math.min(SLOW_SPAN, trace.duration / 20);
	const lead = () => Math.min(MOMENT_LEAD, trace.duration / 60);
	const shown = () => Math.min(MOMENT_SHOWN, Math.max(1, trace.duration / 10));

	/** Moments at or before t that are still recent enough to mention, newest last. */
	function recentMoments(t) {
		const found = [];
		for (const m of trace.moments ?? []) {
			if (m.t > t) break;
			if (t - m.t < shown()) found.push(m);
		}
		// Events that land close together (a bucket emptying, then the first 429)
		// stay readable side by side instead of replacing each other.
		return found.slice(-MOMENTS_STACKED);
	}

	let captionKey = "";
	function updateCaption() {
		const box = $("caption");
		if (!box) return;
		const phase = trace.phases[phaseIndexAt(simT)];
		const moments = recentMoments(simT);
		const key = `${phase.from}|${moments.map((m) => m.t).join(",")}`;
		if (key === captionKey) return;
		captionKey = key;
		box.hidden = !phase.caption && !moments.length;
		box.innerHTML =
			(phase.caption ? `<strong>${phase.label}.</strong> ${phase.caption}` : "") +
			moments.map((m) => `<span class="now">${m.t.toFixed(1)} s · ${m.label}</span>`).join("");
	}

	/** Slow motion: briefly after each phase starts, and around each moment. */
	function isSlowAt(t) {
		if (!guided) return false;
		if (trace.phases.some((p, i) => i > 0 && t >= p.from && t < p.from + span())) return true;
		return (trace.moments ?? []).some((m) => t >= m.t - lead() && t < m.t + span());
	}

	function restart(autoplay) {
		simT = 0;
		captionKey = "";
		setPlaying(autoplay);
	}

	/** Apply new options, rebuild the trace and start over from 0. */
	function rerun(patch) {
		opts = { ...opts, ...patch };
		trace = build(opts);
		drawTimeline();
		restart(!reduceMotion);
	}

	// ---- loop ---------------------------------------------------------------
	function frame(now) {
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		if (playing) {
			// Guided mode never stops playback; it slows down so changes are easy to catch.
			simT += dt * speed * (isSlowAt(simT) ? SLOW_FACTOR : 1);
			const end = runEnd();
			if (simT >= end) {
				simT = end;
				setPlaying(false);
			}
		}
		render(trace, simT, col);
		updateCaption();
		const clock = $("clock");
		if (clock) clock.textContent = `t = ${Math.min(simT, trace.duration).toFixed(1)} s`;
		const head = $("playhead");
		if (head) head.style.left = `calc(${Math.min(1, simT / trace.duration) * 100}% - 1px)`;
		requestAnimationFrame(frame);
	}

	drawTimeline();
	if (reduceMotion) {
		// Complete at rest: show the whole run, no motion.
		simT = runEnd();
	}
	setPlaying(false);
	requestAnimationFrame(frame);

	return {
		rerun,
		get options() {
			return opts;
		},
	};
}
