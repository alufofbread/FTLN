require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const { TikTokLiveConnection } = require("tiktok-live-connector");

const CHECK_INTERVAL_SECONDS = Math.max(
  Number.parseInt(process.env.CHECK_INTERVAL_SECONDS || "60", 10),
  30
);

const MEMBERS_PATH = path.join(process.cwd(), "members.json");
const CONFIG_PATH = path.join(process.cwd(), "config.json");

const CREATOR_AUTOCOMPLETE_USERNAMES = [
  "randomrapid",
  "danielgoofyahh_",
  "axelae.ae",
  "tobymalton0",
  "rl_warrior",
  "batmncon",
  "fasttrack_mini",
  "kyro.rll",
  "ryftago",
  "jordanriley96",
  "rl_sam4",
  "rozza_c9",
  "lux.killa",
  "lils.0007",
  "oo8ray",
  "j28.jg",
  "trexidov",
  "lexlexi.0x",
  "egarnerjones2",
  "tee_es_on_tiktok",
  "soultrapped_",
  "kruze.rl",
  "flkcs",
  "evans_fn",
  "dreadrl",
  "quixc_god",
  "glowing.jellyfish1",
  "1_1_1_382",
  "jxrds_o",
  "b0tsquad_",
  "wnt8d_",
  "extraa__aa",
  "kronosfvv._",
];

const state = new Map();
let checkAllMembersInProgress = false;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function cleanUsername(username) {
  return String(username || "")
    .trim()
    .replace(/^@/, "");
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeMember(member) {
  const username = cleanUsername(member.username);

  return {
    username,
    displayName: String(member.displayName || username).trim() || username,
  };
}

function loadMembers() {
  const members = readJsonFile(MEMBERS_PATH, []);
  return members
    .map(normalizeMember)
    .filter((member) => member.username);
}

function saveMembers(members) {
  const uniqueMembers = new Map();

  for (const member of members.map(normalizeMember)) {
    if (member.username) {
      uniqueMembers.set(member.username.toLowerCase(), member);
    }
  }

  const sortedMembers = [...uniqueMembers.values()].sort((a, b) =>
    a.username.localeCompare(b.username)
  );

  writeJsonFile(MEMBERS_PATH, sortedMembers);
  return sortedMembers;
}

function loadConfig() {
  const config = readJsonFile(CONFIG_PATH, {});

  return {
    channelId:
      config.channelId ||
      process.env.DISCORD_CHANNEL_ID ||
      null,
  };
}

function saveConfig(config) {
  writeJsonFile(CONFIG_PATH, {
    ...loadConfig(),
    ...config,
  });
}

function ensureLocalFiles() {
  if (!fs.existsSync(MEMBERS_PATH)) {
    saveMembers([]);
  } else {
    saveMembers(loadMembers());
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig({ channelId: process.env.DISCORD_CHANNEL_ID || null });
  }
}

function parseMemberEntries(entries) {
  return String(entries || "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [rawUsername, ...displayParts] = entry.split(":");
      const username = cleanUsername(rawUsername);
      const displayName = displayParts.join(":").trim() || username;

      return { username, displayName };
    })
    .filter((member) => member.username);
}

function upsertMembers(nextMembers) {
  const membersByUsername = new Map(
    loadMembers().map((member) => [member.username.toLowerCase(), member])
  );

  for (const member of nextMembers) {
    const normalized = normalizeMember(member);
    if (normalized.username) {
      membersByUsername.set(normalized.username.toLowerCase(), normalized);
    }
  }

  return saveMembers([...membersByUsername.values()]);
}

function removeMember(username) {
  const cleanedUsername = cleanUsername(username);
  const remainingMembers = loadMembers().filter(
    (member) => member.username.toLowerCase() !== cleanedUsername.toLowerCase()
  );

  saveMembers(remainingMembers);
  state.delete(cleanedUsername);

  return remainingMembers;
}

function formatMembers(members) {
  if (members.length === 0) {
    return "No TikTok members are configured yet.";
  }

  return members
    .map((member) => ({
      username: member.username,
      displayName: member.displayName || member.username,
    }))
    .map((member) =>
      member.displayName === member.username
        ? `- @${member.username}`
        : `- ${member.displayName} (@${member.username})`
    )
    .join("\n");
}

function getCreatorAutocompleteChoices(focusedValue, mode = "add") {
  const query = cleanUsername(focusedValue).toLowerCase();
  const trackedMembers = loadMembers();
  const trackedUsernames = new Set(
    trackedMembers.map((member) => member.username.toLowerCase())
  );
  const usernames =
    mode === "remove"
      ? trackedMembers.map((member) => member.username)
      : CREATOR_AUTOCOMPLETE_USERNAMES.filter(
          (username) => !trackedUsernames.has(username.toLowerCase())
        );

  return usernames
    .filter((username) => username.toLowerCase().includes(query))
    .slice(0, 25)
    .map((username) => ({
      name: `@${username}`,
      value: username,
    }));
}

function pickFirst(...values) {
  return values.find((value) => typeof value === "string" && value.trim());
}

function getRoomData(roomInfo) {
  return roomInfo?.data || roomInfo?.roomInfo || roomInfo || {};
}

function getLiveTitle(roomInfo) {
  const room = getRoomData(roomInfo);

  return (
    pickFirst(
      room.title,
      room.caption,
      room.liveRoom?.title,
      room.liveRoom?.caption,
      room.room?.title,
      room.room?.caption
    ) || "No caption found"
  );
}

function getLiveId(roomInfo, username) {
  const room = getRoomData(roomInfo);

  return String(
    room.id_str ||
      room.id ||
      room.room_id ||
      room.roomId ||
      room.liveRoom?.roomId ||
      room.liveRoom?.id ||
      `${username}-live`
  );
}

function getViewerCount(roomInfo) {
  const room = getRoomData(roomInfo);
  return (
    room.user_count ||
    room.userCount ||
    room.stats?.user_count ||
    room.liveRoom?.user_count ||
    null
  );
}

function getAvatar(roomInfo) {
  const owner = getRoomData(roomInfo)?.owner || {};
  return (
    owner.avatar_thumb?.url_list?.[0] ||
    owner.avatar_medium?.url_list?.[0] ||
    owner.avatar_large?.url_list?.[0] ||
    null
  );
}

function getTikTokConnectionOptions() {
  const options = {
    fetchRoomInfoOnConnect: false,
    processInitialData: false,
    webClientOptions: {
      timeout: 15000,
    },
  };

  if (process.env.TIKTOK_SESSION_ID && process.env.TIKTOK_TT_TARGET_IDC) {
    options.sessionId = process.env.TIKTOK_SESSION_ID;
    options.ttTargetIdc = process.env.TIKTOK_TT_TARGET_IDC;
  }

  return options;
}

async function fetchLiveDetails(member) {
  const connection = new TikTokLiveConnection(
    member.username,
    getTikTokConnectionOptions()
  );

  const isLive = await connection.fetchIsLive();
  if (!isLive) {
    return { isLive: false };
  }

  const roomInfo = await connection.fetchRoomInfo();
  return {
    isLive: true,
    roomInfo,
    liveId: getLiveId(roomInfo, member.username),
    title: getLiveTitle(roomInfo),
    viewerCount: getViewerCount(roomInfo),
    avatar: getAvatar(roomInfo),
  };
}

async function sendLiveNotification(channel, member, live) {
  const liveUrl = `https://www.tiktok.com/@${member.username}/live`;
  const displayName = member.displayName || member.username;

  const embed = new EmbedBuilder()
    .setColor(0xff0050)
    .setTitle(`${displayName} is live on TikTok`)
    .setURL(liveUrl)
    .setDescription(live.title)
    .addFields(
      { name: "Creator", value: `@${member.username}`, inline: true },
      { name: "Join stream", value: `[Open TikTok LIVE](${liveUrl})`, inline: true }
    )
    .setTimestamp(new Date());

  if (live.avatar) {
    embed.setThumbnail(live.avatar);
  }

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function checkMember(channel, member) {
  try {
    const live = await fetchLiveDetails(member);
    const previous = state.get(member.username) || {};

    if (!live.isLive) {
      state.set(member.username, { isLive: false, liveId: null });
      console.log(`[offline] @${member.username}`);
      return;
    }

    if (previous.isLive) {
      const liveIdNote =
        previous.liveId === live.liveId
          ? live.liveId
          : `${previous.liveId || "unknown"} -> ${live.liveId || "unknown"}`;
      state.set(member.username, { isLive: true, liveId: live.liveId });
      console.log(`[still live] @${member.username} (${liveIdNote})`);
      return;
    }

    await sendLiveNotification(channel, member, live);
    state.set(member.username, { isLive: true, liveId: live.liveId });
    console.log(`[notified] @${member.username} (${live.liveId})`);
  } catch (error) {
    console.error(`[error] @${member.username}:`, error.message);
  }
}

async function resolveNotificationChannel(client) {
  const { channelId } = loadConfig();

  if (!channelId) {
    console.log("No notification channel configured. Use /setchannel in Discord.");
    return null;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    console.warn("Configured notification channel is missing or is not text-based.");
    return null;
  }

  return channel;
}

async function checkAllMembers(client) {
  if (checkAllMembersInProgress) {
    console.log("Previous TikTok LIVE check is still running. Skipping this tick.");
    return;
  }

  checkAllMembersInProgress = true;

  try {
    const channel = await resolveNotificationChannel(client);
    const members = loadMembers();

    if (!channel || members.length === 0) {
      if (members.length === 0) {
        console.log("No TikTok members configured. Use /addmember or /addmembers.");
      }
      return;
    }

    console.log(`Checking ${members.length} TikTok account(s)...`);

    for (const member of members) {
      await checkMember(channel, member);
    }
  } finally {
    checkAllMembersInProgress = false;
  }
}

function getCommands() {
  return [
    new SlashCommandBuilder()
      .setName("setchannel")
      .setDescription("Set the Discord channel that receives TikTok LIVE notifications.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Notification channel")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement
          )
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("addmember")
      .setDescription("Add or update one TikTok member.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option
          .setName("username")
          .setDescription("TikTok username, with or without @")
          .setAutocomplete(true)
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("display_name")
          .setDescription("Optional display name for alerts")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("addmembers")
      .setDescription("Add multiple TikTok members at once.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option
          .setName("members")
          .setDescription("Comma/newline list. Use username or username:Display Name.")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("removemember")
      .setDescription("Remove a TikTok member.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option
          .setName("username")
          .setDescription("TikTok username, with or without @")
          .setAutocomplete(true)
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("listmembers")
      .setDescription("List configured TikTok members.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("checknow")
      .setDescription("Run a TikTok LIVE check immediately.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ].map((command) => command.toJSON());
}

async function registerCommands(client) {
  const commands = getCommands();

  if (process.env.DISCORD_GUILD_ID) {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    await guild.commands.set(commands);
    console.log(`Registered ${commands.length} guild command(s).`);
    return;
  }

  await client.application.commands.set(commands);
  console.log(`Registered ${commands.length} global command(s).`);
}

async function handleInteraction(interaction, client) {
  if (interaction.isAutocomplete()) {
    const focusedOption = interaction.options.getFocused(true);

    if (
      focusedOption.name === "username" &&
      ["addmember", "removemember"].includes(interaction.commandName)
    ) {
      await interaction.respond(
        getCreatorAutocompleteChoices(
          focusedOption.value,
          interaction.commandName === "removemember" ? "remove" : "add"
        )
      );
    } else {
      await interaction.respond([]);
    }

    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === "setchannel") {
    const channel = interaction.options.getChannel("channel", true);
    saveConfig({ channelId: channel.id });
    await interaction.reply({
      content: `TikTok LIVE notifications will be sent to ${channel}.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "addmember") {
    const username = cleanUsername(interaction.options.getString("username", true));
    const displayName =
      interaction.options.getString("display_name")?.trim() || username;

    const members = upsertMembers([{ username, displayName }]);
    await interaction.reply({
      content: `@${username}, added to the live watchlist.`,
    });
    return;
  }

  if (interaction.commandName === "addmembers") {
    const entries = parseMemberEntries(
      interaction.options.getString("members", true)
    );

    if (entries.length === 0) {
      await interaction.reply({
        content: "I could not find any valid TikTok usernames in that list.",
        ephemeral: true,
      });
      return;
    }

    const members = upsertMembers(entries);
    await interaction.reply({
      content: `Added/updated ${entries.length} member(s). Tracking ${members.length} total.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "removemember") {
    const username = cleanUsername(interaction.options.getString("username", true));
    const beforeCount = loadMembers().length;
    const members = removeMember(username);
    const removed = members.length < beforeCount;

    await interaction.reply({
      content: removed
        ? `Removed @${username}. Tracking ${members.length} member(s).`
        : `@${username} was not in the member list.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "listmembers") {
    const membersText = formatMembers(loadMembers());
    await interaction.reply({
      content: membersText.slice(0, 1900),
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "checknow") {
    await interaction.deferReply({ ephemeral: true });
    await checkAllMembers(client);
    await interaction.editReply("TikTok LIVE check finished.");
  }
}

async function main() {
  const token = requiredEnv("DISCORD_TOKEN");
  ensureLocalFiles();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once("ready", async () => {
    console.log(`FT Notifier logged in as ${client.user.tag}`);
    await registerCommands(client);

    await checkAllMembers(client);
    setInterval(
      () => checkAllMembers(client),
      CHECK_INTERVAL_SECONDS * 1000
    );
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      await handleInteraction(interaction, client);
    } catch (error) {
      console.error(`[command error] ${interaction.commandName}:`, error);

      const response = {
        content: "Something went wrong while running that command.",
        ephemeral: true,
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(response);
      } else {
        await interaction.reply(response);
      }
    }
  });

  await client.login(token);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
