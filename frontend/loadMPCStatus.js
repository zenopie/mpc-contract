// Load MPC node status from contract AND check liveness via HTTP
async function loadMPCNodeStatus() {
    try {
        if (!CONFIG.contractAddress || !CONFIG.codeHash) {
            console.error('Cannot load MPC status: contract config not loaded');
            return;
        }

        // Get node info from contract
        const result = await secretjs.query.compute.queryContract({
            contract_address: CONFIG.contractAddress,
            code_hash: CONFIG.codeHash,
            query: { get_state: {} }
        });

        if (result.state && result.state.mpc_nodes) {
            const nodes = result.state.mpc_nodes;
            const threshold = result.state.threshold;

            // Check liveness for each node
            const nodeHealthChecks = await Promise.all(
                nodes.map(async (node) => {
                    const port = 3000 + node.node_id;
                    const healthUrl = `http://localhost:${port}/health`;

                    try {
                        const response = await fetch(healthUrl);
                        if (response.ok) {
                            const health = await response.json();
                            return {
                                ...node,
                                isAlive: true,
                                healthData: health
                            };
                        }
                    } catch (error) {
                        console.warn(`Node ${node.node_id} health check failed:`, error.message);
                    }

                    return {
                        ...node,
                        isAlive: false
                    };
                })
            );

            // Update MPC status display
            const mpcStatusDiv = document.querySelector('.mpc-status');
            mpcStatusDiv.innerHTML = nodeHealthChecks.map(node => {
                const statusClass = node.isAlive && node.active ? 'active' : '';
                const statusIcon = node.isAlive && node.active ? '✓' : (node.isAlive ? '⚠️' : '✗');
                const statusText = node.isAlive && node.active ? 'Active & Alive' : (node.isAlive ? 'Inactive' : 'Offline');

                return `
                    <div class="node-status ${statusClass}">
                        <div class="node-id">Node ${node.node_id}</div>
                        <div>${statusIcon} ${statusText}</div>
                        <div style="font-size: 0.8em; color: #666; margin-top: 5px;">
                            ${node.address.slice(0, 12)}...
                        </div>
                        ${node.isAlive ? `
                            <div style="font-size: 0.7em; color: #999; margin-top: 3px;">
                                Uptime: ${Math.floor(node.healthData.uptime)}s
                            </div>
                        ` : ''}
                    </div>
                `;
            }).join('');

            // Update threshold info
            const activeNodes = nodeHealthChecks.filter(n => n.isAlive && n.active).length;
            const thresholdInfo = document.querySelector('.mpc-status').parentElement.querySelector('div[style*="text-align: center"]');
            if (thresholdInfo) {
                thresholdInfo.innerHTML = `
                    Threshold: ${threshold} of ${nodes.length} nodes required<br>
                    <span style="font-size: 0.9em; color: ${activeNodes >= threshold ? '#28a745' : '#dc3545'}">
                        ${activeNodes} node${activeNodes !== 1 ? 's' : ''} currently alive and active
                    </span>
                `;
            }

            console.log(`✓ MPC nodes loaded: ${activeNodes}/${nodes.length} alive`);
        }
    } catch (error) {
        console.error('Failed to load MPC node status:', error);
    }
}

// Export for use in app.js
window.loadMPCNodeStatus = loadMPCNodeStatus;
