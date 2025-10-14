use cosmwasm_std::{
    entry_point, to_binary, Binary, Deps, DepsMut, Env, MessageInfo,
    Response, StdError, StdResult,
};
use sha2::{Sha256, Digest};

use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg, StateResponse, StateCommitmentResponse, ValidationResponse, CurrentRootResponse, PendingValidationsResponse};
use crate::state::{
    State, MPCNode, StateCommitment, StateTransition, Transfer,
    PendingValidation, NodeValidation, MerkleProofElement,
    STATE, PENDING_VALIDATIONS, STATE_COMMITMENTS,
};

// ============================================================================
// INSTANTIATE
// ============================================================================

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> StdResult<Response> {
    let state = State {
        mpc_nodes: vec![],
        threshold: msg.threshold,
        current_state_root: vec![0; 32],  // Genesis root
        block_height: 0,
    };

    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("threshold", msg.threshold.to_string()))
}

// ============================================================================
// EXECUTE
// ============================================================================

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> StdResult<Response> {
    match msg {
        ExecuteMsg::RegisterMPCNode { public_key } =>
            register_mpc_node(deps, info, public_key),
        ExecuteMsg::SubmitStateTransition { transition } =>
            submit_state_transition(deps, env, info, transition),
        ExecuteMsg::ValidateTransition { validation_id, valid, partial_signature } =>
            validate_transition(deps, env, info, validation_id, valid, partial_signature),
        ExecuteMsg::FinalizeTransition { validation_id } =>
            finalize_transition(deps, env, validation_id),
        ExecuteMsg::SubmitTransfer { transfer } =>
            submit_transfer(deps, env, info, transfer),
    }
}

fn register_mpc_node(
    deps: DepsMut,
    info: MessageInfo,
    public_key: Vec<u8>,
) -> StdResult<Response> {
    let mut state = STATE.load(deps.storage)?;

    // Check if node from this address is already registered
    let existing_idx = state.mpc_nodes.iter().position(|n| n.address == info.sender.to_string());

    if let Some(idx) = existing_idx {
        // Update existing node's public key
        let node_id = state.mpc_nodes[idx].node_id;
        state.mpc_nodes[idx].public_key = public_key;
        state.mpc_nodes[idx].active = true;

        STATE.save(deps.storage, &state)?;

        return Ok(Response::new()
            .add_attribute("action", "register_mpc_node")
            .add_attribute("node_id", node_id.to_string())
            .add_attribute("address", info.sender.to_string())
            .add_attribute("updated", "true"));
    }

    // New registration
    let node_id = state.mpc_nodes.len() as u32 + 1;

    state.mpc_nodes.push(MPCNode {
        address: info.sender.to_string(),
        node_id,
        public_key,
        active: true,
    });

    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("action", "register_mpc_node")
        .add_attribute("node_id", node_id.to_string())
        .add_attribute("address", info.sender.to_string()))
}

fn submit_state_transition(
    deps: DepsMut,
    env: Env,
    _info: MessageInfo,
    transition: StateTransition,
) -> StdResult<Response> {
    let _state = STATE.load(deps.storage)?;

    // 1. Verify user signature
    if !verify_user_signature(&transition) {
        return Err(StdError::generic_err("Invalid user signature"));
    }

    // 2. Create pending validation
    let validation_id = format!("{}-{}", env.block.height, transition.user_address);

    let pending_validation = PendingValidation {
        validation_id: validation_id.clone(),
        transition: transition.clone(),
        validations: vec![],
        threshold_reached: false,
        created_at: env.block.time.seconds(),
    };

    PENDING_VALIDATIONS.insert(deps.storage, &validation_id, &pending_validation)?;

    Ok(Response::new()
        .add_attribute("action", "submit_state_transition")
        .add_attribute("validation_id", validation_id)
        .add_attribute("user", transition.user_address)
        .add_attribute("old_root", hex::encode(transition.old_state_root))
        .add_attribute("new_root", hex::encode(transition.new_state_root)))
}

fn validate_transition(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    validation_id: String,
    valid: bool,
    partial_signature: Vec<u8>,
) -> StdResult<Response> {
    let state = STATE.load(deps.storage)?;

    // 1. Verify sender is an MPC node
    let node = state.mpc_nodes.iter()
        .find(|n| n.address == info.sender.to_string() && n.active)
        .ok_or_else(|| StdError::generic_err("Not an active MPC node"))?;

    let node_id = node.node_id; // Copy node_id before moving state

    // 2. Find pending validation
    let mut validation = PENDING_VALIDATIONS.get(deps.storage, &validation_id)
        .ok_or_else(|| StdError::generic_err("Validation not found"))?;

    // 3. Check not already validated by this node
    if validation.validations.iter().any(|v| v.node_id == node_id) {
        return Err(StdError::generic_err("Already validated"));
    }

    // 4. Add validation
    validation.validations.push(NodeValidation {
        node_id,
        valid,
        partial_signature,
    });

    // 5. Check if threshold reached - if so, auto-finalize!
    let valid_count = validation.validations.iter().filter(|v| v.valid).count();
    let threshold_reached = valid_count >= state.threshold as usize;

    if threshold_reached {
        // Auto-finalize: aggregate signatures and update state
        let threshold_signature = aggregate_signatures(&validation.validations);

        // Update state root
        let mut updated_state = state;
        updated_state.current_state_root = validation.transition.new_state_root.clone();
        updated_state.block_height += 1;
        STATE.save(deps.storage, &updated_state)?;

        // Store state commitment
        let commitment = StateCommitment {
            user_address: validation.transition.user_address.clone(),
            state_root: validation.transition.new_state_root.clone(),
            ipfs_cid: validation.transition.new_state_ipfs.clone(),
            merkle_proof: serialize_merkle_proof(&validation.transition.merkle_proof),
            nonce: 0,
            updated_at: _env.block.time.seconds(),
        };
        STATE_COMMITMENTS.insert(deps.storage, &commitment.user_address, &commitment)?;

        // Remove pending validation
        PENDING_VALIDATIONS.remove(deps.storage, &validation_id)?;

        return Ok(Response::new()
            .add_attribute("action", "validate_and_finalize")
            .add_attribute("node_id", node_id.to_string())
            .add_attribute("valid", valid.to_string())
            .add_attribute("threshold_reached", "true")
            .add_attribute("finalized", "true")
            .add_attribute("user", validation.transition.user_address)
            .add_attribute("new_root", hex::encode(updated_state.current_state_root))
            .add_attribute("block_height", updated_state.block_height.to_string())
            .add_attribute("threshold_signature", hex::encode(threshold_signature)));
    }

    // Threshold not reached yet - just save validation
    validation.threshold_reached = false;
    PENDING_VALIDATIONS.insert(deps.storage, &validation_id, &validation)?;

    Ok(Response::new()
        .add_attribute("action", "validate_transition")
        .add_attribute("node_id", node_id.to_string())
        .add_attribute("valid", valid.to_string())
        .add_attribute("threshold_reached", "false"))
}

fn finalize_transition(
    deps: DepsMut,
    env: Env,
    validation_id: String,
) -> StdResult<Response> {
    let mut state = STATE.load(deps.storage)?;

    // 1. Find validation
    let validation = PENDING_VALIDATIONS.get(deps.storage, &validation_id)
        .ok_or_else(|| StdError::generic_err("Validation not found"))?;

    // 2. Verify threshold reached
    if !validation.threshold_reached {
        return Err(StdError::generic_err("Threshold not reached"));
    }

    // 3. Aggregate TSS signatures
    let threshold_signature = aggregate_signatures(&validation.validations);

    // 4. Update state root (THIS IS THE KEY!)
    // The new state root becomes part of the global Merkle tree
    state.current_state_root = validation.transition.new_state_root.clone();
    state.block_height += 1;

    STATE.save(deps.storage, &state)?;

    // 5. Store state commitment
    let commitment = StateCommitment {
        user_address: validation.transition.user_address.clone(),
        state_root: validation.transition.new_state_root.clone(),
        ipfs_cid: validation.transition.new_state_ipfs.clone(),
        merkle_proof: serialize_merkle_proof(&validation.transition.merkle_proof),
        nonce: 0,  // Would extract from validated shares
        updated_at: env.block.time.seconds(),
    };

    STATE_COMMITMENTS.insert(
        deps.storage,
        &commitment.user_address,
        &commitment
    )?;

    // 6. Remove pending validation
    PENDING_VALIDATIONS.remove(deps.storage, &validation_id)?;

    Ok(Response::new()
        .add_attribute("action", "finalize_transition")
        .add_attribute("user", validation.transition.user_address)
        .add_attribute("new_root", hex::encode(state.current_state_root))
        .add_attribute("block_height", state.block_height.to_string())
        .add_attribute("ipfs_cid", validation.transition.new_state_ipfs)
        .add_attribute("threshold_signature", hex::encode(threshold_signature)))
}

fn submit_transfer(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    transfer: Transfer,
) -> StdResult<Response> {
    // Submit both sender and recipient transitions
    // In production, these would be linked atomically

    let response1 = submit_state_transition(
        deps.branch(),
        env.clone(),
        info.clone(),
        transfer.sender_transition,
    )?;

    let response2 = submit_state_transition(
        deps,
        env,
        info,
        transfer.recipient_transition,
    )?;

    Ok(Response::new()
        .add_attribute("action", "submit_transfer")
        .add_attribute("sender", transfer.sender)
        .add_attribute("recipient", transfer.recipient)
        .add_attribute("amount_commitment", hex::encode(transfer.amount_commitment))
        .add_attributes(response1.attributes)
        .add_attributes(response2.attributes))
}

// ============================================================================
// QUERY
// ============================================================================

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetState {} => {
            let state = STATE.load(deps.storage)?;
            to_binary(&StateResponse { state })
        }
        QueryMsg::GetStateCommitment { user_address } => {
            let commitment = STATE_COMMITMENTS.get(deps.storage, &user_address)
                .ok_or_else(|| StdError::generic_err("Commitment not found"))?;
            to_binary(&StateCommitmentResponse { commitment })
        }
        QueryMsg::GetValidation { validation_id } => {
            let validation = PENDING_VALIDATIONS.get(deps.storage, &validation_id)
                .ok_or_else(|| StdError::generic_err("Not found"))?;
            to_binary(&ValidationResponse { validation })
        }
        QueryMsg::GetCurrentRoot {} => {
            let state = STATE.load(deps.storage)?;
            to_binary(&CurrentRootResponse { root: state.current_state_root })
        }
        QueryMsg::ListPendingValidations {} => {
            // Iterate through all pending validations
            let validation_ids: Vec<String> = PENDING_VALIDATIONS
                .iter(deps.storage)?
                .map(|item| {
                    let (key, _) = item?;
                    Ok(key)
                })
                .collect::<StdResult<Vec<String>>>()?;
            to_binary(&PendingValidationsResponse { validation_ids })
        }
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

fn verify_user_signature(transition: &StateTransition) -> bool {
    // In production: verify ECDSA/EdDSA signature
    // For POC: simplified check
    !transition.user_signature.is_empty()
}

fn aggregate_signatures(validations: &[NodeValidation]) -> Vec<u8> {
    // Aggregate TSS partial signatures into threshold signature
    // In production: proper BLS aggregation
    // For POC: concatenate
    validations.iter()
        .flat_map(|v| v.partial_signature.clone())
        .collect()
}

fn serialize_merkle_proof(proof: &[MerkleProofElement]) -> Vec<u8> {
    // Serialize proof for storage
    proof.iter()
        .flat_map(|e| e.hash.clone())
        .collect()
}

// ============================================================================
// MPC VALIDATION LOGIC (Reference for off-chain nodes)
// ============================================================================

/// This runs OFF-CHAIN on each MPC node when they receive validation request
#[allow(dead_code)]
pub fn hash_shares(balance: i64, nonce: i64) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(balance.to_le_bytes());
    hasher.update(nonce.to_le_bytes());
    hasher.finalize().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::*;
    use crate::state::EncryptedShares;

    #[test]
    fn test_complete_mpc_flow() {
        let mut deps = mock_dependencies();
        let env = mock_env();

        // 1. Instantiate
        instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("creator", &[]),
            InstantiateMsg { threshold: 2 }
        ).unwrap();

        // 2. Register MPC nodes
        for i in 1..=3 {
            execute(
                deps.as_mut(),
                env.clone(),
                mock_info(&format!("node{}", i), &[]),
                ExecuteMsg::RegisterMPCNode {
                    public_key: vec![i; 32],
                }
            ).unwrap();
        }

        // 3. User submits state transition
        let transition = StateTransition {
            user_address: "alice".to_string(),
            old_state_root: vec![1; 32],
            new_state_root: vec![2; 32],
            merkle_proof: vec![],
            new_state_ipfs: "QmABC123".to_string(),
            user_signature: vec![1, 2, 3],
            encrypted_shares: vec![
                EncryptedShares {
                    node_id: 1,
                    encrypted_data: vec![],
                },
                EncryptedShares {
                    node_id: 2,
                    encrypted_data: vec![],
                },
                EncryptedShares {
                    node_id: 3,
                    encrypted_data: vec![],
                },
            ],
        };

        execute(
            deps.as_mut(),
            env.clone(),
            mock_info("alice", &[]),
            ExecuteMsg::SubmitStateTransition { transition }
        ).unwrap();

        let validation_id = format!("{}-{}", env.block.height, "alice");

        // 4. MPC nodes validate
        for i in 1..=2 {
            execute(
                deps.as_mut(),
                env.clone(),
                mock_info(&format!("node{}", i), &[]),
                ExecuteMsg::ValidateTransition {
                    validation_id: validation_id.clone(),
                    valid: true,
                    partial_signature: vec![i; 32],
                }
            ).unwrap();
        }

        // 5. Finalize
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info("anyone", &[]),
            ExecuteMsg::FinalizeTransition {
                validation_id: validation_id.clone(),
            }
        ).unwrap();

        // 6. Query state commitment
        let res = query(
            deps.as_ref(),
            env.clone(),
            QueryMsg::GetStateCommitment {
                user_address: "alice".to_string(),
            }
        ).unwrap();

        let commitment: StateCommitmentResponse = cosmwasm_std::from_binary(&res).unwrap();
        assert_eq!(commitment.commitment.ipfs_cid, "QmABC123");
    }
}
