const MODULE_ID = "luck-dice-automation";
const LUCK_DICE_ITEM_NAME = "Luck Dice";
const DEBUG = false;

const workflowState = new Map();

function debug(...args) {
  if (DEBUG) console.log(`${MODULE_ID} |`, ...args);
}

function getWorkflowKey(workflow) {
  return workflow?.uuid ?? workflow?.id ?? `${workflow?.actor?.id}-${workflow?.item?.id}-${Date.now()}`;
}

function getState(workflow) {
  const key = getWorkflowKey(workflow);
  if (!workflowState.has(key)) {
    workflowState.set(key, {
      luckSpentOnAttack: 0,
      damagePrompted: false,
      attackPrompted: false
    });
  }
  return workflowState.get(key);
}

function getLuckItem(actor) {
  return actor?.items?.find((item) => item.name === LUCK_DICE_ITEM_NAME);
}

function getLuckUses(actor) {
  const item = getLuckItem(actor);
  return Number(item?.system?.uses?.value ?? 0);
}

async function updateLuckUses(actor, delta) {
  const item = getLuckItem(actor);
  if (!item) return false;

  const uses = item.system?.uses ?? {};
  const current = Number(uses.value ?? 0);
  const max = Number(uses.max ?? current);
  const next = Math.clamp(current + delta, 0, max);
  if (next === current) return false;

  await item.update({ "system.uses.value": next });
  debug(`Updated Luck Dice: ${current} -> ${next}`);
  return true;
}

async function promptChoice(title, content, buttons) {
  const dialogButtons = buttons.map((b) => ({
    action: b.action,
    label: b.label,
    callback: () => b.action
  }));

  if (foundry?.applications?.api?.DialogV2) {
    return foundry.applications.api.DialogV2.wait({
      window: { title },
      content,
      buttons: dialogButtons
    });
  }

  return Dialog.wait({
    title,
    content,
    buttons: Object.fromEntries(
      buttons.map((b) => [
        b.action,
        {
          label: b.label,
          callback: () => b.action
        }
      ])
    ),
    default: buttons[0]?.action,
    close: () => "decline"
  });
}

function getDefiniteHitState(workflow) {
  if (!workflow?.attackRoll) return null;

  const hitTargets = workflow.hitTargets instanceof Set ? workflow.hitTargets : new Set();
  if (hitTargets.size > 0) return true;

  const targets = workflow.targets instanceof Set ? [...workflow.targets] : [];
  if (targets.length !== 1) return null; // Multi-target and no hits can be ambiguous.

  const attackTotal = Number(workflow.attackTotal ?? workflow.attackRoll?.total);
  const targetAC = Number(targets[0]?.actor?.system?.attributes?.ac?.value);

  if (!Number.isFinite(attackTotal) || !Number.isFinite(targetAC)) return null;
  return attackTotal >= targetAC;
}

async function setAttackRoll(workflow, roll) {
  // Midi may expose setAttackRoll in some builds; fallback to direct assignment.
  if (typeof workflow.setAttackRoll === "function") {
    await workflow.setAttackRoll(roll);
  } else {
    workflow.attackRoll = roll;
    workflow.attackTotal = roll.total;
  }
}

async function rerollAttack(workflow) {
  const newRoll = await (new Roll(workflow.attackRoll.formula, workflow.attackRoll.data ?? {})).evaluate();
  await setAttackRoll(workflow, newRoll);
  return newRoll;
}

async function addLuckDiceToAttack(workflow, diceCount) {
  const bonusRoll = await (new Roll(`${diceCount}d6`)).evaluate();
  const currentTotal = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
  workflow.attackTotal = currentTotal + bonusRoll.total;
  workflow.luckAttackBonus = (workflow.luckAttackBonus ?? 0) + bonusRoll.total;
  debug("Applied attack bonus", { diceCount, bonus: bonusRoll.total, newTotal: workflow.attackTotal });
}

function recomputeHitTargets(workflow) {
  const targets = workflow.targets instanceof Set ? [...workflow.targets] : [];
  const total = Number(workflow.attackTotal ?? workflow.attackRoll?.total);
  if (!Number.isFinite(total)) return;

  const hits = targets.filter((t) => {
    const ac = Number(t?.actor?.system?.attributes?.ac?.value);
    return Number.isFinite(ac) && total >= ac;
  });

  workflow.hitTargets = new Set(hits);
}

async function promptLuckOnMiss(workflow) {
  const actor = workflow?.actor;
  if (!actor || !game.user?.isGM && actor.hasPlayerOwner && !actor.isOwner) return;

  const state = getState(workflow);
  if (state.attackPrompted) return;

  while (true) {
    recomputeHitTargets(workflow);
    const hitState = getDefiniteHitState(workflow);
    debug("Attack hit-state check", { hitState, total: workflow.attackTotal, hits: workflow.hitTargets?.size ?? 0 });

    if (hitState !== false) return;

    const available = getLuckUses(actor);
    if (available <= 0) return;

    state.attackPrompted = true;
    const options = [{ action: "decline", label: "Keep Miss" }];
    options.unshift({ action: "add", label: `Add Luck Dice (1-${Math.min(6, available)}d6)` });
    if (available >= 2) options.unshift({ action: "reroll", label: "Spend 2 to Reroll" });

    const action = await promptChoice(
      "Luck Dice: Missed Attack",
      `<p>Your attack missed. Spend Luck Dice?</p><p>Available: <strong>${available}</strong></p>`,
      options
    );

    if (action === "decline" || !action) return;

    if (action === "reroll" && available >= 2) {
      const spent = await updateLuckUses(actor, -2);
      if (!spent) return;
      state.luckSpentOnAttack += 2;
      await rerollAttack(workflow);
    }

    if (action === "add") {
      const maxDice = Math.min(6, getLuckUses(actor));
      if (maxDice <= 0) return;

      const entry = await foundry.applications.api.DialogV2.prompt({
        window: { title: "Luck Dice: Add to Attack" },
        content: `<label>Number of d6 (1-${maxDice}): <input id="luckDiceCount" type="number" min="1" max="${maxDice}" value="1"></label>`,
        ok: {
          label: "Spend",
          callback: (event, button, html) => Number(html.querySelector("#luckDiceCount")?.value ?? 1)
        },
        rejectClose: false
      });

      const diceCount = Math.clamp(Number(entry ?? 0), 1, maxDice);
      if (!Number.isFinite(diceCount) || diceCount < 1) return;

      const spent = await updateLuckUses(actor, -diceCount);
      if (!spent) return;
      state.luckSpentOnAttack += diceCount;
      await addLuckDiceToAttack(workflow, diceCount);
    }
  }
}

async function promptLuckOnDamage(workflow) {
  const actor = workflow?.actor;
  if (!actor) return;

  const state = getState(workflow);
  if (state.damagePrompted) return;

  const hitState = getDefiniteHitState(workflow);
  debug("Damage hook hit-state", { hitState, total: workflow.attackTotal, hits: workflow.hitTargets?.size ?? 0 });
  if (hitState !== true) return;

  const available = getLuckUses(actor);
  if (available <= 0) return;

  const entry = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Luck Dice: Add to Damage" },
    content: `<p>Attack hit. Add Luck Dice to damage?</p>
      <label>Number of d6 (0-${Math.min(6, available)}): <input id="luckDamageCount" type="number" min="0" max="${Math.min(6, available)}" value="0"></label>`,
    ok: {
      label: "Apply",
      callback: (event, button, html) => Number(html.querySelector("#luckDamageCount")?.value ?? 0)
    },
    rejectClose: false
  });

  const diceCount = Math.clamp(Number(entry ?? 0), 0, Math.min(6, available));
  if (!Number.isFinite(diceCount) || diceCount <= 0) {
    state.damagePrompted = true;
    return;
  }

  const spent = await updateLuckUses(actor, -diceCount);
  if (!spent) return;

  // Inject into formula before damage evaluation so crit multiplication includes Luck Dice.
  const addFormula = `${diceCount}d6`;
  if (workflow.damageRollFormula) {
    workflow.damageRollFormula = `(${workflow.damageRollFormula}) + ${addFormula}`;
  } else if (workflow.damageFormula) {
    workflow.damageFormula = `(${workflow.damageFormula}) + ${addFormula}`;
  } else {
    workflow.bonusDamageRoll = (workflow.bonusDamageRoll ? `${workflow.bonusDamageRoll} + ` : "") + addFormula;
  }

  state.damagePrompted = true;
  debug("Injected luck dice into damage", { addFormula, damageRollFormula: workflow.damageRollFormula, damageFormula: workflow.damageFormula });
}

async function maybeRegainLuckDie(actor, state) {
  if (!actor || !state || state.luckSpentOnAttack > 0) return;
  await updateLuckUses(actor, 1);
}

Hooks.once("ready", () => {
  if (!game.modules.get("midi-qol")?.active) {
    ui.notifications?.warn("Luck Dice Automation requires Midi-QoL.");
    return;
  }

  Hooks.on("midi-qol.AttackRollComplete", async (workflow) => {
    try {
      const hitState = getDefiniteHitState(workflow);
      debug("AttackRollComplete", { workflowId: workflow?.id, hitState, attackTotal: workflow?.attackTotal, hitTargets: workflow?.hitTargets?.size });

      if (hitState === false) {
        await promptLuckOnMiss(workflow);
      }

      const state = getState(workflow);
      const attackDie = workflow?.attackRoll?.dice?.[0]?.results?.[0]?.result;
      if (attackDie === 1 && state.luckSpentOnAttack === 0) {
        await maybeRegainLuckDie(workflow.actor, state);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | AttackRollComplete error`, err);
    }
  });

  Hooks.on("midi-qol.preDamageRoll", async (workflow) => {
    try {
      await promptLuckOnDamage(workflow);
    } catch (err) {
      console.error(`${MODULE_ID} | preDamageRoll error`, err);
    }
  });

  Hooks.on("midi-qol.RollComplete", async (workflow) => {
    try {
      const state = getState(workflow);
      const kind = workflow?.workflowType ?? workflow?.item?.system?.actionType ?? workflow?.type;
      const failed = workflow?.failed === true || workflow?.isFailed === true || workflow?.success === false;
      if ((kind === "save" || kind === "check") && failed) {
        await maybeRegainLuckDie(workflow.actor, state);
      }

      // Cleanup to avoid unbounded growth.
      const key = getWorkflowKey(workflow);
      workflowState.delete(key);
    } catch (err) {
      console.error(`${MODULE_ID} | RollComplete error`, err);
    }
  });

  debug("Initialized");
});
