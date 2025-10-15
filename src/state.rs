use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use secret_toolkit::storage::{Item, Keymap};

// ============================================================================
// STATE STRUCTURES
// ============================================================================

/// Global contract state
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct State {
    pub mpc_nodes: Vec<MPCNode>,
    pub threshold: u32,
    pub current_state_root: Vec<u8>,
    pub block_height: u64,
}

/// MPC committee member
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MPCNode {
    pub address: String,
    pub node_id: u32,
    pub public_key: Vec<u8>,
    pub active: bool,
}

/// User's state commitment (stored on-chain)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct StateCommitment {
    pub user_address: String,
    pub state_root: Vec<u8>,      // Hash of user's state
    pub ipfs_cid: String,          // Where encrypted state lives
    pub merkle_proof: Vec<u8>,     // Proof in global tree
    pub nonce: u64,
    pub updated_at: u64,
}

/// Secret shares sent to MPC nodes for validation
/// Uses hex-encoded strings from Shamir's Secret Sharing library
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct SecretShares {
    pub old_balance_share: String,  // Hex-encoded share from SSS
    pub new_balance_share: String,  // Hex-encoded share from SSS
    pub amount_share: String,       // Hex-encoded share from SSS
    pub old_nonce_share: String,    // Hex-encoded share from SSS
    pub new_nonce_share: String,    // Hex-encoded share from SSS

    // VSS randomness (for hash-based commitment)
    #[serde(default)]
    pub gamma: String,  // γ_i - hex-encoded randomness for commitment
}

/// State transition request
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct StateTransition {
    pub user_address: String,

    // Commitments (public)
    pub old_state_root: Vec<u8>,
    pub new_state_root: Vec<u8>,

    // Merkle proof
    pub merkle_proof: Vec<MerkleProofElement>,

    // IPFS pointer
    pub new_state_ipfs: String,

    // User signature
    pub user_signature: Vec<u8>,

    // Secret shares (one per MPC node, encrypted to that node)
    pub encrypted_shares: Vec<EncryptedShares>,

    // VSS proof (Baghery's hash-based scheme)
    #[serde(default)]
    pub vss_commitments: Vec<Vec<u8>>,  // c_i = H(v_i || R(i) || γ_i) for each node
    #[serde(default)]
    pub vss_proof_polynomial: Vec<String>, // Z(X) polynomial coefficients as hex strings
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct EncryptedShares {
    pub node_id: u32,
    pub encrypted_data: Vec<u8>,  // Encrypted SecretShares for this node
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MerkleProofElement {
    pub hash: Vec<u8>,
    pub is_left: bool,
}

/// Transfer between two users
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Transfer {
    pub sender: String,
    pub recipient: String,

    // Sender's transition
    pub sender_transition: StateTransition,

    // Recipient's transition
    pub recipient_transition: StateTransition,

    // Amount (as commitment, not actual value)
    pub amount_commitment: Vec<u8>,
}

/// Pending validation (waiting for threshold MPC signatures)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PendingValidation {
    pub validation_id: String,
    pub transition: StateTransition,
    pub validations: Vec<NodeValidation>,
    pub threshold_reached: bool,
    pub created_at: u64,
}

/// Individual node's validation
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct NodeValidation {
    pub node_id: u32,
    pub valid: bool,
    pub partial_signature: Vec<u8>,  // TSS partial signature
}

// ============================================================================
// STORAGE
// ============================================================================

pub const STATE: Item<State> = Item::new(b"state");
pub const PENDING_VALIDATIONS: Keymap<String, PendingValidation> = Keymap::new(b"pending_validations");
pub const STATE_COMMITMENTS: Keymap<String, StateCommitment> = Keymap::new(b"state_commitments");
