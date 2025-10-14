import { SecretNetworkClient, Wallet } from 'secretjs';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// DEPLOYMENT SCRIPT
// ============================================================================

async function deploy() {
    console.log('🚀 MPC Contract Deployment with SecretJS');
    console.log('==========================================\n');

    // Load configuration
    const config = {
        mnemonic: process.env.DEPLOYER_MNEMONIC || process.env.MNEMONIC,
        chainId: process.env.CHAIN_ID || 'secret-4',
        rpcUrl: process.env.RPC_URL || 'https://lcd.erth.network',
        threshold: parseInt(process.env.THRESHOLD || '2'),
        // Use optimized contract from optimized-wasm/ (built with make build-mainnet-reproducible)
        contractPath: process.env.CONTRACT_PATH || 'optimized-wasm/secret_contract.wasm.gz',
    };

    if (!config.mnemonic) {
        console.error('❌ MNEMONIC not found in .env');
        console.error('   Please add your wallet mnemonic to .env file');
        process.exit(1);
    }

    // Check if contract file exists
    if (!fs.existsSync(config.contractPath)) {
        console.error(`❌ Contract WASM not found at: ${config.contractPath}`);
        console.error('   Please build the contract first:');
        console.error('   make build-mainnet-reproducible');
        console.error('');
        console.error('   Or for quick dev builds:');
        console.error('   cargo build --target wasm32-unknown-unknown --release');
        console.error('   CONTRACT_PATH=target/wasm32-unknown-unknown/release/secret_contract.wasm node deploy.js');
        process.exit(1);
    }

    console.log('📋 Configuration:');
    console.log(`   Chain ID: ${config.chainId}`);
    console.log(`   RPC URL: ${config.rpcUrl}`);
    console.log(`   Threshold: ${config.threshold}`);
    console.log(`   Contract: ${config.contractPath}`);
    console.log('');

    // Initialize wallet and client
    console.log('🔑 Initializing wallet...');
    const wallet = new Wallet(config.mnemonic);
    const client = new SecretNetworkClient({
        url: config.rpcUrl,
        wallet: wallet,
        walletAddress: wallet.address,
        chainId: config.chainId,
    });

    console.log(`   Address: ${wallet.address}`);

    // Check balance
    try {
        const balance = await client.query.bank.balance({
            address: wallet.address,
            denom: 'uscrt'
        });
        console.log(`   Balance: ${(parseInt(balance.balance.amount) / 1_000_000).toFixed(2)} SCRT`);
    } catch (error) {
        console.log('   Balance: (unable to query)');
    }
    console.log('');

    // Upload contract
    console.log('📤 Uploading contract...');
    const wasmCode = fs.readFileSync(config.contractPath);

    let uploadTx;
    try {
        uploadTx = await client.tx.compute.storeCode(
            {
                sender: wallet.address,
                wasm_byte_code: wasmCode,
                source: '',
                builder: '',
            },
            {
                gasLimit: 5_000_000,
            }
        );

        if (uploadTx.code !== 0) {
            console.error('❌ Upload failed:', uploadTx.rawLog);
            process.exit(1);
        }

        console.log('✓ Contract uploaded successfully');
        console.log(`   TX Hash: ${uploadTx.transactionHash}`);
    } catch (error) {
        console.error('❌ Upload error:', error.message);
        process.exit(1);
    }

    // Extract code ID
    const codeIdAttr = uploadTx.arrayLog.find(
        log => log.type === 'message' && log.key === 'code_id'
    );

    if (!codeIdAttr) {
        console.error('❌ Could not find code_id in transaction logs');
        process.exit(1);
    }

    const codeId = parseInt(codeIdAttr.value);
    console.log(`   Code ID: ${codeId}`);
    console.log('');

    // Get code hash
    console.log('🔍 Querying code hash...');
    let codeHash;
    try {
        const codeInfo = await client.query.compute.codeHashByCodeId({ code_id: codeId.toString() });
        codeHash = codeInfo.code_hash;
        console.log(`   Code Hash: ${codeHash}`);
    } catch (error) {
        console.error('❌ Failed to get code hash:', error.message);
        process.exit(1);
    }
    console.log('');

    // Instantiate contract
    console.log('🎬 Instantiating contract...');
    const label = `mpc-coordinator-${Date.now()}`;
    const initMsg = { threshold: config.threshold };

    console.log(`   Label: ${label}`);
    console.log(`   Init message: ${JSON.stringify(initMsg)}`);

    let instantiateTx;
    try {
        instantiateTx = await client.tx.compute.instantiateContract(
            {
                sender: wallet.address,
                code_id: codeId,
                code_hash: codeHash,
                init_msg: initMsg,
                label: label,
            },
            {
                gasLimit: 500_000,
            }
        );

        if (instantiateTx.code !== 0) {
            console.error('❌ Instantiation failed:', instantiateTx.rawLog);
            process.exit(1);
        }

        console.log('✓ Contract instantiated successfully');
        console.log(`   TX Hash: ${instantiateTx.transactionHash}`);
    } catch (error) {
        console.error('❌ Instantiation error:', error.message);
        process.exit(1);
    }

    // Extract contract address
    const contractAddressAttr = instantiateTx.arrayLog.find(
        log => log.type === 'message' && log.key === 'contract_address'
    );

    if (!contractAddressAttr) {
        console.error('❌ Could not find contract_address in transaction logs');
        process.exit(1);
    }

    const contractAddress = contractAddressAttr.value;
    console.log(`   Contract Address: ${contractAddress}`);
    console.log('');

    // Query initial state
    console.log('🔍 Querying initial state...');
    try {
        const state = await client.query.compute.queryContract({
            contract_address: contractAddress,
            code_hash: codeHash,
            query: { get_state: {} },
        });

        console.log('   Initial state:', JSON.stringify(state, null, 2));
    } catch (error) {
        console.log('   (Could not query state)');
    }
    console.log('');

    // Save deployment info
    const deploymentInfo = {
        chainId: config.chainId,
        codeId: codeId,
        codeHash: codeHash,
        contractAddress: contractAddress,
        threshold: config.threshold,
        deployer: wallet.address,
        deployedAt: new Date().toISOString(),
        uploadTxHash: uploadTx.transactionHash,
        instantiateTxHash: instantiateTx.transactionHash,
    };

    const deploymentFile = 'deployment.json';
    fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
    console.log(`💾 Deployment info saved to ${deploymentFile}`);
    console.log('');

    // Success summary
    console.log('✅ Deployment Complete!');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📝 Contract Details:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Code ID:          ${codeId}`);
    console.log(`   Code Hash:        ${codeHash}`);
    console.log(`   Contract Address: ${contractAddress}`);
    console.log(`   Threshold:        ${config.threshold}`);
    console.log(`   Chain ID:         ${config.chainId}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('📋 Next Steps:');
    console.log('');
    console.log('1. Update your MPC node .env files:');
    console.log(`   CONTRACT_ADDRESS=${contractAddress}`);
    console.log(`   CONTRACT_CODE_HASH=${codeHash}`);
    console.log('');
    console.log('2. Or create environment file automatically:');
    console.log(`   node createEnv.js`);
    console.log('');
    console.log('3. Start your MPC nodes:');
    console.log('   cd mpc-node');
    console.log('   NODE_ID=1 npm start  # Terminal 1');
    console.log('   NODE_ID=2 npm start  # Terminal 2');
    console.log('   NODE_ID=3 npm start  # Terminal 3');
    console.log('');
}

// Run deployment
deploy().catch(error => {
    console.error('\n💥 Deployment failed:', error);
    process.exit(1);
});
