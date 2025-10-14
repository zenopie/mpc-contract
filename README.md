# MPC SNIP Contract - Privacy-Preserving State Management on Secret Network

A complete Multi-Party Computation (MPC) system for managing private user state on Secret Network using secret sharing, threshold signatures, and stateless blockchain architecture.

## Overview

This project implements a privacy-preserving token system where:

- **User state (balances, nonces) is kept off-chain** - Only commitments stored on-chain
- **State is secret-shared across MPC nodes** - No single node knows full state
- **Threshold validation** - Requires consensus from `t-of-n` nodes
- **Zero-knowledge proofs** - Nodes validate without knowing actual values
- **Merkle tree state commitments** - Efficient proof of state inclusion
- **IPFS storage** - Encrypted full state stored decentralized

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                     User (Alice)                              │
│  • Creates state transition (1000 → 900, send 100)           │
│  • Splits values into secret shares                          │
│  • Encrypts shares for each MPC node                         │
│  • Submits to contract with commitments                      │
└────────────────────────┬──────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │ Node 1  │    │ Node 2  │    │ Node 3  │
    │ Share₁  │    │ Share₂  │    │ Share₃  │
    │ Validates│   │ Validates│   │ Validates│
    │   ↓     │    │   ↓     │    │   ↓     │
    │ Signs   │    │ Signs   │    │ Signs   │
    └────┬────┘    └────┬────┘    └────┬────┘
         │              │              │
         └──────┬───────┴──────┬───────┘
                ▼              ▼
         ┌──────────────────────────┐
         │  Secret Network Contract │
         │  • Coordinates MPC       │
         │  • Aggregates signatures │
         │  • Stores commitments    │
         │  • Updates state root    │
         └──────────────────────────┘
                ▼
         ┌──────────────────────────┐
         │     Blockchain State     │
         │  ✓ State root hash       │
         │  ✓ IPFS CID              │
         │  ✓ Merkle proofs         │
         │  ✗ NOT actual balances   │
         └──────────────────────────┘
```

## Components

### 1. Smart Contract (`src/`)

CosmWasm contract deployed on Secret Network that:
- Manages MPC node registry
- Coordinates state transition validations
- Aggregates threshold signatures
- Stores state commitments (not actual state!)
- Maintains global Merkle tree root

**Key Messages:**
- `RegisterMPCNode` - Node joins committee
- `SubmitStateTransition` - User proposes state change
- `ValidateTransition` - Node validates on their share
- `FinalizeTransition` - Aggregate and commit after threshold
- `SubmitTransfer` - Atomic transfer between users

### 2. MPC Node (`mpc-node/`)

Off-chain node that:
- Receives encrypted secret shares from users
- Validates state transitions on shares only
- Never sees actual balances (only shares)
- Generates partial TSS signatures
- Submits validations to contract

**Key Features:**
- Secret sharing (Shamir's)
- Encryption (NaCl Box)
- Threshold signatures (TSS)
- Share-based validation

## What Makes This Private?

### Traditional Blockchain
```
Blockchain State:
Alice: 1000 tokens ❌ PUBLIC!
Bob: 500 tokens   ❌ PUBLIC!
```

### This MPC System
```
Blockchain State:
Alice: commitment(0x3a7f...) ✓ PRIVATE
       IPFS: QmABC... (encrypted)

Node 1 has: share₁ of Alice's balance (meaningless alone)
Node 2 has: share₂ of Alice's balance (meaningless alone)
Node 3 has: share₃ of Alice's balance (meaningless alone)

Need 2+ nodes to reconstruct → No single point of knowledge!
```

## Quick Start

### 1. Setup Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env and fill in:
# - DEPLOYER_MNEMONIC (wallet with ~2 SCRT for deployment)
# - NODE1_MNEMONIC, NODE2_MNEMONIC, NODE3_MNEMONIC (each needs ~0.5 SCRT)
# - CHAIN_ID and RPC_URL (default: secret-4 mainnet)
# - THRESHOLD (default: 2)
```

### 2. Deploy Contract

```bash
# Install dependencies
npm install

# Deploy contract (uploads, instantiates, saves deployment.json)
node deploy.js
```

This will:
- Upload contract code to Secret Network
- Instantiate the MPC coordinator contract with your threshold
- Save deployment info to `deployment.json`

### 3. Setup MPC Node Configurations

```bash
# Generate .env files for each node from main .env
node createEnv.js
```

This creates `mpc-node/.env.node1`, `.env.node2`, `.env.node3` with each node's mnemonic and contract details.

### 4. Start MPC Nodes

Open **3 separate terminal windows** and run:

**Terminal 1 (Node 1):**
```bash
cd mpc-node
cp .env.node1 .env
npm install  # First time only
npm start
```

**Terminal 2 (Node 2):**
```bash
cd mpc-node
cp .env.node2 .env
npm start
```

**Terminal 3 (Node 3):**
```bash
cd mpc-node
cp .env.node3 .env
npm start
```

Each node will:
- Connect to Secret Network
- Auto-register with the contract (generates encryption keypair)
- Listen for state transition validations
- Run HTTP server on ports 3001, 3002, 3003

### 5. Verify Setup

Check node health:
```bash
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
```

Expected response:
```json
{
  "status": "healthy",
  "nodeId": 1,
  "address": "secret1...",
  "isRegistered": true,
  "uptime": 123.45
}
```

### 6. Start Frontend (Optional)

```bash
cd frontend

# Copy deployment info
cp ../deployment.json .

# Start static file server (any method works)
python3 -m http.server 8000

# Open http://localhost:8000 in browser
```

---

## Build Contract (Optional - Pre-built Available)

```bash
# Install Rust and wasm32 target
rustup target add wasm32-unknown-unknown

# Build contract
cargo build --target wasm32-unknown-unknown --release

# Optimize for mainnet
make build-mainnet-reproducable
```

## Usage Example

### User Submits Transaction

```javascript
// Alice wants to send 100 tokens
const oldBalance = 1000;
const newBalance = 900;
const amount = 100;

// 1. Create secret shares (3 shares, 2-of-3 threshold)
const oldBalanceShares = createSecretShares(oldBalance, 3, 2);
const newBalanceShares = createSecretShares(newBalance, 3, 2);
const amountShares = createSecretShares(amount, 3, 2);

// 2. Encrypt each share for its node
const encryptedShares = [];
for (let i = 0; i < 3; i++) {
  const shares = {
    old_balance_share: oldBalanceShares[i],
    new_balance_share: newBalanceShares[i],
    amount_share: amountShares[i],
    // ... nonce shares
  };

  encryptedShares.push({
    node_id: i + 1,
    encrypted_data: encrypt(shares, nodes[i].publicKey)
  });
}

// 3. Submit to contract
await contract.submitStateTransition({
  transition: {
    user_address: "alice",
    old_state_root: hashOldState(),
    new_state_root: hashNewState(),
    encrypted_shares: encryptedShares,
    user_signature: signTransition()
  }
});
```

### Nodes Validate

```javascript
// Each node automatically:
// 1. Receives validation request
// 2. Decrypts their share
// 3. Validates equation on SHARE (not actual balance!)
if (oldBalanceShare - amountShare === newBalanceShare) {
  // Valid! Generate partial signature
  const partialSig = generatePartialSignature(transition);
  await contract.validateTransition(validationId, true, partialSig);
}
```

### Contract Finalizes

```javascript
// When threshold reached (2-of-3):
// 1. Aggregate partial signatures → threshold signature
// 2. Update global state root
// 3. Store commitment on-chain
await contract.finalizeTransition(validationId);

// Now on-chain:
{
  user_address: "alice",
  state_root: "0x3a7f...",  // Commitment, not balance!
  ipfs_cid: "QmABC123",     // Encrypted state
  merkle_proof: [...]
}
```

## Privacy Guarantees

| Property | Traditional | This System |
|----------|-------------|-------------|
| Balance visibility | ❌ Public | ✓ Private (shares only) |
| Single point of trust | ❌ Yes | ✓ No (threshold) |
| Transaction amounts | ❌ Public | ✓ Private (commitments) |
| State storage | ❌ On-chain | ✓ Off-chain (IPFS) |
| Validation | ❌ Reveals values | ✓ Zero-knowledge on shares |

## Security Model

### Threat Model

**Assumptions:**
- Honest majority: At least `threshold` nodes are honest
- Secure channels: Encryption prevents eavesdropping
- Trusted setup: Initial parameters are secure

**Protected Against:**
- Individual node compromise (up to threshold-1)
- Eavesdropping on transactions
- Single point of failure
- Censorship (threshold ensures liveness)

**NOT Protected Against (in PoC):**
- Collusion of threshold nodes
- Side-channel attacks
- Quantum computers (add post-quantum crypto)

## Files Structure

```
mpc-contract/
├── src/                    # Smart contract
│   ├── contract.rs         # Main contract logic
│   ├── state.rs            # State structures
│   ├── msg.rs              # Message types
│   └── lib.rs              # Module exports
│
├── mpc-node/               # MPC node implementation
│   ├── src/
│   │   ├── crypto.js       # Crypto primitives
│   │   └── validator.js    # Validation logic
│   ├── index.js            # Node server
│   ├── test.js             # Test suite
│   └── README.md           # Node documentation
│
├── Cargo.toml              # Rust dependencies
├── Makefile                # Build commands
└── README.md               # This file
```

## Testing

### Contract Tests

```bash
cargo test
```

### MPC Node Tests

```bash
cd mpc-node
npm test
```

### Integration Test

1. Deploy contract to testnet
2. Start 3 MPC nodes
3. Submit test transaction
4. Verify validation completes
5. Query state commitment

## Production Considerations

This is a **proof-of-concept**. For production:

### Cryptography
- [ ] Use audited Shamir's Secret Sharing library
- [ ] Implement proper TSS (FROST, GG20)
- [ ] Add BLS signature aggregation
- [ ] Use Pedersen commitments
- [ ] Implement MPC comparison protocols
- [ ] Add post-quantum cryptography

### Security
- [ ] Professional security audit
- [ ] Key management and rotation
- [ ] Slashing for malicious nodes
- [ ] Rate limiting and DoS protection
- [ ] Secure enclave support (SGX/SEV)

### Scalability
- [ ] Batch validations
- [ ] Optimistic rollups
- [ ] State compression
- [ ] IPFS pinning strategy
- [ ] Node discovery protocol

### Features
- [ ] View keys for selective disclosure
- [ ] Confidential transfers
- [ ] Multi-asset support
- [ ] Atomic swaps
- [ ] Governance for node rotation

## Research Papers & References

- **Shamir's Secret Sharing**: Shamir, A. (1979)
- **Threshold Signatures**: Gennaro et al. (1996)
- **FROST**: Komlo & Goldberg (2020)
- **GG20**: Gennaro & Goldfeder (2020)
- **Pedersen Commitments**: Pedersen (1991)

## License

ISC

## Contributing

This is a research prototype. Contributions welcome!

## Contact

For questions or collaboration, please open an issue.
