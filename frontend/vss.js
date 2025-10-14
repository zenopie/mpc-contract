// ============================================================================
// Baghery's Hash-Based VSS Implementation
// ============================================================================

/**
 * Generate cryptographically secure random integer in range [-500000, 500000]
 * Uses Web Crypto API for CSPRNG
 */
function secureRandomInt() {
    const range = 1000000;
    const randomBytes = new Uint32Array(1);
    crypto.getRandomValues(randomBytes);
    return (randomBytes[0] % range) - 500000;
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
 * Generate Shamir secret sharing polynomial
 * @param {number} secret - The secret to share (e.g., balance)
 * @param {number} threshold - Degree of polynomial (threshold - 1)
 * @param {number} numShares - Number of shares to generate
 * @returns {{shares: number[], polynomial: number[]}}
 */
function generateShamirShares(secret, threshold, numShares) {
    // Generate random polynomial P(X) where P(0) = secret
    const polynomial = [secret];

    // Generate random coefficients for degree 1 to threshold-1 using CSPRNG
    for (let i = 1; i < threshold; i++) {
        const coeff = secureRandomInt();
        polynomial.push(coeff);
    }

    // Evaluate polynomial at points 1, 2, ..., n to get shares
    const shares = [];
    for (let i = 1; i <= numShares; i++) {
        shares.push(evaluatePolynomial(polynomial, i));
    }

    return { shares, polynomial };
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
    const { shares: pShares, polynomial: P } = generateShamirShares(secret, threshold, numNodes);

    // 2. Generate auxiliary polynomial R(X) of same degree
    const { shares: rShares, polynomial: R } = generateShamirShares(0, threshold, numNodes);

    // 3. Generate random gamma values for each node using CSPRNG
    const gammas = [];
    for (let i = 0; i < numNodes; i++) {
        gammas.push(secureRandomInt());
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
    const Z = [];
    for (let i = 0; i < Math.max(R.length, P.length); i++) {
        const rCoeff = i < R.length ? R[i] : 0;
        const pCoeff = i < P.length ? P[i] : 0;
        Z.push(Math.floor(rCoeff + d * pCoeff));
    }

    return {
        shares: pShares,      // v_i = P(i) - the actual secret shares
        gammas: gammas,       // γ_i - randomness for commitments
        commitments: commitments,  // c_i - public commitments
        proofPolynomial: Z,   // Z(X) - public proof polynomial
        challenge: d,         // d - challenge value (for debugging)
        R: rShares,           // R(i) values (for debugging/testing)
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
