use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use crate::state::{State, StateCommitment, StateTransition, Transfer, PendingValidation};

// ============================================================================
// MESSAGES
// ============================================================================

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct InstantiateMsg {
    pub threshold: u32,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteMsg {
    // MPC node management
    RegisterMPCNode {
        public_key: Vec<u8>,
    },

    // Submit state transition with secret shares
    SubmitStateTransition {
        transition: StateTransition,
    },

    // MPC node validates transition (receives their share)
    ValidateTransition {
        validation_id: String,
        valid: bool,
        partial_signature: Vec<u8>,
    },

    // Finalize after threshold reached
    FinalizeTransition {
        validation_id: String,
    },

    // Transfer (atomic update of two users)
    SubmitTransfer {
        transfer: Transfer,
    },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryMsg {
    GetState {},
    GetStateCommitment { user_address: String },
    GetValidation { validation_id: String },
    GetCurrentRoot {},
    ListPendingValidations {},
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct StateResponse {
    pub state: State,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct StateCommitmentResponse {
    pub commitment: StateCommitment,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ValidationResponse {
    pub validation: PendingValidation,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct CurrentRootResponse {
    pub root: Vec<u8>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct PendingValidationsResponse {
    pub validation_ids: Vec<String>,
}
