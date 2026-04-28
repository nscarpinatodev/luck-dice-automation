// ── Luck Dice Automation — Attack & Damage ────────────────────────────────────
// All attack-roll manipulation, chat-card history rendering, and Midi-QoL hooks.
// Depends on: core.js (must be loaded first).

(() => {
const LDA = window.LDA;
const {
  MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME,
  workflowState, pendingMidiSaveResults, clamp, debug,
  getWorkflowKey, getState, getDiceItem, getDiceUses, updateDiceUses,
  updateLuckUses, actorHasLuckDice, isWorkflowResponder,
  promptChoice, promptSlider, buildFakeRoll, getKeptD20Result, spendDiceFromPools,
  evaluateReroll, buildDiceAvailableHTML, whisperLuckRegain, maybeRegainLuckDie,
  isLuckDiceEnabled, isInspirationEnabled, actorHasInspiration, consumeInspiration,
  evaluateInspirationReroll,
} = LDA;

// ── Hit state detection ───────────────────────────────────────────────────────

// getKeptD20Result is defined in core.js and shared across all roll types.

/**
 * Returns true (definite hit), false (definite miss), or null (uncertain).
 *
 * IMPORTANT: Midi resets workflow.hitTargets via checkHits() after AttackRollComplete
 * fires. An empty hitTargets cannot be trusted as a definite miss — only a non-empty
 * hitTargets is a reliable positive confirmation from Midi.
 * For misses (empty hitTargets) we fall back to AC comparison using workflow.attackTotal.
 */
function getDefiniteHitState(workflow) {
  if (!workflow?.attackRoll) return null;

  const d20Result = getKeptD20Result(workflow.attackRoll);
  if (d20Result === 20) return true;
  if (d20Result === 1)  return false;

  const hitTargets = workflow.hitTargets instanceof Set ? workflow.hitTargets : null;
  if (hitTargets !== null && hitTargets.size > 0) return true;

  const targets = workflow.targets instanceof Set ? [...workflow.targets] : [];
  if (targets.length !== 1) return null;

  const attackTotal = Number(workflow.attackTotal ?? workflow.attackRoll?.total);
  const targetAC    = Number(targets[0]?.actor?.system?.attributes?.ac?.value);
  if (!Number.isFinite(attackTotal) || !Number.isFinite(targetAC)) return null;
  return attackTotal >= targetAC;
}

// ── Attack roll manipulation ──────────────────────────────────────────────────

async function setAttackRoll(workflow, roll) {
  if (typeof workflow.setAttackRoll === "function") {
    await workflow.setAttackRoll(roll);
  } else {
    workflow.attackRoll  = roll;
    workflow.attackTotal = roll.total;
  }
  try {
    workflow.attackRollHTML = await roll.render();
    debug(`setAttackRoll: rendered attackRollHTML total=${roll.total}`);
  } catch (e) {
    debug(`setAttackRoll: roll.render() failed (${e.message})`);
  }
}

/**
 * Build a combined Roll from baseRoll + bonusRoll by merging their RollTerms.
 * Using Roll.fromTerms means .total returns the correct value naturally.
 */
async function buildCombinedRoll(baseRoll, bonusRoll) {
  try {
    const OperatorTerm = foundry.dice.terms?.OperatorTerm;
    if (!OperatorTerm) throw new Error("foundry.dice.terms.OperatorTerm not found");
    const plusTerm = new OperatorTerm({ operator: "+" });
    plusTerm._evaluated = true;
    const combined = Roll.fromTerms([...baseRoll.terms, plusTerm, ...bonusRoll.terms]);
    debug(`buildCombinedRoll: total=${combined.total} (Roll.fromTerms)`);
    return combined;
  } catch (e) {
    debug(`buildCombinedRoll: Roll.fromTerms failed (${e.message}), patching _total`);
    baseRoll._total = (baseRoll._total ?? baseRoll.total) + bonusRoll.total;
    return baseRoll;
  }
}

async function rerollAttack(workflow) {
  debug(`rerollAttack: formula="${workflow.attackRoll.formula}" old total=${workflow.attackRoll.total}`);
  const newRoll = await evaluateReroll(workflow.attackRoll);
  await setAttackRoll(workflow, newRoll);
  // Sync workflow.isCritical from the new d20 result.
  const d20Result = getKeptD20Result(newRoll);
  if (d20Result === 20) workflow.isCritical = true;
  else if (d20Result !== undefined) workflow.isCritical = false;
  console.log(`[${MODULE_ID}] rerollAttack: new total=${newRoll.total} d20=${d20Result} isCritical=${workflow.isCritical}`);
  return newRoll;
}

async function rerollInspirationAttack(workflow) {
  debug(`rerollInspirationAttack: formula="${workflow.attackRoll.formula}" old total=${workflow.attackRoll.total}`);
  const newRoll = await evaluateInspirationReroll(workflow.attackRoll);
  await setAttackRoll(workflow, newRoll);
  const d20Result = getKeptD20Result(newRoll);
  if (d20Result === 20) workflow.isCritical = true;
  else if (d20Result !== undefined) workflow.isCritical = false;
  console.log(`[${MODULE_ID}] rerollInspirationAttack: new total=${newRoll.total} d20=${d20Result} isCritical=${workflow.isCritical}`);
  return newRoll;
}

async function addLuckDiceToAttack(workflow, diceCount) {
  const bonusRoll  = await new Roll(`${diceCount}d6`).evaluate();
  if (game.dice3d) await game.dice3d.showForRoll(bonusRoll, game.user, true, null, false);
  const prevTotal  = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
  const combined   = await buildCombinedRoll(workflow.attackRoll, bonusRoll);
  await setAttackRoll(workflow, combined);
  workflow.luckAttackBonus = (workflow.luckAttackBonus ?? 0) + bonusRoll.total;
  console.log(`[${MODULE_ID}] addLuckDiceToAttack: ${diceCount}d6 = ${bonusRoll.total}, total ${prevTotal} → ${combined.total}`);
  return bonusRoll;
}

/**
 * Append the new attack total to a running history stored as a message flag.
 * renderChatMessage rebuilds the full chain from this array on every re-render.
 */
async function updateAttackCard(workflow, currentTotal, renderedRoll = "", sectionLabel = "LUCK DICE") {
  const msgId = workflow.itemCardId ?? workflow.chatId ?? workflow.messageId ?? workflow.chatMessage?.id;
  if (!msgId) { debug("updateAttackCard: no message ID on workflow"); return; }
  const message = game.messages.get(msgId);
  if (!message) { debug(`updateAttackCard: message "${msgId}" not found`); return; }

  const finalTotal = workflow.attackRoll.total;
  const existing   = message.getFlag?.(MODULE_ID, "attackReroll");
  const history    = existing?.history ? [...existing.history] : [currentTotal];
  if (history[history.length - 1] !== finalTotal) history.push(finalTotal);

  const hitState = getDefiniteHitState(workflow);
  const isHit    = hitState === true;
  const isCrit   = isHit && workflow.isCritical === true;

  debug(`updateAttackCard: history=[${history.join(" → ")}] isHit=${isHit} isCrit=${isCrit}`);
  try {
    const updates = { [`flags.${MODULE_ID}.attackReroll`]: { history, isHit, isCrit } };
    if (renderedRoll) {
      // Parse the card DOM and insert or append to the labelled section.
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = message.content ?? "";

      // Derive a stable CSS class from the section label so repeated calls
      // (e.g. two "Add Dice" actions) append to the same section rather than
      // creating a duplicate header.
      const sectionClass = `lda-section-${sectionLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const existingSection = tempDiv.querySelector(`.${sectionClass}`);

      if (existingSection) {
        // Append the new roll beneath the existing header.
        existingSection.insertAdjacentHTML("beforeend", renderedRoll);
      } else {
        // First roll for this label — create the section with its header.
        const luckSection = document.createElement("div");
        luckSection.className = sectionClass;
        luckSection.innerHTML =
          `<p style="text-align:center;font-size:10px;font-weight:bold;letter-spacing:0.15em;` +
          `text-transform:uppercase;opacity:0.6;margin:6px 0 2px">${sectionLabel}</p>` +
          renderedRoll;

        // Insert before Midi-QoL's hit-display / damage sections so the luck
        // dice sit below the full attack roll block (including tooltip) but
        // above the target rows and damage.
        const midiAnchor = tempDiv.querySelector(
          ".midi-qol-hits-display, .midi-qol-damage-roll, " +
          ".midi-qol-target-list, .end-midi-qol-attack-roll"
        );
        if (midiAnchor) {
          midiAnchor.insertAdjacentElement("beforebegin", luckSection);
        } else {
          // Fallback: after the first .dice-roll (attack section).
          const attackSection = tempDiv.querySelector(".dice-roll");
          if (attackSection) attackSection.insertAdjacentElement("afterend", luckSection);
          else tempDiv.appendChild(luckSection);
        }
      }
      updates.content = tempDiv.innerHTML;
    }
    await message.update(updates);
  } catch (e) {
    console.warn(`[${MODULE_ID}] updateAttackCard error:`, e);
  }
}

/** Recompute workflow.hitTargets from the current workflow.attackTotal vs each target's AC. */
function recomputeHitTargets(workflow) {
  const targets = workflow.targets instanceof Set ? [...workflow.targets] : [];
  const total   = Number(workflow.attackTotal ?? workflow.attackRoll?.total);
  if (!Number.isFinite(total)) return;
  workflow.hitTargets = new Set(
    targets.filter((t) => {
      const ac = Number(t?.actor?.system?.attributes?.ac?.value);
      return Number.isFinite(ac) && total >= ac;
    })
  );
  debug(`recomputeHitTargets: total=${total} hits=${workflow.hitTargets.size}/${targets.length}`);
}

// ── Damage injection ──────────────────────────────────────────────────────────

function injectLuckDamage(workflow, diceCount, isCrit) {
  const formula     = buildLuckDamageFormula(diceCount, isCrit);
  const baseFormula = `${diceCount}d6`;

  if (typeof workflow.damageRollFormula === "string" && workflow.damageRollFormula) {
    workflow.damageRollFormula = `(${workflow.damageRollFormula}) + ${formula}`;
    console.log(`[${MODULE_ID}] injectLuckDamage via damageRollFormula: ${workflow.damageRollFormula}`);
    return;
  }
  if (typeof workflow.damageFormula === "string" && workflow.damageFormula) {
    workflow.damageFormula = `(${workflow.damageFormula}) + ${formula}`;
    console.log(`[${MODULE_ID}] injectLuckDamage via damageFormula: ${workflow.damageFormula}`);
    return;
  }
  Hooks.once("dnd5e.preRollDamageV2", (rollConfig) => {
    const parts = Array.isArray(rollConfig?.parts) ? rollConfig.parts
      : Array.isArray(rollConfig?.rolls?.[0]?.parts) ? rollConfig.rolls[0].parts
      : null;
    if (parts) {
      parts.push(baseFormula);
      console.log(`[${MODULE_ID}] injectLuckDamage via preRollDamageV2: pushed "${baseFormula}" onto parts`);
    } else {
      console.warn(`[${MODULE_ID}] injectLuckDamage: preRollDamageV2 parts not found — config keys:`, Object.keys(rollConfig ?? {}));
    }
  });
  console.log(`[${MODULE_ID}] injectLuckDamage: registered preRollDamageV2 hook for "${baseFormula}" (isCrit=${isCrit})`);
}

function getPrimaryDamageType(workflow) {
  const item = workflow?.item;
  if (!item) return null;
  const types5x = item.system?.damage?.base?.types;
  if (types5x instanceof Set && types5x.size > 0) return [...types5x][0];
  const parts = item.system?.damage?.parts;
  if (Array.isArray(parts) && parts.length > 0 && parts[0]?.[1]) return parts[0][1];
  return null;
}

function isCritDiceMaximized() {
  try { return !!game.settings.get("dnd5e", "criticalDamageMaxDice"); } catch { return false; }
}

function buildLuckDamageFormula(diceCount, isCrit) {
  if (!isCrit) return `${diceCount}d6`;
  if (isCritDiceMaximized()) return `${diceCount}d6 + ${diceCount * 6}`;
  return `${diceCount * 2}d6`;
}

// ── Attack prompts ────────────────────────────────────────────────────────────

async function promptLuckOnMiss(workflow) {
  const actor = workflow?.actor;
  if (!actor || (!game.user?.isGM && actor.hasPlayerOwner && !actor.isOwner)) return;

  const state = getState(workflow);
  if (state.attackPrompted) return;

  let diceAdded = false; // once true, reroll option is hidden

  while (true) {
    const hitState = getDefiniteHitState(workflow);
    console.log(`[${MODULE_ID}] promptLuckOnMiss loop: hitState=${hitState} total=${workflow.attackTotal ?? workflow.attackRoll?.total} hits=${workflow.hitTargets?.size ?? 0}`);
    if (hitState !== false) return;

    const luckEnabled  = isLuckDiceEnabled();
    const luckAvail    = luckEnabled ? getDiceUses(actor, LUCK_DICE_ITEM_NAME)   : 0;
    const impactAvail  = luckEnabled ? getDiceUses(actor, IMPACT_DICE_ITEM_NAME) : 0;
    const totalAvail   = luckAvail + impactAvail;
    const hasInsp      = isInspirationEnabled() && actorHasInspiration(actor);

    if (totalAvail <= 0 && !hasInsp) { debug("promptLuckOnMiss: no dice or inspiration available, exiting"); return; }

    console.log(`[${MODULE_ID}] promptLuckOnMiss: luck=${luckAvail} impact=${impactAvail} total=${totalAvail} inspiration=${hasInsp} diceAdded=${diceAdded}`);
    state.attackPrompted = true;

    const options = [];
    if (hasInsp)                         options.push({ action: "inspiration", label: "Use Inspiration (Reroll)" });
    if (totalAvail >= 2 && !diceAdded)   options.push({ action: "reroll",      label: "Spend 2 Dice to Reroll" });
    if (totalAvail > 0)                  options.push({ action: "add",         label: `Add Dice (1–${totalAvail}d6)` });
    options.push({ action: "decline", label: "Keep Miss" });

    const action = await promptChoice(
      "Missed Attack",
      `<p>Your attack missed. What would you like to do?</p>${luckEnabled ? buildDiceAvailableHTML(actor) : ""}`,
      options
    );
    console.log(`[${MODULE_ID}] promptLuckOnMiss: player chose "${action}"`);
    if (action === "decline" || !action) return;

    if (action === "inspiration") {
      await consumeInspiration(actor);
      const oldTotal = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
      const newRoll  = await rerollInspirationAttack(workflow);
      await updateAttackCard(workflow, oldTotal, await newRoll.render(), "INSPIRATION");
      if (getDefiniteHitState(workflow) === true) {
        state.convertedMissToHit = true;
        recomputeHitTargets(workflow);
        debug("promptLuckOnMiss: inspiration reroll converted miss to hit");
      }
      // Inspiration and Luck Dice are mutually exclusive — stop here regardless of hit state.
      return;
    }

    if (action === "reroll" && totalAvail >= 2) {
      const spent = await spendDiceFromPools(actor, 2);
      if (spent < 2) { debug("promptLuckOnMiss: could not spend 2 dice for reroll"); return; }
      state.luckSpentOnAttack += 2;
      const oldTotalReroll = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
      const newRoll        = await rerollAttack(workflow);
      await updateAttackCard(workflow, oldTotalReroll, await newRoll.render());
      if (getDefiniteHitState(workflow) === true) {
        state.convertedMissToHit = true;
        recomputeHitTargets(workflow);
        debug("promptLuckOnMiss: reroll converted miss to hit");
      }
    }

    if (action === "add") {
      const curLuck   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
      const curImpact = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
      const curMax    = curLuck + curImpact;
      if (curMax <= 0) return;

      const raw = await promptSlider("Add Dice to Attack", buildDiceAvailableHTML(actor), "luckDiceCount", 1, curMax, 1);
      const diceCount = clamp(Number(raw ?? 0), 1, curMax);
      if (!Number.isFinite(diceCount) || diceCount < 1) { debug("promptLuckOnMiss: invalid diceCount"); return; }

      const spent = await spendDiceFromPools(actor, diceCount);
      if (spent < 1) { debug("promptLuckOnMiss: could not spend dice for add"); return; }
      diceAdded = true;
      state.luckSpentOnAttack += diceCount;
      const oldTotalAdd = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
      const bonusRoll   = await addLuckDiceToAttack(workflow, diceCount);
      await updateAttackCard(workflow, oldTotalAdd, await bonusRoll.render());
      if (getDefiniteHitState(workflow) === true) {
        state.convertedMissToHit = true;
        recomputeHitTargets(workflow);
        debug("promptLuckOnMiss: add-dice converted miss to hit");
      }
    }
  }
}

async function promptLuckOnDamage(workflow) {
  const actor = workflow?.actor;
  if (!actor) return;

  const state = getState(workflow);
  if (state.damagePrompted) return;

  const hitState    = getDefiniteHitState(workflow);
  const effectiveHit = hitState === true || state.convertedMissToHit === true;
  const isCrit       = workflow.isCritical === true;
  const maximizeCrit = isCrit && isCritDiceMaximized();

  console.log(
    `[${MODULE_ID}] preDamageRoll:`,
    `hitState=${hitState}`,
    `convertedMissToHit=${state.convertedMissToHit ?? false}`,
    `effectiveHit=${effectiveHit}`,
    `isCrit=${isCrit}`,
    `maximizeCrit=${maximizeCrit}`,
    `hitTargets=${workflow.hitTargets?.size ?? "n/a"}`,
    `attackTotal=${workflow.attackTotal ?? workflow.attackRoll?.total ?? "n/a"}`,
    `damageRollFormula="${workflow.damageRollFormula ?? "n/a"}"`,
    `damageFormula="${workflow.damageFormula ?? "n/a"}"`
  );

  if (!effectiveHit) { debug("promptLuckOnDamage: not a hit — skipping damage prompt"); return; }

  const luckAvail   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impactAvail = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const totalAvail  = luckAvail + impactAvail;
  if (totalAvail <= 0) { debug("promptLuckOnDamage: no dice available"); return; }

  let critNote = "";
  if (isCrit) {
    critNote = maximizeCrit
      ? `<p><em>Critical hit! Extra dice are maximized.</em></p>`
      : `<p><em>Critical hit! You'll roll double the chosen number of dice.</em></p>`;
  }

  const raw = await promptSlider(
    isCrit ? "Add Dice to Damage (Critical Hit!)" : "Add Dice to Damage",
    `<p>Attack ${isCrit ? "critically " : ""}hit! Add dice to damage?</p>${critNote}${buildDiceAvailableHTML(actor)}`,
    "luckDamageCount",
    0, totalAvail, 0
  );

  state.damagePrompted = true;

  const diceCount = clamp(Number(raw ?? 0), 0, totalAvail);
  if (!Number.isFinite(diceCount) || diceCount <= 0) { debug("promptLuckOnDamage: player chose 0 dice"); return; }

  const spent = await spendDiceFromPools(actor, diceCount);
  if (spent < 1) { debug("promptLuckOnDamage: could not spend dice"); return; }

  console.log(`[${MODULE_ID}] promptLuckOnDamage: injecting ${diceCount}d6 isCrit=${isCrit} maximizeCrit=${maximizeCrit}`);
  injectLuckDamage(workflow, diceCount, isCrit);
}

async function promptNatOne(workflow) {
  const actor = workflow?.actor;
  if (!actor || (!game.user?.isGM && actor.hasPlayerOwner && !actor.isOwner)) return;

  const state        = getState(workflow);
  const luckEnabled  = isLuckDiceEnabled();
  const luckAvail    = luckEnabled ? getDiceUses(actor, LUCK_DICE_ITEM_NAME)   : 0;
  const impactAvail  = luckEnabled ? getDiceUses(actor, IMPACT_DICE_ITEM_NAME) : 0;
  const totalAvail   = luckAvail + impactAvail;
  const hasInsp      = isInspirationEnabled() && actorHasInspiration(actor);

  // No options at all — auto-regain if luck dice are enabled and the actor has them.
  if (totalAvail < 2 && !hasInsp) {
    debug("promptNatOne: fewer than 2 dice available and no inspiration — auto-regaining 1 Luck Die");
    if (luckEnabled) {
      await updateLuckUses(actor, 1);
      await whisperLuckRegain(actor, "natural 1 with no dice to reroll");
    }
    return;
  }

  const options = [];
  if (hasInsp)         options.push({ action: "inspiration", label: "Use Inspiration (Reroll)" });
  if (totalAvail >= 2) options.push({ action: "reroll",      label: "Spend 2 Dice to Reroll" });
  options.push({ action: "keep", label: luckEnabled ? "Keep Miss (Regain 1 Luck Die)" : "Keep Miss" });

  const action = await promptChoice(
    "Natural 1!",
    `<p>You rolled a natural 1. What would you like to do?</p>${luckEnabled ? buildDiceAvailableHTML(actor) : ""}`,
    options
  );

  console.log(`[${MODULE_ID}] promptNatOne: player chose "${action}"`);

  if (action === "inspiration") {
    await consumeInspiration(actor);
    const oldTotal = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
    const newRoll  = await rerollInspirationAttack(workflow);
    await updateAttackCard(workflow, oldTotal, await newRoll.render(), "INSPIRATION");
    if (getDefiniteHitState(workflow) === true) {
      state.convertedMissToHit = true;
      recomputeHitTargets(workflow);
      debug("promptNatOne: inspiration reroll converted nat-1 to hit");
    }
    // Inspiration and Luck Dice are mutually exclusive — stop here regardless of hit state.
    return;
  }

  if (action === "reroll") {
    const spent = await spendDiceFromPools(actor, 2);
    if (spent < 2) { debug("promptNatOne: could not spend 2 dice"); return; }
    state.luckSpentOnAttack += 2;
    const oldTotal = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
    const newRoll  = await rerollAttack(workflow);
    await updateAttackCard(workflow, oldTotal, await newRoll.render());
    if (getDefiniteHitState(workflow) === true) {
      state.convertedMissToHit = true;
      recomputeHitTargets(workflow);
      debug("promptNatOne: reroll converted nat-1 miss to hit");
    } else {
      await promptLuckOnMiss(workflow);
    }
    return;
  }

  if (luckEnabled) {
    await updateLuckUses(actor, 1);
    await whisperLuckRegain(actor, "kept natural 1 miss");
  }
}

// ── Midi save-pass card indicator ────────────────────────────────────────────

/**
 * Flip the Midi spell-card target row for `uuid` from × (failed) to ✓ (passed)
 * directly on the provided DOM `container`. Called from renderChatMessageHTML
 * so re-renders triggered by Midi don't revert the icon.
 *
 * @param {Element}      container  Root element to search within.
 * @param {string}       uuid       Token UUID to locate.
 * @param {number}       [newTotal] Luck-dice adjusted save total — updates the roll display.
 * @param {number}       [dc]       Save DC — updates the tooltip.
 */
function applyLuckySavePassToDOM(container, uuid, newTotal, dc) {
  if (!(container instanceof Element)) return;
  const anchorEl = container.querySelector(`[data-uuid="${uuid}"]`);
  if (!anchorEl) return;

  // The UUID attribute is on a child div; climb to the <li> row that holds the icon.
  const row = anchorEl.closest("li") ??
              anchorEl.closest("[class*='midi-qol-flex-container']") ??
              anchorEl.parentElement;
  if (!row) return;

  let flipped = false;
  for (const icon of row.querySelectorAll("i, span[class*='fa-']")) {
    if (icon.closest(".dice-result, .dice-tooltip")) continue;
    const cls = icon.className ?? "";
    if (!/fa-(times|xmark)|midi-qol-(miss|fail|save-fail|save-failure)/i.test(cls)) continue;
    icon.classList.remove(
      "fa-times", "fa-xmark", "midi-qol-miss", "midi-qol-fail",
      "midi-qol-save-fail", "midi-qol-save-failure", "miss", "fail", "failure"
    );
    icon.classList.add("fa-check", "midi-qol-save-success", "success");
    icon.style.color = "#719f50";
    flipped = true;
  }
  row.classList.remove("failure", "miss", "fail", "midi-qol-miss", "midi-qol-save-failure");
  row.classList.add("success", "midi-qol-save-success");

  // Update the displayed save total so the card shows the luck-dice adjusted number.
  if (newTotal !== undefined) {
    // Midi renders the roll total in a span with a class that includes "save-total",
    // or sometimes as a plain number span / anchor within the row.  Try several selectors.
    const totalEl = row.querySelector(
      ".midi-qol-save-total, [class*='save-total'], [class*='saveTotal'], " +
      ".midi-qol-roll-total, [class*='roll-total']"
    );
    if (totalEl) {
      totalEl.textContent = String(newTotal);
      if (dc !== undefined) {
        totalEl.setAttribute("data-tooltip", `${newTotal} vs DC ${dc} (luck dice)`);
        totalEl.setAttribute("title", `${newTotal} vs DC ${dc} (luck dice)`);
      }
      debug(`applyLuckySavePassToDOM: updated save total display to ${newTotal}`);
    } else {
      // Log child class names so we can find the right selector on the next pass.
      const childClasses = [...row.querySelectorAll("*")].map(el => el.className).filter(Boolean);
      console.log(`[${MODULE_ID}] applyLuckySavePassToDOM: save total span not found for uuid=${uuid} — row child classes:`, childClasses);
    }
  }

  debug(`applyLuckySavePassToDOM: flipped=${flipped} uuid=${uuid} newTotal=${newTotal ?? "n/a"}`);
}

// ── Chat card history rendering ───────────────────────────────────────────────

/**
 * Mutate `container` to display the reroll history stored in `reroll`.
 * Returns true if the anchor element was found and the history was applied.
 */
function applyHistoryToDOM(container, reroll) {
  const { history, isHit } = reroll;
  if (!history?.length || history.length < 2) return false;
  if (!(container instanceof Element)) return false;

  for (const el of container.querySelectorAll("h4.dice-total, .dice-total")) {
    if (Number(el.textContent.trim()) !== history[0]) continue;

    el.style.cssText += ";text-decoration:line-through;opacity:0.4;font-size:0.8em;margin-bottom:2px";

    let anchor = el;
    for (let i = 1; i < history.length; i++) {
      const isLast = i === history.length - 1;
      const newEl  = document.createElement(el.tagName.toLowerCase());

      if (!isLast) {
        newEl.className   = el.className;
        newEl.textContent = String(history[i]);
        newEl.style.cssText = "text-decoration:line-through;opacity:0.4;font-size:0.8em;margin-bottom:2px";
      } else if (isHit) {
        newEl.className        = "dice-total success";
        newEl.style.color      = "#719f50";
        newEl.style.borderColor = "#719f50";
        newEl.appendChild(document.createTextNode(String(history[i])));
        const iconsDiv = document.createElement("div");
        iconsDiv.className = "icons";
        const icon = document.createElement("i");
        icon.className = "fas fa-check";
        icon.setAttribute("inert", "");
        iconsDiv.appendChild(icon);
        newEl.appendChild(iconsDiv);
      } else {
        newEl.className   = el.className;
        newEl.textContent = String(history[i]);
      }

      anchor.parentNode.insertBefore(newEl, anchor.nextSibling);
      anchor = newEl;
    }

    debug(`applyHistoryToDOM (numeric): history=[${history.join("→")}] isHit=${isHit ?? false}`);
    return true;
  }

  // Text-label mode fallback (Midi configured to show "misses"/"hits" instead of totals).
  if (isHit === true) {
    for (const el of container.querySelectorAll("h4.dice-total, .dice-total")) {
      const text = el.textContent.trim().toLowerCase();
      if (text === "" || !isNaN(Number(text))) continue;
      if (!/miss|fumble|fail/.test(text)) continue;
      el.className        = "dice-total success";
      el.style.color      = "#719f50";
      el.style.borderColor = "#719f50";
      el.textContent      = "hits";
      debug(`applyHistoryToDOM (text-label): "${text}" → "hits"`);
      return true;
    }
  }

  return false;
}

// ── Midi hit-indicator update ─────────────────────────────────────────────────

/**
 * Flip Midi-QoL's target hit-check row from miss (×) to hit (✓) inside `container`.
 * DOM structure (from inspection):
 *   <li class="target failure midi-qol midi-qol-hit-class midi-qol-target-select">
 *     <i class="midi-qol-hit-symbol fas fa-[times|xmark] midi-qol-miss miss">
 */
function updateMidiHitIndicators(container) {
  if (!(container instanceof Element)) return;
  let updated = false;

  // Primary: use Midi's own hit-symbol class to find miss icons precisely.
  for (const icon of container.querySelectorAll(
    "i.midi-qol-hit-symbol.midi-qol-miss, " +
    "i.midi-qol-hit-symbol.fa-times, " +
    "i.midi-qol-hit-symbol.fa-xmark"
  )) {
    icon.classList.remove("fa-times", "fa-xmark", "midi-qol-miss", "miss");
    icon.classList.add("fa-check", "midi-qol-hit", "hit");
    icon.style.color = "#719f50";
    const row = icon.closest("li");
    if (row) {
      row.classList.remove("failure", "miss", "midi-qol-miss", "midi-qol-missed");
      row.classList.add("hit", "midi-qol-hit");
    }
    updated = true;
  }

  // Fallback: any fa-times/fa-xmark outside the dice-result section.
  if (!updated) {
    for (const icon of container.querySelectorAll("i.fas.fa-times, i.fas.fa-xmark, i.fa-times, i.fa-xmark")) {
      if (icon.closest(".dice-result")) continue;
      icon.classList.remove("fa-times", "fa-xmark");
      icon.classList.add("fa-check");
      icon.style.color = "#719f50";
      const row = icon.parentElement?.closest("li, .midi-qol-target-result, [class*='target']");
      if (row) {
        row.classList.remove("failure", "miss", "midi-qol-miss", "midi-qol-missed");
        row.classList.add("hit", "midi-qol-hit");
      }
      updated = true;
    }
  }

  debug(`updateMidiHitIndicators: updated=${updated}`);
}

// ── Midi save failure prompt ──────────────────────────────────────────────────

/**
 * Show the luck dice / inspiration prompt on the current client and return the
 * result. Called directly when this client owns the actor.
 *
 * Cross-file calls to promptNatOneSave (saving-throw.js) and promptLuckOnCheckFail
 * (skill-check.js) go through LDA because those scripts load after attack.js.
 */
async function runMidiSavePrompt(actor, rollTotal, dc, formula, d20Result, rollMsgId, rollMsgContent) {
  const fakeRoll = buildFakeRoll(rollTotal, formula, d20Result);
  if (d20Result === 1) {
    return LDA.promptNatOneSave(actor, rollTotal, dc, fakeRoll, rollMsgId, rollMsgContent);
  }
  return LDA.promptLuckOnCheckFail(
    actor, rollTotal, dc, rollMsgId, rollMsgContent, fakeRoll,
    "Failed Saving Throw", "saving throw"
  );
}

/**
 * Emit a midiSaveFailed socket to the owning player and await their result.
 * The Promise resolves when the player's client emits midiSaveResult back.
 * Times out after 60 seconds (player dismissed / no response).
 */
function requestMidiSaveFromPlayer(actor, rollTotal, dc, formula, d20Result, rollMsgId, rollMsgContent) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingMidiSaveResults.delete(actor.id);
      resolve(null);
    }, 60_000);

    pendingMidiSaveResults.set(actor.id, { resolve, timeoutId });

    game.socket.emit(`module.${MODULE_ID}`, {
      type: "midiSaveFailed",
      actorId: actor.id, rollTotal, dc, formula,
      d20Result, rollMsgId, rollMsgContent
    });
  });
}

/**
 * Patch the save-roll entry in workflow.tokenSaves so Midi counts the token as
 * having passed. Handles both Roll objects and plain-object wrappers.
 */
function patchSaveRoll(saveData, newTotal) {
  // Direct Roll object or Roll-like with _total
  if (typeof saveData?._total !== "undefined") {
    saveData._total = newTotal;
    return;
  }
  // Object that wraps a Roll: {roll: Roll, ...}
  if (typeof saveData?.roll?._total !== "undefined") {
    saveData.roll._total = newTotal;
    return;
  }
  // Last resort: redefine the total getter
  try {
    Object.defineProperty(saveData, "total", { get: () => newTotal, configurable: true, enumerable: true });
  } catch (e) {
    debug(`patchSaveRoll: could not patch total — ${e.message}`);
  }
}

/**
 * After a luck dice save pass, retroactively heal the actor for the "halves"
 * save damage that was already applied. Midi had applied full damage (save failed
 * when postWaitForSaves fired); on a pass the target should have taken half.
 */
async function retroactivelyFixMidiSaveDamage(workflow, actor) {
  // Determine onSave damage behavior from the item activity or legacy field.
  const activities = workflow.item?.system?.activities;
  let onSave = "none";
  if (activities) {
    for (const activity of activities.values()) {
      if (activity?.save?.damage?.onSave) { onSave = activity.save.damage.onSave; break; }
    }
  }
  if (onSave === "none") {
    onSave = workflow.item?.system?.save?.onSave ?? "none";
  }
  console.log(`[${MODULE_ID}] retroactivelyFixMidiSaveDamage: actor=${actor.name} onSave=${onSave}`);
  if (onSave !== "halves") return;

  // Find this actor's damage entry in workflow.damageList.
  const damageList = Array.isArray(workflow.damageList) ? workflow.damageList : [];
  console.log(
    `[${MODULE_ID}] retroactivelyFixMidiSaveDamage: damageList length=${damageList.length}`,
    damageList.map(d => ({ actorId: d.actorId, tokenId: d.tokenId, applied: d.appliedDamage }))
  );
  const entry = damageList.find(
    d => d.actorId === actor.id || d.tokenId === actor.token?.id
  );
  if (!entry) {
    console.log(`[${MODULE_ID}] retroactivelyFixMidiSaveDamage: no damageList entry for ${actor.name}`);
    return;
  }

  // Midi-QoL 13 uses different field names — check several.
  const applied = Number(entry.appliedDamage ?? entry.applied ?? entry.damageApplied ?? entry.total ?? 0);
  if (applied <= 0) return;

  // Full damage was applied; on a pass the target should take half.
  // Heal the difference: full − floor(full / 2) = ceil(full / 2).
  const healAmount = applied - Math.floor(applied / 2);
  if (healAmount <= 0) return;

  const currentHP = Number(actor.system?.attributes?.hp?.value ?? 0);
  const maxHP     = Number(actor.system?.attributes?.hp?.max   ?? 0);
  const newHP     = Math.min(currentHP + healAmount, maxHP);
  console.log(`[${MODULE_ID}] retroactivelyFixMidiSaveDamage: ${actor.name} applied=${applied} healing=${healAmount} hp ${currentHP}→${newHP}`);
  await actor.update({ "system.attributes.hp.value": newHP });
}

/**
 * Flip the save indicator in BOTH the stored message.content (so Midi's async
 * enrichment starts from the correct HTML) AND persist a flag so the
 * dnd5e.renderChatMessage hook can re-apply the flip on every subsequent render.
 * Both changes are written in a single server round-trip.
 */
async function updateMidiSaveCardForActor(workflow, actor, uuid) {
  const msgId = workflow.itemCardId ?? workflow.chatId ?? workflow.messageId;
  if (!msgId) { console.log(`[${MODULE_ID}] updateMidiSaveCardForActor: no itemCardId`); return; }
  const message = game.messages.get(msgId);
  if (!message) { console.log(`[${MODULE_ID}] updateMidiSaveCardForActor: message ${msgId} not found`); return; }

  // Retrieve luck-dice totals stored in postWaitForSaves.
  const passData = workflow._luckyMidiPasses?.get(uuid);
  const newTotal = passData?.newTotal;
  const dc       = passData?.dc;

  // Bake fa-check (and updated total) into the stored HTML so Midi's async enrichment
  // starts from the already-correct HTML.
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = message.content ?? "";
  applyLuckySavePassToDOM(tempDiv, uuid, newTotal, dc);

  // Persist flag with {newTotal, dc} so dnd5e.renderChatMessage can re-apply after enrichment.
  const existing   = message.getFlag?.(MODULE_ID, "luckyMidiPasses") ?? {};
  const flagEntry  = { newTotal: newTotal ?? null, dc: dc ?? null };
  await message.update({
    content: tempDiv.innerHTML,
    [`flags.${MODULE_ID}.luckyMidiPasses`]: { ...existing, [uuid]: flagEntry }
  });
  console.log(`[${MODULE_ID}] updateMidiSaveCardForActor: content+flag updated for ${actor.name} uuid=${uuid} newTotal=${newTotal ?? "n/a"} dc=${dc ?? "n/a"}`);
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  console.log(`[${MODULE_ID}] attack.js ready — midi-qol active=${game.modules.get("midi-qol")?.active ?? false}`);
  if (!game.modules.get("midi-qol")?.active) {
    ui.notifications?.warn("Luck Dice Automation requires Midi-QoL.");
    return;
  }

  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!(html instanceof HTMLElement)) return;
    // Attack reroll history only — save-pass flip is handled in dnd5e.renderChatMessage
    // (which fires AFTER Midi's async card enrichment, so it doesn't get overwritten).
    const reroll = message.getFlag?.(MODULE_ID, "attackReroll");
    if (reroll?.history?.length >= 2 && !reroll.baked) {
      applyHistoryToDOM(html, reroll);
      if (reroll.isHit) updateMidiHitIndicators(html);
    }
  });

  // dnd5e.renderChatMessage fires AFTER Midi's async card enrichment completes.
  // This is the correct place to apply the save-pass flip so enrichment doesn't
  // overwrite it.  The flag stores { [uuid]: { newTotal, dc } } so we can also
  // restore the correct save total on each re-render.
  Hooks.on("dnd5e.renderChatMessage", (message, html) => {
    if (!(html instanceof Element)) return;
    const luckyPasses = message.getFlag?.(MODULE_ID, "luckyMidiPasses");
    if (!luckyPasses) return;
    for (const [uuid, passData] of Object.entries(luckyPasses)) {
      // Support both old (boolean true) and new ({newTotal, dc}) flag shapes.
      const newTotal = typeof passData === "object" && passData !== null ? (passData.newTotal ?? undefined) : undefined;
      const dc       = typeof passData === "object" && passData !== null ? (passData.dc       ?? undefined) : undefined;
      applyLuckySavePassToDOM(html, uuid, newTotal, dc);
    }
  });

  Hooks.on("midi-qol.AttackRollComplete", async (workflow) => {
    console.log(`[${MODULE_ID}] AttackRollComplete INVOKED — actor="${workflow?.actor?.name}" wfUserId=${workflow?.userId} myUserId=${game.user.id} isGM=${game.user.isGM}`);
    try {
      if (!isWorkflowResponder(workflow)) return;
      const actor    = workflow?.actor;
      const hasLuck  = isLuckDiceEnabled() && actorHasLuckDice(actor);
      const hasInsp  = isInspirationEnabled() && actorHasInspiration(actor);
      console.log(`[${MODULE_ID}] AttackRollComplete fired — actor="${actor?.name}" type=${actor?.type} hasLuck=${hasLuck} hasInsp=${hasInsp} userId=${workflow?.userId}`);
      if (!hasLuck && !hasInsp) return;

      const hitState = getDefiniteHitState(workflow);
      console.log(
        `[${MODULE_ID}] AttackRollComplete:`,
        `actor="${workflow?.actor?.name}"`,
        `item="${workflow?.item?.name}"`,
        `hitState=${hitState}`,
        `attackTotal=${workflow?.attackTotal ?? workflow?.attackRoll?.total ?? "n/a"}`,
        `d20=${getKeptD20Result(workflow?.attackRoll) ?? "n/a"}`,
        `hitTargets=${workflow?.hitTargets?.size ?? "n/a"}`,
        `targets=${workflow?.targets?.size ?? "n/a"}`
      );

      if (hitState === false) {
        const d20Result = getKeptD20Result(workflow?.attackRoll);
        if (d20Result === 1) {
          await promptNatOne(workflow);
        } else {
          await promptLuckOnMiss(workflow);
        }
      }
    } catch (err) {
      console.error(`[${MODULE_ID}] AttackRollComplete error:`, err);
    }
  });

  Hooks.on("midi-qol.preDamageRoll", async (workflow) => {
    try {
      if (!isLuckDiceEnabled() || !actorHasLuckDice(workflow?.actor)) return;
      if (!isWorkflowResponder(workflow)) return;
      await promptLuckOnDamage(workflow);

      const msgId = workflow.itemCardId ?? workflow.chatId ?? workflow.messageId ?? workflow.chatMessage?.id;
      if (msgId) {
        const message = game.messages.get(msgId);
        const existing = message?.getFlag?.(MODULE_ID, "attackReroll");
        const state    = getState(workflow);
        const effectiveHit = getDefiniteHitState(workflow) === true || state.convertedMissToHit === true;
        if (existing && !existing.isHit && effectiveHit) {
          await message.setFlag(MODULE_ID, "attackReroll", {
            ...existing,
            isHit: true,
            isCrit: workflow.isCritical === true
          });
        }
      }
    } catch (err) {
      console.error(`[${MODULE_ID}] preDamageRoll error:`, err);
    }
  });

  // ── Midi save failure prompt ─────────────────────────────────────────────────
  // "postWorkflowState_WaitForSaves" fires AFTER all save rolls are collected
  // and stored in workflow.targetSaveDetails (the source of the tokenSaves getter).
  // Midi-QoL 13 awaits async hooks, so we can block here, prompt players, and
  // patch the underlying saveRoll._total before Midi applies pass/fail outcomes.
  // Diagnostic listeners — log every save-adjacent hook so we know which names fire.
  for (const _diagHook of [
    "midi-qol.preCheckSaves", "midi-qol.postCheckSaves",
    "midi-qol.preWaitForSaves", "midi-qol.postWaitForSaves",
    "midi-qol.preSavesComplete", "midi-qol.postSavesComplete",
    "midi-qol.preApplyDynamicEffects", "midi-qol.postApplyDynamicEffects",
    "midi-qol.DamageRollComplete",
  ]) {
    Hooks.on(_diagHook, (wf) => console.log(`[${MODULE_ID}] DIAG hook fired: ${_diagHook} actor="${wf?.actor?.name}"`));
  }

  Hooks.on("midi-qol.postWaitForSaves", async (workflow) => {
    console.log(`[${MODULE_ID}] postWaitForSaves FIRED — actor="${workflow?.actor?.name}" wfUserId=${workflow?.userId} myUserId=${game.user.id} isGM=${game.user.isGM}`);
    try {
      if (!isWorkflowResponder(workflow)) return;

      const luckOn = isLuckDiceEnabled();
      const inspOn = isInspirationEnabled();
      if (!luckOn && !inspOn) return;

      // targetSaveDetails: { [uuid: string]: { saveRoll: Roll, rollDC?: number, ... } }
      const targetSaveDetails = workflow?.targetSaveDetails;
      const detailEntries = Object.entries(targetSaveDetails ?? {});
      console.log(`[${MODULE_ID}] postWaitForSaves: targetSaveDetails keys=[${detailEntries.map(([k]) => k).join(",")}]`);
      console.log(`[${MODULE_ID}] postWaitForSaves: damageList length=${workflow?.damageList?.length ?? 0}`, (workflow?.damageList ?? []).map(d => ({ actorId: d.actorId, tokenId: d.tokenId, applied: d.appliedDamage, total: d.totalDamage })));
      if (!detailEntries.length) return;

      // DC: try per-entry first (each target may have a different DC), fall back to workflow-level.
      const workflowDC = Number(
        workflow.saveDetails?.rollDC ??
        workflow.saveDetails?.dc ??
        workflow.item?.system?.save?.dc ??
        [...(workflow.item?.system?.activities?.values() ?? [])][0]?.save?.dc ??
        0
      );
      console.log(`[${MODULE_ID}] postWaitForSaves: workflowDC=${workflowDC}`);

      for (const [uuid, details] of detailEntries) {
        const saveRoll  = details?.saveRoll;
        const rollTotal = Number(saveRoll?.total ?? 0);
        const dc        = Number(details?.rollDC ?? details?.saveDetails?.rollDC ?? workflowDC);
        console.log(`[${MODULE_ID}] postWaitForSaves entry: uuid=${uuid} total=${rollTotal} dc=${dc} detailKeys=[${Object.keys(details ?? {}).join(",")}]`);
        if (!dc || rollTotal >= dc) continue;

        // Resolve the actor from the UUID (token UUID or actor UUID).
        let actor = null;
        try {
          const doc = fromUuidSync ? fromUuidSync(uuid) : null;
          actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
        } catch {}
        if (!actor) {
          const token = [...(workflow.targets ?? [])].find(
            t => t.document?.uuid === uuid || t.uuid === uuid || t.actor?.uuid === uuid
          );
          actor = token?.actor;
        }
        console.log(`[${MODULE_ID}] postWaitForSaves: resolved actor=${actor?.name ?? "null"} type=${actor?.type ?? "null"}`);
        if (!actor || actor.type !== "character") continue;

        const hasLuck = luckOn && actorHasLuckDice(actor);
        const hasInsp = inspOn && actorHasInspiration(actor);
        console.log(`[${MODULE_ID}] postWaitForSaves: hasLuck=${hasLuck} hasInsp=${hasInsp}`);
        if (!hasLuck && !hasInsp) continue;

        // Find the save's chat message (last few messages matching actor + total).
        const saveMsg = game.messages.contents.slice(-10).reverse().find(m =>
          m.rolls?.some(r => Number(r?.total) === rollTotal) &&
          (m.speaker?.actor === actor.id || m.content?.includes(actor.name))
        );
        const rollMsgId      = saveMsg?.id      ?? null;
        const rollMsgContent = saveMsg?.content ?? "";
        const formula        = saveRoll?.formula ?? "1d20";
        const d20Result      = getKeptD20Result(saveRoll) ?? null;

        // Route to the correct client and await the result.
        const activeOwner = game.users.find(
          u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER")
        );
        console.log(`[${MODULE_ID}] postWaitForSaves: activeOwner=${activeOwner?.name ?? "none"}`);

        let result;
        if (!activeOwner || activeOwner.id === game.user.id) {
          result = await runMidiSavePrompt(actor, rollTotal, dc, formula, d20Result, rollMsgId, rollMsgContent);
        } else {
          result = await requestMidiSaveFromPlayer(actor, rollTotal, dc, formula, d20Result, rollMsgId, rollMsgContent);
        }

        console.log(`[${MODULE_ID}] postWaitForSaves: ${actor.name} result=${JSON.stringify(result)}`);

        // ── Luck-dice save pass: inject result into Midi before it applies damage ──
        if (result?.passed && result.finalTotal >= dc) {
          const newTotal = result.finalTotal;

          // 1) Patch the saveRoll object in targetSaveDetails so tokenSaves getter sees a pass.
          if (saveRoll) {
            saveRoll._total = newTotal;
            // Also override .total as a direct property (handles plain-object saveRolls that
            // don't use a getter) and redefine the getter to be sure.
            try { saveRoll.total = newTotal; } catch {}
            try {
              Object.defineProperty(saveRoll, "total", {
                get() { return newTotal; }, configurable: true, enumerable: true
              });
            } catch {}
          }

          // 2) Midi caches pass/fail in workflow.saves and workflow.failedSaves during
          //    checkSaves().  Patch those Sets directly so applySaves() sees a pass.
          let tokenDoc = null;
          try { tokenDoc = fromUuidSync ? fromUuidSync(uuid) : null; } catch {}
          // fromUuidSync on a token UUID returns TokenDocument; .object is the canvas Token5e.
          const tokenObj = tokenDoc?.object ?? canvas?.tokens?.get(tokenDoc?.id) ?? null;

          console.log(`[${MODULE_ID}] postWaitForSaves sets BEFORE: saves=${workflow.saves?.size ?? typeof workflow.saves} failedSaves=${workflow.failedSaves?.size ?? typeof workflow.failedSaves}`);

          if (workflow.failedSaves instanceof Set) {
            // Remove every representation of this target.
            if (tokenObj) workflow.failedSaves.delete(tokenObj);
            if (tokenDoc) workflow.failedSaves.delete(tokenDoc);
            workflow.failedSaves.delete(uuid);
            for (const entry of [...workflow.failedSaves]) {
              const eUuid    = entry?.document?.uuid ?? entry?.uuid ?? null;
              const eActorId = entry?.actor?.id ?? entry?.document?.actor?.id ?? null;
              if (eUuid === uuid || eActorId === actor.id) workflow.failedSaves.delete(entry);
            }
          }

          if (workflow.saves instanceof Set) {
            // Add whichever representation Midi uses.
            if (tokenObj) workflow.saves.add(tokenObj);
            if (tokenDoc) workflow.saves.add(tokenDoc);
          }

          console.log(`[${MODULE_ID}] postWaitForSaves sets AFTER: saves=${workflow.saves?.size ?? typeof workflow.saves} failedSaves=${workflow.failedSaves?.size ?? typeof workflow.failedSaves} — ${actor.name} NOW PASSES`);

          // 3a) Patch the details object itself: some Midi paths read details.passed /
          //     details.isSave / details.success directly instead of consulting the Sets.
          if (details) {
            try { details.passed  = true;  } catch {}
            try { details.isSave  = true;  } catch {}
            try { details.success = true;  } catch {}
            try { details.failed  = false; } catch {}
            // Store the new total on the details object too so any downstream accessor sees it.
            try { details.saveTotal = newTotal; } catch {}
          }

          // 3) Store the result so RollComplete can update the spell card and, if needed,
          //    retroactively heal (in case damage was already applied before this hook).
          if (!workflow._luckyMidiPasses) workflow._luckyMidiPasses = new Map();
          workflow._luckyMidiPasses.set(uuid, { actor, newTotal, dc });

          // 4) If damage was already applied (unusual timing), retroactively heal now.
          if (Array.isArray(workflow.damageList) && workflow.damageList.length > 0) {
            await retroactivelyFixMidiSaveDamage(workflow, actor);
          }
        }
      }
    } catch (err) {
      console.error(`[${MODULE_ID}] postWaitForSaves error:`, err);
    }
  });

  // ── Lucky Midi save passes — card update + retroactive heal (fires after everything) ──
  Hooks.on("midi-qol.RollComplete", async (workflow) => {
    const passes = workflow._luckyMidiPasses;
    if (!passes?.size) return;
    try {
      // Log damage-tracking fields so we can see what's populated after Midi finishes.
      console.log(
        `[${MODULE_ID}] RollComplete (luckyPasses):`,
        `passes=${passes.size}`,
        `damageList=${workflow.damageList?.length ?? "n/a"}`,
        `damageDetailArr=${workflow.damageDetailArr?.length ?? "n/a"}`,
        `saves=${workflow.saves?.size ?? typeof workflow.saves}`,
        `failedSaves=${workflow.failedSaves?.size ?? typeof workflow.failedSaves}`
      );
      if (workflow.damageList?.length) {
        console.log(`[${MODULE_ID}] RollComplete damageList entries=`,
          workflow.damageList.map(d => ({ actorId: d.actorId, tokenId: d.tokenId, applied: d.appliedDamage, total: d.totalDamage, uuid: d.uuid })));
      }
      for (const [uuid, { actor, dc }] of passes) {
        // Log current HP so we can verify whether createReverseDamageCard already healed.
        const curHP = actor.system?.attributes?.hp?.value;
        console.log(`[${MODULE_ID}] RollComplete (luckyPasses): ${actor.name} currentHP=${curHP}`);
        // If damage was applied (damageList now populated), retroactively heal.
        if (Array.isArray(workflow.damageList) && workflow.damageList.length > 0) {
          await retroactivelyFixMidiSaveDamage(workflow, actor);
        }
        // Update spell card — all Midi rendering is done by RollComplete.
        await updateMidiSaveCardForActor(workflow, actor, uuid);
      }
    } catch (err) {
      console.error(`[${MODULE_ID}] RollComplete (luckyPasses) error:`, err);
    }
  });

  Hooks.on("midi-qol.RollComplete", async (workflow) => {
    try {
      if (!isLuckDiceEnabled() || !actorHasLuckDice(workflow?.actor)) return;
      if (!isWorkflowResponder(workflow)) return;
      const state = getState(workflow);

      // Permanently bake the reroll history into message.content.
      const msgId = workflow.itemCardId ?? workflow.chatId ?? workflow.messageId ?? workflow.chatMessage?.id;
      if (msgId) {
        const message = game.messages.get(msgId);
        const reroll  = message?.getFlag?.(MODULE_ID, "attackReroll");
        if (reroll?.history?.length >= 2 && !reroll.baked) {
          const tempDiv     = document.createElement("div");
          tempDiv.innerHTML = message.content ?? "";
          const historyApplied = applyHistoryToDOM(tempDiv, reroll);
          if (reroll.isHit) updateMidiHitIndicators(tempDiv);
          if (historyApplied) {
            await message.update({
              content: tempDiv.innerHTML,
              [`flags.${MODULE_ID}.attackReroll`]: { ...reroll, baked: true }
            });
            debug("RollComplete: baked attack history + hit indicators into message.content");
          }
        }
      }

      const kind   = workflow?.workflowType ?? workflow?.item?.system?.actionType ?? workflow?.type;
      const failed = workflow?.failed === true || workflow?.isFailed === true || workflow?.success === false;
      console.log(`[${MODULE_ID}] RollComplete: kind=${kind} failed=${failed}`);
      if ((kind === "save" || kind === "check") && failed) {
        await maybeRegainLuckDie(workflow.actor, state);
      }
      workflowState.delete(getWorkflowKey(workflow));
    } catch (err) {
      console.error(`[${MODULE_ID}] RollComplete error:`, err);
    }
  });

  // ── Concentration save luck dice ─────────────────────────────────────────────
  // Midi-QoL completely replaces dnd5e's concentration check with its own
  // request-card system, so dnd5e.rollConcentration never fires.
  //
  // The correct interception point is preDeleteActiveEffect, which fires
  // SYNCHRONOUSLY on the same client that calls effect.delete() — that is the
  // player's client (confirmed by the socket call-stack in Midi's debug logs).
  // Returning false cancels the server delete request; we then run the luck dice
  // prompt asynchronously and re-trigger the delete manually if the player fails.
  //
  // pendingConcentrationPrompts prevents recursion: our own re-delete call would
  // otherwise re-enter this handler, but the actor.id entry is gone by then.
  const pendingConcentrationPrompts = new Map(); // actorId → pending object

  Hooks.on("preDeleteActiveEffect", (effect, options, userId) => {
    // Must be a concentration effect.
    const isConc =
      effect.statuses?.has("concentrating") ||
      /concentrat/i.test(effect.name  ?? "") ||
      /concentrat/i.test(effect.label ?? "");
    if (!isConc) return;

    const actor = effect.parent;
    if (!actor || actor.type !== "character") return;

    // Only proceed if luck dice or inspiration could help.
    const luckOn = isLuckDiceEnabled();
    const inspOn = isInspirationEnabled();
    if (!luckOn && !inspOn) return;
    if (!actorHasLuckDice(actor) && !(inspOn && actorHasInspiration(actor))) return;

    // Route to the owning client only — non-owners skip.
    const activeOwner = game.users.find(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"));
    if (activeOwner && activeOwner.id !== game.user.id) return;
    if (!activeOwner && !game.user.isGM) return;

    // Guard: already being handled (prevents re-entry when we re-delete after failure).
    if (pendingConcentrationPrompts.has(actor.id)) return;

    // Require a recent (≤30 s) save-roll message for this actor.  This distinguishes
    // a failed-concentration-save deletion from a voluntary end (casting another
    // concentration spell, dismissing it, etc.).
    const now          = Date.now();
    const concSaveMsg  = game.messages.contents.slice(-8).reverse().find(m => {
      if (now - m.timestamp > 30_000) return false;
      if (!m.rolls?.length)           return false;
      return m.speaker?.actor === actor.id || m.content?.includes(actor.name);
    });
    if (!concSaveMsg) {
      console.log(`[${MODULE_ID}] preDeleteActiveEffect: no recent save message — not intercepting concentration end for ${actor.name}`);
      return;
    }

    const roll  = concSaveMsg.rolls[0];
    const total = Number(roll?.total ?? 0);
    // DC: dnd5e 5.x stores the current check DC on actor.concentration.dc.
    const dc    = Number(actor.concentration?.dc ?? 10);

    // If the roll actually PASSED the DC, this is not a failure deletion — skip.
    if (total >= dc) return;

    const formula   = roll.formula ?? "1d20";
    const d20Result = getKeptD20Result(roll) ?? null;

    console.log(`[${MODULE_ID}] preDeleteActiveEffect: intercepting concentration removal for ${actor.name} total=${total} dc=${dc}`);

    // Register pending entry synchronously (guard is set before we return false).
    const pending = { effectId: effect.id, shouldDelete: false, resolve: null };
    pending.promise = new Promise(res => { pending.resolve = res; });
    pendingConcentrationPrompts.set(actor.id, pending);

    (async () => {
      try {
        const result = await runMidiSavePrompt(
          actor, total, dc, formula, d20Result,
          concSaveMsg.id, concSaveMsg.content ?? ""
        );
        console.log(`[${MODULE_ID}] preDeleteActiveEffect conc: ${actor.name} result=${JSON.stringify(result)}`);
        pending.shouldDelete = !(result?.passed && result.finalTotal >= dc);
      } catch (err) {
        console.error(`[${MODULE_ID}] preDeleteActiveEffect conc error:`, err);
        pending.shouldDelete = true;
      } finally {
        // Remove entry FIRST so the re-delete below isn't intercepted again.
        pendingConcentrationPrompts.delete(actor.id);
        pending.resolve();
        if (pending.shouldDelete) {
          const concEffect =
            actor.effects.get(pending.effectId) ??
            actor.effects.find(e =>
              e.statuses?.has("concentrating") ||
              /concentrat/i.test(e.name  ?? "") ||
              /concentrat/i.test(e.label ?? ""));
          if (concEffect) {
            await concEffect.delete();
            console.log(`[${MODULE_ID}] preDeleteActiveEffect: concentration removed for ${actor.name} after failed luck dice`);
          } else {
            console.log(`[${MODULE_ID}] preDeleteActiveEffect: concentration already gone for ${actor.name}`);
          }
        } else {
          console.log(`[${MODULE_ID}] preDeleteActiveEffect: ${actor.name} KEPT concentration via luck dice`);
        }
      }
    })();

    return false; // Block the original deletion — prompt runs asynchronously above.
  });

  console.log(`[${MODULE_ID}] attack.js initialized.`);
});

Object.assign(LDA, { runMidiSavePrompt });
})();
