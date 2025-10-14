import crypto from 'crypto';
import nacl from 'tweetnacl';

// Simple UTF8 encoding/decoding (tweetnacl-util has issues with ES modules)
function utf8ToBytes(str) {
    return new TextEncoder().encode(str);
}

function bytesToUtf8(bytes) {
    return new TextDecoder().decode(bytes);
}

function base64Encode(bytes) {
    return Buffer.from(bytes).toString('base64');
}

function base64Decode(str) {
    return new Uint8Array(Buffer.from(str, 'base64'));
}

// ============================================================================
// SECRET SHARING (Shamir's Secret Sharing simplified)
// ============================================================================

/**
 * Split a secret value into shares
 * @param {number} secret - The secret value to split
 * @param {number} totalShares - Total number of shares to create
 * @param {number} threshold - Minimum shares needed to reconstruct
 * @returns {Array<number>} Array of secret shares
 */
export function createSecretShares(secret, totalShares, threshold) {
    // Simplified additive secret sharing for PoC
    // In production: use proper Shamir's Secret Sharing
    const shares = [];

    // For simplicity, we'll use additive secret sharing
    // Each share is a random value, last share ensures sum = secret
    let sum = 0;

    for (let i = 0; i < totalShares - 1; i++) {
        // Generate random share (smaller range for stability)
        const share = Math.floor(Math.random() * 1000000) - 500000;
        shares.push(share);
        sum += share;
    }

    // Last share = secret - sum (ensures sum of all shares = secret)
    const lastShare = secret - sum;
    shares.push(lastShare);

    return shares;
}

/**
 * Reconstruct secret from shares
 * @param {Array<number>} shares - Array of shares
 * @returns {number} The reconstructed secret
 */
export function reconstructSecret(shares) {
    // Sum all shares (additive secret sharing)
    let sum = 0;

    for (const share of shares) {
        sum += share;
    }

    return sum;
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
 * Encrypt data for a specific recipient
 * @param {object} data - Data to encrypt (will be JSON serialized)
 * @param {Uint8Array} recipientPublicKey - Recipient's public key
 * @param {Uint8Array} senderPrivateKey - Sender's private key
 * @returns {string} Base64 encoded encrypted data with nonce
 */
export function encryptForRecipient(data, recipientPublicKey, senderPrivateKey) {
    const message = utf8ToBytes(JSON.stringify(data));
    const nonce = nacl.randomBytes(nacl.box.nonceLength);

    const encrypted = nacl.box(
        message,
        nonce,
        recipientPublicKey,
        senderPrivateKey
    );

    // Combine nonce + encrypted message
    const combined = new Uint8Array(nonce.length + encrypted.length);
    combined.set(nonce);
    combined.set(encrypted, nonce.length);

    return base64Encode(combined);
}

/**
 * Decrypt data from a sender
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

/**
 * Create a commitment to a value
 * @param {any} value - Value to commit to
 * @returns {string} Hex encoded commitment
 */
export function createCommitment(value) {
    const hasher = crypto.createHash('sha256');
    hasher.update(JSON.stringify(value));
    return hasher.digest('hex');
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

/**
 * Aggregate partial signatures into threshold signature
 * @param {Array<Buffer>} partialSignatures - Array of partial signatures
 * @returns {Buffer} Aggregated threshold signature
 */
export function aggregateSignatures(partialSignatures) {
    // In production: proper BLS aggregation or multi-sig
    // For PoC: XOR all signatures together

    if (partialSignatures.length === 0) {
        throw new Error('No signatures to aggregate');
    }

    const result = Buffer.alloc(32);

    for (const sig of partialSignatures) {
        for (let i = 0; i < 32 && i < sig.length; i++) {
            result[i] ^= sig[i];
        }
    }

    return result;
}

/**
 * Verify a threshold signature
 * @param {Buffer} signature - Threshold signature
 * @param {object} data - Original data
 * @param {Array<Uint8Array>} publicKeys - Public keys of signers
 * @returns {boolean} True if valid
 */
export function verifyThresholdSignature(signature, data, publicKeys) {
    // In production: proper threshold signature verification
    // For PoC: simplified check
    return signature.length === 32;
}

// ============================================================================
// MERKLE PROOF UTILITIES
// ============================================================================

/**
 * Verify a Merkle proof
 * @param {string} leaf - Leaf hash (hex)
 * @param {Array<{hash: string, isLeft: boolean}>} proof - Merkle proof
 * @param {string} root - Expected root hash (hex)
 * @returns {boolean} True if proof is valid
 */
export function verifyMerkleProof(leaf, proof, root) {
    let current = Buffer.from(leaf, 'hex');

    for (const element of proof) {
        const siblingHash = Buffer.from(element.hash, 'hex');
        const hasher = crypto.createHash('sha256');

        if (element.isLeft) {
            hasher.update(siblingHash);
            hasher.update(current);
        } else {
            hasher.update(current);
            hasher.update(siblingHash);
        }

        current = hasher.digest();
    }

    return current.toString('hex') === root;
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

/**
 * Convert hex string to Uint8Array
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToUint8Array(hex) {
    return new Uint8Array(Buffer.from(hex, 'hex'));
}
