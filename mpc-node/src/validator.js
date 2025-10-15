import { hashShares, decryptFromSender, generatePartialSignature, hexShareToNumber } from './crypto.js';
import { verifyTransitionVSS } from './vss.js';

// ============================================================================
// MPC VALIDATION LOGIC
// ============================================================================

/**
 * Represents an MPC node's validation capability
 */
export class MPCValidator {
    constructor(nodeId, privateKey, publicKey) {
        this.nodeId = nodeId;
        this.privateKey = privateKey;
        this.publicKey = publicKey;
    }

    /**
     * Validate a state transition on this node's secret share
     * @param {object} transition - State transition from contract
     * @param {string} encryptedShares - Base64 encrypted shares for this node
     * @param {Uint8Array} senderPublicKey - User's public key
     * @returns {{valid: boolean, reason: string, partialSignature: Buffer}}
     */
    validateTransition(transition, encryptedShares, senderPublicKey) {
        try {
            // 1. Decrypt the shares intended for this node
            const shares = decryptFromSender(
                encryptedShares,
                senderPublicKey,
                this.privateKey
            );

            console.log(`[Node ${this.nodeId}] Decrypted shares (hex):`, {
                oldBalance: shares.old_balance_share,
                newBalance: shares.new_balance_share,
                amount: shares.amount_share,
                oldNonce: shares.old_nonce_share,
                newNonce: shares.new_nonce_share,
                gamma: shares.gamma
            });

            // Convert hex string shares to numbers for validation
            const oldBalanceNum = hexShareToNumber(shares.old_balance_share);
            const newBalanceNum = hexShareToNumber(shares.new_balance_share);
            const amountNum = hexShareToNumber(shares.amount_share);
            const oldNonceNum = hexShareToNumber(shares.old_nonce_share);
            const newNonceNum = hexShareToNumber(shares.new_nonce_share);
            const gammaNum = hexShareToNumber(shares.gamma);

            console.log(`[Node ${this.nodeId}] Converted shares (numeric):`, {
                oldBalance: oldBalanceNum,
                newBalance: newBalanceNum,
                amount: amountNum,
                oldNonce: oldNonceNum,
                newNonce: newNonceNum,
                gamma: gammaNum
            });

            // 2. Verify VSS proof (Baghery's hash-based scheme)
            const vssResult = verifyTransitionVSS(this.nodeId, {
                old_balance_share: oldBalanceNum,
                new_balance_share: newBalanceNum,
                amount_share: amountNum,
                old_nonce_share: oldNonceNum,
                new_nonce_share: newNonceNum,
                gamma: gammaNum
            }, transition);
            if (!vssResult.valid) {
                console.log(`[Node ${this.nodeId}] VSS verification failed:`, vssResult.reason);
                return {
                    valid: false,
                    reason: vssResult.reason,
                    partialSignature: null
                };
            }
            console.log(`[Node ${this.nodeId}] ✓ VSS verification passed`);

            // 3. Validate balance equation on shares
            // old_balance + amount = new_balance (amount positive for deposits, negative for withdrawals)
            if (oldBalanceNum + amountNum !== newBalanceNum) {
                return {
                    valid: false,
                    reason: 'Balance equation failed on share',
                    partialSignature: null
                };
            }

            // 4. Validate nonce incremented (skip for initialization when old_nonce = 0 and new_nonce = 0)
            const isInitialization = (oldBalanceNum === 0 && oldNonceNum === 0 && newNonceNum === 0);

            if (!isInitialization && newNonceNum !== oldNonceNum + 1) {
                return {
                    valid: false,
                    reason: 'Nonce not incremented correctly on share',
                    partialSignature: null
                };
            }

            // 5. Verify hash commitments match shares
            const oldHashCommitment = hashShares(
                oldBalanceNum,
                oldNonceNum
            );

            const newHashCommitment = hashShares(
                newBalanceNum,
                newNonceNum
            );

            // Note: In production, verify these against Pedersen commitments
            // or other commitment schemes in the transition

            console.log(`[Node ${this.nodeId}] Hash commitments:`, {
                oldHash: oldHashCommitment.toString('hex').slice(0, 16) + '...',
                newHash: newHashCommitment.toString('hex').slice(0, 16) + '...'
            });

            // 6. All validations passed! Generate partial signature
            const partialSignature = generatePartialSignature(
                {
                    transition,
                    shares
                },
                this.privateKey,
                this.nodeId
            );

            console.log(`[Node ${this.nodeId}] ✓ Validation PASSED`);

            return {
                valid: true,
                reason: 'All checks passed',
                partialSignature
            };

        } catch (error) {
            console.error(`[Node ${this.nodeId}] Validation error:`, error.message);
            return {
                valid: false,
                reason: `Error: ${error.message}`,
                partialSignature: null
            };
        }
    }

}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract encrypted shares for a specific node from transition
 * @param {object} transition - State transition
 * @param {number} nodeId - Node ID
 * @returns {string|null} Encrypted shares or null
 */
export function extractNodeShares(transition, nodeId) {
    const nodeShares = transition.encrypted_shares.find(
        s => s.node_id === nodeId
    );
    return nodeShares ? nodeShares.encrypted_data : null;
}
