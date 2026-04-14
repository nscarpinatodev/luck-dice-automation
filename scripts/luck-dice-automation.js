const MODULE_ID = "luck-dice-automation";
const LUCK_DICE_ITEM_NAME = "Luck Dice";
const IMPACT_DICE_ITEM_NAME = "Impact Dice";
const DEBUG = true; // TODO: set false before shipping

const workflowState = new Map();

function debug(...args) {
  if (DEBUG) console.log(`[${MODULE_ID}]`, ...args);
}

function getWorkflowKey(workflow) {
  return workflow?.uuid ?? workflow?.id ?? `${workflow?.actor?.id}-${workflow?.item?.id}-${Date.now()}`;
}

function getState(workflow) {
  const key = getWorkflowKey(workflow);
  if (!workflowState.has(key)) {
    workflowState.set(key, { luckSpentOnAttack: 0, damagePrompted: false, attackPrompted: false });
  }
  return workflowState.get(key);
}

// ── Dice resource helpers ─────────────────────────────────────────────────────
// Generalized so both Luck Dice and Impact Dice can share the same read/write logic.

function getDiceItem(actor, itemName) {
  return actor?.items?.find((i) => i.name === itemName);
}

function getDiceUses(actor, itemName) {
  const item = getDiceItem(actor, itemName);
  if (!item) return 0;
  // dnd5e 5.x tracks uses as { spent, max } — value is computed, not stored.
  const max = Number(item.system?.uses?.max ?? 0);
  const spent = Number(item.system?.uses?.spent ?? 0);
  const available = Math.max(0, max - spent);
  debug(`getDiceUses(${itemName}): max=${max} spent=${spent} available=${available}`);
  return available;
}

async function updateDiceUses(actor, itemName, delta) {
  const item = getDiceItem(actor, itemName);
  if (!item) {
    console.warn(`[${MODULE_ID}] updateDiceUses: "${itemName}" not found on actor "${actor?.name}"`);
    return false;
  }
  const max = Number(item.system?.uses?.max ?? 0);
  const currentSpent = Number(item.system?.uses?.spent ?? 0);
  const currentAvailable = Math.max(0, max - currentSpent);
  const newAvailable = Math.clamp(currentAvailable + delta, 0, max);
  if (newAvailable === currentAvailable) {
    debug(`updateDiceUses(${itemName}, ${delta}): no change (available=${currentAvailable})`);
    return false;
  }
  const newSpent = max - newAvailable;
  await item.update({ "system.uses.spent": newSpent });
  console.log(`[${MODULE_ID}] ${itemName}: ${currentAvailable} → ${newAvailable} (spent ${currentSpent} → ${newSpent})`);
  return true;
}

// Luck Dice wrappers — used by damage/regain code that doesn't need Impact Dice.
function getLuckItem(actor) { return getDiceItem(actor, LUCK_DICE_ITEM_NAME); }
function getLuckUses(actor) { return getDiceUses(actor, LUCK_DICE_ITEM_NAME); }
async function updateLuckUses(actor, delta) { return updateDiceUses(actor, LUCK_DICE_ITEM_NAME, delta); }

/**
 * Returns true only if the actor is a player character (dnd5e type "character")
 * AND has at least one of the Luck Dice / Impact Dice items on their sheet.
 * All three Midi hooks bail out immediately if this returns false, so NPCs and
 * characters without the items are completely transparent to this module.
 */
function actorHasLuckDice(actor) {
  if (!actor) return false;
  if (actor.type !== "character") return false;
  return !!(getDiceItem(actor, LUCK_DICE_ITEM_NAME) || getDiceItem(actor, IMPACT_DICE_ITEM_NAME));
}

/**
 * Returns true only on the one client that should handle the luck-dice prompts
 * for this workflow. Midi fires AttackRollComplete/preDamageRoll/RollComplete on
 * EVERY connected client simultaneously and awaits all listeners — if two clients
 * both show dialogs and modify the workflow, they race and damage never fires.
 *
 * Priority:
 *  1. workflow.userId (set by Midi to the user who initiated the roll) — use this
 *     when available; only respond on the matching client.
 *  2. If an active non-GM player owns the actor, they handle it.
 *  3. Otherwise the GM handles it.
 */
function isWorkflowResponder(workflow) {
  if (workflow?.userId) return workflow.userId === game.user.id;
  const actor = workflow?.actor;
  if (!actor) return game.user.isGM;
  const activeOwner = game.users.find(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"));
  if (activeOwner) return activeOwner.id === game.user.id;
  return game.user.isGM;
}

// ── Dialog helpers ────────────────────────────────────────────────────────────

/** Show a multi-button choice dialog. Falls back to legacy Dialog if DialogV2 is absent. */
async function promptChoice(title, content, buttons) {
  debug(`promptChoice: "${title}" — options: ${buttons.map((b) => b.action).join(", ")}`);
  const dialogButtons = buttons.map((b) => ({ action: b.action, label: b.label, callback: () => b.action }));

  if (foundry?.applications?.api?.DialogV2) {
    return foundry.applications.api.DialogV2.wait({ window: { title }, content, buttons: dialogButtons });
  }
  return Dialog.wait({
    title, content,
    buttons: Object.fromEntries(buttons.map((b) => [b.action, { label: b.label, callback: () => b.action }])),
    default: buttons[0]?.action,
    close: () => "decline"
  });
}

/**
 * Show a slider input dialog. Returns the selected number, or null if cancelled.
 * Falls back to legacy Dialog if DialogV2 is absent.
 */
async function promptSlider(title, content, inputId, min, max, defaultVal = min) {
  debug(`promptSlider: "${title}" min=${min} max=${max} default=${defaultVal}`);

  // No inline oninput — Foundry v13 ApplicationV2 dialogs don't have access to the
  // global document scope from inline handlers, so document.getElementById returns null.
  // The listener is attached via the render callback instead.
  // oninput uses `this.nextElementSibling` (the <output> immediately after) so it works
  // without any document.getElementById lookup — reliable in Foundry v13 ApplicationV2.
  const sliderHtml = `${content}
    <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
      <input id="${inputId}" type="range" min="${min}" max="${max}" value="${defaultVal}" style="flex:1" oninput="this.nextElementSibling.textContent=this.value">
      <output id="${inputId}_out" style="min-width:2em;text-align:right;font-weight:bold">${defaultVal}</output>
      <span>d6</span>
    </div>`;

  function wireSlider(html) {
    // html?.querySelector may fail if html is not the correct container (ApplicationV2
    // element nesting varies). document.getElementById always works from regular JS
    // context — the restriction on `document` scope only applies to inline oninput=""
    // attribute handlers, not to addEventListener callbacks or hook functions.
    const slider = html?.querySelector?.(`#${inputId}`) ?? document.getElementById(inputId);
    const output = html?.querySelector?.(`#${inputId}_out`) ?? document.getElementById(`${inputId}_out`);
    if (slider && output) {
      slider.addEventListener("input", () => { output.textContent = slider.value; });
      debug(`promptSlider: wired input listener for #${inputId}`);
    } else {
      debug(`promptSlider: could not find #${inputId} — html type=${html?.constructor?.name}`);
    }
  }

  if (foundry?.applications?.api?.DialogV2) {
    return foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: sliderHtml,
      ok: {
        label: "Confirm",
        callback: (_event, button, html) => {
          const el = html?.querySelector?.(`#${inputId}`) ?? button?.form?.elements?.[inputId];
          const val = Number(el?.value ?? defaultVal);
          debug(`promptSlider result: ${val}`);
          return val;
        }
      },
      // Must be a regular function (not arrow) so `this` is the DialogV2 instance.
      // The render callback receives (context, options) — neither is the HTML element.
      // this.element is the dialog's root HTMLElement, available at render time.
      render: function() { wireSlider(this.element); },
      rejectClose: false
    });
  }

  // Legacy Dialog fallback.
  return new Promise((resolve) => {
    new Dialog({
      title,
      content: `<form>${sliderHtml}</form>`,
      buttons: {
        ok: {
          label: "Confirm",
          callback: (html) => {
            const val = Number(html.find(`#${inputId}`).val() ?? defaultVal);
            debug(`promptSlider result (legacy): ${val}`);
            resolve(val);
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "ok",
      close: () => resolve(null),
      render: (html) => wireSlider(html[0] ?? html)
    }).render(true);
  });
}

// ── Hit state detection ───────────────────────────────────────────────────────

/**
 * Returns true (definite hit), false (definite miss), or null (uncertain).
 *
 * IMPORTANT: Midi resets workflow.hitTargets via checkHits() after AttackRollComplete
 * fires, using internal state that may ignore our modified attackTotal. An empty
 * hitTargets therefore cannot be trusted as a definite miss — only a *non-empty*
 * hitTargets is a reliable positive confirmation from Midi.
 * For misses (empty hitTargets), we always fall back to an AC comparison using
 * workflow.attackTotal, which *does* persist across the hook boundary.
 */
/**
 * Return the result of the kept d20 in an attack roll.
 * For advantage (2d20kh) or disadvantage (2d20kl), the discarded die has
 * active:false — we must find the active result, not blindly read results[0].
 */
function getKeptD20Result(attackRoll) {
  const die = attackRoll?.dice?.[0];
  if (!die) return undefined;
  // Find the kept (active) result. Falls back to results[0] if none are explicitly active.
  const kept = die.results?.find(r => r.active !== false) ?? die.results?.[0];
  return kept?.result;
}

function getDefiniteHitState(workflow) {
  if (!workflow?.attackRoll) return null;

  const d20Result = getKeptD20Result(workflow.attackRoll);
  if (d20Result === 20) return true;
  if (d20Result === 1) return false;

  // Non-empty hitTargets = Midi has confirmed a hit. Trust it.
  const hitTargets = workflow.hitTargets instanceof Set ? workflow.hitTargets : null;
  if (hitTargets !== null && hitTargets.size > 0) return true;

  // Empty/absent hitTargets is not reliable — fall through to AC comparison.
  // (Midi may have reset hitTargets after our hook modified attackTotal.)
  const targets = workflow.targets instanceof Set ? [...workflow.targets] : [];
  if (targets.length !== 1) return null; // Multi-target without Midi confirmation is ambiguous.

  const attackTotal = Number(workflow.attackTotal ?? workflow.attackRoll?.total);
  const targetAC = Number(targets[0]?.actor?.system?.attributes?.ac?.value);
  if (!Number.isFinite(attackTotal) || !Number.isFinite(targetAC)) return null;
  return attackTotal >= targetAC;
}

// ── Attack roll manipulation ──────────────────────────────────────────────────

async function setAttackRoll(workflow, roll) {
  if (typeof workflow.setAttackRoll === "function") {
    await workflow.setAttackRoll(roll);
  } else {
    workflow.attackRoll = roll;
    workflow.attackTotal = roll.total;
  }
  // Always overwrite attackRollHTML (whether or not Midi initialized it) so that
  // any subsequent displayCard() call picks up the new roll.
  try {
    workflow.attackRollHTML = await roll.render();
    debug(`setAttackRoll: rendered attackRollHTML total=${roll.total}`);
  } catch (e) {
    debug(`setAttackRoll: roll.render() failed (${e.message})`);
  }
}

/**
 * Build a proper combined Roll from baseRoll + bonusRoll by merging their RollTerms.
 * Using Roll.fromTerms means .total returns the correct value naturally, so Midi's
 * checkHits() (which reads attackRoll.total) sees the updated total without us
 * patching any internal state.
 * Falls back to mutating baseRoll._total if fromTerms is unavailable or throws.
 */
async function buildCombinedRoll(baseRoll, bonusRoll) {
  try {
    const OperatorTerm = foundry.dice.terms?.OperatorTerm;
    if (!OperatorTerm) throw new Error("foundry.dice.terms.OperatorTerm not found");
    const plusTerm = new OperatorTerm({operator: "+"});
    plusTerm._evaluated = true; // Operator terms carry no numeric value; just mark evaluated.
    const combinedTerms = [...baseRoll.terms, plusTerm, ...bonusRoll.terms];
    const combined = Roll.fromTerms(combinedTerms);
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
  const newRoll = await new Roll(workflow.attackRoll.formula, workflow.attackRoll.data ?? {}).evaluate();
  await setAttackRoll(workflow, newRoll);
  // Sync workflow.isCritical from the new d20 result — Midi only set it from the
  // original roll and won't update it after we swap in a new attackRoll.
  const d20Result = getKeptD20Result(newRoll);
  if (d20Result === 20) workflow.isCritical = true;
  else if (d20Result !== undefined) workflow.isCritical = false;
  console.log(`[${MODULE_ID}] rerollAttack: new total=${newRoll.total} d20=${d20Result} isCritical=${workflow.isCritical}`);
  return newRoll;
}

async function addLuckDiceToAttack(workflow, diceCount) {
  const bonusRoll = await new Roll(`${diceCount}d6`).evaluate();
  const prevTotal = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);

  // Merge original roll terms + luck dice terms into a single proper Roll object.
  // This means workflow.attackRoll.total naturally equals the new value, so Midi's
  // checkHits() will see a hit without any internal-state patching.
  const combined = await buildCombinedRoll(workflow.attackRoll, bonusRoll);
  await setAttackRoll(workflow, combined);

  workflow.luckAttackBonus = (workflow.luckAttackBonus ?? 0) + bonusRoll.total;
  console.log(`[${MODULE_ID}] addLuckDiceToAttack: ${diceCount}d6 = ${bonusRoll.total}, total ${prevTotal} → ${combined.total}`);
}

/**
 * Append the new attack total to a running history stored as a message flag.
 * renderChatMessage rebuilds the full chain (3 → 8 → 12 → 19, etc.) from this
 * array on every re-render, so any number of rerolls/additions are displayed.
 *
 * Midi always regenerates the card from its original cached content, so history[0]
 * (the initial miss) is always present in the HTML — the hook can reliably anchor
 * on it regardless of how many dice actions have occurred.
 */
async function updateAttackCard(workflow, currentTotal) {
  const msgId = workflow.itemCardId ?? workflow.chatId ?? workflow.messageId ?? workflow.chatMessage?.id;
  if (!msgId) { debug("updateAttackCard: no message ID on workflow"); return; }
  const message = game.messages.get(msgId);
  if (!message) { debug(`updateAttackCard: message "${msgId}" not found`); return; }

  const finalTotal = workflow.attackRoll.total;
  const existing = message.getFlag?.(MODULE_ID, "attackReroll");
  // Continue an existing history, or start a new one from currentTotal.
  const history = existing?.history ? [...existing.history] : [currentTotal];
  if (history[history.length - 1] !== finalTotal) history.push(finalTotal);

  // Compute hit/crit state immediately — workflow.attackRoll and workflow.isCritical
  // are already updated by the time this is called (rerollAttack / addLuckDiceToAttack
  // run first), so getDefiniteHitState returns the correct value right now.
  // This means renderChatMessageHTML fires with the correct colour straight away
  // instead of waiting for preDamageRoll to stamp isHit later.
  const hitState = getDefiniteHitState(workflow);
  const isHit = hitState === true;
  const isCrit = isHit && workflow.isCritical === true;

  debug(`updateAttackCard: history=[${history.join(" → ")}] isHit=${isHit} isCrit=${isCrit}`);
  try {
    await message.setFlag(MODULE_ID, "attackReroll", { history, isHit, isCrit });
  } catch (e) {
    console.warn(`[${MODULE_ID}] updateAttackCard error:`, e);
  }
}

/** Recompute workflow.hitTargets from the current workflow.attackTotal vs each target's AC. */
function recomputeHitTargets(workflow) {
  const targets = workflow.targets instanceof Set ? [...workflow.targets] : [];
  const total = Number(workflow.attackTotal ?? workflow.attackRoll?.total);
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

/**
 * Inject luck dice into the damage roll so they appear in the same damage section.
 *
 * Tries workflow formula-string properties first (Midi reads these before building
 * the DamageRoll, so Midi handles crit-multiplying for us — we pass the already-
 * computed formula which includes our manual crit handling).
 *
 * Fallback: register a one-time dnd5e.preRollDamageV2 hook. This fires synchronously
 * inside dnd5e's rollDamage() before DamageRoll is constructed from config.parts,
 * adding the luck dice to the same roll as the weapon dice. We pass the base formula
 * (e.g. "2d6") rather than a pre-doubled formula because dnd5e will double all dice
 * parts on a crit (and maximise the extra set if that setting is on).
 *
 * bonusDamageRoll is NOT used — it creates a separate damage section in the chat card.
 */
function injectLuckDamage(workflow, diceCount, isCrit) {
  const formula = buildLuckDamageFormula(diceCount, isCrit);
  const baseFormula = `${diceCount}d6`; // undoubled; dnd5e.preRollDamageV2 path lets dnd5e handle crits

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
  // Fallback: hook into dnd5e's pre-roll config so the luck dice are part of the
  // main DamageRoll rather than a separate bonusDamageRoll section.
  // dnd5e 5.x passes rollConfig as the first arg; parts live at rollConfig.rolls[0].parts,
  // not directly on rollConfig. We try both shapes for robustness.
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

// ── Damage type & crit helpers ────────────────────────────────────────────────

/** Extract the primary damage type from the workflow's item (dnd5e 5.x and legacy). */
function getPrimaryDamageType(workflow) {
  const item = workflow?.item;
  if (!item) return null;
  // dnd5e 5.x: system.damage.base.types is a Set
  const types5x = item.system?.damage?.base?.types;
  if (types5x instanceof Set && types5x.size > 0) return [...types5x][0];
  // Legacy dnd5e: system.damage.parts[0][1]
  const parts = item.system?.damage?.parts;
  if (Array.isArray(parts) && parts.length > 0 && parts[0]?.[1]) return parts[0][1];
  return null;
}

/** Returns true if the dnd5e "maximize critical hit dice" setting is enabled. */
function isCritDiceMaximized() {
  try {
    return !!game.settings.get("dnd5e", "criticalDamageMaxDice");
  } catch {
    return false;
  }
}

/**
 * Build the luck damage formula for an attack that hits.
 * On a crit: doubles the dice. If the dnd5e "maximize crit dice" setting is on,
 * the extra set is replaced with the fixed maximum rather than rolled.
 *   Normal:           diceCount d6
 *   Crit, rolled:     (diceCount * 2) d6
 *   Crit, maximized:  diceCount d6 + (diceCount * 6)
 */
function buildLuckDamageFormula(diceCount, isCrit) {
  if (!isCrit) return `${diceCount}d6`;
  if (isCritDiceMaximized()) return `${diceCount}d6 + ${diceCount * 6}`;
  return `${diceCount * 2}d6`;
}


// ── Combined-pool helpers ─────────────────────────────────────────────────────

/**
 * Spend `count` dice across both pools: Luck Dice first, Impact Dice for any remainder.
 * Returns the number of dice actually spent.
 */
async function spendDiceFromPools(actor, count) {
  const luckAvail  = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impactAvail = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const luckToSpend   = Math.min(count, luckAvail);
  const impactToSpend = Math.min(count - luckToSpend, impactAvail);
  if (luckToSpend   > 0) await updateDiceUses(actor, LUCK_DICE_ITEM_NAME,   -luckToSpend);
  if (impactToSpend > 0) await updateDiceUses(actor, IMPACT_DICE_ITEM_NAME, -impactToSpend);
  return luckToSpend + impactToSpend;
}

/** HTML snippet showing Luck Dice and Impact Dice remaining (and a combined total if both > 0). */
function buildDiceAvailableHTML(actor) {
  const luck   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impact = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const parts  = [];
  if (luck   > 0) parts.push(`${LUCK_DICE_ITEM_NAME}: <strong>${luck}</strong>`);
  if (impact > 0) parts.push(`${IMPACT_DICE_ITEM_NAME}: <strong>${impact}</strong>`);
  if (luck > 0 && impact > 0) parts.push(`Total: <strong>${luck + impact}</strong>`);
  return parts.length ? `<p>${parts.join(" &nbsp;·&nbsp; ")}</p>` : `<p>No dice available.</p>`;
}

// ── Main prompts ──────────────────────────────────────────────────────────────

async function promptLuckOnMiss(workflow) {
  const actor = workflow?.actor;
  if (!actor || (!game.user?.isGM && actor.hasPlayerOwner && !actor.isOwner)) return;

  const state = getState(workflow);
  if (state.attackPrompted) return;

  while (true) {
    const hitState = getDefiniteHitState(workflow);
    console.log(`[${MODULE_ID}] promptLuckOnMiss loop: hitState=${hitState} total=${workflow.attackTotal ?? workflow.attackRoll?.total} hits=${workflow.hitTargets?.size ?? 0}`);
    if (hitState !== false) return;

    const luckAvail   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
    const impactAvail = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
    const totalAvail  = luckAvail + impactAvail;

    if (totalAvail <= 0) { debug("promptLuckOnMiss: no dice available, exiting"); return; }

    console.log(`[${MODULE_ID}] promptLuckOnMiss: luck=${luckAvail} impact=${impactAvail} total=${totalAvail}`);
    state.attackPrompted = true;

    const maxAdd = totalAvail;
    const options = [{ action: "decline", label: "Keep Miss" }];
    options.unshift({ action: "add", label: `Add Dice (1–${maxAdd}d6)` });
    if (totalAvail >= 2) options.unshift({ action: "reroll", label: "Spend 2 Dice to Reroll" });

    const action = await promptChoice(
      "Missed Attack",
      `<p>Your attack missed. Spend dice?</p>${buildDiceAvailableHTML(actor)}`,
      options
    );
    console.log(`[${MODULE_ID}] promptLuckOnMiss: player chose "${action}"`);
    if (action === "decline" || !action) return;

    if (action === "reroll" && totalAvail >= 2) {
      const spent = await spendDiceFromPools(actor, 2);
      if (spent < 2) { debug("promptLuckOnMiss: could not spend 2 dice for reroll"); return; }
      state.luckSpentOnAttack += 2;
      const oldTotalReroll = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
      await rerollAttack(workflow);
      await updateAttackCard(workflow, oldTotalReroll);
      if (getDefiniteHitState(workflow) === true) {
        state.convertedMissToHit = true;
        // Populate hitTargets NOW so Midi's checkHits() (which runs after this hook
        // returns) sees a non-empty set and proceeds to the damage phase.
        // We only do this on a confirmed hit — calling it on a miss would set an
        // empty Set, which Midi interprets as "already processed / no hits" and
        // would skip damage even after a later successful reroll in the same loop.
        recomputeHitTargets(workflow);
        debug("promptLuckOnMiss: reroll converted miss to hit");
      }
    }

    if (action === "add") {
      // Re-read totals in case a prior reroll already consumed some dice this loop.
      const curLuck   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
      const curImpact = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
      const curMax    = curLuck + curImpact;
      if (curMax <= 0) return;

      const raw = await promptSlider(
        "Add Dice to Attack",
        buildDiceAvailableHTML(actor),
        "luckDiceCount",
        1, curMax, 1
      );

      const diceCount = Math.clamp(Number(raw ?? 0), 1, curMax);
      if (!Number.isFinite(diceCount) || diceCount < 1) { debug("promptLuckOnMiss: invalid diceCount"); return; }

      const spent = await spendDiceFromPools(actor, diceCount);
      if (spent < 1) { debug("promptLuckOnMiss: could not spend dice for add"); return; }
      state.luckSpentOnAttack += diceCount;
      const oldTotalAdd = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
      await addLuckDiceToAttack(workflow, diceCount);
      await updateAttackCard(workflow, oldTotalAdd);
      if (getDefiniteHitState(workflow) === true) {
        state.convertedMissToHit = true;
        recomputeHitTargets(workflow); // same reasoning as the reroll branch above
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

  const hitState = getDefiniteHitState(workflow);
  // convertedMissToHit is set in promptLuckOnMiss while workflow.targets was still populated.
  // It's a reliable fallback for when Midi has cleared targets/hitTargets by the time
  // preDamageRoll fires.
  const effectiveHit = hitState === true || state.convertedMissToHit === true;
  const isCrit = workflow.isCritical === true;
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

  if (!effectiveHit) {
    debug("promptLuckOnDamage: not a hit — skipping damage prompt");
    return;
  }

  const luckAvail   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impactAvail = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const totalAvail  = luckAvail + impactAvail;

  if (totalAvail <= 0) {
    debug("promptLuckOnDamage: no dice available");
    return;
  }

  const maxDice = totalAvail;

  // Inform the player of crit behaviour before they choose how many dice to spend.
  let critNote = "";
  if (isCrit) {
    critNote = maximizeCrit
      ? `<p><em>Critical hit! Extra dice are maximized — you get your chosen dice rolled plus the same count at max value.</em></p>`
      : `<p><em>Critical hit! You'll roll double the chosen number of dice.</em></p>`;
  }

  const raw = await promptSlider(
    isCrit ? "Add Dice to Damage (Critical Hit!)" : "Add Dice to Damage",
    `<p>Attack ${isCrit ? "critically " : ""}hit! Add dice to damage?</p>${critNote}${buildDiceAvailableHTML(actor)}`,
    "luckDamageCount",
    0, maxDice, 0
  );

  // Mark prompted regardless of choice — prevents double-prompt if the hook fires twice.
  state.damagePrompted = true;

  const diceCount = Math.clamp(Number(raw ?? 0), 0, maxDice);
  if (!Number.isFinite(diceCount) || diceCount <= 0) {
    debug("promptLuckOnDamage: player chose 0 dice");
    return;
  }

  const spent = await spendDiceFromPools(actor, diceCount);
  if (spent < 1) { debug("promptLuckOnDamage: could not spend dice"); return; }

  console.log(`[${MODULE_ID}] promptLuckOnDamage: injecting ${diceCount}d6 isCrit=${isCrit} maximizeCrit=${maximizeCrit}`);
  injectLuckDamage(workflow, diceCount, isCrit);
}

/**
 * Send a whispered chat message to the GM(s) and the actor's owning player(s)
 * whenever a Luck Die is regained.
 */
async function whisperLuckRegain(actor, reason) {
  const gmIds    = game.users.filter(u => u.isGM).map(u => u.id);
  const ownerIds = game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.id);
  const recipients = [...new Set([...gmIds, ...ownerIds])];
  await ChatMessage.create({
    content: `<p><strong>${actor.name}</strong> regained 1 Luck Die (${reason}).</p>`,
    whisper: recipients,
    speaker: { alias: "Luck Dice Automation" }
  });
}

async function maybeRegainLuckDie(actor, state) {
  if (!actor || !state || state.luckSpentOnAttack > 0) return;
  console.log(`[${MODULE_ID}] maybeRegainLuckDie: restoring 1 Luck Die for "${actor.name}"`);
  await updateLuckUses(actor, 1);
  await whisperLuckRegain(actor, "failed save or check");
}

/**
 * Special prompt for a natural 1 attack roll.
 * Only two options are offered:
 *   1. Spend 2 dice to reroll (if ≥ 2 total dice available).
 *   2. Keep the miss and regain 1 Luck Die.
 * If fewer than 2 dice are available the player can't reroll, so they auto-regain silently.
 * If the reroll is still a miss, falls through to the normal promptLuckOnMiss loop.
 */
async function promptNatOne(workflow) {
  const actor = workflow?.actor;
  if (!actor || (!game.user?.isGM && actor.hasPlayerOwner && !actor.isOwner)) return;

  const state = getState(workflow);

  const luckAvail   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impactAvail = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const totalAvail  = luckAvail + impactAvail;

  // Not enough dice to offer a reroll — auto-regain silently.
  if (totalAvail < 2) {
    debug("promptNatOne: fewer than 2 dice available — auto-regaining 1 Luck Die");
    await updateLuckUses(actor, 1);
    await whisperLuckRegain(actor, "natural 1 with no dice to reroll");
    return;
  }

  const action = await promptChoice(
    "Natural 1!",
    `<p>You rolled a natural 1. What would you like to do?</p>${buildDiceAvailableHTML(actor)}`,
    [
      { action: "reroll", label: "Spend 2 Dice to Reroll" },
      { action: "keep",   label: "Keep Miss (Regain 1 Luck Die)" }
    ]
  );

  console.log(`[${MODULE_ID}] promptNatOne: player chose "${action}"`);

  if (action === "reroll") {
    const spent = await spendDiceFromPools(actor, 2);
    if (spent < 2) { debug("promptNatOne: could not spend 2 dice"); return; }
    state.luckSpentOnAttack += 2;
    const oldTotal = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
    await rerollAttack(workflow);
    await updateAttackCard(workflow, oldTotal);
    if (getDefiniteHitState(workflow) === true) {
      state.convertedMissToHit = true;
      recomputeHitTargets(workflow); // same as promptLuckOnMiss — needed for damage phase
      debug("promptNatOne: reroll converted nat-1 miss to hit");
    } else {
      // Still a miss after the reroll — offer the normal miss options.
      // (attackPrompted is NOT set by promptNatOne so promptLuckOnMiss runs normally.)
      await promptLuckOnMiss(workflow);
    }
    return;
  }

  // "keep" or dialog closed — regain 1 Luck Die.
  await updateLuckUses(actor, 1);
  await whisperLuckRegain(actor, "kept natural 1 miss");
}

// ── Chat card history rendering ───────────────────────────────────────────────

/**
 * Mutate `container` (a live HTMLElement or a detached div) to display the
 * PF2e-style reroll history stored in `reroll`.
 *
 * Intermediate (non-final) entries copy the original element's class so they
 * inherit the dnd5e failure colour (red). The final entry gets the success/
 * critical class + inline colour + checkmark icon(s) if the attack hit, or
 * the failure class with no strike-through if it was a final miss.
 *
 * Returns true if the anchor element was found and the history was applied.
 */
function applyHistoryToDOM(container, reroll) {
  const { history, isHit } = reroll;
  if (!history?.length || history.length < 2) return false;
  if (!(container instanceof Element)) return false;

  for (const el of container.querySelectorAll("h4.dice-total, .dice-total")) {
    if (Number(el.textContent.trim()) !== history[0]) continue;

    // Strike history[0] in place (the original Midi-rendered miss).
    el.style.cssText += ";text-decoration:line-through;opacity:0.4;font-size:0.8em;margin-bottom:2px";

    let anchor = el;
    for (let i = 1; i < history.length; i++) {
      const isLast = i === history.length - 1;
      const newEl = document.createElement(el.tagName.toLowerCase());

      if (!isLast) {
        // Intermediate miss — copy original class so dnd5e failure colour applies.
        newEl.className = el.className;
        newEl.textContent = String(history[i]);
        newEl.style.cssText = "text-decoration:line-through;opacity:0.4;font-size:0.8em;margin-bottom:2px";
      } else if (isHit) {
        // Final hit — always use success (green) styling regardless of crit.
        // A rerolled nat-20 is still a success in the luck-dice context; gold/double-
        // check crit display would be confusing since the original roll was a miss.
        newEl.className = "dice-total success";
        newEl.style.color = "#719f50";
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
        // Final miss — copy original class (failure colour), no strike-through.
        newEl.className = el.className;
        newEl.textContent = String(history[i]);
      }

      anchor.parentNode.insertBefore(newEl, anchor.nextSibling);
      anchor = newEl;
    }

    debug(`applyHistoryToDOM (numeric): history=[${history.join("→")}] isHit=${isHit ?? false}`);
    return true;
  }

  // ── Text-label mode ───────────────────────────────────────────────────────────
  // Midi is configured to show "hits"/"misses"/"fumble" labels instead of totals.
  // Numeric history display doesn't apply here; we just need to update the label
  // when a reroll converted the original miss into a hit.
  if (isHit === true) {
    for (const el of container.querySelectorAll("h4.dice-total, .dice-total")) {
      const text = el.textContent.trim().toLowerCase();
      // Skip numeric and empty elements — only match text labels.
      if (text === "" || !isNaN(Number(text))) continue;
      // Match any miss/fumble label.
      if (!/miss|fumble|fail/.test(text)) continue;
      el.className = "dice-total success";
      el.style.color = "#719f50";
      el.style.borderColor = "#719f50";
      el.textContent = "hits";
      debug(`applyHistoryToDOM (text-label): "${text}" → "hits"`);
      return true;
    }
  }

  return false;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  if (!game.modules.get("midi-qol")?.active) {
    ui.notifications?.warn("Luck Dice Automation requires Midi-QoL.");
    return;
  }

  // Inject the reroll history into the live DOM on every re-render.
  // Skipped once the history has been permanently baked into message.content
  // (which happens at RollComplete — see below).
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const reroll = message.getFlag?.(MODULE_ID, "attackReroll");
    if (!reroll?.history?.length || reroll.history.length < 2) return;
    if (reroll.baked) return; // already in message.content; no DOM injection needed
    if (!(html instanceof HTMLElement)) return;
    applyHistoryToDOM(html, reroll);
  });

  Hooks.on("midi-qol.AttackRollComplete", async (workflow) => {
    try {
      if (!actorHasLuckDice(workflow?.actor)) return;
      if (!isWorkflowResponder(workflow)) return;
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
      if (!actorHasLuckDice(workflow?.actor)) return;
      if (!isWorkflowResponder(workflow)) return;
      await promptLuckOnDamage(workflow);

      // preDamageRoll fires after Midi's checkHits() — the first reliable moment we
      // know the attack is a confirmed hit. If we stored a reroll history flag earlier,
      // update it with isHit/isCrit so renderChatMessageHTML can apply the correct
      // hit/crit CSS class to the final total in the history chain.
      const msgId = workflow.itemCardId ?? workflow.chatId ?? workflow.messageId ?? workflow.chatMessage?.id;
      if (msgId) {
        const message = game.messages.get(msgId);
        const existing = message?.getFlag?.(MODULE_ID, "attackReroll");
        const state = getState(workflow);
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

  Hooks.on("midi-qol.RollComplete", async (workflow) => {
    try {
      if (!actorHasLuckDice(workflow?.actor)) return;
      if (!isWorkflowResponder(workflow)) return;
      const state = getState(workflow);

      // Permanently bake the reroll history into message.content so it survives
      // page reloads without relying on the renderChatMessageHTML DOM injection.
      // By RollComplete, preDamageRoll has already stamped isHit/isCrit onto the
      // flag, so applyHistoryToDOM produces the correct final styling.
      const msgId = workflow.itemCardId ?? workflow.chatId ?? workflow.messageId ?? workflow.chatMessage?.id;
      if (msgId) {
        const message = game.messages.get(msgId);
        const reroll = message?.getFlag?.(MODULE_ID, "attackReroll");
        if (reroll?.history?.length >= 2 && !reroll.baked) {
          const tempDiv = document.createElement("div");
          tempDiv.innerHTML = message.content ?? "";
          if (applyHistoryToDOM(tempDiv, reroll)) {
            // Single update: bake content + mark flag as baked atomically.
            await message.update({
              content: tempDiv.innerHTML,
              [`flags.${MODULE_ID}.attackReroll`]: { ...reroll, baked: true }
            });
            debug("RollComplete: baked attack history into message.content");
          }
        }
      }

      const kind = workflow?.workflowType ?? workflow?.item?.system?.actionType ?? workflow?.type;
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

  console.log(`[${MODULE_ID}] Initialized — DEBUG=${DEBUG}`);
});
