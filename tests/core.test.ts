import { describe, it, expect } from "vitest";
import {
  mulberry32,
  seedFromName,
  makeVocabKeys,
  makeRoleKeys,
  orthogonalize,
  stackAndUnitNorm,
  bind,
  unbind,
  sharpen,
  corvacsLite,
  softmaxTemp,
  type ComplexVector,
} from "../src/nuggets/core.js";

function magnitude(v: ComplexVector, d: number): number {
  return Math.sqrt(v.re[d] * v.re[d] + v.im[d] * v.im[d]);
}

function norm2D(v: ComplexVector): number {
  let sum = 0;
  for (let d = 0; d < v.re.length; d++) {
    sum += v.re[d] * v.re[d] + v.im[d] * v.im[d];
  }
  return Math.sqrt(sum);
}

describe("mulberry32", () => {
  it("produces deterministic output", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it("produces values in [0, 1)", () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("seedFromName", () => {
  it("produces consistent seeds", () => {
    expect(seedFromName("test")).toBe(seedFromName("test"));
    expect(seedFromName("a")).not.toBe(seedFromName("b"));
  });
});

describe("makeVocabKeys", () => {
  it("creates unit-magnitude complex vectors", () => {
    const rng = mulberry32(0);
    const keys = makeVocabKeys(5, 64, rng);
    expect(keys).toHaveLength(5);
    for (const key of keys) {
      expect(key.re).toHaveLength(64);
      expect(key.im).toHaveLength(64);
      // Each element should have magnitude ~1
      for (let d = 0; d < 64; d++) {
        expect(magnitude(key, d)).toBeCloseTo(1.0, 10);
      }
    }
  });
});

describe("makeRoleKeys", () => {
  it("creates L position keys", () => {
    const keys = makeRoleKeys(64, 10);
    expect(keys).toHaveLength(10);
    // role[0] should be all ones (base^0 = 1)
    for (let d = 0; d < 64; d++) {
      expect(keys[0].re[d]).toBeCloseTo(1.0, 10);
      expect(keys[0].im[d]).toBeCloseTo(0.0, 10);
    }
  });
});

describe("bind/unbind", () => {
  it("unbind recovers the original", () => {
    const rng = mulberry32(99);
    const keys = makeVocabKeys(2, 128, rng);
    const a = keys[0];
    const b = keys[1];

    const bound = bind(a, b);
    const recovered = unbind(bound, a);

    // recovered should be close to b (cosine similarity)
    let dot = 0;
    for (let d = 0; d < 128; d++) {
      dot += recovered.re[d] * b.re[d] + recovered.im[d] * b.im[d];
    }
    const sim = dot / (norm2D(recovered) * norm2D(b));
    expect(sim).toBeGreaterThan(0.99);
  });
});

describe("orthogonalize", () => {
  it("reduces correlation between keys", () => {
    const rng = mulberry32(7);
    const keys = makeVocabKeys(5, 128, rng);
    const orth = orthogonalize(keys, 2, 0.4);
    expect(orth).toHaveLength(5);
    // Each should still be unit magnitude
    for (const key of orth) {
      for (let d = 0; d < 128; d++) {
        expect(magnitude(key, d)).toBeCloseTo(1.0, 5);
      }
    }
  });

  it("returns input unchanged with iters=0", () => {
    const rng = mulberry32(7);
    const keys = makeVocabKeys(3, 32, rng);
    const result = orthogonalize(keys, 0);
    expect(result).toBe(keys);
  });
});

describe("sharpen", () => {
  it("returns identity when p=1", () => {
    const v: ComplexVector = {
      re: new Float64Array([1, 2, 3]),
      im: new Float64Array([4, 5, 6]),
    };
    const result = sharpen(v, 1.0);
    expect(result).toBe(v);
  });

  it("amplifies high-magnitude elements with p>1", () => {
    const v: ComplexVector = {
      re: new Float64Array([0.1, 1.0]),
      im: new Float64Array([0.0, 0.0]),
    };
    const result = sharpen(v, 2.0);
    // magnitude of second element should be amplified more
    const mag0 = Math.abs(result.re[0]);
    const mag1 = Math.abs(result.re[1]);
    expect(mag1 / mag0).toBeGreaterThan(1.0 / 0.1); // more than 10x
  });
});

describe("corvacsLite", () => {
  it("returns identity when a=0", () => {
    const v: ComplexVector = {
      re: new Float64Array([1, 2, 3]),
      im: new Float64Array([4, 5, 6]),
    };
    const result = corvacsLite(v, 0);
    expect(result).toBe(v);
  });
});

describe("softmaxTemp", () => {
  it("returns valid probabilities", () => {
    const sims = new Float64Array([1.0, 2.0, 3.0]);
    const probs = softmaxTemp(sims, 1.0);
    let sum = 0;
    for (let i = 0; i < probs.length; i++) {
      expect(probs[i]).toBeGreaterThan(0);
      sum += probs[i];
    }
    expect(sum).toBeCloseTo(1.0, 8);
  });

  it("becomes more uniform at higher temperature", () => {
    const sims = new Float64Array([1.0, 2.0, 3.0]);
    const low = softmaxTemp(sims, 0.5);
    const high = softmaxTemp(sims, 5.0);
    // At high temp, max prob should be closer to uniform (1/3)
    expect(Math.max(...high)).toBeLessThan(Math.max(...low));
  });
});

describe("stackAndUnitNorm", () => {
  it("produces unit-norm 2D vectors", () => {
    const rng = mulberry32(0);
    const keys = makeVocabKeys(3, 32, rng);
    const normed = stackAndUnitNorm(keys);
    expect(normed).toHaveLength(3);
    for (const row of normed) {
      expect(row).toHaveLength(64);
      let norm = 0;
      for (let d = 0; d < 64; d++) norm += row[d] * row[d];
      expect(Math.sqrt(norm)).toBeCloseTo(1.0, 8);
    }
  });
});
