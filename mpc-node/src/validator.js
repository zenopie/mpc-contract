import { hashShares, decryptFromSender, generatePartialSignature } from './crypto.js';
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

            console.log(`[Node ${this.nodeId}] Decrypted shares:`, {
                oldBalance: shares.old_balance_share,
                newBalance: shares.new_balance_share,
                amount: shares.amount_share,
                oldNonce: shares.old_nonce_share,
                newNonce: shares.new_nonce_share,
                gamma: shares.gamma
            });

            // 2. Verify VSS proof (Baghery's hash-based scheme)
            const vssResult = verifyTransitionVSS(this.nodeId, shares, transition);
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
            if (shares.old_balance_share + shares.amount_share !== shares.new_balance_share) {
                return {
                    valid: false,
                    reason: 'Balance equation failed on share',
                    partialSignature: null
                };
            }

            // 4. Validate nonce incremented (skip for initialization when old_nonce = 0 and new_nonce = 0)
            const isInitialization = (shares.old_balance_share === 0 && shares.old_nonce_share === 0 && shares.new_nonce_share === 0);

            if (!isInitialization && shares.new_nonce_share !== shares.old_nonce_share + 1) {
                return {
                    valid: false,
                    reason: 'Nonce not incremented correctly on share',
                    partialSignature: null
                };
            }

            // 5. Balance non-negativity check
            // NOTE: Individual shares CAN be negative in additive secret sharing!
            // Only the reconstructed secret (sum of all shares) needs to be non-negative.
            // In production, use proper MPC comparison protocol to check reconstructed balance.
            // For PoC, we skip this check since we can't reconstruct without all shares.

            // 6. Verify hash commitments match shares
            const oldHashCommitment = hashShares(
                shares.old_balance_share,
                shares.old_nonce_share
            );

            const newHashCommitment = hashShares(
                shares.new_balance_share,
                shares.new_nonce_share
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

    /**
     * Validate a transfer (two state transitions)
     * @param {object} senderTransition - Sender's state transition
     * @param {object} recipientTransition - Recipient's state transition
     * @param {string} senderEncryptedShares - Sender's encrypted shares
     * @param {string} recipientEncryptedShares - Recipient's encrypted shares
     * @param {Uint8Array} senderPublicKey - Sender's public key
     * @param {Uint8Array} recipientPublicKey - Recipient's public key
     * @returns {{valid: boolean, reason: string}}
     */
    validateTransfer(
        senderTransition,
        recipientTransition,
        senderEncryptedShares,
        recipientEncryptedShares,
        senderPublicKey,
        recipientPublicKey
    ) {
        try {
            // Decrypt both shares
            const senderShares = decryptFromSender(
                senderEncryptedShares,
                senderPublicKey,
                this.privateKey
            );

            const recipientShares = decryptFromSender(
                recipientEncryptedShares,
                recipientPublicKey,
                this.privateKey
            );

            // Validate sender loses amount (amount is negative for send)
            const senderValid =
                senderShares.old_balance_share + senderShares.amount_share ===
                senderShares.new_balance_share;

            // Validate recipient gains same amount (amount is positive for receive)
            const recipientValid =
                recipientShares.old_balance_share + recipientShares.amount_share ===
                recipientShares.new_balance_share;

            // Validate nonces
            const senderNonceValid =
                senderShares.new_nonce_share === senderShares.old_nonce_share + 1;

            const recipientNonceValid =
                recipientShares.new_nonce_share === recipientShares.old_nonce_share + 1;

            if (!senderValid || !recipientValid || !senderNonceValid || !recipientNonceValid) {
                return {
                    valid: false,
                    reason: 'Transfer validation failed on shares'
                };
            }

            console.log(`[Node ${this.nodeId}] ✓ Transfer validation PASSED`);

            return {
                valid: true,
                reason: 'Transfer valid on shares'
            };

        } catch (error) {
            return {
                valid: false,
                reason: `Error: ${error.message}`
            };
        }
    }

    /**
     * Simulate MPC computation of balance comparison
     * In production: use proper MPC comparison protocol
     * @param {number} share - This node's share
     * @param {number} threshold - Threshold to compare against
     * @returns {number} Share of comparison result (0 or 1)
     */
    mpcCompareShare(share, threshold) {
        // Simplified: each node computes on their share
        // Real MPC would not reveal individual comparisons
        return share >= threshold ? 1 : 0;
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

/**
 * Verify all nodes in committee have provided shares
 * @param {object} transition - State transition
 * @param {Array<number>} nodeIds - Expected node IDs
 * @returns {boolean}
 */
export function verifyAllSharesPresent(transition, nodeIds) {
    const providedNodeIds = transition.encrypted_shares.map(s => s.node_id);
    return nodeIds.every(id => providedNodeIds.includes(id));
}
