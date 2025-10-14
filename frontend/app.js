// Configuration - WILL BE SET FROM deployment.json
let CONFIG = {
    chainId: 'secret-4',
    chainName: 'Secret Network',
    rpc: 'https://lcd.erth.network',
    rest: 'https://lcd.erth.network',
    contractAddress: '', // Set from deployment.json
    codeHash: '', // Set from deployment.json
};

let secretjs = null;
let walletAddress = null;
let userBalance = null;
let userNonce = 0;
let userEncryptionKeyPair = null; // For encrypting shares to MPC nodes

// Load contract config on startup
async function loadConfig() {
    try {
        const response = await fetch('./deployment.json');
        if (response.ok) {
            const deployment = await response.json();
            CONFIG.contractAddress = deployment.contractAddress;
            CONFIG.codeHash = deployment.codeHash;
            CONFIG.chainId = deployment.chainId;

            document.getElementById('contractAddress').textContent = CONFIG.contractAddress;
            document.getElementById('codeHash').textContent = CONFIG.codeHash.slice(0, 16) + '...';

            console.log('✓ Config loaded:', CONFIG);
        }
    } catch (error) {
        console.error('Failed to load deployment.json:', error);
        showStatus('Failed to load contract config. Please check deployment.json exists.', 'error');
    }
}

// Initialize on page load
loadConfig();

// Connect to Keplr wallet
window.connectWallet = async function() {
    try {
        showStatus('Connecting to Keplr...', 'info');

        if (!window.keplr) {
            showStatus('Please install Keplr extension', 'error');
            window.open('https://www.keplr.app/download', '_blank');
            return;
        }

        // Enable Secret Network
        await window.keplr.enable(CONFIG.chainId);

        // Get offline signer
        const offlineSigner = await window.keplr.getOfflineSigner(CONFIG.chainId);
        const accounts = await offlineSigner.getAccounts();
        walletAddress = accounts[0].address;

        // Use SecretJS from global window object
        const { SecretNetworkClient } = window.secretjs;

        secretjs = new SecretNetworkClient({
            url: CONFIG.rest,
            chainId: CONFIG.chainId,
            wallet: offlineSigner,
            walletAddress: walletAddress,
        });

        // Store address for easier access
        secretjs.address = walletAddress;

        // Update UI
        document.getElementById('walletStatus').textContent = 'Wallet Connected';
        document.getElementById('walletAddress').textContent = walletAddress;
        document.getElementById('connectBtn').textContent = 'Connected ✓';
        document.getElementById('connectBtn').disabled = true;
        document.getElementById('appContent').classList.remove('hidden');

        showStatus('Connected successfully!', 'success');

        // Make sure config is loaded before querying
        if (!CONFIG.contractAddress || !CONFIG.codeHash) {
            console.log('Waiting for config to load...');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Load MPC node status (checks actual liveness)
        if (window.loadMPCNodeStatus) {
            await window.loadMPCNodeStatus();

            // Refresh status every 10 seconds
            setInterval(() => window.loadMPCNodeStatus(), 10000);
        }

        // Load user balance
        await loadBalance();

    } catch (error) {
        console.error('Connection error:', error);
        showStatus(`Connection failed: ${error.message}`, 'error');
    }
};

// Show status message
function showStatus(message, type = 'info') {
    const statusDiv = document.getElementById('statusMessage');
    statusDiv.innerHTML = `<div class="status ${type}">${message}</div>`;
    setTimeout(() => {
        if (statusDiv.innerHTML.includes(message)) {
            statusDiv.innerHTML = '';
        }
    }, 5000);
}

// Add transaction to history
function addTxToHistory(description, txHash) {
    const historyDiv = document.getElementById('txHistory');
    if (historyDiv.textContent.includes('No transactions yet')) {
        historyDiv.innerHTML = '';
    }

    const txItem = document.createElement('div');
    txItem.className = 'tx-item';
    txItem.innerHTML = `
        <div><strong>${description}</strong></div>
        <div class="tx-hash">
            <a href="https://www.mintscan.io/secret/tx/${txHash}" target="_blank">
                ${txHash}
            </a>
        </div>
        <div style="font-size: 0.8em; color: #999; margin-top: 5px;">
            ${new Date().toLocaleString()}
        </div>
    `;
    historyDiv.insertBefore(txItem, historyDiv.firstChild);
}

// Load user balance
async function loadBalance() {
    try {
        if (!walletAddress) {
            console.error('Cannot load balance: wallet not connected');
            return;
        }

        if (!CONFIG.contractAddress || !CONFIG.codeHash) {
            console.error('Cannot load balance: contract config not loaded');
            showStatus('Contract config not loaded. Please refresh.', 'error');
            return;
        }

        showStatus('Loading balance...', 'info');

        const result = await secretjs.query.compute.queryContract({
            contract_address: CONFIG.contractAddress,
            code_hash: CONFIG.codeHash,
            query: {
                get_state_commitment: {
                    user_address: walletAddress
                }
            }
        });

        if (result.commitment) {
            // In production: fetch encrypted state from IPFS (result.commitment.ipfs_cid) and decrypt
            // For POC: use encrypted localStorage to simulate IPFS storage
            const storageKey = `mpc_state_${walletAddress}`;
            const storedState = localStorage.getItem(storageKey);

            if (storedState) {
                const state = decryptState(storedState);
                if (state) {
                    userBalance = state.balance;
                    userNonce = result.commitment.nonce;

                    document.getElementById('balanceAmount').textContent = userBalance;
                    showStatus('Balance loaded (decrypted)', 'success');
                } else {
                    document.getElementById('balanceAmount').textContent = '? (Decryption failed)';
                    showStatus('Failed to decrypt local state', 'error');
                }
            } else {
                // Commitment exists but no local state (user switched browsers/devices)
                document.getElementById('balanceAmount').textContent = '? (Encrypted)';
                showStatus('State found on-chain but not locally. In production, would fetch from IPFS: ' + result.commitment.ipfs_cid, 'info');
            }
        } else {
            document.getElementById('balanceAmount').textContent = '0 (Not Initialized)';
            showStatus('Balance not initialized. Please initialize first.', 'info');
        }
    } catch (error) {
        console.log('No state commitment found:', error);
        document.getElementById('balanceAmount').textContent = '0 (Not Initialized)';
    }
}

// Initialize balance
window.initializeBalance = async function(event) {
    event.preventDefault();

    const initialBalance = parseInt(document.getElementById('initialBalance').value);
    const btn = document.getElementById('initBtn');

    try {
        btn.disabled = true;
        btn.innerHTML = '<span class="loading"></span> Initializing...';

        showStatus('Getting MPC nodes from contract...', 'info');

        // Get MPC nodes from contract first
        const stateResult = await secretjs.query.compute.queryContract({
            contract_address: CONFIG.contractAddress,
            code_hash: CONFIG.codeHash,
            query: { get_state: {} }
        });

        const numNodes = stateResult.state.mpc_nodes.length;

        if (!stateResult.state || numNodes === 0) {
            throw new Error('MPC nodes not registered yet. Please wait for nodes to start.');
        }

        console.log(`Creating shares for ${numNodes} nodes (threshold: ${stateResult.state.threshold})`);

        showStatus('Creating VSS proof for balance...', 'info');

        // Generate VSS proof for the new balance (Baghery's hash-based scheme)
        const threshold = stateResult.state.threshold;
        const vssProof = await VSSUtils.generateVSSProof(initialBalance, threshold, numNodes);

        console.log('VSS Proof generated:', {
            shares: vssProof.shares,
            commitments: vssProof.commitments.map(c => Array.from(c.slice(0, 8))), // Show first 8 bytes
            proofPolynomial: vssProof.proofPolynomial,
            challenge: vssProof.challenge
        });

        showStatus('Encrypting shares for MPC nodes...', 'info');

        // Get user encryption keypair
        const userKeyPair = getUserEncryptionKeyPair();

        // Encrypt shares for each node using real nacl.box encryption
        const encryptedShares = stateResult.state.mpc_nodes.map((node, i) => {
            const shareData = {
                old_balance_share: 0,
                new_balance_share: vssProof.shares[i],
                amount_share: vssProof.shares[i], // Positive for deposits (0 + amount = new_balance)
                old_nonce_share: 0,
                new_nonce_share: 0, // Nonce starts at 0
                gamma: vssProof.gammas[i] // VSS randomness for commitment
            };

            // Convert node public key from array to hex string (browser-compatible)
            const nodePublicKeyHex = Array.from(node.public_key)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            return {
                node_id: node.node_id,
                encrypted_data: encryptForNode(shareData, nodePublicKeyHex, userKeyPair)
            };
        });

        showStatus('Submitting state transition...', 'info');

        // Prepare contract message
        // For POC: store user's encryption public key in user_signature field
        const userPublicKeyArray = Array.from(userKeyPair.publicKey);
        // Pad to 64 bytes if needed
        while (userPublicKeyArray.length < 64) {
            userPublicKeyArray.push(0);
        }

        const contractMsg = {
            submit_state_transition: {
                transition: {
                    user_address: walletAddress,
                    old_state_root: Array(32).fill(0),
                    new_state_root: hashBalance(initialBalance, 0),
                    merkle_proof: [],
                    new_state_ipfs: `Qm${randomHash()}`,
                    user_signature: userPublicKeyArray, // Contains user encryption public key for POC
                    encrypted_shares: encryptedShares,
                    vss_commitments: vssProof.commitments, // Hash commitments for VSS
                    vss_proof_polynomial: vssProof.proofPolynomial // Z(X) coefficients
                }
            }
        };

        console.log('Submitting transaction:', {
            contractAddress: CONFIG.contractAddress,
            codeHash: CONFIG.codeHash,
            msg: contractMsg
        });

        // Create MsgExecuteContract
        const { MsgExecuteContract } = window.secretjs;
        const msg = new MsgExecuteContract({
            sender: secretjs.address,
            contract_address: CONFIG.contractAddress,
            code_hash: CONFIG.codeHash,
            msg: contractMsg,
        });

        // Broadcast transaction
        const tx = await secretjs.tx.broadcast([msg], {
            gasLimit: 1_000_000,
            gasPriceInFeeDenom: 0.1,
            feeDenom: "uscrt",
            broadcastMode: "Sync",
        });

        console.log("Transaction response:", tx);

        if (tx.code !== 0) {
            throw new Error(`Transaction failed: ${tx.rawLog}`);
        }

        // Extract validation_id from transaction attributes
        const validationIdAttr = tx.arrayLog?.[0]?.events
            ?.find(e => e.type === 'wasm')
            ?.attributes?.find(a => a.key === 'validation_id');

        const validationId = validationIdAttr?.value || `${tx.height}-${walletAddress}`;

        console.log('🔑 Validation ID:', validationId);
        console.log('📋 MPC nodes should now validate this transition');

        showStatus(`Balance initialized! Validation ID: ${validationId}`, 'success');
        addTxToHistory(`Initialized balance: ${initialBalance}`, tx.transactionHash);

        userBalance = initialBalance;
        userNonce = 0;
        document.getElementById('balanceAmount').textContent = initialBalance;

        // Save encrypted state to localStorage (simulates encrypted IPFS storage in POC)
        const storageKey = `mpc_state_${walletAddress}`;
        const encryptedState = encryptState({
            balance: initialBalance,
            nonce: 0,
            updatedAt: Date.now()
        });
        localStorage.setItem(storageKey, encryptedState);
        console.log('✓ State encrypted and saved to localStorage');

    } catch (error) {
        console.error('Init error:', error);
        showStatus(`Initialization failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Initialize';
    }
};

// Send tokens
window.sendTokens = async function(event) {
    event.preventDefault();

    const recipient = document.getElementById('recipient').value;
    const amount = parseInt(document.getElementById('amount').value);
    const btn = document.getElementById('sendBtn');

    try {
        btn.disabled = true;
        btn.innerHTML = '<span class="loading"></span> Sending...';

        if (!userBalance || userBalance < amount) {
            throw new Error('Insufficient balance');
        }

        showStatus('Getting MPC nodes from contract...', 'info');

        // Get MPC nodes first to know how many shares to create
        const stateResult = await secretjs.query.compute.queryContract({
            contract_address: CONFIG.contractAddress,
            code_hash: CONFIG.codeHash,
            query: { get_state: {} }
        });

        const numNodes = stateResult.state.mpc_nodes.length;

        if (!stateResult.state || numNodes === 0) {
            throw new Error('MPC nodes not registered yet. Please wait for nodes to start.');
        }

        console.log(`Creating shares for ${numNodes} nodes (threshold: ${stateResult.state.threshold})`);

        showStatus('Creating VSS proofs for transaction...', 'info');

        const threshold = stateResult.state.threshold;

        // Generate VSS proofs for old balance, new balance, and amount
        const oldBalanceVSS = await VSSUtils.generateVSSProof(userBalance, threshold, numNodes);
        const newBalance = userBalance - amount;
        const newBalanceVSS = await VSSUtils.generateVSSProof(newBalance, threshold, numNodes);

        // For simplicity, use regular additive sharing for amount and nonce
        const amountShares = createSecretShares(amount, numNodes);
        const oldNonceShares = createSecretShares(userNonce, numNodes);
        const newNonceShares = oldNonceShares.map(s => s + 1);

        console.log('VSS Proofs generated for send:', {
            oldBalance: oldBalanceVSS.shares,
            newBalance: newBalanceVSS.shares,
            amount: amountShares
        });

        showStatus('Encrypting shares for MPC nodes...', 'info');

        // Get user encryption keypair
        const userKeyPair = getUserEncryptionKeyPair();

        // Encrypt shares for each node using real nacl.box encryption
        const encryptedShares = stateResult.state.mpc_nodes.map((node, i) => {
            const shareData = {
                old_balance_share: oldBalanceVSS.shares[i],
                new_balance_share: newBalanceVSS.shares[i],
                amount_share: -amountShares[i], // Negative for sends/withdrawals (old + (-amount) = new)
                old_nonce_share: oldNonceShares[i],
                new_nonce_share: newNonceShares[i],
                gamma: newBalanceVSS.gammas[i] // VSS randomness for new balance commitment
            };

            // Convert node public key from array to hex string (browser-compatible)
            const nodePublicKeyHex = Array.from(node.public_key)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            return {
                node_id: node.node_id,
                encrypted_data: encryptForNode(shareData, nodePublicKeyHex, userKeyPair)
            };
        });

        showStatus('Submitting transaction...', 'info');

        // Prepare contract message
        // For POC: store user's encryption public key in user_signature field
        const userPublicKeyArray = Array.from(userKeyPair.publicKey);
        // Pad to 64 bytes if needed
        while (userPublicKeyArray.length < 64) {
            userPublicKeyArray.push(0);
        }

        const contractMsg = {
            submit_state_transition: {
                transition: {
                    user_address: walletAddress,
                    old_state_root: hashBalance(userBalance, userNonce),
                    new_state_root: hashBalance(userBalance - amount, userNonce + 1),
                    merkle_proof: [],
                    new_state_ipfs: `Qm${randomHash()}`,
                    user_signature: userPublicKeyArray, // Contains user encryption public key for POC
                    encrypted_shares: encryptedShares,
                    vss_commitments: newBalanceVSS.commitments, // Hash commitments for new balance VSS
                    vss_proof_polynomial: newBalanceVSS.proofPolynomial // Z(X) coefficients for new balance
                }
            }
        };

        console.log('Submitting send transaction:', {
            contractAddress: CONFIG.contractAddress,
            codeHash: CONFIG.codeHash,
            msg: contractMsg
        });

        // Create MsgExecuteContract
        const { MsgExecuteContract } = window.secretjs;
        const msg = new MsgExecuteContract({
            sender: secretjs.address,
            contract_address: CONFIG.contractAddress,
            code_hash: CONFIG.codeHash,
            msg: contractMsg,
        });

        // Broadcast transaction
        const tx = await secretjs.tx.broadcast([msg], {
            gasLimit: 1_000_000,
            gasPriceInFeeDenom: 0.1,
            feeDenom: "uscrt",
            broadcastMode: "Sync",
        });

        console.log("Transaction response:", tx);

        if (tx.code !== 0) {
            throw new Error(`Transaction failed: ${tx.rawLog}`);
        }

        showStatus('Transaction submitted! Waiting for MPC validation...', 'success');
        addTxToHistory(`Sent ${amount} tokens to ${recipient.slice(0, 20)}...`, tx.transactionHash);

        userBalance -= amount;
        userNonce += 1;
        document.getElementById('balanceAmount').textContent = userBalance;

        // Save encrypted state to localStorage (simulates encrypted IPFS storage in POC)
        const storageKey = `mpc_state_${walletAddress}`;
        const encryptedState = encryptState({
            balance: userBalance,
            nonce: userNonce,
            updatedAt: Date.now()
        });
        localStorage.setItem(storageKey, encryptedState);
        console.log('✓ State encrypted and saved to localStorage');

        // Reset form
        document.getElementById('recipient').value = '';
        document.getElementById('amount').value = '';

    } catch (error) {
        console.error('Send error:', error);
        showStatus(`Send failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Send Tokens';
    }
};

// Helper: Get or create user encryption keypair
function getUserEncryptionKeyPair() {
    if (userEncryptionKeyPair) {
        return userEncryptionKeyPair;
    }

    // Try to load from localStorage
    const stored = localStorage.getItem('userEncryptionKeyPair');
    if (stored) {
        const parsed = JSON.parse(stored);
        userEncryptionKeyPair = {
            publicKey: new Uint8Array(parsed.publicKey),
            secretKey: new Uint8Array(parsed.secretKey)
        };
        return userEncryptionKeyPair;
    }

    // Generate new keypair
    userEncryptionKeyPair = nacl.box.keyPair();

    // Store in localStorage
    localStorage.setItem('userEncryptionKeyPair', JSON.stringify({
        publicKey: Array.from(userEncryptionKeyPair.publicKey),
        secretKey: Array.from(userEncryptionKeyPair.secretKey)
    }));

    console.log('Generated new encryption keypair for user');
    return userEncryptionKeyPair;
}

// Helper: Encrypt data for a specific MPC node
function encryptForNode(data, nodePublicKeyHex, userKeyPair) {
    // Convert hex public key to Uint8Array
    const nodePublicKey = new Uint8Array(nodePublicKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

    // Serialize data to JSON
    const message = new TextEncoder().encode(JSON.stringify(data));

    // Generate nonce
    const nonce = nacl.randomBytes(nacl.box.nonceLength);

    // Encrypt with nacl.box
    const encrypted = nacl.box(message, nonce, nodePublicKey, userKeyPair.secretKey);

    // Combine nonce + encrypted data
    const combined = new Uint8Array(nonce.length + encrypted.length);
    combined.set(nonce);
    combined.set(encrypted, nonce.length);

    return Array.from(combined);
}

// Helper: Create secret shares (simplified additive sharing)
function createSecretShares(secret, numShares) {
    const shares = [];
    let sum = 0;

    for (let i = 0; i < numShares - 1; i++) {
        const share = Math.floor(Math.random() * 1000000) - 500000;
        shares.push(share);
        sum += share;
    }

    shares.push(secret - sum);
    return shares;
}

// Helper: Hash balance and nonce
function hashBalance(balance, nonce) {
    const data = `${balance}-${nonce}`;
    const hash = Array.from(new TextEncoder().encode(data));
    while (hash.length < 32) hash.push(0);
    return hash.slice(0, 32);
}

// Helper: Random hash for IPFS CID
function randomHash() {
    return Array.from({length: 46}, () =>
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]
    ).join('');
}

// Helper: Encrypt state for localStorage using user's keypair
function encryptState(stateData) {
    const userKeyPair = getUserEncryptionKeyPair();

    // Derive symmetric key from user's secret key (first 32 bytes)
    const symmetricKey = userKeyPair.secretKey.slice(0, nacl.secretbox.keyLength);

    // Serialize state to JSON
    const message = new TextEncoder().encode(JSON.stringify(stateData));

    // Generate nonce
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);

    // Encrypt with nacl.secretbox (symmetric encryption)
    const encrypted = nacl.secretbox(message, nonce, symmetricKey);

    // Combine nonce + encrypted data
    const combined = new Uint8Array(nonce.length + encrypted.length);
    combined.set(nonce);
    combined.set(encrypted, nonce.length);

    // Convert to base64 for localStorage
    return btoa(String.fromCharCode.apply(null, combined));
}

// Helper: Decrypt state from localStorage
function decryptState(encryptedData) {
    try {
        const userKeyPair = getUserEncryptionKeyPair();

        // Derive symmetric key from user's secret key (first 32 bytes)
        const symmetricKey = userKeyPair.secretKey.slice(0, nacl.secretbox.keyLength);

        // Decode from base64
        const combined = new Uint8Array(atob(encryptedData).split('').map(c => c.charCodeAt(0)));

        // Extract nonce and encrypted data
        const nonce = combined.slice(0, nacl.secretbox.nonceLength);
        const encrypted = combined.slice(nacl.secretbox.nonceLength);

        // Decrypt
        const decrypted = nacl.secretbox.open(encrypted, nonce, symmetricKey);

        if (!decrypted) {
            throw new Error('Decryption failed');
        }

        // Parse JSON
        const json = new TextDecoder().decode(decrypted);
        return JSON.parse(json);
    } catch (error) {
        console.error('Failed to decrypt state:', error);
        return null;
    }
}
