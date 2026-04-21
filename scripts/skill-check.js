// ── Luck Dice Automation — Skill Check Flow ───────────────────────────────────
// GM launcher UI, socket-based roll dispatch, and luck dice prompts for
// failed skill / ability checks.
// Depends on: core.js (must be loaded first).

// ── Label helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a check value string ("skill:acr" or "ability:str") and return a
 * human-readable label like "Acrobatics (DEX)" or "Strength Check".
 */
function getCheckLabel(checkValue) {
  const [type, key] = (checkValue ?? "").split(":");
  if (type === "skill") {
    const cfg = CONFIG.DND5E?.skills?.[key];
    if (cfg) {
      const abilityKey = cfg.ability;
      const abbrKey    = CONFIG.DND5E?.abilities?.[abilityKey]?.abbreviation ?? abilityKey;
      const abbr       = game.i18n.localize(abbrKey).toUpperCase().slice(0, 3);
      return `${game.i18n.localize(cfg.label)} (${abbr})`;
    }
  }
  if (type === "ability") {
    const cfg = CONFIG.DND5E?.abilities?.[key];
    if (cfg) return `${game.i18n.localize(cfg.label)} Check`;
  }
  if (type === "save") {
    const cfg = CONFIG.DND5E?.abilities?.[key];
    if (cfg) return `${game.i18n.localize(cfg.label)} Save`;
  }
  return checkValue ?? "";
}

/** Build <optgroup> blocks for the check selector in the launcher dialog. */
function buildCheckOptions() {
  const skills    = CONFIG.DND5E?.skills    ?? {};
  const abilities = CONFIG.DND5E?.abilities ?? {};

  const skillOpts = Object.entries(skills)
    .sort(([, a], [, b]) => game.i18n.localize(a.label).localeCompare(game.i18n.localize(b.label)))
    .map(([id, cfg]) => {
      const abilityKey = cfg.ability;
      const abbrKey    = abilities[abilityKey]?.abbreviation ?? abilityKey;
      const abbr       = game.i18n.localize(abbrKey).toUpperCase().slice(0, 3);
      return `<option value="skill:${id}">${game.i18n.localize(cfg.label)} (${abbr})</option>`;
    }).join("");

  const abilityOpts = Object.entries(abilities)
    .sort(([, a], [, b]) => game.i18n.localize(a.label).localeCompare(game.i18n.localize(b.label)))
    .map(([id, cfg]) => `<option value="ability:${id}">${game.i18n.localize(cfg.label)} Check</option>`)
    .join("");

  const saveOpts = Object.entries(abilities)
    .sort(([, a], [, b]) => game.i18n.localize(a.label).localeCompare(game.i18n.localize(b.label)))
    .map(([id, cfg]) => `<option value="save:${id}">${game.i18n.localize(cfg.label)} Save</option>`)
    .join("");

  return `<optgroup label="Skill Checks">${skillOpts}</optgroup>
          <optgroup label="Ability Checks">${abilityOpts}</optgroup>
          <optgroup label="Saving Throws">${saveOpts}</optgroup>`;
}

/** Build checkbox rows for every player character currently in the world. */
function buildCharacterCheckboxes() {
  return game.actors
    .filter(a => a.type === "character")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(a =>
      `<label style="display:flex;align-items:center;gap:7px;padding:4px 6px;cursor:pointer;border-radius:3px">` +
      `<input type="checkbox" name="sck-actor" value="${a.id}" style="margin:0;flex-shrink:0">` +
      `<span>${a.name}</span></label>`
    )
    .join("");
}

// ── GM Launcher Dialog ────────────────────────────────────────────────────────

async function showSkillCheckLauncher() {
  const characterCheckboxes = buildCharacterCheckboxes();
  if (!characterCheckboxes) {
    ui.notifications.warn("No player characters found in this world.");
    return;
  }

  const content = `
    <div style="display:flex;flex-direction:column;gap:12px;padding:4px 0">
      <div class="form-group">
        <label style="font-weight:bold;margin-bottom:4px;display:block">Characters</label>
        <div id="sck-actors" style="border:1px solid #555;border-radius:3px;padding:2px;max-height:220px;overflow-y:auto">
          ${characterCheckboxes}
        </div>
      </div>
      <div class="form-group">
        <label style="font-weight:bold;margin-bottom:4px;display:block">Check</label>
        <select id="sck-check" style="width:100%">${buildCheckOptions()}</select>
      </div>
      <div class="form-group">
        <label style="font-weight:bold;margin-bottom:4px;display:block">DC</label>
        <input id="sck-dc" type="number" value="15" min="1" max="60" style="width:100%">
      </div>
      <div class="form-group">
        <label style="font-weight:bold;margin-bottom:4px;display:block">Roll Modifier</label>
        <div style="display:flex;gap:20px;align-items:center">
          <label style="margin:0;cursor:pointer"><input type="radio" name="sck-adv" value="normal" checked style="margin-right:4px">Normal</label>
          <label style="margin:0;cursor:pointer"><input type="radio" name="sck-adv" value="advantage" style="margin-right:4px">Advantage</label>
          <label style="margin:0;cursor:pointer"><input type="radio" name="sck-adv" value="disadvantage" style="margin-right:4px">Disadvantage</label>
        </div>
      </div>
      <div class="form-group" style="display:flex;align-items:center;gap:8px">
        <input id="sck-show-dc" type="checkbox" style="margin:0">
        <label for="sck-show-dc" style="margin:0;cursor:pointer">Show DC to players</label>
      </div>
    </div>`;

  function readFormValues(root) {
    // DialogV2 in Foundry v13 passes the Application instance, not a DOM element.
    // Normalise: if root has a .element property, use that; legacy jQuery objects have .find().
    const el = (root instanceof Element) ? root
             : (root?.element instanceof Element) ? root.element
             : root;
    const q = (id) => el.querySelector?.(id) ?? el.find?.(id)?.[0];
    const checkEl  = q("#sck-check");
    const dcEl     = q("#sck-dc");
    const showDcEl = q("#sck-show-dc");
    const actorIds    = [...(el.querySelectorAll?.('input[name="sck-actor"]:checked') ?? el.find?.('input[name="sck-actor"]:checked') ?? [])].map(cb => cb.value);
    const check       = checkEl?.value ?? "";
    const dc          = Number(dcEl?.value ?? 15);
    const showDC      = showDcEl?.checked ?? false;
    const advRadio    = el.querySelector?.('input[name="sck-adv"]:checked') ?? el.find?.('input[name="sck-adv"]:checked')?.[0];
    const advantageMode = advRadio?.value ?? "normal";
    return { actorIds, check, dc, showDC, advantageMode };
  }

  if (foundry?.applications?.api?.DialogV2) {
    await foundry.applications.api.DialogV2.prompt({
      window: { title: "Request Check or Save", width: 420 },
      content,
      ok: {
        label: "Send Request",
        callback: (_event, _button, html) => {
          const { actorIds, check, dc, showDC, advantageMode } = readFormValues(html);
          if (!actorIds.length) { ui.notifications.warn("Select at least one character."); return; }
          dispatchCheckRequests(actorIds, check, dc, showDC, advantageMode);
        }
      },
      rejectClose: false
    });
    return;
  }

  // Legacy Dialog fallback.
  new Dialog({
    title: "Request Check or Save",
    content: `<form>${content}</form>`,
    buttons: {
      send: {
        label: "Send Request",
        callback: (html) => {
          const { actorIds, check, dc, showDC, advantageMode } = readFormValues(html);
          if (!actorIds.length) { ui.notifications.warn("Select at least one character."); return; }
          dispatchCheckRequests(actorIds, check, dc, showDC, advantageMode);
        }
      },
      cancel: { label: "Cancel" }
    },
    default: "send"
  }).render(true);
}

// ── GM summary card ───────────────────────────────────────────────────────────

/** Build the whispered GM summary card HTML from the current actor status map. */
function buildGMCheckCard(label, dc, statuses) {
  const rows = Object.values(statuses).map(({ name, status, total }) => {
    let indicator;
    if (status === "passed")
      indicator = `<span style="color:#719f50">&#10003; Passed &mdash; ${total}</span>`;
    else if (status === "failed")
      indicator = `<span style="color:#c0392b">&#10007; Failed &mdash; ${total}</span>`;
    else
      indicator = `<span style="opacity:0.5">&#x23F3; Pending</span>`;
    return `<li style="display:flex;justify-content:space-between;align-items:center;
                        padding:2px 0;margin:0;list-style:none">
              <span>${name}</span>${indicator}
            </li>`;
  }).join("");
  return `
    <div>
      <p style="margin:0 0 2px;font-size:0.85em;opacity:0.7">Skill Check Request</p>
      <p style="margin:0 0 6px"><strong>${label}</strong> &mdash; DC ${dc}</p>
      <ul style="margin:0;padding:0">${rows}</ul>
    </div>`;
}

/**
 * Update one actor's row in the GM summary card and rebuild the card HTML.
 * Called by the GM directly (for offline players / mirrorToGM) or via socket
 * when a player finishes their roll sequence.
 */
async function updateGMCheckCard(gmCardId, actorId, finalTotal, passed) {
  if (!gmCardId) return;
  const message = game.messages.get(gmCardId);
  if (!message) return;
  const data = message.getFlag?.(MODULE_ID, "checkCard");
  if (!data) return;

  data.statuses[actorId] = {
    ...data.statuses[actorId],
    status: passed ? "passed" : "failed",
    total:  finalTotal
  };

  await message.update({
    content: buildGMCheckCard(data.label, data.dc, data.statuses),
    [`flags.${MODULE_ID}.checkCard`]: data
  });
}

/**
 * Called once a player's full roll sequence is resolved.
 * On a player client: emits a socket so the GM can update their summary card,
 *   and applies the hide-from-GM setting to the roll card.
 * On the GM client: updates the card directly.
 */
async function reportCheckResult(actor, finalTotal, passed, gmCardId, rollMsgId) {
  // Apply hide-from-GM: whisper the player's combined roll card to the player only.
  let hideCards = false;
  try { hideCards = game.settings.get(MODULE_ID, "hideCheckCardsFromGM"); } catch {}
  if (hideCards && rollMsgId) {
    const rollMsg  = game.messages.get(rollMsgId);
    const ownerIds = game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.id);
    if (rollMsg && ownerIds.length > 0) {
      await rollMsg.update({ whisper: ownerIds }).catch(() => {});
    }
  }

  if (game.user.isGM) {
    await updateGMCheckCard(gmCardId, actor.id, finalTotal, passed);
  } else {
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "checkResult", gmCardId, actorId: actor.id, finalTotal, passed, rollMsgId
    });
  }
}

// ── Request dispatch ──────────────────────────────────────────────────────────

/**
 * For each selected actor:
 *  - Creates a GM-whispered summary card tracking every actor's status.
 *  - If an active player owns the actor: send a socket message to their client.
 *  - If mirrorToGM is on: also handle it on the GM's client simultaneously.
 *  - If no active player (offline / NPC-only): GM handles the roll directly.
 */
async function dispatchCheckRequests(actorIds, checkValue, dc, showDC = false, advantageMode = "normal") {
  const label = getCheckLabel(checkValue);
  console.log(`[${MODULE_ID}] dispatchCheckRequests: check=${label} DC=${dc} showDC=${showDC} adv=${advantageMode} actors=[${actorIds.join(",")}]`);

  // Build initial status map (all pending) and create the GM summary card.
  const statuses = {};
  for (const id of actorIds) {
    const a = game.actors.get(id);
    if (a) statuses[id] = { name: a.name, status: "pending", total: null };
  }
  const gmCardMsg = await ChatMessage.create({
    content: buildGMCheckCard(label, dc, statuses),
    whisper: game.users.filter(u => u.isGM).map(u => u.id),
    speaker: { alias: "Luck Dice Automation" },
    flags:   { [MODULE_ID]: { checkCard: { label, dc, statuses } } }
  });
  const gmCardId = gmCardMsg?.id ?? null;

  let mirrorToGM = false;
  try { mirrorToGM = game.settings.get(MODULE_ID, "mirrorToGM"); } catch {}

  for (const actorId of actorIds) {
    const actor = game.actors.get(actorId);
    if (!actor) continue;

    const activeOwner = game.users.find(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"));

    if (activeOwner) {
      // Ask the player's client to prompt-then-roll.
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "checkRequest", actorId, checkValue, dc, showDC, gmCardId, advantageMode
      });
      // Also handle on GM's client when mirroring is enabled.
      if (mirrorToGM) rollSkillForCheck(actor, checkValue, dc, showDC, gmCardId, advantageMode);
    } else {
      // No active player — GM handles the roll.
      rollSkillForCheck(actor, checkValue, dc, showDC, gmCardId, advantageMode);
    }
  }
}

// ── Roll execution ────────────────────────────────────────────────────────────

/**
 * Open the dnd5e roll dialog for the given actor and check type, then process
 * the result: if it fails the DC, trigger the luck dice prompt.
 */
async function rollSkillForCheck(actor, checkValue, dc, showDC = false, gmCardId = null, advantageMode = "normal") {
  if (!actor) return;
  const [type, key] = (checkValue ?? "").split(":");
  const label = getCheckLabel(checkValue);

  debug(`rollSkillForCheck: ${actor.name} — ${label} DC ${dc} showDC=${showDC} adv=${advantageMode}`);

  // Prompt the user to confirm they're ready before the roll dialog opens.
  const dcText  = showDC ? ` — DC <strong>${dc}</strong>` : "";
  const advText = advantageMode === "advantage"    ? " <em>(with Advantage)</em>"
                : advantageMode === "disadvantage" ? " <em>(with Disadvantage)</em>"
                : "";
  const proceed = await promptChoice(
    "Check Request",
    `<p>The GM has requested a <strong>${label}</strong>${advText} for <strong>${actor.name}</strong>${dcText}.</p>
     <p>Click <strong>Roll</strong> when you're ready.</p>`,
    [
      { action: "roll",    label: "Roll" },
      { action: "dismiss", label: "Dismiss" }
    ]
  );
  if (!proceed || proceed === "dismiss") return;

  // Snapshot existing message IDs so we can identify the card the roll creates.
  const knownMsgIds = new Set(game.messages.map(m => m.id));

  // Build roll options from the launcher's advantage/disadvantage selection.
  const rollOptions = advantageMode === "advantage"    ? { advantage: true }
                    : advantageMode === "disadvantage" ? { disadvantage: true }
                    : {};

  let roll = null;
  try {
    if (type === "skill") {
      roll = await actor.rollSkill(key, rollOptions);
    } else if (type === "ability") {
      // dnd5e 5.x uses rollAbilityTest; older builds may use rollAbilityCheck.
      const fn = typeof actor.rollAbilityTest === "function" ? "rollAbilityTest" : "rollAbilityCheck";
      roll = await actor[fn](key, rollOptions);
    } else if (type === "save") {
      // dnd5e 5.x removed rollAbilitySave; try the most likely alternatives in order.
      const saveFn = typeof actor.rollAbilitySave  === "function" ? "rollAbilitySave"
                   : typeof actor.rollSavingThrow   === "function" ? "rollSavingThrow"
                   : null;
      if (saveFn) {
        roll = await actor[saveFn](key, rollOptions);
      } else {
        const available = Object.getOwnPropertyNames(Object.getPrototypeOf(actor))
          .filter(n => /^roll/i.test(n));
        console.error(`[${MODULE_ID}] rollSkillForCheck: no saving throw method found on actor "${actor.name}". Available roll methods: [${available.join(", ")}]`);
        ui.notifications.error("Saving throw roll method not found — check the console (F12) for available methods.");
        return;
      }
    }
  } catch (e) {
    console.error(`[${MODULE_ID}] rollSkillForCheck: roll error for ${actor.name}:`, e);
    return;
  }

  if (!roll) {
    debug(`rollSkillForCheck: roll cancelled for ${actor.name}`);
    return;
  }

  // Find the chat message the roll just created.
  const rollMsg        = game.messages.contents.filter(m => !knownMsgIds.has(m.id)).at(-1);
  const rollMsgId      = rollMsg?.id      ?? null;
  const rollMsgContent = rollMsg?.content ?? "";

  const total  = Number(roll.total ?? 0);
  const passed = total >= dc;
  console.log(`[${MODULE_ID}] rollSkillForCheck: ${actor.name} rolled ${total} vs DC ${dc} → ${passed ? "PASS" : "FAIL"}`);

  if (passed) {
    await reportCheckResult(actor, total, true, gmCardId, rollMsgId);
  } else {
    const isSave    = type === "save";
    const d20Result = isSave ? getKeptD20Result(roll) : null;
    const isNatOne  = d20Result === 1;

    let result;
    if (isSave && isNatOne) {
      // Saves get a restricted nat-1 dialog (reroll or gain luck die — no add-dice).
      result = await promptNatOneSave(actor, total, dc, roll, rollMsgId, rollMsgContent);
    } else {
      result = await promptLuckOnCheckFail(
        actor, total, dc, rollMsgId, rollMsgContent, roll,
        isSave ? "Failed Saving Throw" : "Failed Skill Check",
        isSave ? "saving throw"         : "skill check"
      );
    }
    if (result) await reportCheckResult(actor, result.finalTotal, result.passed, gmCardId, rollMsgId);
  }
}

// ── Luck dice prompt for failed checks ───────────────────────────────────────

async function promptLuckOnCheckFail(actor, rollTotal, dc, rollMsgId = null, rollMsgContent = "", originalRoll = null, dialogTitle = "Failed Skill Check", rollType = "skill check") {
  // Permission guard: only the actor's owner (or GM) may see the dialog.
  if (!game.user.isGM && actor.hasPlayerOwner && !actor.isOwner) return;

  const luckEnabled = isLuckDiceEnabled();

  if (luckEnabled && !actorHasLuckDice(actor) && !isInspirationEnabled()) return;

  const luckAvail   = luckEnabled ? getDiceUses(actor, LUCK_DICE_ITEM_NAME)   : 0;
  const impactAvail = luckEnabled ? getDiceUses(actor, IMPACT_DICE_ITEM_NAME) : 0;
  const totalAvail  = luckAvail + impactAvail;
  const hasInspNow  = isInspirationEnabled() && actorHasInspiration(actor);

  if (totalAvail <= 0 && !hasInspNow) {
    // No resources at all — auto-regain one luck die if applicable.
    if (luckEnabled && actorHasLuckDice(actor)) {
      debug(`promptLuckOnCheckFail: no dice available for ${actor.name} — auto-regaining`);
      await updateLuckUses(actor, 1);
      await whisperLuckRegain(actor, "failed skill check with no dice available");
    }
    return { finalTotal: rollTotal, passed: false };
  }

  let currentTotal          = rollTotal;
  let baseTotal             = rollTotal;    // reset on each reroll; used as origin for the summary line
  let currentRoll           = originalRoll; // updated on reroll so formula stays current
  let allBonusRolls         = [];           // reset on each reroll
  let bonusMsgId            = rollMsgId;    // start from the initial roll card
  let currentBaseMsgContent = rollMsgContent;
  let hasRerolled           = false;        // true once a luck dice reroll has been made
  let inspirationUsed       = false;        // true once inspiration has been consumed

  while (currentTotal < dc) {
    const curLuck   = luckEnabled ? getDiceUses(actor, LUCK_DICE_ITEM_NAME)   : 0;
    const curImpact = luckEnabled ? getDiceUses(actor, IMPACT_DICE_ITEM_NAME) : 0;
    const curTotal  = curLuck + curImpact;
    const hasInsp   = isInspirationEnabled() && actorHasInspiration(actor);

    // Once dice have been committed (reroll or add), running dry ends the attempt silently.
    if (curTotal <= 0 && !hasInsp) {
      if (!hasRerolled && allBonusRolls.length === 0 && !inspirationUsed) {
        if (luckEnabled && actorHasLuckDice(actor)) {
          await updateLuckUses(actor, 1);
          await whisperLuckRegain(actor, "failed skill check, ran out of dice");
        }
      }
      return { finalTotal: currentTotal, passed: currentTotal >= dc };
    }

    const diceCommitted = hasRerolled || allBonusRolls.length > 0 || inspirationUsed;

    // Build option list based on what's available and what's already been spent.
    const options = [];
    // Inspiration reroll — only before any other resource has been committed.
    if (hasInsp && allBonusRolls.length === 0 && !inspirationUsed)
      options.push({ action: "inspiration", label: "Use Inspiration (Reroll)" });
    // Luck dice options are blocked once inspiration has been used on this roll.
    if (!inspirationUsed) {
      // Reroll — only before bonus dice have been added this attempt.
      if (luckEnabled && currentRoll && curTotal >= 2 && allBonusRolls.length === 0)
        options.push({ action: "reroll", label: "Spend 2 Dice to Reroll" });
      if (luckEnabled && curTotal > 0)
        options.push({ action: "add", label: `Add Dice (1–${curTotal}d6)` });
    }
    // Keep failure — always show as an escape; luck die gain only if nothing was committed.
    // After inspiration, diceCommitted is true so no die is gained, but we still show the button.
    if (!diceCommitted)
      options.push({ action: "keep", label: luckEnabled ? "Keep Failure (Gain 1 Luck Die)" : "Keep Failure" });
    else if (inspirationUsed)
      options.push({ action: "keep", label: "Keep Failure" });

    const action = await promptChoice(
      dialogTitle,
      `<p><strong>${actor.name}</strong> rolled <strong>${currentTotal}</strong> vs DC <strong>${dc}</strong>.</p>
       <p>Spend dice to improve the roll, or keep the failure?</p>
       ${luckEnabled ? buildDiceAvailableHTML(actor) : ""}`,
      options
    );

    console.log(`[${MODULE_ID}] promptLuckOnCheckFail: ${actor.name} chose "${action}"`);

    if (!action || action === "keep") {
      // Only grant a luck die if no resources were already committed this attempt.
      if (luckEnabled && !diceCommitted) {
        await updateLuckUses(actor, 1);
        await whisperLuckRegain(actor, "kept failed skill check");
      }
      return { finalTotal: currentTotal, passed: false };
    }

    if (action === "inspiration") {
      await consumeInspiration(actor);
      inspirationUsed = true;

      const newRoll    = await evaluateInspirationReroll(currentRoll);
      const rerollHtml = await newRoll.render();
      const rerollSection = `
        <div style="border-top:1px solid #aaa;margin-top:4px;padding-top:4px">
          <p style="margin:0 0 4px;font-size:0.85em;opacity:0.7">Rerolled with Inspiration:</p>
          ${rerollHtml}
        </div>`;

      currentBaseMsgContent = currentBaseMsgContent + rerollSection;
      baseTotal    = Number(newRoll.total ?? 0);
      currentTotal = baseTotal;
      currentRoll  = newRoll;
      allBonusRolls = [];

      const existingMsg = bonusMsgId ? game.messages.get(bonusMsgId) : null;
      if (existingMsg) {
        await existingMsg.update({ content: currentBaseMsgContent });
      } else {
        const msg = await ChatMessage.create({ content: currentBaseMsgContent, speaker: { alias: actor.name } });
        bonusMsgId = msg?.id ?? null;
      }

      if (currentTotal >= dc) return { finalTotal: currentTotal, passed: true }; // passed on the inspiration reroll
    }

    else if (action === "reroll") {
      const spent = await spendDiceFromPools(actor, 2);
      if (spent < 2) return null;

      const newRoll    = await evaluateReroll(currentRoll);
      const rerollHtml = await newRoll.render();
      const rerollSection = `
        <div style="border-top:1px solid #aaa;margin-top:4px;padding-top:4px">
          <p style="margin:0 0 4px;font-size:0.85em;opacity:0.7">Rerolled with Luck Dice:</p>
          ${rerollHtml}
        </div>`;

      currentBaseMsgContent = currentBaseMsgContent + rerollSection;
      baseTotal    = Number(newRoll.total ?? 0);
      currentTotal = baseTotal;
      currentRoll  = newRoll;
      allBonusRolls = [];
      hasRerolled   = true;

      // Update the card immediately to show the reroll.
      const existingMsg = bonusMsgId ? game.messages.get(bonusMsgId) : null;
      if (existingMsg) {
        await existingMsg.update({ content: currentBaseMsgContent });
      } else {
        const msg = await ChatMessage.create({ content: currentBaseMsgContent, speaker: { alias: actor.name } });
        bonusMsgId = msg?.id ?? null;
      }

      if (currentTotal >= dc) return { finalTotal: currentTotal, passed: true }; // passed on the reroll
    }

    else if (action === "add") {
      const raw = await promptSlider(
        "Add Dice to Check",
        buildDiceAvailableHTML(actor),
        "luckCheckCount",
        1, curTotal, 1
      );
      const diceCount = clamp(Number(raw ?? 0), 1, curTotal);
      if (!Number.isFinite(diceCount) || diceCount < 1) return null;

      const spent = await spendDiceFromPools(actor, diceCount);
      if (spent < 1) return null;

      const bonusRoll = await new Roll(`${diceCount}d6`).evaluate();
      if (game.dice3d) await game.dice3d.showForRoll(bonusRoll, game.user, true, null, false);

      allBonusRolls.push(bonusRoll);
      currentTotal += bonusRoll.total;

      bonusMsgId = await postCheckBonus(actor, baseTotal, allBonusRolls, currentTotal, dc, bonusMsgId, currentBaseMsgContent, rollType);

      if (currentTotal >= dc) return { finalTotal: currentTotal, passed: true }; // passed — loop exits
      // Still failing — loop back to offer more dice.
    }
  }
  // While loop exited because currentTotal >= dc.
  return { finalTotal: currentTotal, passed: true };
}

/**
 * Update the initial roll card in place (or create a standalone card if none exists)
 * to append all luck-dice bonus rolls. baseMsgContent is the original roll card HTML
 * and is prepended unchanged so the d20 result stays visible at the top.
 * Returns the chat message ID for the next iteration.
 */
async function postCheckBonus(actor, originalTotal, allBonusRolls, newTotal, dc, existingMsgId = null, baseMsgContent = "", rollType = "skill check") {
  const passed = newTotal >= dc;

  // Render each bonus roll and stack them vertically.
  const rollsHtml = (await Promise.all(allBonusRolls.map(r => r.render()))).join("");

  // Summary line: originalTotal + bonus1 + bonus2 + … = newTotal vs DC X
  const bonusParts  = allBonusRolls.map(r => `<strong>${r.total}</strong>`).join(" + ");
  const summaryLine = `<strong style="font-size:1.15em">${originalTotal}</strong> + ${bonusParts} = <strong>${newTotal}</strong> vs DC ${dc} —
    <strong style="color:${passed ? "#719f50" : "#c0392b"}">${passed ? "PASSED" : "FAILED"}</strong>`;

  const luckSection = `
    <div style="border-top:1px solid #aaa;margin-top:6px;padding-top:6px">
      <p style="margin:0 0 6px"><strong>${actor.name}</strong> spent luck dice on a ${rollType}.</p>
      ${rollsHtml}
      <p style="margin:6px 0 0">${summaryLine}</p>
    </div>`;

  const content = baseMsgContent + luckSection;

  // Update the existing card (initial roll card or prior iteration), or create a new one.
  const existingMsg = existingMsgId ? game.messages.get(existingMsgId) : null;
  if (existingMsg) {
    await existingMsg.update({ content });
    return existingMsgId;
  }

  const msg = await ChatMessage.create({ content, speaker: { alias: actor.name } });
  return msg?.id ?? null;
}

// ── Keybinding registration ───────────────────────────────────────────────────

Hooks.once("init", () => {
  game.keybindings.register(MODULE_ID, "openSkillCheckLauncher", {
    name:       "Open Check / Save Launcher",
    hint:       "Opens the GM dialog for requesting a skill check, ability check, or saving throw from players.",
    editable:   [],   // no default — GM assigns their preferred key in Configure Controls
    restricted: true, // GM-only
    onDown: () => {
      showSkillCheckLauncher();
      return true;
    }
  });
  console.log(`[${MODULE_ID}] Keybinding registered: openSkillCheckLauncher`);
});

// ── Socket handler (registered in ready hook) ─────────────────────────────────

Hooks.once("ready", () => {
  console.log(`[${MODULE_ID}] skill-check.js ready — registering socket listener.`);

  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    if (data?.type === "checkRequest") {
      const actor = game.actors.get(data.actorId);
      // Only the non-GM owner of the actor handles this; the GM handles via dispatchCheckRequests.
      if (!actor || game.user.isGM || !actor.isOwner) return;
      debug(`skill-check socket: received checkRequest for ${actor.name}`);
      await rollSkillForCheck(actor, data.checkValue, data.dc, data.showDC ?? false, data.gmCardId ?? null, data.advantageMode ?? "normal");

    } else if (data?.type === "midiSaveFailed") {
      // Player client: show the luck dice prompt, then report the result back to GM.
      const actor = game.actors.get(data.actorId);
      if (!actor || game.user.isGM || !actor.isOwner) return;
      debug(`skill-check socket: received midiSaveFailed for ${actor.name}`);
      const result = await runMidiSavePrompt(
        actor, data.rollTotal, data.dc,
        data.formula ?? "1d20", data.d20Result ?? null,
        data.rollMsgId ?? null, data.rollMsgContent ?? ""
      );
      game.socket.emit(`module.${MODULE_ID}`, {
        type:       "midiSaveResult",
        actorId:    actor.id,
        passed:     result?.passed    ?? false,
        finalTotal: result?.finalTotal ?? data.rollTotal
      });

    } else if (data?.type === "midiSaveResult" && game.user.isGM) {
      // GM client: resolve the pending Promise so preCheckSaves can patch tokenSaves.
      const pending = pendingMidiSaveResults.get(data.actorId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pendingMidiSaveResults.delete(data.actorId);
        pending.resolve(data);
      }

    } else if (data?.type === "checkResult" && game.user.isGM) {
      debug(`skill-check socket: received checkResult for actorId=${data.actorId} total=${data.finalTotal} passed=${data.passed}`);
      await updateGMCheckCard(data.gmCardId, data.actorId, data.finalTotal, data.passed);

      // Apply hide-from-GM: whisper the player's roll card to the player only.
      let hideCards = false;
      try { hideCards = game.settings.get(MODULE_ID, "hideCheckCardsFromGM"); } catch {}
      if (hideCards && data.rollMsgId) {
        const actor   = game.actors.get(data.actorId);
        const rollMsg = game.messages.get(data.rollMsgId);
        if (rollMsg && actor) {
          const ownerIds = game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.id);
          if (ownerIds.length > 0) await rollMsg.update({ whisper: ownerIds }).catch(() => {});
        }
      }
    }
  });
});
