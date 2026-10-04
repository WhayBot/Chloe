// tests/rng.test.js — tes RNG ber-seed
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/rng.js';

describe('rng — seed menghasilkan urutan sama', () => {
  it('dua RNG dengan seed sama → urutan float identik', () => {
    const a = createRng('test-seed-42');
    const b = createRng('test-seed-42');
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(a.float(), b.float(), `float ke-${i} berbeda`);
    }
  });

  it('seed berbeda → urutan berbeda', () => {
    const a = createRng('alpha');
    const b = createRng('beta');
    let same = 0;
    for (let i = 0; i < 50; i++) {
      if (a.float() === b.float()) same++;
    }
    assert.ok(same < 5, 'terlalu banyak kebetulan sama');
  });

  it('seed numerik menghasilkan urutan sama', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    for (let i = 0; i < 50; i++) {
      assert.strictEqual(a.float(), b.float());
    }
  });
});

describe('rng.float', () => {
  it('selalu dalam [0, 1)', () => {
    const r = createRng('range-test');
    for (let i = 0; i < 1000; i++) {
      const v = r.float();
      assert.ok(v >= 0 && v < 1, `float di luar jangkauan: ${v}`);
    }
  });
});

describe('rng.int', () => {
  it('selalu dalam [min, max] inklusif', () => {
    const r = createRng('int-test');
    for (let i = 0; i < 500; i++) {
      const v = r.int(3, 7);
      assert.ok(v >= 3 && v <= 7, `int di luar [3,7]: ${v}`);
    }
  });

  it('mencakup semua nilai dalam rentang kecil', () => {
    const r = createRng('coverage');
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(r.int(0, 3));
    assert.deepStrictEqual([...seen].sort(), [0, 1, 2, 3]);
  });
});

describe('rng.pick', () => {
  it('mengembalikan elemen dari array', () => {
    const r = createRng('pick-test');
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) {
      assert.ok(arr.includes(r.pick(arr)));
    }
  });

  it('array kosong → undefined', () => {
    const r = createRng('empty');
    assert.strictEqual(r.pick([]), undefined);
  });
});

describe('rng.weightedPick', () => {
  it('bobot 0 tidak pernah terpilih', () => {
    const r = createRng('weighted');
    const items = [
      { value: 'a', weight: 1 },
      { value: 'b', weight: 0 },
      { value: 'c', weight: 1 },
    ];
    for (let i = 0; i < 200; i++) {
      assert.notStrictEqual(r.weightedPick(items), 'b');
    }
  });

  it('bobot berat mendominasi', () => {
    const r = createRng('heavy');
    const items = [
      { value: 'rare', weight: 1 },
      { value: 'common', weight: 99 },
    ];
    let commonCount = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (r.weightedPick(items) === 'common') commonCount++;
    }
    assert.ok(commonCount > N * 0.9, `common hanya ${commonCount}/${N}`);
  });

  it('deterministik dengan seed sama', () => {
    const items = [
      { value: 'x', weight: 3 },
      { value: 'y', weight: 7 },
    ];
    const a = createRng('det');
    const b = createRng('det');
    for (let i = 0; i < 50; i++) {
      assert.strictEqual(a.weightedPick(items), b.weightedPick(items));
    }
  });
});

describe('rng.normal', () => {
  it('rata-rata mendekati 0 untuk sampel besar', () => {
    const r = createRng('normal');
    let sum = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) sum += r.normal();
    const mean = sum / N;
    assert.ok(Math.abs(mean) < 0.1, `mean terlalu jauh dari 0: ${mean}`);
  });
});

describe('rng.lognormal', () => {
  it('selalu positif', () => {
    const r = createRng('lognorm');
    for (let i = 0; i < 500; i++) {
      assert.ok(r.lognormal(0, 1) > 0);
    }
  });

  it('median mendekati exp(mu)', () => {
    const r = createRng('ln-median');
    const mu = Math.log(20); // median seharusnya ~20
    const vals = [];
    const N = 5000;
    for (let i = 0; i < N; i++) vals.push(r.lognormal(mu, 0.5));
    vals.sort((a, b) => a - b);
    const median = vals[Math.floor(N / 2)];
    assert.ok(median > 15 && median < 28, `median lognormal: ${median}`);
  });

  it('deterministik', () => {
    const a = createRng('lndet');
    const b = createRng('lndet');
    for (let i = 0; i < 30; i++) {
      assert.strictEqual(a.lognormal(1, 0.5), b.lognormal(1, 0.5));
    }
  });
});
