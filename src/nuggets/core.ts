/**
 * FHRR (Fourier Holographic Reduced Representation) math primitives.
 *
 * The API stays compatible with the previous HRR layer, but the implementation
 * is explicitly phase-based: vectors are represented as unit-magnitude complex
 * numbers where binding is phase addition and unbinding is phase subtraction.
 *
 * We keep the vectors in split complex form (`re`/`im`) so the rest of the
 * codebase can continue to use fast typed-array math with zero dependencies.
 */

export interface ComplexVector {
  re: Float64Array;
  im: Float64Array;
}

const TWO_PI = 2 * Math.PI;

function wrapPhase(phase: number): number {
  if (phase > Math.PI || phase <= -Math.PI) {
    phase = ((phase + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  }
  return phase;
}

function phaseOf(re: number, im: number): number {
  return Math.atan2(im, re);
}

export function normalisePhaseVector(v: ComplexVector): ComplexVector {
  const D = v.re.length;
  const re = new Float64Array(D);
  const im = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    const phase = phaseOf(v.re[d], v.im[d]);
    re[d] = Math.cos(phase);
    im[d] = Math.sin(phase);
  }
  return { re, im };
}

export function cloneVector(v: ComplexVector): ComplexVector {
  return {
    re: new Float64Array(v.re),
    im: new Float64Array(v.im),
  };
}

function makePhaseVector(D: number, rng: () => number): ComplexVector {
  const re = new Float64Array(D);
  const im = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    const phase = TWO_PI * rng();
    re[d] = Math.cos(phase);
    im[d] = Math.sin(phase);
  }
  return { re, im };
}

export function makeKeyFromText(text: string, D: number): ComplexVector {
  return makePhaseVector(D, mulberry32(seedFromName(text)));
}

function cosineSimilarity(a: ComplexVector, b: ComplexVector): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let d = 0; d < a.re.length; d++) {
    const ar = a.re[d];
    const ai = a.im[d];
    const br = b.re[d];
    const bi = b.im[d];
    dot += ar * br + ai * bi;
    aNorm += ar * ar + ai * ai;
    bNorm += br * br + bi * bi;
  }
  return dot / (Math.sqrt(aNorm * bNorm) + 1e-12);
}

// ---------------------------------------------------------------------------
// Seeded PRNG — Mulberry32
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a stable u32 seed from a string. */
export function seedFromName(name: string): number {
  const bytes = new TextEncoder().encode(name);
  const padded = new Uint8Array(8);
  padded.set(bytes.subarray(0, 8));
  return (
    (padded[0] | (padded[1] << 8) | (padded[2] << 16) | (padded[3] << 24)) >>>
    0
  );
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export function makeVocabKeys(
  V: number,
  D: number,
  rng: () => number,
): ComplexVector[] {
  const keys: ComplexVector[] = [];
  for (let v = 0; v < V; v++) {
    keys.push(makePhaseVector(D, rng));
  }
  return keys;
}

/**
 * Create deterministic role keys via evenly spaced phase ramps.
 * role[k][d] = exp(i * k * 2πd / D)
 */
export function makeRoleKeys(D: number, L: number): ComplexVector[] {
  const keys: ComplexVector[] = [];
  for (let k = 0; k < L; k++) {
    const re = new Float64Array(D);
    const im = new Float64Array(D);
    for (let d = 0; d < D; d++) {
      const phase = (k * TWO_PI * d) / D;
      re[d] = Math.cos(phase);
      im[d] = Math.sin(phase);
    }
    keys.push({ re, im });
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Orthogonalization
// ---------------------------------------------------------------------------

/**
 * Lightweight FHRR decorrelation.
 *
 * We nudge each key away from the others in complex space, then project the
 * result back onto the unit circle so every element remains phase-only.
 */
export function orthogonalize(
  keys: ComplexVector[],
  iters = 1,
  step = 0.4,
): ComplexVector[] {
  if (iters <= 0 || keys.length === 0) return keys;

  let work = keys.map((key) => normalisePhaseVector(key));

  for (let iter = 0; iter < iters; iter++) {
    const next: ComplexVector[] = [];

    for (let i = 0; i < work.length; i++) {
      const re = new Float64Array(work[i].re);
      const im = new Float64Array(work[i].im);

      for (let j = 0; j < work.length; j++) {
        if (i === j) continue;
        const corr = cosineSimilarity(work[i], work[j]);
        if (Math.abs(corr) < 1e-9) continue;
        for (let d = 0; d < re.length; d++) {
          re[d] -= step * corr * work[j].re[d];
          im[d] -= step * corr * work[j].im[d];
        }
      }

      next.push(normalisePhaseVector({ re, im }));
    }

    work = next;
  }

  return work;
}

// ---------------------------------------------------------------------------
// Signal processing
// ---------------------------------------------------------------------------

/**
 * Contrast increase for noisy superpositions while preserving phase.
 * For unit-magnitude FHRR keys this is effectively a no-op, but recovered
 * memories carry magnitudes that encode evidence strength.
 */
export function sharpen(z: ComplexVector, p = 1.0, eps = 1e-12): ComplexVector {
  if (p === 1.0) return z;
  const D = z.re.length;
  const re = new Float64Array(D);
  const im = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    const mag = Math.sqrt(z.re[d] * z.re[d] + z.im[d] * z.im[d]);
    const scale = (mag + eps) ** (p - 1.0);
    re[d] = z.re[d] * scale;
    im[d] = z.im[d] * scale;
  }
  return { re, im };
}

/**
 * Gentle magnitude limiter that keeps large recovered amplitudes from
 * dominating similarity scoring.
 */
export function corvacsLite(z: ComplexVector, a = 0.0): ComplexVector {
  if (a <= 0) return z;
  const D = z.re.length;
  const re = new Float64Array(D);
  const im = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    const mag = Math.sqrt(z.re[d] * z.re[d] + z.im[d] * z.im[d]) + 1e-12;
    const scale = Math.tanh(a * mag) / mag;
    re[d] = z.re[d] * scale;
    im[d] = z.im[d] * scale;
  }
  return { re, im };
}

export function softmaxTemp(sims: Float64Array, T = 1.0): Float64Array {
  T = Math.max(T, 1e-6);
  const n = sims.length;
  const z = new Float64Array(n);

  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    z[i] = sims[i] / T;
    if (z[i] > max) max = z[i];
  }

  let sum = 0;
  for (let i = 0; i < n; i++) {
    z[i] = Math.exp(z[i] - max);
    sum += z[i];
  }

  sum += 1e-12;
  for (let i = 0; i < n; i++) {
    z[i] /= sum;
  }
  return z;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function stackAndUnitNorm(keys: ComplexVector[]): Float64Array[] {
  if (keys.length === 0) return [];
  const D = keys[0].re.length;
  const D2 = D * 2;
  const rows: Float64Array[] = [];

  for (const key of keys) {
    const row = new Float64Array(D2);
    row.set(key.re, 0);
    row.set(key.im, D);
    let norm = 0;
    for (let d = 0; d < D2; d++) {
      norm += row[d] * row[d];
    }
    norm = 1 / (Math.sqrt(norm) + 1e-12);
    for (let d = 0; d < D2; d++) {
      row[d] *= norm;
    }
    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Bind / Unbind
// ---------------------------------------------------------------------------

/**
 * Bind by phase addition.
 *
 * In split-complex form this is the same as element-wise complex
 * multiplication.
 */
export function bind(a: ComplexVector, b: ComplexVector): ComplexVector {
  const D = a.re.length;
  const re = new Float64Array(D);
  const im = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    const phase = wrapPhase(phaseOf(a.re[d], a.im[d]) + phaseOf(b.re[d], b.im[d]));
    const mag = Math.sqrt(
      (a.re[d] * a.re[d] + a.im[d] * a.im[d]) *
      (b.re[d] * b.re[d] + b.im[d] * b.im[d]),
    );
    re[d] = Math.cos(phase) * mag;
    im[d] = Math.sin(phase) * mag;
  }
  return { re, im };
}

/**
 * Unbind by phase subtraction.
 */
export function unbind(m: ComplexVector, key: ComplexVector): ComplexVector {
  const D = m.re.length;
  const re = new Float64Array(D);
  const im = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    const phase = wrapPhase(phaseOf(m.re[d], m.im[d]) - phaseOf(key.re[d], key.im[d]));
    const mag = Math.sqrt(m.re[d] * m.re[d] + m.im[d] * m.im[d]);
    re[d] = Math.cos(phase) * mag;
    im[d] = Math.sin(phase) * mag;
  }
  return { re, im };
}
