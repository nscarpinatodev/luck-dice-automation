// ── Luck Dice Automation — Core ───────────────────────────────────────────────
// Shared constants, dice helpers, dialog utilities, and settings registration.
// Loaded first; attack.js and skill-check.js depend on everything defined here.

window.LDA = (() => {

const MODULE_ID = "luck-dice-automation";
const LUCK_DICE_ITEM_NAME  = "Luck Dice";
const IMPACT_DICE_ITEM_NAME = "Impact Dice";

// Per-workflow transient state. Keyed by workflow UUID/ID so concurrent workflows
// don't interfere. Cleared at RollComplete.
const workflowState = new Map();

// Pending Midi save result Promises: actorId → {resolve, timeoutId}
// The preCheckSaves hook (GM client) puts entries here; the midiSaveResult socket
// message (from the player's client) resolves them.
const pendingMidiSaveResults = new Map();

// Math.clamp is a Foundry global extension, not native JS. Define a local fallback
// so the module works regardless of browser/Foundry execution order.
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Read the debug flag from settings at call time so it can be toggled live.
function debug(...args) {
  let on = false;
  try { on = game.settings.get(MODULE_ID, "debug"); } catch { /* settings not ready yet */ }
  if (on) console.log(`[${MODULE_ID}]`, ...args);
}

// Top-level load marker — always printed, even before the ready hook fires.
// If this line is missing from the console the script file itself isn't being executed.
console.log(`[${MODULE_ID}] core.js parsed — user=${game?.user?.name ?? "unknown"} isGM=${game?.user?.isGM ?? "?"} build=${Date.now()}`);

// ── Workflow state helpers ────────────────────────────────────────────────────

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
// Generalized so both Luck Dice and Impact Dice share the same read/write logic.

function getDiceItem(actor, itemName) {
  return actor?.items?.find((i) => i.name === itemName);
}

function getDiceUses(actor, itemName) {
  const item = getDiceItem(actor, itemName);
  if (!item) return 0;
  // dnd5e 5.x tracks uses as { spent, max } — value is computed, not stored.
  const max   = Number(item.system?.uses?.max   ?? 0);
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
  const max              = Number(item.system?.uses?.max   ?? 0);
  const currentSpent     = Number(item.system?.uses?.spent ?? 0);
  const currentAvailable = Math.max(0, max - currentSpent);
  const newAvailable     = clamp(currentAvailable + delta, 0, max);
  if (newAvailable === currentAvailable) {
    debug(`updateDiceUses(${itemName}, ${delta}): no change (available=${currentAvailable})`);
    return false;
  }
  const newSpent = max - newAvailable;
  await item.update({ "system.uses.spent": newSpent });
  console.log(`[${MODULE_ID}] ${itemName}: ${currentAvailable} → ${newAvailable} (spent ${currentSpent} → ${newSpent})`);
  return true;
}

// Luck Dice convenience wrappers used by code that doesn't need Impact Dice.
function getLuckItem(actor)               { return getDiceItem(actor, LUCK_DICE_ITEM_NAME); }
function getLuckUses(actor)               { return getDiceUses(actor, LUCK_DICE_ITEM_NAME); }
async function updateLuckUses(actor, delta) { return updateDiceUses(actor, LUCK_DICE_ITEM_NAME, delta); }

/**
 * Returns true only if the actor is a player character (dnd5e type "character")
 * AND has at least one of the Luck Dice / Impact Dice items on their sheet.
 */
function actorHasLuckDice(actor) {
  if (!actor) return false;
  if (actor.type !== "character") return false;
  return !!(getDiceItem(actor, LUCK_DICE_ITEM_NAME) || getDiceItem(actor, IMPACT_DICE_ITEM_NAME));
}

/**
 * Returns true only on the one client that should handle luck-dice prompts.
 * Midi fires hooks on EVERY connected client simultaneously; if two clients
 * both show dialogs and modify the workflow they race and damage never fires.
 *
 * Priority:
 *  1. workflow.userId === game.user.id  → this IS the initiating client.
 *  2. workflow.userId is a different active user → defer to them.
 *  3. workflow.userId user is offline (or no userId) → fallback:
 *       a. Active non-GM owner of the actor → they handle it.
 *       b. Otherwise GM handles it.
 *
 * Mirror setting: when enabled the GM also receives every prompt in addition to
 * the initiating user. Both clients see the dialog simultaneously.
 */
function isWorkflowResponder(workflow) {
  let mirrorToGM = false;
  try { mirrorToGM = game.settings.get(MODULE_ID, "mirrorToGM"); } catch { /* pre-init */ }

  const wfUserId   = workflow?.userId;
  const isInitiator = !!(wfUserId && wfUserId === game.user.id);

  // Mirror mode: initiating user AND GM both receive the prompt.
  if (mirrorToGM) return isInitiator || game.user.isGM;

  // Normal mode: only the initiating user handles the workflow.
  if (isInitiator) return true;

  // Another active user initiated it — defer to them.
  if (wfUserId) {
    const wfUser = game.users.get(wfUserId);
    if (wfUser?.active) return false;
    // Initiating user is offline → fall through to fallback.
  }

  // Fallback for missing/offline workflow.userId: active non-GM owner, then GM.
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

  const sliderHtml = `${content}
    <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
      <input id="${inputId}" type="range" min="${min}" max="${max}" value="${defaultVal}" style="flex:1">
      <output id="${inputId}_out" style="min-width:2em;text-align:right;font-weight:bold">${defaultVal}</output>
      <span>d6</span>
    </div>`;

  function wireSlider(html) {
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
          const el  = html?.querySelector?.(`#${inputId}`) ?? button?.form?.elements?.[inputId];
          const val = Number(el?.value ?? defaultVal);
          debug(`promptSlider result: ${val}`);
          return val;
        }
      },
      render: function() { wireSlider(this.element); },
      rejectClose: false
    });
  }

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

// ── Roll inspection helpers ───────────────────────────────────────────────────

/**
 * Build a minimal Roll-compatible object from serialised data.
 * Used when a real Roll is unavailable (e.g. socket messages for Midi saves).
 * formula should be a fully-evaluated string like "1d20 + 4", NOT a template.
 */
function buildFakeRoll(total, formula = "1d20", d20Result = null) {
  return {
    total,
    _total: total,
    formula,
    data: {},
    dice: d20Result !== null
      ? [{ results: [{ result: d20Result, active: true }] }]
      : []
  };
}

/**
 * Return the result of the kept d20 in a roll.
 * For advantage (2d20kh) or disadvantage (2d20kl), the discarded die has
 * active:false — we must find the active result, not blindly read results[0].
 */
function getKeptD20Result(roll) {
  const die = roll?.dice?.[0];
  if (!die) return undefined;
  const kept = die.results?.find(r => r.active !== false) ?? die.results?.[0];
  return kept?.result;
}

// ── Combined-pool helpers ─────────────────────────────────────────────────────

/**
 * Spend `count` dice across both pools: Luck Dice first, Impact Dice for any remainder.
 * Returns the number of dice actually spent.
 */
async function spendDiceFromPools(actor, count) {
  const luckAvail   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impactAvail = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const luckToSpend   = Math.min(count, luckAvail);
  const impactToSpend = Math.min(count - luckToSpend, impactAvail);
  if (luckToSpend   > 0) await updateDiceUses(actor, LUCK_DICE_ITEM_NAME,   -luckToSpend);
  if (impactToSpend > 0) await updateDiceUses(actor, IMPACT_DICE_ITEM_NAME, -impactToSpend);
  return luckToSpend + impactToSpend;
}

/**
 * Evaluate a fresh roll using the same formula and data as originalRoll, then
 * show a Dice So Nice animation visible to all players.
 * Dice spending is the caller's responsibility — call this AFTER spending.
 */
async function evaluateReroll(originalRoll) {
  // Advantage (kh) is preserved; disadvantage (kl) rerolls as a plain d20.
  // e.g. "2d20kl1 + 5" or "2d20kl + 5" → "1d20 + 5", "2d20kh1 + 5" stays unchanged.
  const formula = (originalRoll.formula ?? "").replace(/\b\d+d20kl\d*\b/gi, "1d20");
  const newRoll = await new Roll(formula, originalRoll.data ?? {}).evaluate();
  if (game.dice3d) await game.dice3d.showForRoll(newRoll, game.user, true, null, false);
  return newRoll;
}

/** HTML snippet showing available dice counts. */
function buildDiceAvailableHTML(actor) {
  const luck   = getDiceUses(actor, LUCK_DICE_ITEM_NAME);
  const impact = getDiceUses(actor, IMPACT_DICE_ITEM_NAME);
  const parts  = [];
  if (luck   > 0) parts.push(`${LUCK_DICE_ITEM_NAME}: <strong>${luck}</strong>`);
  if (impact > 0) parts.push(`${IMPACT_DICE_ITEM_NAME}: <strong>${impact}</strong>`);
  if (luck > 0 && impact > 0) parts.push(`Total: <strong>${luck + impact}</strong>`);
  return parts.length ? `<p>${parts.join(" &nbsp;·&nbsp; ")}</p>` : `<p>No dice available.</p>`;
}

// ── Whisper helpers ───────────────────────────────────────────────────────────

/** Whisper a Luck Die regain message to the GM(s) and the actor's owner(s). */
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

// ── Setting helpers ───────────────────────────────────────────────────────────

function isLuckDiceEnabled() {
  try { return game.settings.get(MODULE_ID, "enableLuckDice"); } catch { return true; }
}

function isInspirationEnabled() {
  try { return game.settings.get(MODULE_ID, "enableInspiration"); } catch { return false; }
}

// ── Inspiration helpers ───────────────────────────────────────────────────────

/** Returns true if the actor is a player character who currently has Inspiration. */
function actorHasInspiration(actor) {
  if (!actor || actor.type !== "character") return false;
  return !!actor.system?.attributes?.inspiration;
}

/** Remove the actor's Inspiration point. */
async function consumeInspiration(actor) {
  await actor.update({ "system.attributes.inspiration": false });
  console.log(`[${MODULE_ID}] ${actor.name}: inspiration consumed`);
}

/**
 * Reroll using Inspiration. Honours the "inspirationAdvantage" setting:
 *   on  → always uses advantage (2d20kh1), overriding any existing adv/disadv.
 *   off → plain reroll (strips disadvantage, same as evaluateReroll).
 */
async function evaluateInspirationReroll(originalRoll) {
  let useAdvantage = false;
  try { useAdvantage = game.settings.get(MODULE_ID, "inspirationAdvantage"); } catch {}

  const formula = useAdvantage
    ? (originalRoll.formula ?? "").replace(/\b\d+d20(?:k[hl]\d+)?\b/gi, "2d20kh1")
    : (originalRoll.formula ?? "").replace(/\b\d+d20kl\d*\b/gi, "1d20");

  const newRoll = await new Roll(formula, originalRoll.data ?? {}).evaluate();
  if (game.dice3d) await game.dice3d.showForRoll(newRoll, game.user, true, null, false);
  return newRoll;
}

// ── Module settings ───────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enableLuckDice", {
    name: "Enable Luck Dice Automation",
    hint: "When enabled, players are prompted to spend Luck Dice on failed attacks, saves, and checks.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "enableInspiration", {
    name: "Enable Inspiration Automation",
    hint: "When enabled, players with Inspiration are prompted to use it on failed attacks, saves, and skill checks.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "inspirationAdvantage", {
    name: "Inspiration Rerolls with Advantage",
    hint: "When enabled, using Inspiration to reroll grants advantage (roll 2d20, keep the higher result).",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "mirrorToGM", {
    name: "Mirror roll requests to GM?",
    hint: "Off (default): Luck Dice prompts are sent only to the person who initiated " +
          "the roll — the player if the player rolled, the GM if the GM rolled — " +
          "even if the player controlling that character is currently online. " +
          "On: every Luck Dice prompt is shown to both the initiating user and the GM " +
          "simultaneously, regardless of who rolled.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "hideCheckCardsFromGM", {
    name: "Hide skill check roll cards from GM",
    hint: "When enabled, individual player roll cards are whispered to the rolling player only. " +
          "The GM sees only the summary card.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "debug", {
    name: "Debug Logging",
    hint: "Print detailed Luck Dice Automation messages to the browser console. " +
          "Leave off in normal play.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  console.log(`[${MODULE_ID}] Settings registered.`);
});

return {
  MODULE_ID, LUCK_DICE_ITEM_NAME, IMPACT_DICE_ITEM_NAME,
  workflowState, pendingMidiSaveResults, clamp, debug,
  getWorkflowKey, getState,
  getDiceItem, getDiceUses, updateDiceUses,
  getLuckItem, getLuckUses, updateLuckUses,
  actorHasLuckDice, isWorkflowResponder,
  promptChoice, promptSlider,
  buildFakeRoll, getKeptD20Result,
  spendDiceFromPools, evaluateReroll, buildDiceAvailableHTML,
  whisperLuckRegain, maybeRegainLuckDie,
  isLuckDiceEnabled, isInspirationEnabled,
  actorHasInspiration, consumeInspiration, evaluateInspirationReroll,
};
})();
