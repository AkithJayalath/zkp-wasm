//! Ported native MSM algorithms (T5.3 and T5.4).
//!
//! T5.3 = Pippenger with signed digits, where bucket accumulation is done in AFFINE
//!        coordinates and many additions share one field inversion (Montgomery's batch
//!        inversion trick). Affine addition costs about 6 multiplications once the
//!        inversion is shared, against about 11 for the mixed Jacobian addition arkworks
//!        uses. Bucket reduction then uses mixed additions from the affine buckets.
//! T5.4 = T5.3 + the GLV endomorphism: every scalar k is split into k1 + lambda*k2 with
//!        k1, k2 about 128 bits, and every base P gets a partner phi(P), so the MSM has
//!        twice the points but half the windows.
//!
//! Both are standard in fast native MSMs (Aztec/Barretenberg, the ZPrize 2022 entries,
//! ark-msm). Rapidsnark uses neither. The same code is compiled natively and to WASM.

use ark_ec::{
    scalar_mul::glv::GLVConfig,
    short_weierstrass::{Affine, Projective, SWCurveConfig},
    AdditiveGroup,
};
use ark_ff::{batch_inversion, BigInt, BigInteger, Field, PrimeField, Zero};

#[cfg(feature = "threads")]
use rayon::prelude::*;

/// Number of additions that share one inversion. Larger batches amortise the inversion
/// better; 256 already makes it a small cost, and keeps the scratch arrays in cache.
const BATCH: usize = 256;

/// Window size: arkworks' rule (0.69 * log2 n + 2), which measured best or within noise
/// of best for batch-affine on BN254 G1 at 2^14 and 2^16 points. Capped at 15 so a signed
/// digit fits in an i16. MSM_C overrides it (native tuning runs only).
fn window_bits(n: usize) -> usize {
    if let Ok(v) = std::env::var("MSM_C") {
        if let Ok(c) = v.parse::<usize>() {
            return c.clamp(2, 15);
        }
    }
    if n < 32 {
        3
    } else {
        ((ark_std::log2(n) as usize * 69 / 100) + 2).min(15)
    }
}

#[inline]
fn bits_at(k: &BigInt<4>, off: usize, c: usize) -> u64 {
    let limb = off / 64;
    let sh = off % 64;
    if limb >= 4 {
        return 0;
    }
    let mut v = k.0[limb] >> sh;
    if sh + c > 64 && limb + 1 < 4 {
        v |= k.0[limb + 1] << (64 - sh);
    }
    v & ((1u64 << c) - 1)
}

/// Signed-digit recoding, window-major: digits[w * n + i] in [-2^(c-1), 2^(c-1)].
fn signed_digits(ks: &[BigInt<4>], c: usize, windows: usize) -> Vec<i16> {
    let n = ks.len();
    let mut d = vec![0i16; windows * n];
    let half = 1i64 << (c - 1);
    let full = 1i64 << c;
    for (i, k) in ks.iter().enumerate() {
        let mut carry = 0i64;
        for w in 0..windows {
            let mut v = bits_at(k, w * c, c) as i64 + carry;
            if v > half {
                v -= full;
                carry = 1;
            } else {
                carry = 0;
            }
            d[w * n + i] = v as i16;
        }
    }
    d
}

/// Affine buckets with batched additions. A bucket equal to `Affine::identity()` is empty.
struct Buckets<P: SWCurveConfig> {
    b: Vec<Affine<P>>,
    stamp: Vec<u32>,
    round: u32,
    cap: usize,
    // scratch for one batch
    idx: Vec<u32>,
    pts: Vec<Affine<P>>,
    den: Vec<P::BaseField>,
}

impl<P: SWCurveConfig> Buckets<P> {
    fn new(m: usize) -> Self {
        Self {
            b: vec![Affine::identity(); m],
            stamp: vec![0; m],
            round: 1,
            cap: std::env::var("MSM_B").ok().map(|v| v.parse().unwrap()).unwrap_or(BATCH),
            idx: Vec::with_capacity(BATCH),
            pts: Vec::with_capacity(BATCH),
            den: Vec::with_capacity(BATCH),
        }
    }

    /// Queue bucket[j] += p. Returns false if bucket j already has an addition waiting in
    /// this batch (the caller retries it in a later pass).
    #[inline]
    fn push(&mut self, j: usize, p: Affine<P>) -> bool {
        if self.stamp[j] == self.round {
            return false;
        }
        if self.b[j].infinity {
            self.b[j] = p; // empty bucket: no addition needed
            return true;
        }
        self.stamp[j] = self.round;
        self.idx.push(j as u32);
        self.pts.push(p);
        if self.idx.len() == self.cap {
            self.flush();
        }
        true
    }

    /// Apply every queued addition with one shared inversion.
    fn flush(&mut self) {
        if self.idx.is_empty() {
            return;
        }
        self.den.clear();
        for (k, &j) in self.idx.iter().enumerate() {
            let q = &self.b[j as usize];
            let p = &self.pts[k];
            let d = if q.x != p.x {
                p.x - q.x
            } else if q.y == p.y && !q.y.is_zero() {
                q.y.double() // doubling: lambda = 3x^2 / 2y (a = 0 for BN254 G1 and G2)
            } else {
                P::BaseField::ONE // P + (-P): result is empty, denominator unused
            };
            self.den.push(d);
        }
        batch_inversion(&mut self.den);
        for (k, &j) in self.idx.iter().enumerate() {
            let q = self.b[j as usize];
            let p = self.pts[k];
            let r = if q.x != p.x {
                let l = (p.y - q.y) * self.den[k];
                let x3 = l.square() - q.x - p.x;
                Affine::new_unchecked(x3, l * (q.x - x3) - q.y)
            } else if q.y == p.y && !q.y.is_zero() {
                let x2 = q.x.square();
                let l = (x2.double() + x2 + P::COEFF_A) * self.den[k];
                let x3 = l.square() - q.x.double();
                Affine::new_unchecked(x3, l * (q.x - x3) - q.y)
            } else {
                Affine::identity()
            };
            self.b[j as usize] = r;
        }
        self.idx.clear();
        self.pts.clear();
        self.round = self.round.wrapping_add(1).max(1);
    }

    /// sum_j (j+1) * bucket[j], with the usual running sum (mixed additions).
    fn reduce(&self) -> Projective<P> {
        let mut running = Projective::<P>::zero();
        let mut sum = Projective::<P>::zero();
        for q in self.b.iter().rev() {
            if !q.infinity {
                running += q;
            }
            sum += running;
        }
        sum
    }
}

/// One window: accumulate every point into its bucket, then reduce.
fn window_sum<P: SWCurveConfig>(pts: &[Affine<P>], digits: &[i16], m: usize) -> Projective<P> {
    // A window that uses only a few buckets (the top window of the signed recoding, or
    // tiny MSMs) would put the same bucket in a batch again and again, leaving batches
    // of one or two additions that each pay a full inversion. Such windows use ordinary
    // mixed additions instead; every full window uses batch-affine additions.
    let used = digits.iter().map(|d| d.unsigned_abs() as usize).max().unwrap_or(0);
    if used < 4 * BATCH {
        return window_sum_projective(pts, digits, used);
    }
    let mut bk = Buckets::<P>::new(m);
    // First pass over all points; collisions within a batch are deferred.
    let mut deferred: Vec<u32> = Vec::new();
    for (i, &d) in digits.iter().enumerate() {
        if d == 0 || pts[i].infinity {
            continue;
        }
        let (j, p) = if d > 0 { (d as usize - 1, pts[i]) } else { ((-d) as usize - 1, -pts[i]) };
        if !bk.push(j, p) {
            deferred.push(i as u32);
        }
    }
    bk.flush();
    // Retry deferred points until none are left (usually one or two short passes).
    while !deferred.is_empty() {
        let mut again = Vec::new();
        for &i in &deferred {
            let d = digits[i as usize];
            let (j, p) = if d > 0 { (d as usize - 1, pts[i as usize]) } else { ((-d) as usize - 1, -pts[i as usize]) };
            if !bk.push(j, p) {
                again.push(i);
            }
        }
        bk.flush();
        deferred = again;
    }
    bk.reduce()
}

/// Fallback for windows with few buckets: Jacobian buckets, mixed additions.
fn window_sum_projective<P: SWCurveConfig>(pts: &[Affine<P>], digits: &[i16], m: usize) -> Projective<P> {
    if m == 0 {
        return Projective::zero();
    }
    let mut b = vec![Projective::<P>::zero(); m];
    for (i, &d) in digits.iter().enumerate() {
        if d > 0 {
            b[d as usize - 1] += &pts[i];
        } else if d < 0 {
            b[(-d) as usize - 1] -= &pts[i];
        }
    }
    let mut running = Projective::<P>::zero();
    let mut sum = Projective::<P>::zero();
    for q in b.iter().rev() {
        running += q;
        sum += running;
    }
    sum
}

/// Core batch-affine Pippenger. `ks` are standard-form integers below 2^num_bits.
pub fn msm_batch_affine<P: SWCurveConfig>(pts: &[Affine<P>], ks: &[BigInt<4>], num_bits: usize) -> Projective<P> {
    assert_eq!(pts.len(), ks.len());
    let n = pts.len();
    if n == 0 {
        return Projective::zero();
    }
    let c = window_bits(n);
    let windows = num_bits / c + 1; // +1 for the final carry of the signed recoding
    let m = 1usize << (c - 1); // signed digits halve the bucket count
    let digits = signed_digits(ks, c, windows);

    #[cfg(feature = "threads")]
    let sums: Vec<Projective<P>> = (0..windows).into_par_iter().map(|w| window_sum(pts, &digits[w * n..(w + 1) * n], m)).collect();
    #[cfg(not(feature = "threads"))]
    let sums: Vec<Projective<P>> = (0..windows).map(|w| window_sum(pts, &digits[w * n..(w + 1) * n], m)).collect();

    let mut total = Projective::<P>::zero();
    for s in sums.iter().rev() {
        for _ in 0..c {
            total.double_in_place();
        }
        total += s;
    }
    total
}

/// T5.3: batch-affine MSM over full-length scalars.
pub fn msm_ba<P: SWCurveConfig>(bases: &[Affine<P>], ks: &[BigInt<4>]) -> Projective<P> {
    let bits = P::ScalarField::MODULUS_BIT_SIZE as usize;
    msm_batch_affine(bases, ks, bits)
}

/// Fast GLV scalar split (Babai rounding with precomputed constants), the way native
/// libraries do it. arkworks' `scalar_decomposition` gives the same kind of split but
/// allocates heap integers for every scalar, which cost ~16% of the whole MSM.
///
/// With the lattice basis (n11, n12; n21, n22) from `P::SCALAR_DECOMP_COEFFS`:
///   beta1 = round(k * n22 / r), beta2 = round(-k * n12 / r)
///   k2 = -(beta1 * n12 + beta2 * n22),  k1 = k - lambda * k2   (mod r)
/// beta is computed as (k * g) >> 256 with g = floor(2^256 * |n| / r); it can be one
/// below the exact rounding, which only makes |k1|, |k2| a few bits larger (still about
/// 128 bits). The identity k = k1 + lambda * k2 holds exactly either way.
struct GlvSplit<P: GLVConfig> {
    g1: BigInt<4>,
    g2: BigInt<4>,
    beta1_neg: bool,
    beta2_neg: bool,
    n: [P::ScalarField; 4],
}

fn mul_shr256(a: &BigInt<4>, b: &BigInt<4>) -> BigInt<4> {
    let mut t = [0u64; 8];
    for i in 0..4 {
        let mut carry = 0u128;
        for j in 0..4 {
            let cur = t[i + j] as u128 + (a.0[i] as u128) * (b.0[j] as u128) + carry;
            t[i + j] = cur as u64;
            carry = cur >> 64;
        }
        t[i + 4] = carry as u64;
    }
    BigInt::new([t[4], t[5], t[6], t[7]])
}

impl<P: GLVConfig> GlvSplit<P>
where
    P::ScalarField: PrimeField<BigInt = BigInt<4>>,
{
    fn new() -> Self {
        use num_bigint::BigUint;
        let r: BigUint = P::ScalarField::MODULUS.into();
        let g = |x: &BigInt<4>| -> BigInt<4> {
            let v: BigUint = (BigUint::from(1u8) << 256) * BigUint::from(*x) / &r;
            BigInt::try_from(v).expect("rounding constant fits in 256 bits")
        };
        let c = P::SCALAR_DECOMP_COEFFS; // (positive?, |n|) for n11, n12, n21, n22
        let f = |(pos, v): (bool, BigInt<4>)| {
            let x = P::ScalarField::from_bigint(v).unwrap();
            if pos { x } else { -x }
        };
        Self {
            g1: g(&c[3].1),
            g2: g(&c[1].1),
            beta1_neg: !c[3].0,      // sign(n22)
            beta2_neg: c[1].0,       // sign(-n12)
            n: [f(c[0]), f(c[1]), f(c[2]), f(c[3])],
        }
    }

    #[inline]
    fn split(&self, k: &BigInt<4>) -> ((bool, BigInt<4>), (bool, BigInt<4>)) {
        let s = |v: BigInt<4>, neg: bool| {
            let x = P::ScalarField::from_bigint(v).unwrap();
            if neg { -x } else { x }
        };
        let b1 = s(mul_shr256(k, &self.g1), self.beta1_neg);
        let b2 = s(mul_shr256(k, &self.g2), self.beta2_neg);
        let k2 = -(b1 * self.n[1] + b2 * self.n[3]);
        let kf = P::ScalarField::from_bigint(*k).expect("scalar below the group order");
        let k1 = kf - P::LAMBDA * k2;
        let signed = |x: P::ScalarField| {
            let v = x.into_bigint();
            if v.0[2] == 0 && v.0[3] == 0 { (true, v) } else { (false, (-x).into_bigint()) }
        };
        (signed(k1), signed(k2))
    }
}

/// T5.4: GLV split, then batch-affine MSM over 2n half-length scalars.
pub fn msm_ba_glv<P: GLVConfig>(bases: &[Affine<P>], ks: &[BigInt<4>]) -> Projective<P>
where
    P::ScalarField: PrimeField<BigInt = BigInt<4>>,
{
    let n = bases.len();
    let g = GlvSplit::<P>::new();
    let split = |i: usize| -> (Affine<P>, BigInt<4>, Affine<P>, BigInt<4>) {
        let p = bases[i];
        let ((s1, k1), (s2, k2)) = g.split(&ks[i]);
        let phi = if p.infinity { p } else { P::endomorphism_affine(&p) };
        let p1 = if s1 { p } else { -p };
        let p2 = if s2 { phi } else { -phi };
        (p1, k1, p2, k2)
    };
    #[cfg(feature = "threads")]
    let parts: Vec<_> = (0..n).into_par_iter().map(split).collect();
    #[cfg(not(feature = "threads"))]
    let parts: Vec<_> = (0..n).map(split).collect();

    let mut pts = Vec::with_capacity(2 * n);
    let mut sc = Vec::with_capacity(2 * n);
    let mut maxbits = 0u32;
    for (p1, k1, p2, k2) in parts {
        maxbits = maxbits.max(k1.num_bits()).max(k2.num_bits());
        pts.push(p1);
        sc.push(k1);
        pts.push(p2);
        sc.push(k2);
    }
    msm_batch_affine(&pts, &sc, maxbits.max(1) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_std::{test_rng, UniformRand};

    fn split_ok<P: GLVConfig>()
    where
        P::ScalarField: PrimeField<BigInt = BigInt<4>>,
    {
        let g = GlvSplit::<P>::new();
        let mut rng = test_rng();
        let mut ks: Vec<P::ScalarField> = (0..2000).map(|_| P::ScalarField::rand(&mut rng)).collect();
        ks.extend([P::ScalarField::ZERO, P::ScalarField::ONE, -P::ScalarField::ONE, P::LAMBDA]);
        for k in ks {
            let ((s1, k1), (s2, k2)) = g.split(&k.into_bigint());
            let f = |s: bool, v: BigInt<4>| {
                let x = P::ScalarField::from_bigint(v).unwrap();
                if s { x } else { -x }
            };
            assert_eq!(f(s1, k1) + P::LAMBDA * f(s2, k2), k);
            assert!(k1.num_bits() <= 130 && k2.num_bits() <= 130, "{} {}", k1.num_bits(), k2.num_bits());
        }
    }

    #[test]
    fn glv_split_g1() {
        split_ok::<ark_bn254::g1::Config>();
    }
    #[test]
    fn glv_split_g2() {
        split_ok::<ark_bn254::g2::Config>();
    }
}
