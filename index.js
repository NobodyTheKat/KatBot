require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// --------------------------------------------------
// AUTOMATIC GITHUB UPDATE
// --------------------------------------------------

if (
  process.env.KATBOT_UPDATE_CHECKED !== '1' &&
  process.env.KATBOT_AUTO_UPDATE !== 'false' &&
  fs.existsSync(path.join(__dirname, '.git'))
) {
  const git = args => spawnSync('git', args, {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 60000,
  });

  try {
    const branch = (
      process.env.GITHUB_BRANCH ||
      git(['branch', '--show-current']).stdout ||
      'main'
    ).trim();

    const fetch = git(['fetch', 'origin', branch]);

    if (fetch.status !== 0) {
      throw new Error(fetch.stderr || 'Git fetch failed');
    }

    const local = git(['rev-parse', 'HEAD']).stdout.trim();
    const remote = git(['rev-parse', `origin/${branch}`]).stdout.trim();

    if (local && remote && local !== remote) {
      const changed = git([
        'diff', '--name-only', 'HEAD', `origin/${branch}`,
      ]);

      if (changed.status !== 0) {
        throw new Error('Could not inspect the update');
      }

      const packageChanged = changed.stdout
        .split(/\r?\n/)
        .some(file =>
          ['package.json', 'package-lock.json'].includes(file)
        );

      const update = git(['merge', '--ff-only', `origin/${branch}`]);

      if (update.status !== 0) {
        throw new Error(
          update.stderr || 'Update refused because local changes exist'
        );
      }

      console.log(
        `[Updater] Updated ${local.slice(0, 7)} -> ${remote.slice(0, 7)}`
      );

      if (packageChanged) {
        const install = spawnSync('npm', ['ci'], {
          cwd: __dirname,
          stdio: 'inherit',
          timeout: 180000,
        });

        if (install.status !== 0) {
          throw new Error('npm ci failed');
        }
      }

      const child = spawnSync(process.execPath, [__filename], {
        cwd: __dirname,
        stdio: 'inherit',
        env: {
          ...process.env,
          KATBOT_UPDATE_CHECKED: '1',
        },
      });

      process.exit(child.status ?? 1);
    }

    console.log('[Updater] KatBot is up to date.');
  } catch (error) {
    console.error('[Updater] Startup update check failed:', error.message);
  }
}

// --------------------------------------------------
// DISCORD
// --------------------------------------------------

const {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing from .env.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

const rest = new REST({ version: '10' })
  .setToken(process.env.DISCORD_TOKEN);

// --------------------------------------------------
// SAVED SETTINGS
// --------------------------------------------------

const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'settings.json');

fs.mkdirSync(dataDir, { recursive: true });

function loadData() {
  try {
    if (!fs.existsSync(dataFile)) {
      fs.writeFileSync(dataFile, '{}', 'utf8');
    }

    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (error) {
    console.error('Could not load settings:', error.message);
    return {};
  }
}

const settings = loadData();

function saveData() {
  const temporaryFile = `${dataFile}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(settings, null, 2),
    'utf8'
  );

  fs.renameSync(temporaryFile, dataFile);
}

function getSettings(guildId) {
  if (!settings[guildId]) {
    settings[guildId] = {
      welcomeEnabled: false,
      welcomeMessage: '',
      statuses: [],
      statusInterval: 60,
      customCommands: {},
    };

    saveData();
  }

  const config = settings[guildId];

  if (typeof config.welcomeEnabled !== 'boolean') {
    config.welcomeEnabled = false;
  }

  if (typeof config.welcomeMessage !== 'string') {
    config.welcomeMessage = '';
  }

  if (!Array.isArray(config.statuses)) {
    config.statuses = [];
  }

  if (!Number.isInteger(config.statusInterval)) {
    config.statusInterval = 60;
  }

  if (
    !config.customCommands ||
    typeof config.customCommands !== 'object'
  ) {
    config.customCommands = {};
  }

  return config;
}

// --------------------------------------------------
// PLACEHOLDERS
// --------------------------------------------------

const placeholderHelp = [
  '`{user}` — username',
  '`{user.mention}` — mention the user',
  '`{user.id}` — user ID',
  '`{user.tag}` — username and tag, when available',
  '`{username}` — username',
  '`{server}` — server name',
  '`{server.id}` — server ID',
  '`{server.members}` — member count',
  '`{server.owner}` — server owner mention',
  '`{channel}` — channel name',
  '`{channel.mention}` — channel mention',
  '`{date}` — current date',
  '`{time}` — current time',
  '`{timestamp}` — Unix timestamp',
  '`{bot}` — bot username',
].join('\n');

function replacePlaceholders(text, context) {
  const guild = context.guild || null;
  const user = context.user || null;
  const channel = context.channel || null;
  const now = new Date();

  const replacements = {
    '{user}': user?.username || '',
    '{user.mention}': user?.id ? `<@${user.id}>` : '',
    '{user.id}': user?.id || '',
    '{user.tag}': user?.tag || user?.username || '',
    '{username}': user?.username || '',
    '{server}': guild?.name || '',
    '{server.id}': guild?.id || '',
    '{server.members}': String(guild?.memberCount ?? 0),
    '{server.owner}': guild?.ownerId
      ? `<@${guild.ownerId}>`
      : '',
    '{channel}': channel?.name || '',
    '{channel.mention}': channel?.id
      ? `<#${channel.id}>`
      : '',
    '{date}': now.toLocaleDateString('en-GB'),
    '{time}': now.toLocaleTimeString('en-GB', {
      hour12: false,
    }),
    '{timestamp}': String(Math.floor(now.getTime() / 1000)),
    '{bot}': client.user?.username || 'KatBot',
  };

  return String(text || '').replace(
    /\{user\.mention\}|\{user\.id\}|\{user\.tag\}|\{server\.members\}|\{server\.owner\}|\{server\.id\}|\{channel\.mention\}|\{timestamp\}|\{username\}|\{server\}|\{channel\}|\{user\}|\{time\}|\{date\}|\{bot\}/g,
    match => replacements[match] ?? match
  );
}

// --------------------------------------------------
// COLORS AND MESSAGE STYLES
// --------------------------------------------------

const embedPresets = {
  plain: { label: 'Plain Text (no embed)', color: null },
  blurple: { label: 'Discord Blurple', color: '#5865F2' },
  red: { label: 'Red', color: '#ED4245' },
  orange: { label: 'Orange', color: '#F97316' },
  yellow: { label: 'Yellow', color: '#FEE75C' },
  green: { label: 'Green', color: '#57F287' },
  cyan: { label: 'Cyan', color: '#00D9FF' },
  blue: { label: 'Blue', color: '#3498DB' },
  purple: { label: 'Purple', color: '#9B59B6' },
  pink: { label: 'Pink', color: '#EB459E' },
  dark: { label: 'Dark', color: '#232428' },
  none: { label: 'Embed without color', color: null },
};

function presetSelectRow(customId, currentColor) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose Plain Text or an embed color')
      .addOptions(
        Object.entries(embedPresets).map(([value, preset]) => ({
          label: preset.label,
          value,
          description: value === 'plain'
            ? 'Normal message without an embed'
            : (preset.color || 'Embed without a color'),
          default: value === 'plain'
            ? currentColor === '__plain__'
            : (
                preset.color === currentColor ||
                (!currentColor && value === 'none')
              ),
        }))
      )
  );
}

function colorToNumber(color) {
  if (typeof color !== 'string') return null;

  if (!/^#?[0-9a-f]{6}$/i.test(color)) return null;

  return parseInt(color.replace('#', ''), 16);
}

// --------------------------------------------------
// COMMAND REGISTRATION
// --------------------------------------------------

const baseCommands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether KatBot is online'),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Open the KatBot configuration panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

function cleanCommandName(input) {
  return input.toLowerCase().trim()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

function isValidCommandName(name) {
  return /^[a-z0-9_-]{1,32}$/.test(name) &&
    !['setup', 'ping'].includes(name);
}

let syncingGuilds = Promise.resolve();

async function syncGuildCustomCommands(guildId) {
  const commands = Object.entries(getSettings(guildId).customCommands)
    .filter(([name, data]) =>
      isValidCommandName(name) &&
      data &&
      typeof data === 'object'
    )
    .slice(0, 100)
    .map(([name]) =>
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(`KatBot custom command: ${name}`.slice(0, 100))
        .toJSON()
    );

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: commands }
  );
}

function queueGuildCommandSync(guildId) {
  syncingGuilds = syncingGuilds
    .then(() => syncGuildCustomCommands(guildId))
    .catch(error => console.error('Command sync error:', error.message));

  return syncingGuilds;
}

async function syncAllGuildCustomCommands() {
  for (const guild of client.guilds.cache.values()) {
    await syncGuildCustomCommands(guild.id);
  }
}

// --------------------------------------------------
// BOT STATUSES
// --------------------------------------------------

const activityTypes = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
};

const activityLabels = {
  playing: 'Playing',
  watching: 'Watching',
  listening: 'Listening to',
  competing: 'Competing in',
};

let statusTimer = null;
let statusIndex = 0;

function rotateStatus() {
  if (!client.user) return;

  const statuses = [
    ...new Map(
      Object.values(settings)
        .flatMap(server => server.statuses || [])
        .map(item => [`${item.type}:${item.text}`, item])
    ).values(),
  ];

  if (statuses.length) {
    const status = statuses[statusIndex % statuses.length];

    statusIndex = (statusIndex + 1) % statuses.length;

    client.user.setActivity(status.text, {
      type: activityTypes[status.type] ?? ActivityType.Playing,
    });
  } else {
    client.user.setActivity(null);
  }

  clearTimeout(statusTimer);

  const intervals = Object.values(settings)
    .map(server => Number(server.statusInterval) || 60);

  const seconds = intervals.length
    ? Math.max(30, Math.min(...intervals, 3600))
    : 60;

  statusTimer = setTimeout(rotateStatus, seconds * 1000);
}

function refreshStatusNow() {
  clearTimeout(statusTimer);
  statusIndex = 0;
  rotateStatus();
}

// --------------------------------------------------
// SETUP PANEL HELPERS
// --------------------------------------------------

function panelEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(title)
    .setDescription(description)
    .setFooter({
      text: 'KatBot • Changes are saved automatically',
    });
}

function mainPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('setup_welcome')
        .setLabel('Welcome')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('setup_statuses')
        .setLabel('Bot Statuses')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('setup_commands')
        .setLabel('Custom Commands')
        .setStyle(ButtonStyle.Primary)
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('setup_refresh')
        .setLabel('Refresh Panel')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function welcomePanel(guildId) {
  const config = getSettings(guildId);

  return {
    embeds: [
      panelEmbed(
        'Welcome Settings',
        `**Welcome DMs:** ${config.welcomeEnabled ? 'Enabled' : 'Disabled'}\n` +
        `**Message:** ${config.welcomeMessage || '(not configured)'}\n\n` +
        '**Available placeholders:**\n' +
        '`{user}`, `{server}`'
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('welcome_toggle')
          .setLabel(config.welcomeEnabled ? 'Disable DMs' : 'Enable DMs')
          .setStyle(
            config.welcomeEnabled
              ? ButtonStyle.Danger
              : ButtonStyle.Success
          ),

        new ButtonBuilder()
          .setCustomId('welcome_edit')
          .setLabel('Edit Message')
          .setStyle(ButtonStyle.Primary)
      ),

      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('setup_home')
          .setLabel('Back to Panel')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

function statusesPanel(guildId) {
  const config = getSettings(guildId);

  const list = config.statuses.length
    ? config.statuses.map((status, index) =>
      `**${index + 1}.** ${activityLabels[status.type] || status.type} **${status.text}**`
    ).join('\n')
    : 'No activities have been added.';

  return {
    embeds: [
      panelEmbed(
        'Bot Statuses',
        `${list}\n\n**Rotation interval:** ${config.statusInterval} seconds`
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('status_add')
          .setLabel('Add Activity')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId('status_edit_select')
          .setLabel('Edit Activity')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(config.statuses.length === 0),

        new ButtonBuilder()
          .setCustomId('status_delete_select')
          .setLabel('Delete Activity')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(config.statuses.length === 0)
      ),

      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('status_interval_edit')
          .setLabel('Change Interval')
          .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
          .setCustomId('setup_home')
          .setLabel('Back to Panel')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

function commandsPanel(guildId) {
  const entries = Object.entries(getSettings(guildId).customCommands);

  const list = entries.length
    ? entries.map(([name, data]) =>
      `**/${name}** · ${data.style === 'plain' ? 'Plain Text' : (data.title || 'No title')}`
    ).join('\n')
    : 'No custom commands have been created yet.';

  return {
    embeds: [
      panelEmbed(
        'Custom Commands',
        `${list}\n\nCreate, edit or delete slash commands. Changes are saved automatically.`
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('custom_add')
          .setLabel('Create Command')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId('custom_edit_select')
          .setLabel('Edit Command')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(entries.length === 0),

        new ButtonBuilder()
          .setCustomId('custom_delete_select')
          .setLabel('Delete Command')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(entries.length === 0)
      ),

      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('setup_home')
          .setLabel('Back to Panel')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

function statusSelectRow(guildId, customId) {
  const statuses = getSettings(guildId).statuses;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose an activity')
      .addOptions(
        statuses.slice(0, 25).map((status, index) => ({
          label: `${index + 1}. ${status.text}`.slice(0, 100),
          description: (
            activityLabels[status.type] || status.type
          ).slice(0, 100),
          value: String(index),
        }))
      )
  );
}

function commandSelectRow(guildId, customId) {
  const commands = Object.entries(
    getSettings(guildId).customCommands
  ).slice(0, 25);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose a command')
      .addOptions(
        commands.map(([name]) => ({
          label: `/${name}`.slice(0, 100),
          value: name,
        }))
      )
  );
}

// --------------------------------------------------
// MODALS
// --------------------------------------------------

function statusModal(customId, title, status = null) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  const typeInput = new TextInputBuilder()
    .setCustomId('activity_type')
    .setLabel('playing, watching, listening, competing')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20)
    .setValue(status?.type || 'watching');

  const textInput = new TextInputBuilder()
    .setCustomId('activity_text')
    .setLabel('Activity text')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(128)
    .setValue(status?.text || '');

  return modal.addComponents(
    new ActionRowBuilder().addComponents(typeInput),
    new ActionRowBuilder().addComponents(textInput)
  );
}

function customCommandModal(customId, title, data = null) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  const nameInput = new TextInputBuilder()
    .setCustomId('command_name')
    .setLabel('Command name (no slash)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setValue(data?.name || '');

  const titleInput = new TextInputBuilder()
    .setCustomId('command_title')
    .setLabel('Embed title (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(256)
    .setValue(data?.title || '');

  const messageInput = new TextInputBuilder()
    .setCustomId('command_message')
    .setLabel('Message')
    .setPlaceholder('Write your message here')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setValue(data?.description || '');

  return modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(messageInput)
  );
}

async function showHome(interaction, update = false) {
  const payload = {
    embeds: [
      panelEmbed(
        'KatBot • Setup',
        'Choose a section to configure. Changes are saved automatically and applied without restarting KatBot.'
      ),
    ],
    components: mainPanelRows(),
  };

  return update
    ? interaction.update(payload)
    : interaction.reply({
        ...payload,
        flags: MessageFlags.Ephemeral,
      });
}

// --------------------------------------------------
// READY AND GUILD EVENTS
// --------------------------------------------------

client.once(Events.ClientReady, async readyClient => {
  console.log(`KatBot online as ${readyClient.user.tag}`);

  try {
    await rest.put(
      Routes.applicationCommands(readyClient.user.id),
      { body: baseCommands.map(command => command.toJSON()) }
    );

    await syncAllGuildCustomCommands();

    console.log('Base and custom commands synchronized.');
  } catch (error) {
    console.error('Command registration error:', error);
  }

  refreshStatusNow();
});

client.on(Events.GuildCreate, async guild => {
  getSettings(guild.id);
  await queueGuildCommandSync(guild.id);
  refreshStatusNow();
});

client.on(Events.GuildMemberAdd, async member => {
  const config = getSettings(member.guild.id);

  if (!config.welcomeEnabled || !config.welcomeMessage) return;

  const message = replacePlaceholders(config.welcomeMessage, {
    guild: member.guild,
    user: member.user,
    channel: null,
  });

  try {
    await member.send({
      content: message.slice(0, 2000),
      allowedMentions: { parse: [] },
    });
  } catch {
    console.log(`Could not DM ${member.user.tag}.`);
  }
});

// --------------------------------------------------
// INTERACTIONS
// --------------------------------------------------

client.on(Events.InteractionCreate, async interaction => {
  try {
    // ----------------------------------------------
    // SLASH COMMANDS
    // ----------------------------------------------

    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === 'ping') {
        return interaction.reply({
          content: `Pong! ${client.ws.ping} ms`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!interaction.guildId) {
        return interaction.reply({
          content: 'Use this command in a server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (name === 'setup') {
        if (
          !interaction.memberPermissions?.has(
            PermissionFlagsBits.ManageGuild
          )
        ) {
          return interaction.reply({
            content: 'You need Manage Server permission to configure KatBot.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return showHome(interaction);
      }

      const data = getSettings(interaction.guildId).customCommands[name];

      if (!data || typeof data !== 'object') return;

      if (data.style === 'plain') {
        return interaction.reply({
          content: replacePlaceholders(data.description || '', interaction).slice(0, 2000),
          allowedMentions: {
            parse: [],
            users: [],
            roles: [],
            repliedUser: false,
          },
        });
      }

      const embed = new EmbedBuilder();

      if (data.title) {
        embed.setTitle(
          replacePlaceholders(data.title, interaction).slice(0, 256)
        );
      }

      if (data.description) {
        embed.setDescription(
          replacePlaceholders(data.description, interaction).slice(0, 4096)
        );
      }

      const color = colorToNumber(data.color);

      if (color !== null) {
        embed.setColor(color);
      }

      const payload = {
        allowedMentions: {
          parse: [],
          users: [],
          roles: [],
          repliedUser: false,
        },
      };

      if (data.title || data.description) {
        payload.embeds = [embed];
      } else {
        payload.content = 'This command has no message configured.';
      }

      return interaction.reply(payload);
    }

    // ----------------------------------------------
    // BUTTONS
    // ----------------------------------------------

    if (interaction.isButton()) {
      if (!interaction.guildId) {
        return interaction.reply({
          content: 'Use this panel in a server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.ManageGuild
        )
      ) {
        return interaction.reply({
          content: 'You need Manage Server permission to configure KatBot.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const id = interaction.customId;
      const guildId = interaction.guildId;

      if (id === 'setup_refresh' || id === 'setup_home') {
        return showHome(interaction, true);
      }

      if (id === 'setup_welcome') {
        return interaction.reply({
          ...welcomePanel(guildId),
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'setup_statuses') {
        return interaction.reply({
          ...statusesPanel(guildId),
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'setup_commands') {
        return interaction.reply({
          ...commandsPanel(guildId),
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'welcome_toggle') {
        const config = getSettings(guildId);

        config.welcomeEnabled = !config.welcomeEnabled;
        saveData();

        return interaction.update(welcomePanel(guildId));
      }

      if (id === 'welcome_edit') {
        const config = getSettings(guildId);

        const modal = new ModalBuilder()
          .setCustomId('welcome_modal')
          .setTitle('Welcome Message');

        const input = new TextInputBuilder()
          .setCustomId('welcome_message')
          .setLabel('Welcome message')
          .setPlaceholder('Use {user} and {server}')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1900)
          .setValue(config.welcomeMessage);

        modal.addComponents(
          new ActionRowBuilder().addComponents(input)
        );

        return interaction.showModal(modal);
      }

      if (id === 'status_add') {
        return interaction.showModal(
          statusModal('status_add_modal', 'Add Activity')
        );
      }

      if (id === 'status_interval_edit') {
        const config = getSettings(guildId);

        const modal = new ModalBuilder()
          .setCustomId('status_interval_modal')
          .setTitle('Rotation Interval');

        const input = new TextInputBuilder()
          .setCustomId('interval_seconds')
          .setLabel('Seconds (30–3600)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4)
          .setValue(String(config.statusInterval));

        modal.addComponents(
          new ActionRowBuilder().addComponents(input)
        );

        return interaction.showModal(modal);
      }

      if (
        id === 'status_edit_select' ||
        id === 'status_delete_select'
      ) {
        const edit = id === 'status_edit_select';

        return interaction.reply({
          content: edit
            ? 'Choose an activity to edit:'
            : 'Choose an activity to delete:',
          components: [
            statusSelectRow(
              guildId,
              edit ? 'status_edit_pick' : 'status_delete_pick'
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'custom_add') {
        return interaction.reply({
          content: '**Available placeholders:**\n' +
            placeholderHelp +
            '\n\nChoose **Plain Text** for a normal message without an embed, or choose a color for an embed. All custom-command responses are public.',
          components: [presetSelectRow('custom_add_preset')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (
        id === 'custom_edit_select' ||
        id === 'custom_delete_select'
      ) {
        const edit = id === 'custom_edit_select';

        return interaction.reply({
          content: edit
            ? 'Choose a command to edit:'
            : 'Choose a command to delete:',
          components: [
            commandSelectRow(
              guildId,
              edit ? 'custom_edit_pick' : 'custom_delete_pick'
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // ----------------------------------------------
    // SELECT MENUS
    // ----------------------------------------------

    if (interaction.isStringSelectMenu()) {
      if (
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.ManageGuild
        )
      ) {
        return interaction.reply({
          content: 'You need Manage Server permission to configure KatBot.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const guildId = interaction.guildId;
      const id = interaction.customId;

      if (!guildId) {
        return interaction.reply({
          content: 'Use this panel in a server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'custom_add_preset') {
        const presetKey = interaction.values[0];
        const preset = embedPresets[presetKey];

        if (!preset) {
          return interaction.reply({
            content: 'Invalid message style or color selection.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.showModal(
          customCommandModal(
            `custom_add_modal:${presetKey}`,
            'Create Command'
          )
        );
      }

      if (id.startsWith('custom_edit_preset:')) {
        const name = id.slice('custom_edit_preset:'.length);
        const data = getSettings(guildId).customCommands[name];
        const presetKey = interaction.values[0];

        if (!data || !embedPresets[presetKey]) {
          return interaction.reply({
            content: 'Command or color not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.showModal(
          customCommandModal(
            `custom_edit_modal:${name}:${presetKey}`,
            'Edit Command',
            {
              name,
              title: data.title || '',
              description: data.description || '',
            }
          )
        );
      }

      if (id === 'status_edit_pick') {
        const index = Number(interaction.values[0]);
        const status = getSettings(guildId).statuses[index];

        if (!status) {
          return interaction.reply({
            content: 'Activity not found. Reopen the section.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.showModal(
          statusModal(
            `status_edit_modal:${index}`,
            'Edit Activity',
            status
          )
        );
      }

      if (id === 'status_delete_pick') {
        const index = Number(interaction.values[0]);
        const config = getSettings(guildId);

        if (!config.statuses[index]) {
          return interaction.reply({
            content: 'Activity not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const removed = config.statuses.splice(index, 1)[0];

        saveData();
        refreshStatusNow();

        return interaction.update({
          content: `Activity deleted: ${removed.text}`,
          components: [],
        });
      }

      if (id === 'custom_edit_pick') {
        const name = interaction.values[0];
        const data = getSettings(guildId).customCommands[name];

        if (!data) {
          return interaction.reply({
            content: 'Command not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: `Edit /${name}.\n\n**Available placeholders:**\n${placeholderHelp}\n\nChoose Plain Text or an embed color.`,
          components: [
            presetSelectRow(
              `custom_edit_preset:${name}`,
              data.style === 'plain' ? '__plain__' : data.color
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'custom_delete_pick') {
        const name = interaction.values[0];
        const config = getSettings(guildId);

        if (!Object.hasOwn(config.customCommands, name)) {
          return interaction.reply({
            content: 'Command not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        delete config.customCommands[name];

        saveData();
        await queueGuildCommandSync(guildId);

        return interaction.update({
          content: `Command /${name} deleted.`,
          components: [],
        });
      }
    }

    // ----------------------------------------------
    // MODAL SUBMISSIONS
    // ----------------------------------------------

    if (interaction.isModalSubmit()) {
      if (!interaction.guildId) {
        return interaction.reply({
          content: 'Use this panel in a server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.ManageGuild
        )
      ) {
        return interaction.reply({
          content: 'You need Manage Server permission to configure KatBot.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const guildId = interaction.guildId;
      const config = getSettings(guildId);
      const id = interaction.customId;

      if (id === 'welcome_modal') {
        config.welcomeMessage = interaction.fields
          .getTextInputValue('welcome_message')
          .trim();

        saveData();

        return interaction.reply({
          content: 'Welcome message saved.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'status_interval_modal') {
        const seconds = Number(
          interaction.fields.getTextInputValue('interval_seconds')
        );

        if (
          !Number.isInteger(seconds) ||
          seconds < 30 ||
          seconds > 3600
        ) {
          return interaction.reply({
            content: 'Enter a whole number between 30 and 3600.',
            flags: MessageFlags.Ephemeral,
          });
        }

        config.statusInterval = seconds;

        saveData();
        refreshStatusNow();

        return interaction.reply({
          content: `Rotation interval saved: ${seconds} seconds.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (
        id === 'status_add_modal' ||
        id.startsWith('status_edit_modal:')
      ) {
        const type = interaction.fields
          .getTextInputValue('activity_type')
          .trim()
          .toLowerCase();

        const text = interaction.fields
          .getTextInputValue('activity_text')
          .trim();

        if (!Object.hasOwn(activityTypes, type)) {
          return interaction.reply({
            content: 'Use playing, watching, listening, or competing.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!text || text.length > 128) {
          return interaction.reply({
            content: 'Activity text must contain 1–128 characters.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (id === 'status_add_modal') {
          config.statuses.push({ type, text });
        } else {
          const index = Number(id.split(':')[1]);

          if (!config.statuses[index]) {
            return interaction.reply({
              content: 'Activity not found. Reopen the section.',
              flags: MessageFlags.Ephemeral,
            });
          }

          config.statuses[index] = { type, text };
        }

        saveData();
        refreshStatusNow();

        return interaction.reply({
          content: 'Activity saved and applied without restarting KatBot.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (
        id.startsWith('custom_add_modal:') ||
        id.startsWith('custom_edit_modal:')
      ) {
        const isEdit = id.startsWith('custom_edit_modal:');
        const parts = id.split(':');

        const oldName = isEdit ? parts[1] : null;
        const presetKey = isEdit ? parts[2] : parts[1];
        const preset = embedPresets[presetKey];

        if (!preset) {
          return interaction.reply({
            content: 'Invalid message style or color selection. Please start again.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const rawName = interaction.fields
          .getTextInputValue('command_name');

        const name = cleanCommandName(rawName);

        const title = interaction.fields
          .getTextInputValue('command_title')
          .trim();

        const description = interaction.fields
          .getTextInputValue('command_message')
          .trim();

        // THE ONLY CHANGE: compare the trimmed input in lowercase,
        // so uppercase command names are accepted and saved in lowercase.
        if (
          !isValidCommandName(name) ||
          rawName.trim().toLowerCase() !== name
        ) {
          return interaction.reply({
            content: 'Use letters, numbers, hyphens or underscores. /setup and /ping are reserved.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!description) {
          return interaction.reply({
            content: 'Please write a message before saving.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (title.length > 256 || description.length > 4096) {
          return interaction.reply({
            content: 'The title limit is 256 characters and the message limit is 4096.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (
          !isEdit &&
          Object.hasOwn(config.customCommands, name)
        ) {
          return interaction.reply({
            content: `/${name} already exists. Use Edit Command.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (
          oldName &&
          oldName !== name &&
          Object.hasOwn(config.customCommands, name)
        ) {
          return interaction.reply({
            content: `/${name} already exists.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (
          !Object.hasOwn(config.customCommands, name) &&
          Object.keys(config.customCommands).length >= 100
        ) {
          return interaction.reply({
            content: 'The server has reached the limit of 100 custom commands.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (oldName && oldName !== name) {
          delete config.customCommands[oldName];
        }

        config.customCommands[name] = presetKey === 'plain'
          ? {
              style: 'plain',
              title: '',
              description,
              color: null,
            }
          : {
              style: 'embed',
              title,
              description,
              color: preset.color,
            };

        saveData();
        await queueGuildCommandSync(guildId);

        return interaction.reply({
          content: `/${name} saved. Changes are applied without restarting KatBot.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  } catch (error) {
    console.error('Error handling interaction:', error);

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content: 'An error occurred. Check the terminal for details.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
});

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

client.login(process.env.DISCORD_TOKEN);
