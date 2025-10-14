import crypto from 'crypto';

// ============================================================================
// Baghery's Hash-Based VSS Verification (Node.js version)
// ============================================================================

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
 * Hash function for VSS commitments
 * H(a || b || c) = SHA256(a || b || c)
 */
function hashCommitment(v, r, gamma) {
    const data = `${v}|${r}|${gamma}`;
    return crypto.createHash('sha256').update(data).digest();
}

/**
 * Verify a VSS share (performed by MPC node)
 * @param {number} nodeId - Node ID (1-indexed)
 * @param {number} share - The share v_i
 * @param {number} gamma - The gamma value γ_i
 * @param {Array<Array<number>>} commitments - All commitments c_1, ..., c_n
 * @param {Array<number>} proofPolynomial - Z(X) coefficients
 * @returns {boolean} - True if share is valid
 */
export function verifyVSSShare(nodeId, share, gamma, commitments, proofPolynomial) {
    try {
        // 1. Recompute challenge d = H(c_1 || ... || c_n)
        const commitmentsConcat = Buffer.concat(commitments.map(c => Buffer.from(c)));
        const challengeHash = crypto.createHash('sha256').update(commitmentsConcat).digest();

        // Convert first 8 bytes to integer for challenge
        const challenge = challengeHash.readBigInt64BE(0);
        const d = Number(challenge % BigInt(1000000)); // Reduce to reasonable size

        // 2. Evaluate Z(nodeId)
        const zValue = evaluatePolynomial(proofPolynomial, nodeId);

        // 3. Compute expected R(i) = Z(i) - d·v_i
        const rValue = zValue - d * share;

        // 4. Recompute commitment and check against published c_i
        const expectedCommitment = hashCommitment(share, rValue, gamma);
        const actualCommitment = Buffer.from(commitments[nodeId - 1]);

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
    } catch (error) {
        console.error('VSS verification error:', error);
        return false;
    }
}

/**
 * Verify VSS proof for a transition
 * @param {number} nodeId - This node's ID
 * @param {object} shares - Decrypted shares with gamma field
 * @param {object} transition - State transition with vss_commitments and vss_proof_polynomial
 * @returns {{valid: boolean, reason: string}}
 */
export function verifyTransitionVSS(nodeId, shares, transition) {
    // Check if VSS proof is present
    if (!transition.vss_commitments || !transition.vss_proof_polynomial) {
        return {
            valid: false,
            reason: 'VSS proof missing from transition'
        };
    }

    // Check if gamma is present in shares
    if (shares.gamma === undefined || shares.gamma === null) {
        return {
            valid: false,
            reason: 'Gamma missing from encrypted shares'
        };
    }

    // Verify VSS for the new balance share
    const vssValid = verifyVSSShare(
        nodeId,
        shares.new_balance_share,
        shares.gamma,
        transition.vss_commitments,
        transition.vss_proof_polynomial
    );

    if (!vssValid) {
        return {
            valid: false,
            reason: 'VSS verification failed for balance share'
        };
    }

    return {
        valid: true,
        reason: 'VSS verification passed'
    };
}
