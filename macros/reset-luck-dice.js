/**
 * Luck Dice — Session Reset  (Foundry VTT v13 & v14, dnd5e)
 * Paste this into a Foundry macro (type: Script). Run as GM at the start of a session.
 * For use with Scorpious187's Luck Dice Automation.
 *
 * "Luck Dice" is a FEAT (item type "feat") with uses tracked as:
 *   system.uses.max   (string/number)
 *   system.uses.spent (number)
 *
 * Remaining = max - spent
 * If remaining < 3, top up to 3 by setting spent = max - 3 (clamped at 0).
 * Players banked above 3 are left untouched (this only tops up, never reduces).
 */

const FEATURE_NAME = "Luck Dice";
const TARGET_REMAINING = 3;

// "Player Character" heuristic: character-type actors that have at least one player owner
const pcs = game.actors.filter(a => a.type === "character" && a.hasPlayerOwner);

if (!pcs.length) {
  ui.notifications.warn("No player-owned character actors found.");
  return;
}

const updated = [];
const lines = [];
let missingCount = 0;
let skippedCount = 0;

function toNumberOrNaN(v) {
  if (v === null || v === undefined) return NaN;
  // Many dnd5e fields are strings; Number("6") works, Number("@abilities...") becomes NaN
  return Number(v);
}

for (const actor of pcs) {
  // Prefer the feat named "Luck Dice"; fall back to any item with that name.
  const luckItem = actor.items.find(i => i.name === FEATURE_NAME && i.type === "feat")
                ?? actor.items.find(i => i.name === FEATURE_NAME);

  if (!luckItem) {
    missingCount++;
    lines.push(`${actor.name}: ❌ No "${FEATURE_NAME}" item`);
    continue;
  }

  const maxRaw = luckItem.system?.uses?.max;
  const spentRaw = luckItem.system?.uses?.spent;

  const max = toNumberOrNaN(maxRaw);
  const spent = toNumberOrNaN(spentRaw);

  if (!Number.isFinite(max) || !Number.isFinite(spent)) {
    skippedCount++;
    lines.push(`${actor.name}: ⚠️ "${FEATURE_NAME}" uses not numeric (max=${String(maxRaw)}, spent=${String(spentRaw)})`);
    continue;
  }

  const remainingBefore = Math.max(0, max - spent);

  if (remainingBefore < TARGET_REMAINING) {
    const newSpent = Math.max(0, max - TARGET_REMAINING);
    await luckItem.update({ "system.uses.spent": newSpent });

    const remainingAfter = Math.max(0, max - newSpent);
    updated.push(`${actor.name} (${remainingBefore} → ${remainingAfter})`);
    lines.push(`${actor.name}: ${remainingAfter} remaining (updated; max ${max})`);
  } else {
    lines.push(`${actor.name}: ${remainingBefore} remaining (max ${max})`);
  }
}

const html = `
<h2>Luck Dice Audit</h2>
<p><b>Updated:</b> ${updated.length}</p>
${updated.length ? `<p>${updated.join("<br>")}</p>` : "<p>None</p>"}
<hr>
<p><b>Status</b></p>
<ul>${lines.map(l => `<li>${l}</li>`).join("")}</ul>
<p style="opacity:0.8">
Missing item: ${missingCount} &nbsp;|&nbsp; Skipped (non-numeric uses): ${skippedCount}
</p>
`;

await ChatMessage.create({
  content: html,
  whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id)
});

console.log("Luck Dice Audit:", { updated, lines, missingCount, skippedCount });
