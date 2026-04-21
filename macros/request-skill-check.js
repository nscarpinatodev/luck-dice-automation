// Luck Dice Automation — Request Skill Check
// Paste this into a Foundry macro (type: Script). Run as GM only.
// Requires the Luck Dice Automation module to be active.

if (!game.user.isGM) {
  ui.notifications.warn("Only the GM can request skill checks.");
  return;
}

if (typeof showSkillCheckLauncher !== "function") {
  ui.notifications.error("Luck Dice Automation module is not loaded.");
  return;
}

showSkillCheckLauncher();
