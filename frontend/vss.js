// ============================================================================
// Baghery's Hash-Based VSS Implementation
// ============================================================================

/**
 * Generate cryptographically secure random integer in range [0, 1000000]
 * Uses Web Crypto API for CSPRNG
 * Note: Returns only positive values for hex encoding compatibility
 */
function secureRandomInt() {
    const range = 1000000;
    const randomBytes = new Uint32Array(1);
    crypto.getRandomValues(randomBytes);
    return randomBytes[0] % range; // Always positive
}

/**
 * Evaluate polynomial at point x
 * P(x) = a0 + a1*x + a2*x^2 + ... + an*x^n
 */
function evaluatePolynomial(coefficients, x) {
    let result = 0;
    let xPower = 1;

    for (let i = 0; i < coefficients.length; i++) {
        result += coefficients[i] * xPower;
        xPower *= x;
    }

    return Math.floor(result);
}

/**
 * Generate Shamir secret sharing using polynomial evaluation
 * @param {number} secret - The secret to share (e.g., balance)
 * @param {number} threshold - Minimum shares needed to reconstruct (k)
 * @param {number} numShares - Number of shares to generate (n)
 * @returns {{shares: number[], hexShares: string[], polynomial: number[]}} - Shares and polynomial
 */
function generateShamirShares(secret, threshold, numShares) {
    // 1. Generate polynomial P(X) of degree (threshold - 1) where P(0) = secret
    // P(X) = secret + a1*X + a2*X^2 + ... + a(t-1)*X^(t-1)
    const polynomial = [secret];

    // Generate random coefficients for terms X^1 through X^(threshold-1)
    for (let i = 1; i < threshold; i++) {
        polynomial.push(secureRandomInt());
    }

    // 2. Evaluate polynomial at points 1, 2, 3, ..., n to generate shares
    const numericShares = [];
    const hexShares = [];

    for (let x = 1; x <= numShares; x++) {
        const shareValue = evaluatePolynomial(polynomial, x);
        numericShares.push(shareValue);

        // Convert to hex string (pad to 16 chars for consistency)
        const hexShare = shareValue.toString(16).padStart(16, '0');
        hexShares.push(hexShare);
    }

    // Return numeric shares, hex shares, and polynomial coefficients
    return {
        shares: numericShares,    // For VSS computation
        hexShares: hexShares,      // For sending to contract
        polynomial: polynomial     // For debugging/testing
    };
}

/**
 * Hash function for VSS commitments
 * H(a || b || c) = SHA256(a || b || c)
 */
async function hashCommitment(v, r, gamma) {
    const data = `${v}|${r}|${gamma}`;
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return new Uint8Array(hashBuffer);
}

/**
 * Generate VSS proof using Baghery's hash-based scheme
 * @param {number} secret - The secret to share
 * @param {number} threshold - Required threshold
 * @param {number} numNodes - Number of MPC nodes
 * @returns {Promise<{shares, gammas, commitments, proofPolynomial, challenge}>}
 */
async function generateVSSProof(secret, threshold, numNodes) {
    // 1. Generate Shamir sharing polynomial P(X) where P(0) = secret
    const pResult = generateShamirShares(secret, threshold, numNodes);
    const pShares = pResult.shares;        // P(i) numeric values for VSS
    const pHexShares = pResult.hexShares;  // P(i) hex strings for contract
    const pPolynomial = pResult.polynomial; // P(X) coefficients

    // 2. Generate auxiliary polynomial R(X) of same degree
    const rResult = generateShamirShares(0, threshold, numNodes);
    const rShares = rResult.shares;        // R(i) values
    const rPolynomial = rResult.polynomial; // R(X) coefficients

    // 3. Generate random gamma values for each node using CSPRNG
    const gammas = [];
    const gammaHexShares = [];
    for (let i = 0; i < numNodes; i++) {
        const gamma = secureRandomInt();
        gammas.push(gamma);
        // Convert gamma to hex string for contract
        const gammaHex = gamma.toString(16).padStart(16, '0');
        gammaHexShares.push(gammaHex);
    }

    // 4. Compute commitments c_i = H(P(i) || R(i) || γ_i)
    const commitments = [];
    for (let i = 0; i < numNodes; i++) {
        const commitment = await hashCommitment(pShares[i], rShares[i], gammas[i]);
        commitments.push(Array.from(commitment));
    }

    // 5. Calculate challenge d = H(c_1 || c_2 || ... || c_n)
    const commitmentsConcat = commitments.flat();
    const challengeBuffer = await crypto.subtle.digest('SHA-256', new Uint8Array(commitmentsConcat));
    const challengeArray = new Uint8Array(challengeBuffer);

    // Convert first 8 bytes to integer for challenge
    const challenge = new DataView(challengeArray.buffer).getBigInt64(0, false);
    const d = Number(challenge % BigInt(1000000)); // Reduce to reasonable size

    // 6. Compute proof polynomial Z(X) = R(X) + d·P(X)
    // Combine polynomial coefficients: Z = [R[0] + d*P[0], R[1] + d*P[1], ...]
    const zPolynomial = [];
    for (let i = 0; i < threshold; i++) {
        zPolynomial.push(Math.floor(rPolynomial[i] + d * pPolynomial[i]));
    }

    // Convert polynomial coefficients to hex for contract
    const zHexCoeffs = zPolynomial.map(coeff => coeff.toString(16).padStart(16, '0'));

    return {
        shares: pHexShares,        // v_i = P(i) - hex-encoded secret shares for contract
        gammas: gammaHexShares,    // γ_i - hex-encoded randomness for contract
        commitments: commitments,  // c_i - public commitments
        proofPolynomial: zHexCoeffs, // Z(X) coefficients - hex-encoded for contract
        challenge: d,              // d - challenge value (for debugging)
        P: pPolynomial,            // P(X) coefficients (for debugging/testing)
        R: rPolynomial,            // R(X) coefficients (for debugging/testing)
    };
}

/**
 * Verify a VSS share (performed by MPC node)
 * @param {number} nodeId - Node ID (1-indexed)
 * @param {number} share - The share v_i
 * @param {number} gamma - The gamma value γ_i
 * @param {Array<Array<number>>} commitments - All commitments c_1, ..., c_n
 * @param {Array<number>} proofPolynomial - Z(X) coefficients
 * @returns {Promise<boolean>} - True if share is valid
 */
async function verifyVSSShare(nodeId, share, gamma, commitments, proofPolynomial) {
    // 1. Recompute challenge d = H(c_1 || ... || c_n)
    const commitmentsConcat = commitments.flat();
    const challengeBuffer = await crypto.subtle.digest('SHA-256', new Uint8Array(commitmentsConcat));
    const challengeArray = new Uint8Array(challengeBuffer);
    const challenge = new DataView(challengeArray.buffer).getBigInt64(0, false);
    const d = Number(challenge % BigInt(1000000));

    // 2. Evaluate Z(nodeId)
    const zValue = evaluatePolynomial(proofPolynomial, nodeId);

    // 3. Compute expected R(i) = Z(i) - d·v_i
    const rValue = zValue - d * share;

    // 4. Recompute commitment and check against published c_i
    const expectedCommitment = await hashCommitment(share, rValue, gamma);
    const actualCommitment = new Uint8Array(commitments[nodeId - 1]);

    // Compare commitments
    if (expectedCommitment.length !== actualCommitment.length) {
        return false;
    }

    for (let i = 0; i < expectedCommitment.length; i++) {
        if (expectedCommitment[i] !== actualCommitment[i]) {
            return false;
        }
    }

    return true;
}

// Export functions for use in frontend
window.VSSUtils = {
    generateVSSProof,
    verifyVSSShare,
    evaluatePolynomial,
};

console.log('✓ VSS utilities loaded');
