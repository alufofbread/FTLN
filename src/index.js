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
const { canUseBot } = require("./permissions");
const { AgencyVideos } = require("./agency-videos");
const { Watchlist } = require("./watchlist");
let watchlist;

const CHECK_INTERVAL_SECONDS = Math.max(
  Number.parseInt(process.env.CHECK_INTERVAL_SECONDS || "60", 10),
  30
);

const DATA_DIR = path.resolve(
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd()
);
const MEMBERS_PATH = path.join(DATA_DIR, "members.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const NOTIFICATION_STATE_PATH = path.join(
  DATA_DIR,
  "notification-state.json"
);

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

function getMemberKey(username) {
  return cleanUsername(username).toLowerCase();
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
  if (watchlist) return watchlist.members();
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
    videoChannelId: config.videoChannelId || process.env.AGENCY_VIDEO_CHANNEL_ID || null,
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

function loadNotificationState() {
  const savedState = readJsonFile(NOTIFICATION_STATE_PATH, {});
  return savedState && typeof savedState === "object" ? savedState : {};
}

function saveNotificationState() {
  writeJsonFile(
    NOTIFICATION_STATE_PATH,
    Object.fromEntries([...state.entries()].sort(([a], [b]) => a.localeCompare(b)))
  );
}

function hydrateNotificationState() {
  state.clear();

  for (const [username, memberState] of Object.entries(loadNotificationState())) {
    if (memberState && typeof memberState === "object") {
      state.set(getMemberKey(username), {
        isLive: Boolean(memberState.isLive),
        liveId: memberState.liveId || null,
        updatedAt: memberState.updatedAt || null,
      });
    }
  }
}

function setMemberLiveState(username, nextState) {
  state.set(getMemberKey(username), {
    ...nextState,
    updatedAt: new Date().toISOString(),
  });
  saveNotificationState();
}

function ensureLocalFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Preserve existing file-based configuration on the first switch to a volume.
  if (DATA_DIR !== process.cwd()) {
    for (const filename of ["members.json", "config.json", "notification-state.json"]) {
      const source = path.join(process.cwd(), filename);
      const destination = path.join(DATA_DIR, filename);
      if (fs.existsSync(source) && !fs.existsSync(destination)) {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      }
    }
  }
  if (!fs.existsSync(MEMBERS_PATH)) {
    saveMembers([]);
  } else {
    saveMembers(loadMembers());
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig({ channelId: process.env.DISCORD_CHANNEL_ID || null });
  }

  if (!fs.existsSync(NOTIFICATION_STATE_PATH)) {
    saveNotificationState();
  } else {
    hydrateNotificationState();
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
  return watchlist.add(nextMembers);
}

function removeMember(username) {
  const cleanedUsername = cleanUsername(username);
  const remainingMembers = watchlist.remove(cleanedUsername);
  state.delete(getMemberKey(cleanedUsername));
  saveNotificationState();

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
  const candidates = [...new Set([...CREATOR_AUTOCOMPLETE_USERNAMES, ...(watchlist?.state.roster || []).map(m => m.username)])];
  const usernames =
    mode === "remove"
      ? trackedMembers.map((member) => member.username)
      : candidates.filter(
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
    if (!loadMembers().some(row => getMemberKey(row.username) === getMemberKey(member.username))) return;
    const previous = state.get(getMemberKey(member.username)) || {};

    if (!live.isLive) {
      setMemberLiveState(member.username, { isLive: false, liveId: null });
      console.log(`[offline] @${member.username}`);
      return;
    }

    if (previous.isLive) {
      const liveIdNote =
        previous.liveId === live.liveId
          ? live.liveId
          : `${previous.liveId || "unknown"} -> ${live.liveId || "unknown"}`;
      setMemberLiveState(member.username, { isLive: true, liveId: live.liveId });
      console.log(`[still live] @${member.username} (${liveIdNote})`);
      return;
    }

    if (!loadMembers().some(row => getMemberKey(row.username) === getMemberKey(member.username))) return;
    await sendLiveNotification(channel, member, live);
    setMemberLiveState(member.username, { isLive: true, liveId: live.liveId });
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
      if (!loadMembers().some(row => getMemberKey(row.username) === getMemberKey(member.username))) continue;
      await checkMember(channel, member);
    }
  } finally {
    checkAllMembersInProgress = false;
  }
}

function getCommands() {
  return [
    new SlashCommandBuilder()
      .setName('setvideochannel')
      .setDescription('Set the channel for new @aetheragencytt videos only.')
      .setDefaultMemberPermissions(null)
      .addChannelOption(option => option.setName('channel').setDescription('Agency video alerts channel')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
    new SlashCommandBuilder()
      .setName("setchannel")
      .setDescription("Set the Discord channel that receives TikTok LIVE notifications.")
      .setDefaultMemberPermissions(null)
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
      .setDefaultMemberPermissions(null)
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
      .setDefaultMemberPermissions(null)
      .addStringOption((option) =>
        option
          .setName("members")
          .setDescription("Comma/newline list. Use username or username:Display Name.")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("removemember")
      .setDescription("Remove a TikTok member.")
      .setDefaultMemberPermissions(null)
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
      .setDefaultMemberPermissions(null)
      .addIntegerOption(option => option.setName("page").setDescription("Watchlist page").setMinValue(1).setMaxValue(1000)),
    new SlashCommandBuilder().setName("syncmembers").setDescription("Sync the agency LIVE watchlist now.").setDefaultMemberPermissions(null),
    new SlashCommandBuilder().setName("watchliststatus").setDescription("Show agency sync health and manual override counts.").setDefaultMemberPermissions(null),
    new SlashCommandBuilder()
      .setName("checknow")
      .setDescription("Run a TikTok LIVE check immediately.")
      .setDefaultMemberPermissions(null),
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
  if (!interaction.isAutocomplete() && !interaction.isChatInputCommand()) return;
  if (!canUseBot(interaction, PermissionFlagsBits.Administrator)) {
    if (interaction.isAutocomplete()) {
      await interaction.respond([]);
    } else {
      await interaction.reply({
        content: "You need Administrator permission or the Bot Controller role to use this bot.",
        ephemeral: true,
      });
    }
    return;
  }
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

  if (interaction.commandName === 'setvideochannel') {
    const channel = interaction.options.getChannel('channel', true);
    saveConfig({ videoChannelId: channel.id });
    await interaction.reply({ content: `New @aetheragencytt video alerts will be sent to ${channel}. TikTok video API authorisation must be configured.`, ephemeral: true });
    return;
  }

  if (interaction.commandName === "addmember") {
    const username = cleanUsername(interaction.options.getString("username", true));
    const displayName =
      interaction.options.getString("display_name")?.trim() || username;

    upsertMembers([{ username, displayName }]);
    await interaction.reply({
      content: `@${username} added to the LIVE watchlist. Any manual exclusion was cleared.`,
      ephemeral: true,
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
        : `@${username} was not currently tracked. A manual exclusion was saved so agency sync will not add them.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "listmembers") {
    const members = loadMembers(), pages = Math.max(1, Math.ceil(members.length / 15));
    const page = Math.min(interaction.options.getInteger("page") || 1, pages);
    const membersText = `LIVE watchlist: ${members.length} tracked | page ${page}/${pages}\n` + formatMembers(members.slice((page-1)*15, page*15));
    await interaction.reply({
      content: membersText.slice(0, 1900),
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "syncmembers") {
    await interaction.deferReply({ ephemeral: true });
    const result = await syncAgencyMembers();
    await interaction.editReply(result.ok ? `Agency watchlist synced. Tracking ${result.tracked} members. Manual exclusions are preserved.` : `Sync failed: ${result.error} The saved watchlist is unchanged.`);
    return;
  }
  if (interaction.commandName === "watchliststatus") {
    const summary = watchlist.summary();
    await interaction.reply({ content: `Tracking: ${summary.tracked} | Agency: ${summary.agency} | Manual: ${summary.manual} | Excluded: ${summary.excluded}\nLast successful sync: ${summary.lastSuccess || 'Never'}\nStatus: ${summary.error || 'Healthy'}`, ephemeral: true });
    return;
  }
  if (interaction.commandName === "checknow") {
    await interaction.deferReply({ ephemeral: true });
    await checkAllMembers(client);
    await interaction.editReply("TikTok LIVE check finished.");
  }
}

async function syncAgencyMembers() {
  const before = new Set(loadMembers().map(m => getMemberKey(m.username)));
  const result = await watchlist.sync();
  if (result.ok) {
    const current = new Set(loadMembers().map(m => getMemberKey(m.username)));
    for (const username of before) if (!current.has(username)) state.delete(username);
    saveNotificationState();
    console.log(`[agency roster] synced; agency=${result.agency}, tracked=${result.tracked}`);
  } else console.warn('[agency roster] ' + result.error + ' Keeping the saved watchlist.');
  return result;
}

async function main() {
  const token = requiredEnv("DISCORD_TOKEN");
  ensureLocalFiles();
  watchlist = new Watchlist({ dataDir: DATA_DIR });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });
  const agencyVideos = new AgencyVideos({ dataDir: DATA_DIR, loadConfig });
  const checkAgencyVideos = () => agencyVideos.check(client).catch(error => console.error('[agency videos]', error.message));

  client.once("ready", async () => {
    console.log(`FT Notifier logged in as ${client.user.tag}`);
    await registerCommands(client);

    await syncAgencyMembers();
    setInterval(() => syncAgencyMembers().catch(() => console.error("[agency roster] Sync failed; saved list retained.")), 60000);
    await checkAgencyVideos();
    setInterval(checkAgencyVideos, CHECK_INTERVAL_SECONDS * 1000);

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

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exit(1);
});
module.exports = { getCommands };
