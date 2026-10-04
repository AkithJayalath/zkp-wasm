pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

// C1 workload: out = Poseidon^N(in).
// The private input is hashed N times in a chain; only the final hash is public.
// Every Poseidon(1) adds the same number of constraints, so N sets the circuit size
// precisely. scripts/build_c1.sh picks N to fill each 2^k FFT domain.
template PoseidonChain(N) {
    signal input in;
    signal output out;

    signal s[N + 1];
    component h[N];

    s[0] <== in;
    for (var i = 0; i < N; i++) {
        h[i] = Poseidon(1);
        h[i].inputs[0] <== s[i];
        s[i + 1] <== h[i].out;
    }
    out <== s[N];
}
