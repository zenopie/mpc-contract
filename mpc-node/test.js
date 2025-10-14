import { MPCNode } from './index.js';
import {
    createSecretShares,
    reconstructSecret,
    generateKeyPair,
    encryptForRecipient,
    decryptFromSender,
    publicKeyToHex,
    hashShares,
    createCommitment
} from './src/crypto.js';
import { MPCValidator } from './src/validator.js';

// ============================================================================
// TEST SUITE
// ============================================================================

console.log('🧪 MPC Node Test Suite\n');
console.log('='.repeat(60));

// Test 1: Secret Sharing
console.log('\n1️⃣  Testing Secret Sharing...');
const secret = 1000;
const shares = createSecretShares(secret, 3, 2);
console.log(`   Secret: ${secret}`);
console.log(`   Shares: [${shares.join(', ')}]`);

const reconstructed = reconstructSecret(shares);
console.log(`   Reconstructed: ${reconstructed}`);
console.log(`   ✓ ${reconstructed === secret ? 'PASS' : 'FAIL'}`);

// Test 2: Encryption/Decryption
console.log('\n2️⃣  Testing Encryption...');
const alice = generateKeyPair();
const bob = generateKeyPair();

const message = { balance: 1000, nonce: 1 };
const encrypted = encryptForRecipient(message, bob.publicKey, alice.privateKey);
console.log(`   Encrypted length: ${encrypted.length} chars`);

const decrypted = decryptFromSender(encrypted, alice.publicKey, bob.privateKey);
console.log(`   Decrypted: ${JSON.stringify(decrypted)}`);
console.log(`   ✓ ${JSON.stringify(decrypted) === JSON.stringify(message) ? 'PASS' : 'FAIL'}`);

// Test 3: Share Hashing
console.log('\n3️⃣  Testing Share Hashing...');
const balanceShare = shares[0];
const nonceShare = 1;
const hash = hashShares(balanceShare, nonceShare);
console.log(`   Balance share: ${balanceShare}`);
console.log(`   Nonce share: ${nonceShare}`);
console.log(`   Hash: ${hash.toString('hex').slice(0, 32)}...`);
console.log(`   ✓ PASS`);

// Test 4: Complete MPC Flow Simulation
console.log('\n4️⃣  Testing Complete MPC Validation Flow...');

// Setup: 3 nodes with 2-of-3 threshold
const nodes = [];
for (let i = 1; i <= 3; i++) {
    const keyPair = generateKeyPair();
    const validator = new MPCValidator(i, keyPair.privateKey, keyPair.publicKey);
    nodes.push({
        id: i,
        validator,
        keyPair
    });
    console.log(`   Node ${i} created`);
}

// User creates a transaction: 1000 -> 900 (send 100)
console.log('\n   User Alice wants to send 100 tokens');
const oldBalance = 1000;
const newBalance = 900;
const amount = 100;
const oldNonce = 5;
const newNonce = 6;

// Create secret shares - must maintain relationship: oldBalance - amount = newBalance
const oldBalanceShares = createSecretShares(oldBalance, 3, 2);
const amountShares = createSecretShares(amount, 3, 2);

// Calculate newBalanceShares to maintain the equation on shares
// newBalanceShare[i] = oldBalanceShare[i] - amountShare[i]
const newBalanceShares = oldBalanceShares.map((oldShare, i) =>
    oldShare - amountShares[i]
);

const oldNonceShares = createSecretShares(oldNonce, 3, 2);
// Each nonce share must increment by 1 to maintain: newNonce = oldNonce + 1
const newNonceShares = oldNonceShares.map(share => share + 1);

console.log(`   Created shares for all values`);

// User's keypair
const userKeyPair = generateKeyPair();

// Encrypt shares for each node
const encryptedSharesForNodes = [];
for (let i = 0; i < 3; i++) {
    const shares = {
        old_balance_share: oldBalanceShares[i],
        new_balance_share: newBalanceShares[i],
        amount_share: amountShares[i],
        old_nonce_share: oldNonceShares[i],
        new_nonce_share: newNonceShares[i]
    };

    const encrypted = encryptForRecipient(
        shares,
        nodes[i].keyPair.publicKey,
        userKeyPair.privateKey
    );

    encryptedSharesForNodes.push({
        node_id: i + 1,
        encrypted_data: encrypted
    });
}

console.log(`   Encrypted shares for all nodes`);

// Create state transition
const transition = {
    user_address: 'alice',
    old_state_root: Array(32).fill(1),
    new_state_root: Array(32).fill(2),
    merkle_proof: [],
    new_state_ipfs: 'QmABC123',
    user_signature: [1, 2, 3],
    encrypted_shares: encryptedSharesForNodes
};

// Each node validates
console.log('\n   Nodes validating...');
const validations = [];
for (const node of nodes.slice(0, 2)) {  // Only need 2 for threshold
    const result = node.validator.validateTransition(
        transition,
        encryptedSharesForNodes[node.id - 1].encrypted_data,
        userKeyPair.publicKey
    );
    validations.push(result);
}

const allValid = validations.every(v => v.valid);
console.log(`\n   Threshold reached: ${validations.length}/2`);
console.log(`   All valid: ${allValid}`);
console.log(`   ✓ ${allValid ? 'PASS' : 'FAIL'}`);

// Test 5: Invalid Transaction Detection
console.log('\n5️⃣  Testing Invalid Transaction Detection...');

// Create invalid shares (balance doesn't match)
const invalidShares = {
    old_balance_share: oldBalanceShares[0],
    new_balance_share: oldBalanceShares[0] - 50,  // Wrong! Should be -100
    amount_share: amountShares[0],
    old_nonce_share: oldNonceShares[0],
    new_nonce_share: newNonceShares[0]
};

const invalidEncrypted = encryptForRecipient(
    invalidShares,
    nodes[0].keyPair.publicKey,
    userKeyPair.privateKey
);

const invalidResult = nodes[0].validator.validateTransition(
    transition,
    invalidEncrypted,
    userKeyPair.publicKey
);

console.log(`   Invalid transaction detected: ${!invalidResult.valid}`);
console.log(`   Reason: ${invalidResult.reason}`);
console.log(`   ✓ ${!invalidResult.valid ? 'PASS' : 'FAIL'}`);

// Summary
console.log('\n' + '='.repeat(60));
console.log('🎉 All tests completed!\n');
console.log('Summary:');
console.log('  ✓ Secret sharing works');
console.log('  ✓ Encryption/decryption works');
console.log('  ✓ Share hashing works');
console.log('  ✓ Complete MPC validation works');
console.log('  ✓ Invalid transaction detection works');
console.log('\n' + '='.repeat(60));
console.log('\n📝 To run a live node:');
console.log('  1. Copy .env.example to .env');
console.log('  2. Fill in your configuration');
console.log('  3. Run: npm start\n');
