import crypto from 'crypto';
import nacl from 'tweetnacl';

// Simple UTF8 encoding/decoding
function utf8ToBytes(str) {
    return new TextEncoder().encode(str);
}

function bytesToUtf8(bytes) {
    return new TextDecoder().decode(bytes);
}

function base64Decode(str) {
    return new Uint8Array(Buffer.from(str, 'base64'));
}

// ============================================================================
// SHAMIR'S SECRET SHARING - Manual Implementation
// ============================================================================

/**
 * Convert hex string share to numeric value for validation
 * @param {string} hexShare - Hex-encoded share from manual SSS
 * @returns {number} Numeric value for arithmetic validation
 */
export function hexShareToNumber(hexShare) {
    // Remove '0x' prefix if present
    const cleanHex = hexShare.startsWith('0x') ? hexShare.substring(2) : hexShare;
    return parseInt(cleanHex, 16);
}

// ============================================================================
// ENCRYPTION / DECRYPTION
// ============================================================================

/**
 * Generate a keypair for encryption
 * @returns {{publicKey: Uint8Array, privateKey: Uint8Array}}
 */
export function generateKeyPair() {
    const keyPair = nacl.box.keyPair();
    // Ensure keys are Uint8Array
    return {
        publicKey: new Uint8Array(keyPair.publicKey),
        secretKey: new Uint8Array(keyPair.secretKey),
        privateKey: new Uint8Array(keyPair.secretKey) // Alias for convenience
    };
}

/**
 * Decrypt data from a sender (used by MPC nodes to decrypt shares)
 * @param {string} encryptedBase64 - Base64 encoded encrypted data
 * @param {Uint8Array} senderPublicKey - Sender's public key
 * @param {Uint8Array} recipientPrivateKey - Recipient's private key
 * @returns {object} Decrypted data
 */
export function decryptFromSender(encryptedBase64, senderPublicKey, recipientPrivateKey) {
    const combined = base64Decode(encryptedBase64);

    const nonce = combined.slice(0, nacl.box.nonceLength);
    const encrypted = combined.slice(nacl.box.nonceLength);

    const decrypted = nacl.box.open(
        encrypted,
        nonce,
        senderPublicKey,
        recipientPrivateKey
    );

    if (!decrypted) {
        throw new Error('Decryption failed');
    }

    return JSON.parse(bytesToUtf8(decrypted));
}

// ============================================================================
// HASHING
// ============================================================================

/**
 * Hash share data
 * @param {number} balance - Balance share
 * @param {number} nonce - Nonce share
 * @returns {Buffer} SHA256 hash
 */
export function hashShares(balance, nonce) {
    const hasher = crypto.createHash('sha256');

    // Convert to little-endian bytes
    const balanceBuffer = Buffer.alloc(8);
    balanceBuffer.writeBigInt64LE(BigInt(balance));

    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigInt64LE(BigInt(nonce));

    hasher.update(balanceBuffer);
    hasher.update(nonceBuffer);

    return hasher.digest();
}

// ============================================================================
// TSS (Threshold Signature Scheme) - Simplified
// ============================================================================

/**
 * Generate a partial signature (simplified)
 * @param {object} data - Data to sign
 * @param {Uint8Array} privateKey - Node's private key
 * @param {number} nodeId - Node identifier
 * @returns {Buffer} Partial signature
 */
export function generatePartialSignature(data, privateKey, nodeId) {
    // In production: use proper TSS (e.g., FROST, GG20)
    // For PoC: simple signature with node ID embedded

    const message = JSON.stringify(data);
    const hasher = crypto.createHash('sha256');
    hasher.update(message);
    hasher.update(Buffer.from([nodeId]));
    hasher.update(privateKey);

    return hasher.digest();
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert public key to hex string
 * @param {Uint8Array} publicKey
 * @returns {string}
 */
export function publicKeyToHex(publicKey) {
    return Buffer.from(publicKey).toString('hex');
}
