const BOT_CONTROLLER_ROLE_NAME = "bot controller";

function canUseBot(interaction, administratorPermission) {
  if (!interaction.inGuild()) return false;
  if (interaction.memberPermissions?.has(administratorPermission)) return true;
  return Boolean(interaction.member?.roles?.cache?.some(
    (role) => role.name.trim().toLowerCase() === BOT_CONTROLLER_ROLE_NAME
  ));
}

module.exports = { canUseBot };
