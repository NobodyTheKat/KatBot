require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
    if (fetch.status !== 0) throw new Error(fetch.stderr || 'Fetch failed');

    const local = git(['rev-parse', 'HEAD']).stdout.trim();
    const remote = git(['rev-parse', `origin/${branch}`]).stdout.trim();

    if (local && remote && local !== remote) {
      const changed = git([
        'diff', '--name-only', 'HEAD', `origin/${branch}`,
      ]);

      if (changed.status !== 0) {
        throw new Error(changed.stderr || 'Could not inspect update');
      }

      const packageChanged = changed.stdout
        .split(/\r?\n/)
        .some(file => [
          'package.json',
          'package-lock.json',
        ].includes(file));

      const pull = git(['merge', '--ff-only', `origin/${branch}`]);

      if (pull.status !== 0) {
        throw new Error(
          pull.stderr || 'Update refused; local changes may exist'
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
      welcomeEnabled: true,
      welcomeMessage: 'Welcome {user} to {server}!',
      statuses: [
        { type: 'watching', text: 'the community' },
        { type: 'playing', text: 'Minecraft' },
      ],
      statusInterval: 60,
      customCommands: {},
    };

    saveData();
  }

  const config = settings[guildId];

  if (typeof config.welcomeEnabled !== 'boolean') {
    config.welcomeEnabled = true;
  }

  if (typeof config.welcomeMessage !== 'string') {
    config.welcomeMessage = 'Welcome {user} to {server}!';
  }

  if (!Array.isArray(config.statuses)) config.statuses = [];
  if (!Number.isInteger(config.statusInterval)) {
    config.statusInterval = 60;
  }

  if (
    !config.customCommands ||
    typeof config.customCommands !== 'object' ||
    Array.isArray(config.customCommands)
  ) {
    config.customCommands = {};
  }

  return config;
}

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

const embedPresets = {
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
  none: { label: 'No embed color', color: null },
};

const rest = new REST({ version: '10' })
  .setToken(process.env.DISCORD_TOKEN);

const baseCommands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether KatBot is online'),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Open the KatBot configuration panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

let statusTimer = null;
let statusIndex = 0;
let syncingGuilds = Promise.resolve();

function allConfiguredStatuses() {
  return [
    ...new Map(
      Object.values(settings)
        .flatMap(server => server.statuses || [])
        .map(item => [`${item.type}:${item.text}`, item])
    ).values(),
  ];
}

function rotateStatus() {
  if (!client.user) return;

  const statuses = allConfiguredStatuses();

  if (!statuses.length) {
    client.user.setActivity('KatBot', {
      type: ActivityType.Playing,
    });
  } else {
    const status = statuses[statusIndex % statuses.length];

    statusIndex = (statusIndex + 1) % statuses.length;

    client.user.setActivity(status.text, {
      type: activityTypes[status.type] ?? ActivityType.Playing,
    });
  }

  clearTimeout(statusTimer);

  const intervals = Object.values(settings)
    .map(server => Number(server.statusInterval) || 60);

  const interval = Math.max(30, Math.min(...intervals, 3600));

  statusTimer = setTimeout(rotateStatus, interval * 1000);
}

function refreshStatusNow() {
  clearTimeout(statusTimer);
  statusIndex = 0;
  rotateStatus();
}

function cleanCommandName(input) {
  return input.toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

function isValidCommandName(name) {
  return /^[a-z0-9_-]{1,32}$/.test(name) &&
    !['setup', 'ping'].includes(name);
}

async function syncGuildCustomCommands(guildId) {
  const commands = Object.entries(getSettings(guildId).customCommands)
    .filter(([name, response]) =>
      isValidCommandName(name) && typeof response === 'string'
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
        `**Current message:**\n${config.welcomeMessage}\n\n` +
        'Available placeholders: `{user}`, `{server}`, `{bot}`, `{date}`, `{time}`.'
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

function getStoredCommandData(response) {
  try {
    const parsed = JSON.parse(response);

    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return {
        message: typeof parsed.message === 'string'
          ? parsed.message
          : typeof parsed.content === 'string'
            ? parsed.content
            : '',

        color: parsed.color ?? null,

        visibility: parsed.visibility === 'private'
          ? 'private'
          : 'public',
      };
    }
  } catch {}

  // Support commands saved by older versions.
  return {
    message: typeof response === 'string' ? response : '',
    color: null,
    visibility: 'public',
  };
}

function replacePlaceholders(text, context) {
  const guild = context.guild;
  const user = context.user;
  const channel = context.channel;
  const now = new Date();

  const replacements = {
    '{user}': user?.username || 'Unknown user',
    '{user.mention}': user ? `<@${user.id}>` : '',
    '{user.id}': user?.id || '',
    '{user.tag}': user?.tag || user?.username || 'Unknown user',
    '{username}': user?.username || 'Unknown user',
    '{server}': guild?.name || 'Direct Message',
    '{server.id}': guild?.id || '',
    '{server.members}': String(guild?.memberCount ?? 0),
    '{server.owner}': guild?.ownerId ? `<@${guild.ownerId}>` : 'Unknown',
    '{channel}': channel?.name || 'Unknown',
    '{channel.mention}': channel?.id ? `<#${channel.id}>` : '',
    '{date}': now.toLocaleDateString('en-GB'),
    '{time}': now.toLocaleTimeString('en-GB', { hour12: false }),
    '{timestamp}': String(Math.floor(now.getTime() / 1000)),
    '{bot}': client.user?.username || 'KatBot',
  };

  return String(text || '').replace(
    /\{user\.mention\}|\{user\.id\}|\{user\.tag\}|\{server\.members\}|\{server\.owner\}|\{server\.id\}|\{channel\.mention\}|\{timestamp\}|\{username\}|\{server\}|\{channel\}|\{user\}|\{time\}|\{date\}|\{bot\}/g,
    match => replacements[match] ?? match
  );
}

function normalizeEmbedColor(color) {
  if (typeof color === 'string') {
    if (!/^#?[0-9a-f]{6}$/i.test(color)) return null;

    return parseInt(color.replace('#', ''), 16);
  }

  if (
    Number.isInteger(color) &&
    color >= 0 &&
    color <= 0xFFFFFF
  ) {
    return color;
  }

  return null;
}

function renderCustomResponse(response, interaction) {
  const data = getStoredCommandData(response);

  const message = replacePlaceholders(
    data.message,
    interaction
  ).trim();

  const payload = {};

  if (message) {
    payload.embeds = [
      new EmbedBuilder()
        .setDescription(message.slice(0, 4096)),
    ];

    const color = normalizeEmbedColor(data.color);

    if (color !== null) {
      payload.embeds[0].setColor(color);
    }
  } else {
    payload.content = 'This command has no message configured.';
  }

  payload.allowedMentions = {
    parse: [],
    users: [],
    roles: [],
    repliedUser: false,
  };

  return {
    payload,
    visibility: data.visibility,
  };
}

function commandsPanel(guildId) {
  const entries = Object.entries(
    getSettings(guildId).customCommands
  );

  const list = entries.length
    ? entries.map(([name, response]) => {
      const data = getStoredCommandData(response);
      const preview = data.message || '(empty message)';

      return `**/${name}** · ${data.visibility === 'private' ? 'Private' : 'Public'} · ${preview.slice(0, 55)}`;
    }).join('\n')
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

function presetSelectRow(customId, currentColor = null) {
  const selected = Object.entries(embedPresets).find(
    ([, preset]) =>
      preset.color &&
      preset.color.toLowerCase() ===
        String(currentColor || '').toLowerCase()
  )?.[0] || (currentColor === null ? 'blurple' : 'none');

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose an embed color')
      .addOptions(
        Object.entries(embedPresets).map(([value, preset]) => ({
          label: preset.label,
          value,
          description: preset.color || 'No color',
          default: value === selected,
        }))
      )
  );
}

function visibilitySelectRow(customId, currentVisibility = 'public') {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose response visibility')
      .addOptions([
        {
          label: 'Public response',
          description: 'Everyone in the channel can see it.',
          value: 'public',
          default: currentVisibility !== 'private',
        },
        {
          label: 'Private response',
          description: 'Only you can see the response.',
          value: 'private',
          default: currentVisibility === 'private',
        },
      ])
  );
}

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

function customCommandModal(
  customId,
  title,
  name = '',
  message = ''
) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  const nameInput = new TextInputBuilder()
    .setCustomId('command_name')
    .setLabel('Command name (no slash)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32);

  if (name) nameInput.setValue(name);

  const messageInput = new TextInputBuilder()
    .setCustomId('command_message')
    .setLabel('Message (placeholders listed below)')
    .setPlaceholder(
      'Example: Hello {user.mention}, welcome to {server}!'
    )
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000);

  if (message) messageInput.setValue(message);

  const reminder = new TextInputBuilder()
    .setCustomId('placeholder_reminder')
    .setLabel('PLACEHOLDER REMINDER — read this')
    .setPlaceholder(
      '{user}, {user.mention}, {user.id}, {username}, {server}, {server.members}, {server.owner}, {channel}, {channel.mention}, {date}, {time}, {timestamp}, {bot}'
    )
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100);

  // The reminder field is optional and read-only in purpose:
  // users can see the placeholder list without needing to memorize it.
  // Discord does not support truly read-only modal fields.
  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(messageInput),
    new ActionRowBuilder().addComponents(reminder)
  );

  return modal;
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

client.once(Events.ClientReady, async readyClient => {
  console.log(`KatBot online as ${readyClient.user.tag}`);

  try {
    await rest.put(
      Routes.applicationCommands(readyClient.user.id),
      {
        body: baseCommands.map(command => command.toJSON()),
      }
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

  if (!config.welcomeEnabled) return;

  const message = replacePlaceholders(config.welcomeMessage, {
    guild: member.guild,
    user: member.user,
    channel: null,
  });

  try {
    await member.send(message);
  } catch {
    console.log(`Could not DM ${member.user.tag}.`);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
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

      const response = getSettings(
        interaction.guildId
      ).customCommands[name];

      if (typeof response === 'string') {
        const rendered = renderCustomResponse(
          response,
          interaction
        );

        return interaction.reply({
          ...rendered.payload,
          flags: rendered.visibility === 'private'
            ? MessageFlags.Ephemeral
            : undefined,
        });
      }

      return;
    }

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
          .setLabel('Use {user} and {server} as placeholders')
          .setPlaceholder('Welcome {user} to {server}!')
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
          content: 'Step 1/2 — Choose the embed color:',
          components: [
            presetSelectRow('custom_add_preset'),
          ],
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

      if (!guildId) {
        return interaction.reply({
          content: 'Use this panel in a server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const id = interaction.customId;

      if (id === 'custom_add_preset') {
        const colorKey = interaction.values[0];

        if (!embedPresets[colorKey]) {
          return interaction.reply({
            content: 'Invalid embed color.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.update({
          content: `Color selected: **${embedPresets[colorKey].label}**.\n\nStep 2/2 — Choose response visibility:`,
          components: [
            visibilitySelectRow(`custom_add_visibility:${colorKey}`),
          ],
        });
      }

      if (id.startsWith('custom_add_visibility:')) {
        const colorKey = id.slice('custom_add_visibility:'.length);
        const visibility = interaction.values[0];

        if (!embedPresets[colorKey]) {
          return interaction.reply({
            content: 'Invalid color selection. Start again.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const modal = customCommandModal(
          `custom_add_modal:${colorKey}:${visibility}`,
          'Create Command'
        );

        return interaction.showModal(modal);
      }

      if (id.startsWith('custom_edit_preset:')) {
        const name = id.slice('custom_edit_preset:'.length);
        const response = getSettings(guildId).customCommands[name];

        if (typeof response !== 'string') {
          return interaction.reply({
            content: 'Command not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const colorKey = interaction.values[0];

        if (!embedPresets[colorKey]) {
          return interaction.reply({
            content: 'Invalid embed color.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.update({
          content: `Color selected: **${embedPresets[colorKey].label}**.\n\nChoose response visibility:`,
          components: [
            visibilitySelectRow(
              `custom_edit_visibility:${name}:${colorKey}`,
              getStoredCommandData(response).visibility
            ),
          ],
        });
      }

      if (id.startsWith('custom_edit_visibility:')) {
        const parts = id.split(':');
        const name = parts[1];
        const colorKey = parts[2];
        const visibility = interaction.values[0];
        const response = getSettings(guildId).customCommands[name];

        if (
          !embedPresets[colorKey] ||
          typeof response !== 'string'
        ) {
          return interaction.reply({
            content: 'Command not found. Start again.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const data = getStoredCommandData(response);

        return interaction.showModal(
          customCommandModal(
            `custom_edit_modal:${name}:${colorKey}:${visibility}`,
            'Edit Command',
            name,
            data.message
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
        const response = getSettings(guildId).customCommands[name];

        if (typeof response !== 'string') {
          return interaction.reply({
            content: 'Command not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const data = getStoredCommandData(response);

        return interaction.update({
          content: `Choose an embed color for /${name}:`,
          components: [
            presetSelectRow(
              `custom_edit_preset:${name}`,
              data.color
            ),
          ],
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

        const colorKey = isEdit ? parts[2] : parts[1];
        const visibility = isEdit ? parts[3] : parts[2];
        const oldName = isEdit ? parts[1] : null;

        const rawName = interaction.fields
          .getTextInputValue('command_name');

        const name = cleanCommandName(rawName);

        const message = interaction.fields
          .getTextInputValue('command_message')
          .trim();

        if (!isValidCommandName(name) || rawName.trim() !== name) {
          return interaction.reply({
            content: 'Use lowercase letters, numbers, hyphens or underscores. /setup and /ping are reserved.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!message) {
          return interaction.reply({
            content: 'Write a message before saving the command.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!embedPresets[colorKey]) {
          return interaction.reply({
            content: 'Invalid color selection. Please start again.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!['public', 'private'].includes(visibility)) {
          return interaction.reply({
            content: 'Invalid visibility selection. Please start again.',
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

        if (message.length > 4096) {
          return interaction.reply({
            content: 'The message must contain no more than 4096 characters.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const color = embedPresets[colorKey].color;

        if (oldName && oldName !== name) {
          delete config.customCommands[oldName];
        }

        config.customCommands[name] = JSON.stringify({
          message,
          color,
          visibility,
        });

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

client.login(process.env.DISCORD_TOKEN);
