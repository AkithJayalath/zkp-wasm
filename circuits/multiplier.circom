pragma circom 2.1.6;

// Day 1 smoke test: proves knowledge of a and b with a * b = c (c is public).
template Multiplier() {
    signal input a;
    signal input b;
    signal output c;
    c <== a * b;
}

component main = Multiplier();
