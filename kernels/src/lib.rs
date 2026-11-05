//! MSM, NTT and QAP kernels for SnarkJS's Groth16 prover.
//!
//! Every function takes and returns the exact byte layouts SnarkJS uses, so a kernel can
//! replace one pipeline stage without touching the rest of the prover:
//!
//! * Field elements are 32 bytes, little-endian. SnarkJS (ffjavascript/wasmcurves) and
//!   arkworks both use Montgomery form with R = 2^256, so the raw bytes of a SnarkJS
//!   element are exactly the internal limbs of an arkworks element. We reinterpret them
//!   (`Fp::new_unchecked`, `.0`) instead of converting, and every operation produces the
//!   same raw bytes SnarkJS would produce.
//! * Proving-key points are affine, Montgomery form, x then y (G2: x.c0, x.c1, y.c0, y.c1).
//!   The point at infinity is stored as all zeros.
//! * MSM scalars are 32-byte little-endian integers in standard (non-Montgomery) form.
//! * MSM results are returned in Jacobian form (x, y, z), Montgomery, like SnarkJS's
//!   `multiExpAffine`, so the rest of the prover can use them unchanged.
//!
//! The same source is compiled natively (src/bin/native_kernels.rs) and to WASM
//! (wasm module below), with or without the `threads` feature.

use ark_bn254::{Fq, Fq2, Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::{short_weierstrass::Affine, AffineRepr, VariableBaseMSM};
use ark_ff::{BigInt, Field, PrimeField};
use ark_poly::{EvaluationDomain, Radix2EvaluationDomain};

#[cfg(feature = "threads")]
use rayon::prelude::*;

pub mod msm_ba;

pub const N8: usize = 32;

// ---------------------------------------------------------------------------
// Raw byte <-> arkworks conversions (no arithmetic, just reinterpretation)
// ---------------------------------------------------------------------------

#[inline]
fn limbs(b: &[u8]) -> BigInt<4> {
    let mut l = [0u64; 4];
    for (i, limb) in l.iter_mut().enumerate() {
        *limb = u64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().unwrap());
    }
    BigInt::new(l)
}

#[inline]
fn put_limbs(out: &mut [u8], v: &BigInt<4>) {
    for i in 0..4 {
        out[i * 8..i * 8 + 8].copy_from_slice(&v.0[i].to_le_bytes());
    }
}

/// Raw Montgomery bytes -> Fr with the same internal representation.
#[inline]
pub fn fr_raw(b: &[u8]) -> Fr {
    Fr::new_unchecked(limbs(b))
}
#[inline]
fn fq_raw(b: &[u8]) -> Fq {
    Fq::new_unchecked(limbs(b))
}
#[inline]
fn put_fr_raw(out: &mut [u8], v: &Fr) {
    put_limbs(out, &v.0)
}
#[inline]
fn put_fq_raw(out: &mut [u8], v: &Fq) {
    put_limbs(out, &v.0)
}

pub fn read_fr_vec(b: &[u8]) -> Vec<Fr> {
    b.chunks_exact(N8).map(fr_raw).collect()
}

pub fn write_fr_vec(v: &[Fr]) -> Vec<u8> {
    let mut out = vec![0u8; v.len() * N8];
    for (o, x) in out.chunks_exact_mut(N8).zip(v) {
        put_fr_raw(o, x);
    }
    out
}

fn is_zero(b: &[u8]) -> bool {
    b.iter().all(|&x| x == 0)
}

fn read_g1_bases(b: &[u8]) -> Vec<G1Affine> {
    let f = |p: &[u8]| {
        if is_zero(p) {
            G1Affine::identity()
        } else {
            Affine::new_unchecked(fq_raw(&p[0..32]), fq_raw(&p[32..64]))
        }
    };
    #[cfg(feature = "threads")]
    {
        b.par_chunks_exact(64).map(f).collect()
    }
    #[cfg(not(feature = "threads"))]
    {
        b.chunks_exact(64).map(f).collect()
    }
}

fn read_g2_bases(b: &[u8]) -> Vec<G2Affine> {
    let f = |p: &[u8]| {
        if is_zero(p) {
            G2Affine::identity()
        } else {
            let x = Fq2::new(fq_raw(&p[0..32]), fq_raw(&p[32..64]));
            let y = Fq2::new(fq_raw(&p[64..96]), fq_raw(&p[96..128]));
            Affine::new_unchecked(x, y)
        }
    };
    #[cfg(feature = "threads")]
    {
        b.par_chunks_exact(128).map(f).collect()
    }
    #[cfg(not(feature = "threads"))]
    {
        b.chunks_exact(128).map(f).collect()
    }
}

fn read_scalars(b: &[u8]) -> Vec<BigInt<4>> {
    b.chunks_exact(N8).map(limbs).collect()
}

// ---------------------------------------------------------------------------
// S5: multi-scalar multiplication (T5.1 / T5.2)
// ---------------------------------------------------------------------------

/// MSM algorithm for S5.
///   0 = arkworks Pippenger with signed digits (T5.1 / T5.2)
///   1 = batch-affine accumulation (T5.3)
///   2 = batch-affine + GLV endomorphism (T5.4)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MsmAlgo {
    Ark = 0,
    BatchAffine = 1,
    BatchAffineGlv = 2,
}

impl MsmAlgo {
    pub fn from_u32(v: u32) -> Self {
        match v {
            1 => MsmAlgo::BatchAffine,
            2 => MsmAlgo::BatchAffineGlv,
            _ => MsmAlgo::Ark,
        }
    }
    pub fn from_name(s: &str) -> Self {
        match s {
            "ba" => MsmAlgo::BatchAffine,
            "glv" | "ba-glv" => MsmAlgo::BatchAffineGlv,
            _ => MsmAlgo::Ark,
        }
    }
}

/// G1 MSM. `bases`: n affine points (64 bytes each). `scalars`: n scalars (32 bytes each).
/// Returns 96 bytes: Jacobian x, y, z in raw Montgomery form.
pub fn msm_g1(bases: &[u8], scalars: &[u8]) -> Vec<u8> {
    msm_g1_with(bases, scalars, MsmAlgo::Ark)
}

pub fn msm_g1_with(bases: &[u8], scalars: &[u8], algo: MsmAlgo) -> Vec<u8> {
    assert_eq!(bases.len() / 64, scalars.len() / N8, "msm_g1: bases and scalars differ in length");
    let b = read_g1_bases(bases);
    let s = read_scalars(scalars);
    let r = match algo {
        MsmAlgo::Ark => G1Projective::msm_bigint(&b, &s),
        MsmAlgo::BatchAffine => msm_ba::msm_ba(&b, &s),
        MsmAlgo::BatchAffineGlv => msm_ba::msm_ba_glv(&b, &s),
    };
    let mut out = vec![0u8; 96];
    put_fq_raw(&mut out[0..32], &r.x);
    put_fq_raw(&mut out[32..64], &r.y);
    put_fq_raw(&mut out[64..96], &r.z);
    out
}

/// G2 MSM. `bases`: n affine points (128 bytes each). Returns 192 bytes (Jacobian, raw).
pub fn msm_g2(bases: &[u8], scalars: &[u8]) -> Vec<u8> {
    msm_g2_with(bases, scalars, MsmAlgo::Ark)
}

pub fn msm_g2_with(bases: &[u8], scalars: &[u8], algo: MsmAlgo) -> Vec<u8> {
    assert_eq!(bases.len() / 128, scalars.len() / N8, "msm_g2: bases and scalars differ in length");
    let b = read_g2_bases(bases);
    let s = read_scalars(scalars);
    let r = match algo {
        MsmAlgo::Ark => G2Projective::msm_bigint(&b, &s),
        MsmAlgo::BatchAffine => msm_ba::msm_ba(&b, &s),
        MsmAlgo::BatchAffineGlv => msm_ba::msm_ba_glv(&b, &s),
    };
    let mut out = vec![0u8; 192];
    for (i, c) in [r.x.c0, r.x.c1, r.y.c0, r.y.c1, r.z.c0, r.z.c1].iter().enumerate() {
        put_fq_raw(&mut out[i * 32..i * 32 + 32], c);
    }
    out
}

// ---------------------------------------------------------------------------
// S4: polynomial stage (T4.1 / T4.2)
// ---------------------------------------------------------------------------

/// One third of the S4 stage, exactly as SnarkJS does it for A, B and C:
///   ifft over the n-th roots of unity, multiply coefficient i by inc^i
///   (inc = primitive 2n-th root), fft again.
/// Result: evaluations at inc * w^j, the "odd" points of the 2n domain.
/// Input and output are raw Montgomery bytes, n = evals.len() / 32 (a power of two).
pub fn coset_eval(evals: &[u8]) -> Vec<u8> {
    let n = evals.len() / N8;
    let mut v = read_fr_vec(evals);
    let domain = Radix2EvaluationDomain::<Fr>::new(n).expect("domain size must be a power of two");
    assert_eq!(domain.size(), n, "input length is not a power of two");
    let inc = Radix2EvaluationDomain::<Fr>::new(2 * n).unwrap().group_gen();
    domain.ifft_in_place(&mut v);
    let coset = domain.get_coset(inc).expect("coset");
    coset.fft_in_place(&mut v);
    write_fr_vec(&v)
}

// ---------------------------------------------------------------------------
// S3: QAP construction (T3.1 / T3.2)
// ---------------------------------------------------------------------------

/// SnarkJS buildABC1: A[c] += coef * w[s] for matrix m (0 = A, 1 = B), then C = A * B.
/// `coeffs` is proving-key section 4 (u32 count, then entries of m, c, s, coef).
/// `witness` is the witness (standard form). Returns A | B | C, each n * 32 bytes, raw.
pub fn build_abc(coeffs: &[u8], witness: &[u8], domain_size: usize) -> Vec<u8> {
    let n = domain_size;
    let s_coef = 12 + N8;
    let n_coef = u32::from_le_bytes(coeffs[0..4].try_into().unwrap()) as usize;
    assert_eq!(coeffs.len(), 4 + n_coef * s_coef, "unexpected coefficient section size");
    let w = read_fr_vec(witness);
    let entry = |i: usize| {
        let e = &coeffs[4 + i * s_coef..4 + (i + 1) * s_coef];
        let m = u32::from_le_bytes(e[0..4].try_into().unwrap()) as usize;
        let c = u32::from_le_bytes(e[4..8].try_into().unwrap()) as usize;
        let s = u32::from_le_bytes(e[8..12].try_into().unwrap()) as usize;
        (m * n + c, s, fr_raw(&e[12..12 + N8]))
    };

    let mut ab = vec![Fr::from(0u64); 2 * n];

    #[cfg(not(feature = "threads"))]
    {
        // T3.1: the same loop as SnarkJS, but one WASM call instead of one per element
        for i in 0..n_coef {
            let (t, s, coef) = entry(i);
            ab[t] += coef * w[s];
        }
    }
    #[cfg(feature = "threads")]
    {
        // T3.2: group entries by output row (counting sort, cheap integer work),
        // then each row is summed independently on the thread pool.
        // Field addition is exact modular arithmetic, so the order of additions
        // does not change the result.
        let mut counts = vec![0u32; 2 * n + 1];
        for i in 0..n_coef {
            let e = &coeffs[4 + i * s_coef..];
            let m = u32::from_le_bytes(e[0..4].try_into().unwrap()) as usize;
            let c = u32::from_le_bytes(e[4..8].try_into().unwrap()) as usize;
            counts[m * n + c + 1] += 1;
        }
        for t in 0..2 * n {
            counts[t + 1] += counts[t];
        }
        let mut pos: Vec<u32> = counts[..2 * n].to_vec();
        let mut order = vec![0u32; n_coef];
        for i in 0..n_coef {
            let e = &coeffs[4 + i * s_coef..];
            let m = u32::from_le_bytes(e[0..4].try_into().unwrap()) as usize;
            let c = u32::from_le_bytes(e[4..8].try_into().unwrap()) as usize;
            let t = m * n + c;
            order[pos[t] as usize] = i as u32;
            pos[t] += 1;
        }
        ab.par_iter_mut().enumerate().for_each(|(t, out)| {
            let mut acc = Fr::from(0u64);
            for &i in &order[counts[t] as usize..counts[t + 1] as usize] {
                let (_, s, coef) = entry(i as usize);
                acc += coef * w[s];
            }
            *out = acc;
        });
    }

    let (a, b) = ab.split_at(n);
    #[cfg(feature = "threads")]
    let c: Vec<Fr> = a.par_iter().zip(b.par_iter()).map(|(x, y)| *x * y).collect();
    #[cfg(not(feature = "threads"))]
    let c: Vec<Fr> = a.iter().zip(b.iter()).map(|(x, y)| *x * y).collect();

    let mut out = Vec::with_capacity(3 * n * N8);
    out.extend_from_slice(&write_fr_vec(a));
    out.extend_from_slice(&write_fr_vec(b));
    out.extend_from_slice(&write_fr_vec(&c));
    out
}

/// SnarkJS joinABC: P = A * B - C, then converted out of Montgomery form
/// (the H MSM needs standard-form scalars). Inputs raw Montgomery, output standard.
pub fn join_abc(a: &[u8], b: &[u8], c: &[u8]) -> Vec<u8> {
    let n = a.len() / N8;
    assert!(b.len() == a.len() && c.len() == a.len());
    let f = |i: usize| {
        let p = fr_raw(&a[i * N8..]) * fr_raw(&b[i * N8..]) - fr_raw(&c[i * N8..]);
        p.into_bigint()
    };
    let mut out = vec![0u8; n * N8];
    #[cfg(feature = "threads")]
    out.par_chunks_exact_mut(N8).enumerate().for_each(|(i, o)| put_limbs(o, &f(i)));
    #[cfg(not(feature = "threads"))]
    out.chunks_exact_mut(N8).enumerate().for_each(|(i, o)| put_limbs(o, &f(i)));
    out
}

// ---------------------------------------------------------------------------
// Per-operation microbenchmark (week 2): the same loops natively and in WASM
// ---------------------------------------------------------------------------

/// `iters` dependent Fr multiplications (a serial chain, so the compiler cannot skip them).
/// Returns a checksum so the work is not optimised away.
pub fn micro_fr_mul(iters: u32) -> u64 {
    let mut x = Fr::from(7u64);
    let y = Fr::from(0x1234_5678_9abc_def1u64).square();
    for _ in 0..iters {
        x *= y;
    }
    x.0 .0[0]
}

/// `iters` dependent G1 mixed additions (Jacobian + affine), the inner operation of MSM.
pub fn micro_g1_add(iters: u32) -> u64 {
    let g = G1Affine::generator();
    let mut acc = G1Projective::from(g);
    for _ in 0..iters {
        acc += g;
    }
    acc.x.0 .0[0]
}

/// Number of worker threads the kernels will use (1 without the `threads` feature).
pub fn kernel_threads() -> usize {
    #[cfg(feature = "threads")]
    {
        rayon::current_num_threads()
    }
    #[cfg(not(feature = "threads"))]
    {
        1
    }
}

// ---------------------------------------------------------------------------
// WASM bindings (wasm-bindgen). Slices are copied into WASM memory by the glue code;
// that copy is part of the stage time measured by the caller.
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    #[cfg(feature = "threads")]
    pub use wasm_bindgen_rayon::init_thread_pool;

    /// `algo`: 0 = arkworks (T5.1/T5.2), 1 = batch-affine (T5.3), 2 = batch-affine + GLV (T5.4)
    #[wasm_bindgen]
    pub fn msm_g1(bases: &[u8], scalars: &[u8], algo: u32) -> Vec<u8> {
        super::msm_g1_with(bases, scalars, super::MsmAlgo::from_u32(algo))
    }
    #[wasm_bindgen]
    pub fn msm_g2(bases: &[u8], scalars: &[u8], algo: u32) -> Vec<u8> {
        super::msm_g2_with(bases, scalars, super::MsmAlgo::from_u32(algo))
    }
    #[wasm_bindgen]
    pub fn coset_eval(evals: &[u8]) -> Vec<u8> {
        super::coset_eval(evals)
    }
    #[wasm_bindgen]
    pub fn build_abc(coeffs: &[u8], witness: &[u8], domain_size: u32) -> Vec<u8> {
        super::build_abc(coeffs, witness, domain_size as usize)
    }
    #[wasm_bindgen]
    pub fn join_abc(a: &[u8], b: &[u8], c: &[u8]) -> Vec<u8> {
        super::join_abc(a, b, c)
    }
    #[wasm_bindgen]
    pub fn micro_fr_mul(iters: u32) -> f64 {
        super::micro_fr_mul(iters) as f64
    }
    #[wasm_bindgen]
    pub fn micro_g1_add(iters: u32) -> f64 {
        super::micro_g1_add(iters) as f64
    }
    #[wasm_bindgen]
    pub fn kernel_threads() -> u32 {
        super::kernel_threads() as u32
    }
    /// Build flags baked into this module, recorded with every result.
    #[wasm_bindgen]
    pub fn build_info() -> String {
        let mut f = vec![];
        if cfg!(feature = "threads") { f.push("threads"); }
        if cfg!(target_feature = "wide-arithmetic") { f.push("wide-arithmetic"); }
        if cfg!(target_feature = "simd128") { f.push("simd128"); }
        if f.is_empty() { "plain".into() } else { f.join("+") }
    }
}

// ---------------------------------------------------------------------------
// Tests: the ported MSMs must give exactly the same point as arkworks' MSM
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::CurveGroup;
    use ark_std::{test_rng, UniformRand};

    fn check<P>(n: usize, special: bool)
    where
        P: ark_ec::scalar_mul::glv::GLVConfig,
        P::ScalarField: PrimeField<BigInt = BigInt<4>>,
        ark_ec::short_weierstrass::Projective<P>: VariableBaseMSM<MulBase = Affine<P>, ScalarField = P::ScalarField>,
    {
        let mut rng = test_rng();
        let mut bases: Vec<Affine<P>> =
            (0..n).map(|_| ark_ec::short_weierstrass::Projective::<P>::rand(&mut rng).into_affine()).collect();
        let mut ks: Vec<BigInt<4>> = (0..n).map(|_| P::ScalarField::rand(&mut rng).into_bigint()).collect();
        if special && n >= 8 {
            // duplicates (doubling), negations (cancellation), identity, zero and one scalars
            bases[1] = bases[0];
            ks[1] = ks[0];
            bases[3] = -bases[2];
            ks[3] = ks[2];
            bases[4] = Affine::identity();
            ks[5] = BigInt::from(0u64);
            ks[6] = BigInt::from(1u64);
            ks[7] = (-P::ScalarField::from(1u64)).into_bigint();
        }
        let want = ark_ec::short_weierstrass::Projective::<P>::msm_bigint(&bases, &ks);
        assert_eq!(msm_ba::msm_ba(&bases, &ks), want, "batch-affine, n={n}");
        assert_eq!(msm_ba::msm_ba_glv(&bases, &ks), want, "batch-affine+GLV, n={n}");
    }

    #[test]
    fn g1_matches_arkworks() {
        for &n in &[1usize, 2, 7, 8, 33, 500, 4096, 20000] {
            check::<ark_bn254::g1::Config>(n, true);
        }
    }

    #[test]
    fn g2_matches_arkworks() {
        for &n in &[1usize, 8, 100, 3000] {
            check::<ark_bn254::g2::Config>(n, true);
        }
    }

    #[test]
    fn many_equal_points_force_collisions() {
        // every point the same and small scalars: maximal bucket collisions
        let g = G1Affine::generator();
        let bases = vec![g; 5000];
        let ks: Vec<BigInt<4>> = (0..5000u64).map(|i| BigInt::from(i % 7 + 1)).collect();
        let want = G1Projective::msm_bigint(&bases, &ks);
        assert_eq!(msm_ba::msm_ba(&bases, &ks), want);
        assert_eq!(msm_ba::msm_ba_glv(&bases, &ks), want);
    }
}
