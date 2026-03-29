/**
 * This file (js/core/calculations.js) contains the core logic for all numerical
 * calculations in the planner, including I/O rates, power, and network status.
 * The power calculation formula has been corrected to use the proper exponents.
 */
import state from '/SatisfiedVisual/js/state.js';
import { SOMERSLOOP_SLOTS } from '/SatisfiedVisual/js/constants.js';
import { renderGlobalTotals, renderSelectionSummary, renderConnections } from '/SatisfiedVisual/js/ui/render.js';
import { round } from '/SatisfiedVisual/js/utils.js';

/**
 * Updates all cards, totals, and network statuses. The main calculation loop.
 */
export function updateAllCalculations() {
    state.placedCards.forEach(card => {
        if (card.building !== 'Alien Power Augmenter') {
            updateCardCalculations(card);
        }
    });
    calculateAndRenderNetworkStatus();
    renderGlobalTotals();
    renderSelectionSummary();
}

/**
 * Calculates and updates the UI for a single card's inputs, outputs, and power.
 * @param {object} cardData - The data object for the card to update.
 */
export function updateCardCalculations(cardData) {
    const { recipe, buildings, powerShard, somersloops, element, building } = cardData;
    const clockSpeedMultiplier = powerShard / 100;

    // Update Inputs
    cardData.inputs = {};
    Object.entries(recipe.inputs).forEach(([name, rate]) => {
        const total = rate * clockSpeedMultiplier * buildings;
        cardData.inputs[name] = round(total, 3); // Use 3-decimal precision for storage
        const inputEl = element.querySelector(`[data-input-name="${name}"] .io-rate`);
        if (inputEl) inputEl.textContent = cardData.inputs[name].toFixed(2);
    });

    // Update Outputs
    const totalSlots = SOMERSLOOP_SLOTS[building] || 0;
    const outputMultiplier = totalSlots > 0 ? (1 + (somersloops / totalSlots)) : 1;
    cardData.outputs = {};
    Object.entries(recipe.outputs).forEach(([name, rate]) => {
        const total = rate * clockSpeedMultiplier * outputMultiplier * buildings;
        cardData.outputs[name] = round(total, 3); // Use 3-decimal precision for storage
        const outputEl = element.querySelector(`[data-output-name="${name}"] .io-rate`);
        if (outputEl) outputEl.textContent = cardData.outputs[name].toFixed(2);
    });

    // --- DEFINITIVE POWER CALCULATION LOGIC (Satisfactory 1.0) ---
    const basePower = state.buildingsMap.get(building)?.power || 0;
    const isGenerator = basePower > 0;

    if (isGenerator) {
        // Generators produce power. The value is positive.
        // In Satisfactory 1.0, overclocking for generators scales linearly
        const overclockPowerMultiplier = clockSpeedMultiplier;
        cardData.power = round(Math.abs(basePower) * overclockPowerMultiplier * buildings, 3);
    } else if (basePower < 0) {
        // Consumers use power. The value is negative.
        // In Satisfactory 1.0, the overclock exponent for consumers is 1.321928
        const powerExponent = 1.321928;
        const overclockPowerMultiplier = Math.pow(clockSpeedMultiplier, powerExponent);
        const amplificationPowerMultiplier = Math.pow(outputMultiplier, 2);
        const totalConsumed = Math.abs(basePower) * overclockPowerMultiplier * amplificationPowerMultiplier * buildings;
        cardData.power = round(-totalConsumed, 3); // Ensure the final value is negative
    } else {
        cardData.power = 0;
    }

    // Update UI Stats
    const powerEl = element.querySelector('[data-value="power"]');
    if (powerEl) powerEl.textContent = cardData.power.toFixed(2);
    
    const buildingsEl = element.querySelector('[data-stat="buildings"]');
    if(buildingsEl) buildingsEl.textContent = buildings;
    
    const clockEl = element.querySelector('[data-stat="clock"]');
    if(clockEl) clockEl.textContent = powerShard.toFixed(2);
    
    const ssStat = element.querySelector('[data-stat="somersloops"]');
    if(ssStat) ssStat.textContent = `${somersloops}/${totalSlots}`;

    const psStat = element.querySelector('[data-stat="shards"]');
    if(psStat) psStat.innerHTML = `
        <svg class="w-3 h-3 inline -mt-1" viewBox="0 0 24 24" fill="currentColor" style="color: var(--accent-yellow);"><path d="M12 1.5l-9 15h18l-9-15zm0 4.85l5.54 9.15h-11.08l5.54-9.15z"></path></svg>
        ${cardData.powerShards}`;
    
    element.classList.toggle('somersloop-active', somersloops > 0);
}


/**
 * Simulates the factory network to identify and flag resource deficits.
 * Correctly distributes supply proportionally if an output connects to multiple consumers.
 */
export function calculateAndRenderNetworkStatus() {
    let changed = true;
    const effectiveOutputs = new Map();
    state.placedCards.forEach(card => effectiveOutputs.set(card.id, {...card.outputs}));

    for (let i = 0; i < state.placedCards.size && changed; i++) {
        changed = false;
        
        // 1. Calculate the total required demand requested from each specific output port
        const outputDemands = new Map();
        state.connections.forEach(conn => {
            const outputKey = `${conn.from.cardId}:${conn.from.itemName}`;
            const consumerCard = state.placedCards.get(conn.to.cardId);
            if (consumerCard) {
                const required = consumerCard.inputs[conn.to.itemName] || 0;
                outputDemands.set(outputKey, (outputDemands.get(outputKey) || 0) + required);
            }
        });

        // 2. Distribute supply to consumers proportionally based on their demand vs total availability
        const inputSupplies = new Map();
        state.connections.forEach(conn => {
            const outputKey = `${conn.from.cardId}:${conn.from.itemName}`;
            const inputKey = `${conn.to.cardId}:${conn.to.itemName}`;
            
            const sourceOutputs = effectiveOutputs.get(conn.from.cardId);
            if (sourceOutputs) {
                const totalSupply = sourceOutputs[conn.from.itemName] || 0;
                const totalDemand = outputDemands.get(outputKey) || 1; // Fallback to 1 to avoid division by zero
                
                const consumerCard = state.placedCards.get(conn.to.cardId);
                const required = consumerCard ? (consumerCard.inputs[conn.to.itemName] || 0) : 0;
                
                let supplied = required;
                // Distribute proportionally if the provider is over capacity
                if (totalSupply < totalDemand) {
                    supplied = required * (totalSupply / totalDemand);
                }
                
                inputSupplies.set(inputKey, (inputSupplies.get(inputKey) || 0) + supplied);
            }
        });

        // 3. Flag deficits and nullify downstream outputs if starved
        state.placedCards.forEach(card => {
            if (card.building === 'Alien Power Augmenter') return;

            let hasDeficit = false;
            Object.entries(card.inputs).forEach(([inputName, required]) => {
                const inputKey = `${card.id}:${inputName}`;
                const supplied = inputSupplies.get(inputKey) || 0;
                if (supplied < required - 0.001) hasDeficit = true;
            });

            if (hasDeficit) {
                const currentCardOutputs = effectiveOutputs.get(card.id);
                for (const outName in currentCardOutputs) {
                    if (currentCardOutputs[outName] !== 0) {
                        currentCardOutputs[outName] = 0;
                        changed = true;
                    }
                }
            }
        });
    }

    // Reset all deficit states before recalculating them for the visual lines
    state.connections.forEach(conn => conn.isDeficit = false);
    state.placedCards.forEach(card => card.inputDeficits.clear());
    
    // --- FINAL DEFICIT RENDER PASS ---
    const outputDemands = new Map();
    state.connections.forEach(conn => {
        const outputKey = `${conn.from.cardId}:${conn.from.itemName}`;
        const consumerCard = state.placedCards.get(conn.to.cardId);
        if (consumerCard) {
            outputDemands.set(outputKey, (outputDemands.get(outputKey) || 0) + (consumerCard.inputs[conn.to.itemName] || 0));
        }
    });

    const inputSupplies = new Map();
    state.placedCards.forEach(card => {
        Object.keys(card.inputs).forEach(inputName => {
            inputSupplies.set(`${card.id}:${inputName}`, 0); 
        });
    });

    state.connections.forEach(conn => {
        const outputKey = `${conn.from.cardId}:${conn.from.itemName}`;
        const inputKey = `${conn.to.cardId}:${conn.to.itemName}`;
        const sourceOutputs = effectiveOutputs.get(conn.from.cardId);
        if (sourceOutputs) {
            const totalSupply = sourceOutputs[conn.from.itemName] || 0;
            const totalDemand = outputDemands.get(outputKey) || 1;
            const consumerCard = state.placedCards.get(conn.to.cardId);
            const required = consumerCard ? (consumerCard.inputs[conn.to.itemName] || 0) : 0;
            
            let supplied = required;
            if (totalSupply < totalDemand) {
                supplied = required * (totalSupply / totalDemand);
            }
            inputSupplies.set(inputKey, (inputSupplies.get(inputKey) || 0) + supplied);
        }
    });

    const deficitInputs = new Set();
    state.placedCards.forEach(card => {
        Object.entries(card.inputs).forEach(([inputName, requiredRate]) => {
            const inputKey = `${card.id}:${inputName}`;
            const suppliedRate = inputSupplies.get(inputKey) || 0;
            if (suppliedRate < requiredRate - 0.001) {
                deficitInputs.add(inputKey);
                card.inputDeficits.add(inputName); 
            }
        });
    });

    state.connections.forEach(conn => {
        const inputKey = `${conn.to.cardId}:${conn.to.itemName}`;
        if (deficitInputs.has(inputKey)) {
            conn.isDeficit = true;
        }
    });

    state.placedCards.forEach(card => {
        card.element.querySelectorAll('.io-item[data-input-name]').forEach(el => {
            el.classList.toggle('deficit', card.inputDeficits.has(el.dataset.inputName));
        });
    });

    renderConnections();
}
