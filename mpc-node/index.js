import { SecretNetworkClient, Wallet } from 'secretjs';
import * as dotenv from 'dotenv';
import http from 'http';
import { MPCValidator, extractNodeShares } from './src/validator.js';
import { generateKeyPair, publicKeyToHex } from './src/crypto.js';

dotenv.config();

// ============================================================================
// MPC NODE SERVER
// ============================================================================

class MPCNode {
    constructor(config) {
        this.nodeId = config.nodeId;
        this.mnemonic = config.mnemonic;
        this.contractAddress = config.contractAddress;
        this.contractCodeHash = config.contractCodeHash;
        this.chainId = config.chainId || 'secret-4';
        this.rpcUrl = config.rpcUrl || 'https://lcd.erth.network';
        this.httpPort = config.httpPort || (3000 + config.nodeId);
        this.httpServer = null;

        // Generate encryption keys for this node
        const keyPair = generateKeyPair();
        this.encryptionPublicKey = keyPair.publicKey;
        this.encryptionPrivateKey = keyPair.privateKey;

        // Initialize validator
        this.validator = new MPCValidator(
            this.nodeId,
            this.encryptionPrivateKey,
            this.encryptionPublicKey
        );

        this.client = null;
        this.wallet = null;
        this.isRegistered = false;
        this.lastHeartbeat = Date.now();
    }

    /**
     * Initialize connection to Secret Network
     */
    async initialize() {
        console.log(`\n🚀 Initializing MPC Node ${this.nodeId}...`);

        // Create wallet from mnemonic
        this.wallet = new Wallet(this.mnemonic);

        // Create Secret Network client
        this.client = new SecretNetworkClient({
            url: this.rpcUrl,
            wallet: this.wallet,
            walletAddress: this.wallet.address,
            chainId: this.chainId,
        });

        console.log(`✓ Connected to Secret Network`);
        console.log(`  Address: ${this.wallet.address}`);
        console.log(`  Node ID: ${this.nodeId}`);
        console.log(`  Public Key: ${publicKeyToHex(this.encryptionPublicKey).slice(0, 16)}...`);
    }

    /**
     * Register this node with the MPC contract
     */
    async register() {
        console.log(`\n📝 Registering MPC Node ${this.nodeId}...`);

        try {
            const tx = await this.client.tx.compute.executeContract(
                {
                    sender: this.wallet.address,
                    contract_address: this.contractAddress,
                    code_hash: this.contractCodeHash,
                    msg: {
                        register_m_p_c_node: {
                            public_key: Array.from(this.encryptionPublicKey)
                        }
                    },
                },
                {
                    gasLimit: 200_000,
                }
            );

            if (tx.code !== 0) {
                throw new Error(`Registration failed: ${tx.rawLog}`);
            }

            this.isRegistered = true;
            console.log(`✓ Node registered successfully`);
            console.log(`  TX Hash: ${tx.transactionHash}`);

            return tx;

        } catch (error) {
            console.error(`❌ Registration failed:`, error.message);
            throw error;
        }
    }

    /**
     * Start HTTP server for health checks and API
     */
    async startHTTPServer() {
        this.httpServer = http.createServer((req, res) => {
            // Enable CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            // Health check endpoint
            if (req.url === '/health' && req.method === 'GET') {
                this.lastHeartbeat = Date.now();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'healthy',
                    nodeId: this.nodeId,
                    address: this.wallet?.address,
                    isRegistered: this.isRegistered,
                    uptime: process.uptime(),
                    lastHeartbeat: this.lastHeartbeat
                }));
                return;
            }

            // Status endpoint
            if (req.url === '/status' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    nodeId: this.nodeId,
                    address: this.wallet?.address,
                    publicKey: publicKeyToHex(this.encryptionPublicKey),
                    isRegistered: this.isRegistered,
                    contractAddress: this.contractAddress,
                    uptime: process.uptime()
                }));
                return;
            }

            // 404 for other endpoints
            res.writeHead(404);
            res.end('Not found');
        });

        this.httpServer.listen(this.httpPort, () => {
            console.log(`🌐 HTTP server listening on http://localhost:${this.httpPort}`);
            console.log(`   Health: http://localhost:${this.httpPort}/health`);
            console.log(`   Status: http://localhost:${this.httpPort}/status`);
        });
    }

    /**
     * Listen for state transition events and validate them
     */
    async startListening() {
        console.log(`\n👂 MPC Node ${this.nodeId} listening for validations...`);
        console.log(`   Contract: ${this.contractAddress}`);
        console.log(`   Watching for events...\n`);

        // Start HTTP server for health checks
        await this.startHTTPServer();

        // In production: use proper event subscription
        // For PoC: polling mechanism
        this.pollingInterval = setInterval(async () => {
            await this.checkForPendingValidations();
        }, 10000); // Check every 10 seconds
    }

    /**
     * Check for pending validations
     */
    async checkForPendingValidations() {
        try {
            // Query contract for list of pending validation IDs
            const result = await this.client.query.compute.queryContract({
                contract_address: this.contractAddress,
                code_hash: this.contractCodeHash,
                query: { list_pending_validations: {} },
            });

            const validationIds = result.validation_ids || [];

            if (validationIds.length === 0) {
                return; // No pending validations
            }

            console.log(`\n📋 [Node ${this.nodeId}] Found ${validationIds.length} pending validation(s)`);

            // Process each validation
            for (const validationId of validationIds) {
                // Check if we've already validated this one (in memory tracking)
                if (this.processedValidations?.has(validationId)) {
                    continue;
                }

                console.log(`\n🔍 [Node ${this.nodeId}] Processing validation: ${validationId}`);

                // Get full validation details
                const validationResult = await this.client.query.compute.queryContract({
                    contract_address: this.contractAddress,
                    code_hash: this.contractCodeHash,
                    query: {
                        get_validation: { validation_id: validationId }
                    }
                });

                const validation = validationResult.validation;

                // Check if we've already validated this
                const alreadyValidated = validation.validations.some(v => v.node_id === this.nodeId);
                if (alreadyValidated) {
                    console.log(`   ⏭️  Already validated by this node`);
                    continue;
                }

                // Extract user's encryption public key from user_signature field (POC)
                // In production, this would come from a proper key registry
                const userPublicKey = new Uint8Array(validation.transition.user_signature.slice(0, 32));

                // Validate the transition
                await this.validateTransition(
                    validationId,
                    validation.transition,
                    userPublicKey
                );

                // Track that we've processed this validation
                if (!this.processedValidations) {
                    this.processedValidations = new Set();
                }
                this.processedValidations.add(validationId);
            }

        } catch (error) {
            // Silently ignore query errors during polling
            // (e.g., if list_pending_validations returns empty or network issues)
        }
    }

    /**
     * Manually validate a specific transition
     * @param {string} validationId - Validation ID from contract
     * @param {object} transition - State transition to validate
     * @param {Uint8Array} userPublicKey - User's public key
     */
    async validateTransition(validationId, transition, userPublicKey) {
        console.log(`\n🔍 [Node ${this.nodeId}] Validating transition: ${validationId}`);

        // Extract encrypted shares for this node
        const encryptedShares = extractNodeShares(transition, this.nodeId);

        if (!encryptedShares) {
            console.error(`❌ No shares found for node ${this.nodeId}`);
            return;
        }

        // Perform validation
        const result = this.validator.validateTransition(
            transition,
            encryptedShares,
            userPublicKey
        );

        console.log(`\n📊 Validation Result:`, {
            valid: result.valid,
            reason: result.reason,
            hasSignature: !!result.partialSignature
        });

        // Submit validation to contract
        if (result.valid && result.partialSignature) {
            await this.submitValidation(validationId, result);
        }

        return result;
    }

    /**
     * Submit validation result to contract
     * @param {string} validationId - Validation ID
     * @param {object} result - Validation result
     */
    async submitValidation(validationId, result) {
        console.log(`\n📤 [Node ${this.nodeId}] Submitting validation...`);

        try {
            const tx = await this.client.tx.compute.executeContract(
                {
                    sender: this.wallet.address,
                    contract_address: this.contractAddress,
                    code_hash: this.contractCodeHash,
                    msg: {
                        validate_transition: {
                            validation_id: validationId,
                            valid: result.valid,
                            partial_signature: Array.from(result.partialSignature)
                        }
                    },
                },
                {
                    gasLimit: 200_000,
                }
            );

            if (tx.code !== 0) {
                throw new Error(`Validation submission failed: ${tx.rawLog}`);
            }

            console.log(`✓ Validation submitted successfully`);
            console.log(`  TX Hash: ${tx.transactionHash}`);

            return tx;

        } catch (error) {
            console.error(`❌ Failed to submit validation:`, error.message);
            throw error;
        }
    }

    /**
     * Query contract state
     */
    async queryState() {
        const result = await this.client.query.compute.queryContract({
            contract_address: this.contractAddress,
            code_hash: this.contractCodeHash,
            query: { get_state: {} },
        });

        return result;
    }

    /**
     * Query user's state commitment
     * @param {string} userAddress - User address
     */
    async queryUserCommitment(userAddress) {
        const result = await this.client.query.compute.queryContract({
            contract_address: this.contractAddress,
            code_hash: this.contractCodeHash,
            query: {
                get_state_commitment: {
                    user_address: userAddress
                }
            },
        });

        return result;
    }

    /**
     * Stop listening
     */
    stop() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        if (this.httpServer) {
            this.httpServer.close();
        }
        console.log(`\n🛑 MPC Node ${this.nodeId} stopped`);
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    // Load configuration
    const config = {
        nodeId: parseInt(process.env.NODE_ID || '1'),
        mnemonic: process.env.MNEMONIC || 'grant rice replace explain federal release fix clever romance raise often wild panic costume badge start supreme electric',
        contractAddress: process.env.CONTRACT_ADDRESS,
        contractCodeHash: process.env.CONTRACT_CODE_HASH,
        chainId: process.env.CHAIN_ID || 'secret-4',
        rpcUrl: process.env.RPC_URL || 'https://lcd.erth.network',
    };

    // Validate config
    if (!config.contractAddress || !config.contractCodeHash) {
        console.error('❌ Missing CONTRACT_ADDRESS or CONTRACT_CODE_HASH in .env');
        console.error('   Please set these environment variables');
        process.exit(1);
    }

    // Create and initialize node
    const node = new MPCNode(config);
    await node.initialize();

    // Register if not already registered
    // In production: check if already registered first
    try {
        await node.register();
    } catch (error) {
        console.log('   (Node may already be registered)');
    }

    // Start listening for validations
    await node.startListening();

    // Keep process running
    process.on('SIGINT', () => {
        node.stop();
        process.exit(0);
    });
}

// Export for testing
export { MPCNode };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
