pragma circom 2.1.6;
// C2 workload (generality check): SHA-256 over B message blocks (circomlib).
// Unlike the Poseidon chain (C1), almost every witness value is a single bit (0 or 1),
// which makes the MSM scalars tiny. This tests whether the RQ2 stage shares and the
// RQ3/RQ4 speed-ups hold for a structurally different circuit.
include "circomlib/circuits/sha256/sha256.circom";

template Sha256Blocks(B) {
    // nBits = B*512 - 65 makes circomlib's padding fill exactly B blocks
    var nBits = B * 512 - 65;
    signal input in[nBits];
    signal output out[256];
    component h = Sha256(nBits);
    for (var i = 0; i < nBits; i++) h.in[i] <== in[i];
    for (var i = 0; i < 256; i++) out[i] <== h.out[i];
}
