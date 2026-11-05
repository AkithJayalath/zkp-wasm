//! N-K: the same kernels as the WASM build, compiled natively.
//! Runs the S3, S4 and S5 stages of a Groth16 proof on a real proving key and witness,
//! in the same order and with the same stage names as the SnarkJS timers.
//!
//!   native_kernels <circuit> <file.zkey> <file.wtns> <runs> <warmup> <threads-label>
//!
//! Prints one JSON line per run (1 cold, `warmup` discarded, `runs` measured).
//! Build without `--features threads` for the 1-thread reference, with it for all cores
//! (rayon uses every logical core unless RAYON_NUM_THREADS is set).
//! MSM_ALGO=ark|ba|glv picks the S5 algorithm (T5.1/T5.2, T5.3, T5.4); default ark.
use std::time::Instant;
use zkp_kernels::*;

struct BinFile {
    sections: Vec<(u32, Vec<u8>)>,
}

impl BinFile {
    fn read(path: &str, magic: &[u8; 4]) -> BinFile {
        let b = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert_eq!(&b[0..4], magic, "{path}: not a {} file", String::from_utf8_lossy(magic));
        let n = u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize;
        let mut p = 12;
        let mut sections = vec![];
        for _ in 0..n {
            let t = u32::from_le_bytes(b[p..p + 4].try_into().unwrap());
            let len = u64::from_le_bytes(b[p + 4..p + 12].try_into().unwrap()) as usize;
            sections.push((t, b[p + 12..p + 12 + len].to_vec()));
            p += 12 + len;
        }
        BinFile { sections }
    }
    fn section(&self, t: u32) -> &[u8] {
        &self.sections.iter().find(|s| s.0 == t).unwrap_or_else(|| panic!("missing section {t}")).1
    }
}

fn u32_at(b: &[u8], p: usize) -> usize {
    u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) as usize
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 7 {
        eprintln!("usage: native_kernels <circuit> <zkey> <wtns> <runs> <warmup> <threads-label>");
        std::process::exit(2);
    }
    let (circuit, runs, warmup, tlabel) = (&a[1], a[4].parse::<usize>().unwrap(), a[5].parse::<usize>().unwrap(), &a[6]);
    let zkey = BinFile::read(&a[2], b"zkey");
    let wtns = BinFile::read(&a[3], b"wtns");

    // Groth16 header (section 2): n8q, q, n8r, r, nVars, nPublic, domainSize, ...
    let h = zkey.section(2);
    let n8q = u32_at(h, 0);
    let n8r = u32_at(h, 4 + n8q);
    let p = 8 + n8q + n8r;
    let n_public = u32_at(h, p + 4);
    let domain = u32_at(h, p + 8);
    let witness = wtns.section(2);
    let (coeffs, ba, bb1, bb2, bc, bh) =
        (zkey.section(4), zkey.section(5), zkey.section(6), zkey.section(7), zkey.section(8), zkey.section(9));
    let wc = &witness[(n_public + 1) * N8..];
    let algo_name = std::env::var("MSM_ALGO").unwrap_or_else(|_| "ark".into());
    let algo = MsmAlgo::from_name(&algo_name);

    let total = 1 + warmup + runs;
    for iter in 0..total {
        let phase = if iter == 0 { "cold" } else if iter <= warmup { "warmup" } else { "warm" };
        let mut st: Vec<(&str, f64)> = vec![];
        let mut lap = {
            let mut t = Instant::now();
            move |name: &'static str, st: &mut Vec<(&str, f64)>| {
                let now = Instant::now();
                st.push((name, (now - t).as_secs_f64() * 1e3));
                t = now;
            }
        };
        let abc = build_abc(coeffs, witness, domain);
        lap("S3_buildABC", &mut st);
        let n = domain * N8;
        let ao = coset_eval(&abc[0..n]);
        let bo = coset_eval(&abc[n..2 * n]);
        let co = coset_eval(&abc[2 * n..3 * n]);
        lap("S4_fft", &mut st);
        let pp = join_abc(&ao, &bo, &co);
        lap("S3_joinABC", &mut st);
        let r = [msm_g1_with(ba, witness, algo)];
        lap("S5_msm_A", &mut st);
        let r1 = [msm_g1_with(bb1, witness, algo)];
        lap("S5_msm_B1", &mut st);
        let r2 = [msm_g2_with(bb2, witness, algo)];
        lap("S5_msm_B2", &mut st);
        let r3 = [msm_g1_with(bc, wc, algo)];
        lap("S5_msm_C", &mut st);
        let r4 = [msm_g1_with(bh, &pp, algo)];
        lap("S5_msm_H", &mut st);
        std::hint::black_box((r, r1, r2, r3, r4));

        let prove: f64 = st.iter().map(|s| s.1).sum();
        let stages: Vec<String> = st.iter().map(|(k, v)| format!("\"{k}\":{v:.4}")).collect();
        println!(
            "{{\"runtime\":\"native-kernels\",\"engine\":\"zkp-kernels\",\"circuit\":\"{circuit}\",\"domain\":{domain},\"threads\":\"{tlabel}\",\"msm_algo\":\"{algo_name}\",\"nthreads\":{},\"iter\":{iter},\"phase\":\"{phase}\",\"prove_ms\":{prove:.4},\"stages\":{{{}}}}}",
            kernel_threads(),
            stages.join(",")
        );
    }
}
