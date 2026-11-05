//! Native side of the per-operation microbenchmark (same loops as the WASM build).
//!   micro <iters> <repeats>   -> one JSON line per repeat
use std::time::Instant;
use zkp_kernels::{micro_fr_mul, micro_g1_add};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let iters: u32 = a.get(1).map(|s| s.parse().unwrap()).unwrap_or(10_000_000);
    let reps: usize = a.get(2).map(|s| s.parse().unwrap()).unwrap_or(10);
    for rep in 0..reps {
        for (name, f) in [("fr_mul", micro_fr_mul as fn(u32) -> u64), ("g1_add", micro_g1_add)] {
            let n = if name == "g1_add" { iters / 10 } else { iters };
            let t = Instant::now();
            let chk = std::hint::black_box(f(n));
            let ns = t.elapsed().as_secs_f64() * 1e9 / n as f64;
            println!("{{\"runtime\":\"native\",\"build\":\"native\",\"op\":\"{name}\",\"rep\":{rep},\"iters\":{n},\"ns_per_op\":{ns:.3},\"check\":{chk}}}");
        }
    }
}
