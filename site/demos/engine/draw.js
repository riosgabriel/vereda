// Canvas helpers shared by every demo page. Colours always come from the
// page's CSS tokens (see readColors), so both themes work.

const TOKENS = ["bg", "surface", "ink", "muted", "line", "first", "retry", "fail", "ok", "refused", "cap"];

export function readColors() {
	const cs = getComputedStyle(document.documentElement);
	const col = {};
	for (const k of TOKENS) col[k] = cs.getPropertyValue(`--${k}`).trim();
	// Canvas text uses the page's sans in three roles, on the same scale as the page's labels.
	const sans = cs.getPropertyValue("--sans").trim();
	col.label = `12px ${sans}`;
	col.strong = `600 12px ${sans}`;
	col.big = `600 14px ${sans}`;
	return col;
}

/** Match the canvas backing store to its CSS size and device pixel ratio. */
export function sizeCanvas(canvas) {
	const dpr = window.devicePixelRatio || 1;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
	}
	const ctx = canvas.getContext("2d");
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);
	return { ctx, w, h };
}

export function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

/** Blend hex colour `a` into `b`; `amt` is how much of `a` remains. */
export function mix(a, b, amt) {
	const parse = (c) => {
		const m = /^#([0-9a-f]{6})$/i.exec(c);
		return m ? [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16)) : null;
	};
	const pa = parse(a);
	const pb = parse(b);
	return pa && pb ? `rgb(${pa.map((v, i) => Math.round(v * amt + pb[i] * (1 - amt))).join(",")})` : a;
}

export function dot(ctx, x, y, r, color, alpha = 1) {
	ctx.globalAlpha = alpha;
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.fill();
	ctx.globalAlpha = 1;
}

/**
 * Shape per request state, keyed by colour token, so a dot never tells its state by colour
 * alone (WCAG 1.4.1). The page legends read it too (see shapeLegends), so the two can't drift.
 * Shapes: circle, ring, square, diamond, triangle, cross.
 */
// No "ring": the circuit breaker's trial halo and the bulkhead's rejection ring already mean something.
export const SHAPES = {
	first: "circle",
	retry: "diamond",
	ok: "square",
	fail: "cross",
	refused: "triangle",
};

/** A request dot drawn as `shape`; `r` is the radius a circle of the same weight would have. */
export function mark(ctx, shape, x, y, r, color, alpha = 1) {
	ctx.globalAlpha = alpha;
	ctx.fillStyle = color;
	ctx.strokeStyle = color;
	ctx.beginPath();
	if (shape === "ring") {
		ctx.lineWidth = Math.max(1.5, r * 0.5);
		ctx.arc(x, y, r - ctx.lineWidth / 2, 0, Math.PI * 2);
		ctx.stroke();
	} else if (shape === "cross") {
		const d = r * 0.95;
		ctx.lineWidth = Math.max(1.5, r * 0.55);
		ctx.moveTo(x - d, y - d);
		ctx.lineTo(x + d, y + d);
		ctx.moveTo(x + d, y - d);
		ctx.lineTo(x - d, y + d);
		ctx.stroke();
	} else {
		if (shape === "square") ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
		else if (shape === "diamond") {
			const d = r * 1.25;
			ctx.moveTo(x, y - d);
			ctx.lineTo(x + d, y);
			ctx.lineTo(x, y + d);
			ctx.lineTo(x - d, y);
		} else if (shape === "triangle") {
			const d = r * 1.3;
			ctx.moveTo(x, y - d);
			ctx.lineTo(x + d * 0.95, y + d * 0.6);
			ctx.lineTo(x - d * 0.95, y + d * 0.6);
		} else ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.lineWidth = 1;
	ctx.globalAlpha = 1;
}

/** A request dot in `state`'s colour and shape. */
export function stateMark(ctx, state, x, y, r, col, alpha = 1) {
	mark(ctx, SHAPES[state] ?? "circle", x, y, r, col[state], alpha);
}

/** Give every legend swatch with a `data-state` the shape its state has on the canvas. */
export function shapeLegends(root = document) {
	for (const el of root.querySelectorAll(".mark[data-state]")) {
		el.dataset.shape = SHAPES[el.dataset.state] ?? "circle";
		el.style.setProperty("--c", `var(--${el.dataset.state})`);
	}
}

/** Value of a `[t, value][]` series at time t (step function), or `fallback` before it starts. */
export function valueAt(series, t, fallback = 0) {
	let v = fallback;
	for (const [st, sv] of series ?? []) {
		if (st > t) break;
		v = sv;
	}
	return v;
}

/**
 * Grid, y ticks, time ticks and shaded "bad" phases for a chart over 0..end.
 * Returns the X and Y scales.
 */
export function timeAxes(ctx, { w, h, pad, end, yMax, ticks, fmt = String, phases = [], col }) {
	const [T, R, B, L] = pad;
	const X = (t) => L + (Math.min(t, end) / end) * (w - L - R);
	const Y = (v) => T + (1 - Math.min(v, yMax) / yMax) * (h - T - B);
	ctx.font = col.label;
	ctx.fillStyle = col.muted;
	ctx.strokeStyle = col.line;
	ctx.lineWidth = 1;
	ctx.textAlign = "right";
	for (const v of ticks) {
		ctx.beginPath();
		ctx.moveTo(L, Y(v));
		ctx.lineTo(w - R, Y(v));
		ctx.stroke();
		ctx.fillText(fmt(v), L - 6, Y(v) + 3);
	}
	ctx.textAlign = "center";
	const step = [1, 2, 4, 5, 10].find((s) => end / s <= 8) ?? 10;
	for (let t = 0; t <= end + 1e-9; t += step) ctx.fillText(`${t}s`, X(t), h - 6);
	ctx.fillStyle = mix(col.fail, col.surface, 0.08);
	for (const p of phases) if (p.tone === "bad") ctx.fillRect(X(p.from), T, X(p.to) - X(p.from), h - T - B);
	return { X, Y };
}

/** A line drawn up to simT, with a dot at the playhead. Nothing after simT: a chart never shows
 *  where the run is going before it gets there. */
export function playedLine(ctx, pts, X, Y, color, simT) {
	const trace = (upTo) => {
		ctx.beginPath();
		let last = null;
		for (const [t, v] of pts) {
			if (t > upTo) break;
			const x = X(t);
			const y = Y(v);
			if (last) ctx.lineTo(x, y);
			else ctx.moveTo(x, y);
			last = [x, y];
		}
		return last;
	};
	ctx.strokeStyle = color;
	ctx.lineWidth = 2.5;
	const end = trace(simT);
	ctx.stroke();
	ctx.lineWidth = 1;
	if (end) dot(ctx, end[0], end[1], 3.5, color);
}

export function legend(ctx, x, y, items, col) {
	ctx.textAlign = "left";
	ctx.font = col.strong;
	for (const [text, color] of items) {
		ctx.fillStyle = color;
		ctx.fillText(text, x, y);
		x += ctx.measureText(text).width + 16;
	}
}
