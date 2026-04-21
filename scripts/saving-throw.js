// ── Luck Dice Automation — Saving Throws ─────────────────────────────────────
// Nat-1 prompt for manual saving throws triggered via the skill check launcher.
// Depends on: core.js and skill-check.js (must be loaded first).

console.log(`[${MODULE_ID}] saving-throw.js parsed — user=${game?.user?.name ?? "unknown"} isGM=${game?.user?.isGM ?? "?"} build=${Date.now()}`);

// ── Nat-1 on saving throw ─────────────────────────────────────────────────────

/**
 * Two-option dialog shown when a player rolls a natural 1 on a saving throw:
 *   • Use Inspiration (Reroll)  — if inspiration is available and enabled
 *   • Spend 2 Dice to Reroll   — if luck dice are enabled and enough are available
 *   • Keep Failure (Gain 1 Luck Die) / Keep Failure
 *
 * If a reroll is chosen and the save still fails, chains into promptLuckOnCheckFail
 * so the player can add dice (the "can add dice to the reroll" rule).
 * Inspiration blocks luck dice: if inspiration is used the chain stops.
 *
 * Returns { finalTotal, passed } or null (cancelled / could not spend).
 */
async function promptNatOneSave(actor, rollTotal, dc, originalRoll, rollMsgId, rollMsgContent) {
  if (!game.user.isGM && actor.hasPlayerOwner && !actor.isOwner) return null;

  const luckEnabled = isLuckDiceEnabled();
  const luckAvail   = luckEnabled
    ? getDiceUses(actor, LUCK_DICE_ITEM_NAME) + getDiceUses(actor, IMPACT_DICE_ITEM_NAME)
    : 0;
  const hasInsp = isInspirationEnabled() && actorHasInspiration(actor);

  // No usable resources — auto-regain one luck die (mirrors nat-1 attack behaviour).
  if (luckAvail < 2 && !hasInsp) {
    debug(`promptNatOneSave: no resources for ${actor.name} — auto-regaining`);
    if (luckEnabled && actorHasLuckDice(actor)) {
      await updateLuckUses(actor, 1);
      await whisperLuckRegain(actor, "natural 1 saving throw with no dice to reroll");
    }
    return { finalTotal: rollTotal, passed: false };
  }

  const options = [];
  if (hasInsp)        options.push({ action: "inspiration", label: "Use Inspiration (Reroll)" });
  if (luckAvail >= 2) options.push({ action: "reroll",      label: "Spend 2 Dice to Reroll" });
  options.push({ action: "keep", label: luckEnabled ? "Keep Failure (Gain 1 Luck Die)" : "Keep Failure" });

  const action = await promptChoice(
    "Natural 1 on Save!",
    `<p><strong>${actor.name}</strong> rolled a natural 1 on a saving throw. What would you like to do?</p>
     ${luckEnabled ? buildDiceAvailableHTML(actor) : ""}`,
    options
  );

  console.log(`[${MODULE_ID}] promptNatOneSave: ${actor.name} chose "${action}"`);

  if (!action || action === "keep") {
    if (luckEnabled) {
      await updateLuckUses(actor, 1);
      await whisperLuckRegain(actor, "kept natural 1 saving throw");
    }
    return { finalTotal: rollTotal, passed: false };
  }

  // Helper: append a reroll section to the roll card and return [msgId, content].
  async function applyRerollSection(newRoll, sectionLabel) {
    const rerollHtml    = await newRoll.render();
    const rerollSection = `
      <div style="border-top:1px solid #aaa;margin-top:4px;padding-top:4px">
        <p style="margin:0 0 4px;font-size:0.85em;opacity:0.7">Rerolled with ${sectionLabel}:</p>
        ${rerollHtml}
      </div>`;
    const updatedContent = rollMsgContent + rerollSection;
    const existingMsg    = rollMsgId ? game.messages.get(rollMsgId) : null;
    let   newMsgId       = rollMsgId;
    if (existingMsg) {
      await existingMsg.update({ content: updatedContent });
    } else {
      const msg = await ChatMessage.create({ content: updatedContent, speaker: { alias: actor.name } });
      newMsgId  = msg?.id ?? null;
    }
    return [newMsgId, updatedContent];
  }

  if (action === "inspiration") {
    await consumeInspiration(actor);
    const newRoll                = await evaluateInspirationReroll(originalRoll);
    const [newMsgId, newContent] = await applyRerollSection(newRoll, "Inspiration");
    const newTotal               = Number(newRoll.total ?? 0);
    if (newTotal >= dc) return { finalTotal: newTotal, passed: true };
    // Inspiration blocks luck dice — report the failure and stop.
    return { finalTotal: newTotal, passed: false };
  }

  if (action === "reroll") {
    const spent = await spendDiceFromPools(actor, 2);
    if (spent < 2) return null;
    const newRoll                = await evaluateReroll(originalRoll);
    const [newMsgId, newContent] = await applyRerollSection(newRoll, "Luck Dice");
    const newTotal               = Number(newRoll.total ?? 0);
    if (newTotal >= dc) return { finalTotal: newTotal, passed: true };
    // Still failing — hand off to the full luck-dice loop (add-dice now available).
    return await promptLuckOnCheckFail(
      actor, newTotal, dc, newMsgId, newContent, newRoll,
      "Failed Saving Throw", "saving throw"
    );
  }

  return null;
}
