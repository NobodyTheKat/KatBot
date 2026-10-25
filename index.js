
require('dotenv').config();

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

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

/* -------------------- CONFIGURATION -------------------- */

const TOKEN = process.env.DISCORD_TOKEN;
const BRANCH = (process.env.GITHUB_BRANCH || 'main').trim();
const AUTO_UPDATE = process.env.AUTO_UPDATE !== 'false';

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  welcomeEnabled: true,
  welcomeMessage: 'Hi {user}, welcome to {server}!',
  statuses: [
    { type: 'watching', text: 'the community' },
    { type: 'playing', text: 'Minecraft' },
  ],
  statusInterval: 60,
  customCommands: {},
};

const ACTIVITY_TYPES = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
};

const ACTIVITY_LABELS = {
  playing: 'Playing',
  watching: 'Watching',
  listening: 'Listening',
  competing: 'Competing',
};

const RESERVED_COMMANDS = new Set(['setup', 'ping', 'update']);

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing from .env');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

const rest = new REST({ version: '10' }).setToken(TOKEN);

let settings = {};
let statusTimer = null;
let statusIndex = 0;
let updateRunning = false;
let restartScheduled = false;
let commandSyncQueue = Promise.resolve();

/* -------------------- SETTINGS -------------------- */

function isObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function isValidCommandName(name) {
  return typeof name === 'string' &&
    /^[a-z0-9_-]{1,32}$/.test(name) &&
    !RESERVED_COMMANDS.has(name);
}

function normalizeSettings(raw) {
  const result = isObject(raw) ? raw : {};
  let changed = false;

  for (const [guildId, original] of Object.entries(result)) {
    if (!isObject(original)) {
      result[guildId] = {};
      changed = true;
    }

    const config = result[guildId];

    if (typeof config.welcomeEnabled !== 'boolean') {
      config.welcomeEnabled = DEFAULT_SETTINGS.welcomeEnabled;
      changed = true;
    }

    if (typeof config.welcomeMessage !== 'string') {
      config.welcomeMessage = DEFAULT_SETTINGS.welcomeMessage;
      changed = true;
    }

    if (!Array.isArray(config.statuses)) {
      config.statuses = DEFAULT_SETTINGS.statuses.map(x => ({ ...x }));
      changed = true;
    }

    const validStatuses = config.statuses.filter(item =>
      isObject(item) &&
      typeof item.type === 'string' &&
      Object.hasOwn(ACTIVITY_TYPES, item.type) &&
      typeof item.text === 'string' &&
      item.text.trim().length > 0 &&
      item.text.length <= 128
    );

    if (validStatuses.length !== config.statuses.length) {
      config.statuses = validStatuses;
      changed = true;
    }

    if (config.statuses.length === 0) {
      config.statuses = DEFAULT_SETTINGS.statuses.map(x => ({ ...x }));
      changed = true;
    }

    if (
      !Number.isInteger(config.statusInterval) ||
      config.statusInterval < 30 ||
      config.statusInterval > 3600
    ) {
      config.statusInterval = DEFAULT_SETTINGS.statusInterval;
      changed = true;
    }

    if (!isObject(config.customCommands)) {
      config.customCommands = {};
      changed = true;
    }

    for (const [name, response] of Object.entries(config.customCommands)) {
      if (
        !isValidCommandName(name) ||
        typeof response !== 'string'
      ) {
        delete config.customCommands[name];
        changed = true;
      }
    }
  }

  return { settings: result, changed };
}

function loadSettings() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, '{}', 'utf8');
    }

    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const normalized = normalizeSettings(parsed);

    settings = normalized.settings;

    if (normalized.changed) {
      saveSettings();
    }
  } catch (error) {
    console.error('Could not load settings.json:', error.message);

    // Do not overwrite an existing unreadable file automatically.
    settings = {};
  }
}

function saveSettings() {
  try {
    const temporaryFile = `${DATA_FILE}.tmp`;

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(settings, null, 2),
      'utf8'
    );

    fs.renameSync(temporaryFile, DATA_FILE);
  } catch (error) {
    console.error('Could not save settings:', error.message);
    throw error;
  }
}

function getSettings(guildId) {
  if (!settings[guildId]) {
    settings[guildId] = {
      welcomeEnabled: DEFAULT_SETTINGS.welcomeEnabled,
      welcomeMessage: DEFAULT_SETTINGS.welcomeMessage,
      statuses: DEFAULT_SETTINGS.statuses.map(x => ({ ...x })),
      statusInterval: DEFAULT_SETTINGS.statusInterval,
      customCommands: {},
    };

    saveSettings();
  }

  const config = settings[guildId];

  // Repair malformed values if settings were changed outside the bot.
  if (!isObject(config.customCommands)) {
    config.customCommands = {};
    saveSettings();
  }

  let changed = false;

  for (const [name, response] of Object.entries(config.customCommands)) {
    if (!isValidCommandName(name) || typeof response !== 'string') {
      delete config.customCommands[name];
      changed = true;
    }
  }

  if (changed) saveSettings();

  return config;
}

loadSettings();

/* -------------------- GITHUB UPDATER -------------------- */

function runGit(args) {
  return spawnSync('git', args, {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function gitError(result) {
  return (result.stderr || result.stdout || 'Unknown Git error').trim();
}

function updateFromGitHub() {
  if (updateRunning) {
    return {
      ok: false,
      updated: false,
      message: 'An update is already running.',
    };
  }

  updateRunning = true;

  try {
    const repositoryCheck = runGit(['rev-parse', '--is-inside-work-tree']);

    if (
      repositoryCheck.status !== 0 ||
      repositoryCheck.stdout.trim() !== 'true'
    ) {
      return {
        ok: false,
        updated: false,
        message: 'This folder is not a Git repository.',
      };
    }

    const fetch = runGit(['fetch', 'origin', BRANCH]);

    if (fetch.status !== 0) {
      return {
        ok: false,
        updated: false,
        message: `GitHub fetch failed: ${gitError(fetch)}`,
      };
    }

    const localResult = runGit(['rev-parse', 'HEAD']);
    const remoteResult = runGit(['rev-parse', `origin/${BRANCH}`]);

    if (localResult.status !== 0 || remoteResult.status !== 0) {
      return {
        ok: false,
        updated: false,
        message: 'Could not determine the current Git revisions.',
      };
    }

    const local = localResult.stdout.trim();
    const remote = remoteResult.stdout.trim();

    if (local === remote) {
      return {
        ok: true,
        updated: false,
        message: 'KatBot is already up to date.',
      };
    }

    const ancestor = runGit([
      'merge-base',
      '--is-ancestor',
      'HEAD',
      `origin/${BRANCH}`,
    ]);

    if (ancestor.status !== 0) {
      return {
        ok: false,
        updated: false,
        message:
          'The local branch has diverged from GitHub. No update was applied.',
      };
    }

    // Refuse to overwrite uncommitted tracked changes.
    const dirty = runGit(['status', '--porcelain']);

    if (dirty.status !== 0) {
      return {
        ok: false,
        updated: false,
        message: 'Could not check the working tree.',
      };
    }

    if (dirty.stdout.trim()) {
      return {
        ok: false,
        updated: false,
        message:
          'Local changes were detected. Commit or stash them before updating.',
      };
    }

    const changed = runGit([
      'diff',
      '--name-only',
      'HEAD',
      `origin/${BRANCH}`,
    ]);

    if (changed.status !== 0) {
      return {
        ok: false,
        updated: false,
        message: `Could not inspect changed files: ${gitError(changed)}`,
      };
    }

    const changedFiles = changed.stdout
      .split(/\r?\n/)
      .filter(Boolean);

    const dependenciesChanged = changedFiles.some(file =>
      ['package.json', 'package-lock.json'].includes(file)
    );

    const merge = runGit([
      'merge',
      '--ff-only',
      `origin/${BRANCH}`,
    ]);

    if (merge.status !== 0) {
      return {
        ok: false,
        updated: false,
        message: `Git update failed: ${gitError(merge)}`,
      };
    }

    if (dependenciesChanged) {
      const install = spawnSync('npm', ['ci'], {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
      });

      if (install.status !== 0) {
        return {
          ok: false,
          updated: true,
          message:
            'The source was updated, but npm ci failed. Check dependencies before restarting.',
        };
      }
    }

    return {
      ok: true,
      updated: true,
      message: `Updated from GitHub: ${local.slice(0, 7)} → ${remote.slice(0, 7)}.`,
    };
  } catch (error) {
    return {
      ok: false,
      updated: false,
      message: `Update error: ${error.message}`,
    };
  } finally {
    updateRunning = false;
  }
}

function restartBot() {
  if (restartScheduled) return;
  restartScheduled = true;

  console.log('Starting replacement process...');

  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'index.js')],
    {
      cwd: __dirname,
      env: process.env,
      detached: true,
      stdio: 'ignore',
    }
  );

  child.once('error', error => {
    console.error('Could not start replacement process:', error.message);
    restartScheduled = false;
  });

  child.unref();

  setTimeout(() => {
    client.destroy();
    process.exit(0);
  }, 2500);
}

/* -------------------- COMMAND REGISTRATION -------------------- */

const baseCommands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Open the KatBot configuration panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check KatBot latency'),

  new SlashCommandBuilder()
    .setName('update')
    .setDescription('Check GitHub for updates')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

async function syncBaseCommands() {
  if (!client.user) return;

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: baseCommands.map(command => command.toJSON()) }
  );
}

async function syncGuildCustomCommands(guildId) {
  if (!client.user) {
    throw new Error('Bot client is not ready.');
  }

  const config = getSettings(guildId);

  const commands = Object.entries(config.customCommands)
    .filter(([name, response]) =>
      isValidCommandName(name) &&
      typeof response === 'string'
    )
    .slice(0, 100)
    .map(([name]) =>
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(`KatBot custom command: ${name}`)
        .toJSON()
    );

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: commands }
  );
}

function queueGuildCommandSync(guildId) {
  commandSyncQueue = commandSyncQueue
    .then(() => syncGuildCustomCommands(guildId))
    .catch(error => {
      console.error(`Command sync failed for guild ${guildId}:`, error);
    });

  return commandSyncQueue;
}

async function syncAllGuilds() {
  await syncBaseCommands();

  for (const guild of client.guilds.cache.values()) {
    await syncGuildCustomCommands(guild.id);
  }
}

/* -------------------- STATUS ROTATION -------------------- */

function allStatuses() {
  const result = [];
  const seen = new Set();

  for (const guild of client.guilds.cache.values()) {
    const config = getSettings(guild.id);

    for (const status of config.statuses) {
      const key = `${status.type}:${status.text}`;

      if (seen.has(key)) continue;

      seen.add(key);
      result.push(status);
    }
  }

  return result;
}

function rotateStatus() {
  if (!client.user) return;

  const statuses = allStatuses();

  if (statuses.length === 0) {
    client.user.setActivity('the community', {
      type: ActivityType.Watching,
    });
  } else {
    const status = statuses[statusIndex % statuses.length];
    statusIndex = (statusIndex + 1) % statuses.length;

    client.user.setActivity(status.text, {
      type: ACTIVITY_TYPES[status.type] ?? ActivityType.Playing,
    });
  }

  if (statusTimer) clearTimeout(statusTimer);

  const intervals = [...client.guilds.cache.values()].map(guild =>
    getSettings(guild.id).statusInterval
  );

  const interval = intervals.length
    ? Math.max(30, Math.min(...intervals))
    : DEFAULT_SETTINGS.statusInterval;

  statusTimer = setTimeout(rotateStatus, interval * 1000);
}

function refreshStatus() {
  if (statusTimer) clearTimeout(statusTimer);
  statusIndex = 0;
  rotateStatus();
}

/* -------------------- PANEL HELPERS -------------------- */

function panelEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'KatBot Configuration • Changes save automatically' });
}

function button(id, label, style = ButtonStyle.Primary, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function homePanel() {
  return {
    embeds: [
      panelEmbed(
        'KatBot Setup',
        'Select a section to configure.\n\n' +
        '**Welcome:** Automatic welcome DMs.\n' +
        '**Bot Statuses:** Rotating activities and interval.\n' +
        '**Custom Commands:** Create, edit, rename and delete slash commands.\n\n' +
        'Settings are saved automatically. A restart is not normally required.'
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        button('setup_welcome', 'Welcome'),
        button('setup_status', 'Bot Statuses'),
        button('setup_commands', 'Custom Commands')
      ),
    ],
  };
}

function welcomePanel(guildId) {
  const config = getSettings(guildId);

  return {
    embeds: [
      panelEmbed(
        'Welcome Messages',
        `**Enabled:** ${config.welcomeEnabled ? 'Yes' : 'No'}\n\n` +
        `**Current message:**\n${config.welcomeMessage}\n\n` +
        'Placeholders: `{user}`, `{server}`.'
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        button(
          'welcome_toggle',
          config.welcomeEnabled ? 'Disable Welcome DMs' : 'Enable Welcome DMs',
          config.welcomeEnabled ? ButtonStyle.Danger : ButtonStyle.Success
        ),
        button('welcome_edit', 'Edit Message')
      ),
      new ActionRowBuilder().addComponents(
        button('setup_home', 'Back to Panel', ButtonStyle.Secondary)
      ),
    ],
  };
}

function statusPanel(guildId) {
  const config = getSettings(guildId);

  const list = config.statuses.map((status, index) =>
    `**${index + 1}. ${ACTIVITY_LABELS[status.type] || status.type}:** ${status.text}`
  ).join('\n');

  return {
    embeds: [
      panelEmbed(
        'Bot Statuses',
        `${list || 'No statuses configured.'}\n\n` +
        `**Rotation interval:** ${config.statusInterval} seconds\n\n` +
        'The bot rotates through activities configured across its servers.'
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        button('status_add', 'Add Activity', ButtonStyle.Success),
        button('status_edit_select', 'Edit Activity', ButtonStyle.Primary, config.statuses.length === 0),
        button('status_delete_select', 'Delete Activity', ButtonStyle.Danger, config.statuses.length === 0)
      ),
      new ActionRowBuilder().addComponents(
        button('status_interval', 'Change Interval', ButtonStyle.Secondary),
        button('setup_home', 'Back to Panel', ButtonStyle.Secondary)
      ),
    ],
  };
}

function commandsPanel(guildId) {
  const config = getSettings(guildId);

  const entries = Object.entries(config.customCommands)
    .filter(([name, response]) =>
      isValidCommandName(name) && typeof response === 'string'
    );

  const description = entries.length
    ? entries.map(([name, response]) =>
        `**/${name}** → ${response.slice(0, 100)}`
      ).join('\n')
    : 'No custom commands have been created yet.';

  return {
    embeds: [
      panelEmbed(
        'Custom Commands',
        `${description}\n\n` +
        'Create commands with custom text responses. Changes are saved automatically.'
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        button('custom_add', 'Create Command', ButtonStyle.Success),
        button('custom_edit_select', 'Edit / Rename', ButtonStyle.Primary, entries.length === 0),
        button('custom_delete_select', 'Delete Command', ButtonStyle.Danger, entries.length === 0)
      ),
      new ActionRowBuilder().addComponents(
        button('setup_home', 'Back to Panel', ButtonStyle.Secondary)
      ),
    ],
  };
}

function selectRow(customId, options, placeholder) {
  if (options.length === 0) {
    throw new Error('Cannot create a select menu without options.');
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(options.slice(0, 25))
  );
}

function statusSelect(guildId, customId) {
  const statuses = getSettings(guildId).statuses;

  return selectRow(
    customId,
    statuses.map((status, index) => ({
      label: `${index + 1}. ${status.text}`.slice(0, 100),
      description: (ACTIVITY_LABELS[status.type] || status.type).slice(0, 100),
      value: String(index),
    })),
    'Select an activity'
  );
}

function commandSelect(guildId, customId) {
  const commands = Object.entries(getSettings(guildId).customCommands)
    .filter(([name, response]) =>
      isValidCommandName(name) && typeof response === 'string'
    );

  return selectRow(
    customId,
    commands.map(([name]) => ({
      label: `/${name}`.slice(0, 100),
      value: name,
    })),
    'Select a command'
  );
}

function makeModal(customId, title, fields) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  modal.addComponents(
    ...fields.map(field =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(field.id)
          .setLabel(field.label)
          .setStyle(field.style || TextInputStyle.Short)
          .setRequired(field.required !== false)
          .setMaxLength(field.maxLength || 100)
          .setValue(field.value || '')
      )
    )
  );

  return modal;
}

function statusModal(customId, title, status = {}) {
  return makeModal(customId, title, [
    {
      id: 'activity_type',
      label: 'playing, watching, listening, competing',
      value: status.type || 'playing',
      maxLength: 20,
    },
    {
      id: 'activity_text',
      label: 'Activity text',
      value: status.text || '',
      maxLength: 128,
    },
  ]);
}

function commandModal(customId, title, name = '', response = '') {
  return makeModal(customId, title, [
    {
      id: 'command_name',
      label: 'Command name without /',
      value: name,
      maxLength: 32,
    },
    {
      id: 'command_response',
      label: 'Text response',
      value: response,
      style: TextInputStyle.Paragraph,
      maxLength: 2000,
    },
  ]);
}

async function showHome(interaction, update = false) {
  const panel = homePanel();

  if (update) {
    return interaction.update(panel);
  }

  return interaction.reply({
    ...panel,
    flags: MessageFlags.Ephemeral,
  });
}

/* -------------------- EVENTS -------------------- */

client.once(Events.ClientReady, async readyClient => {
  console.log(`KatBot is online as ${readyClient.user.tag}`);

  try {
    await syncAllGuilds();
    console.log('Base and custom commands synchronized.');
  } catch (error) {
    console.error('Command registration failed:', error);
  }

  refreshStatus();
});

client.on(Events.GuildCreate, async guild => {
  getSettings(guild.id);

  try {
    await queueGuildCommandSync(guild.id);
  } catch (error) {
    console.error('Could not synchronize new guild:', error);
  }

  refreshStatus();
});

client.on(Events.GuildDelete, () => {
  refreshStatus();
});

client.on(Events.GuildMemberAdd, async member => {
  try {
    const config = getSettings(member.guild.id);

    if (!config.welcomeEnabled) return;

    const message = config.welcomeMessage
      .replaceAll('{user}', `<@${member.id}>`)
      .replaceAll('{server}', member.guild.name);

    await member.send({
      content: message,
      allowedMentions: { users: [member.id] },
    });
  } catch (error) {
    console.error('Could not send welcome DM:', error.message);
  }
});

/* -------------------- INTERACTIONS -------------------- */

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
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({
            content: 'You need Manage Server permission to configure KatBot.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return showHome(interaction);
      }

      if (name === 'update') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({
            content: 'Only administrators can use /update.',
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferReply({
          flags: MessageFlags.Ephemeral,
        });

        const result = updateFromGitHub();

        if (!result.ok) {
          return interaction.editReply(result.message);
        }

        if (!result.updated) {
          return interaction.editReply(result.message);
        }

        if (result.message.includes('npm ci failed')) {
          return interaction.editReply(result.message);
        }

        await interaction.editReply(
          `${result.message}\nRestarting KatBot. It may be offline briefly.`
        );

        setTimeout(restartBot, 1500);
        return;
      }

      const config = getSettings(interaction.guildId);
      const response = config.customCommands[name];

      if (typeof response === 'string') {
        return interaction.reply({
          content: response.slice(0, 2000),
          allowedMentions: { parse: [] },
        });
      }

      return interaction.reply({
        content: 'Unknown command. Try refreshing the command list.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.isButton()) {
      if (!interaction.guildId) {
        return interaction.reply({
          content: 'Use this panel in a server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need Manage Server permission to configure KatBot.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const id = interaction.customId;
      const guildId = interaction.guildId;

      if (id === 'setup_home') {
        return showHome(interaction, true);
      }

      if (id === 'setup_welcome') {
        return interaction.update(welcomePanel(guildId));
      }

      if (id === 'setup_status') {
        return interaction.update(statusPanel(guildId));
      }

      if (id === 'setup_commands') {
        return interaction.update(commandsPanel(guildId));
      }

      if (id === 'welcome_toggle') {
        const config = getSettings(guildId);
        config.welcomeEnabled = !config.welcomeEnabled;
        saveSettings();

        return interaction.update(welcomePanel(guildId));
      }

      if (id === 'welcome_edit') {
        const config = getSettings(guildId);

        return interaction.showModal(
          makeModal('welcome_modal', 'Edit Welcome Message', [
            {
              id: 'welcome_message',
              label: 'Use {user} and {server}',
              value: config.welcomeMessage,
              style: TextInputStyle.Paragraph,
              maxLength: 1900,
            },
          ])
        );
      }

      if (id === 'status_add') {
        return interaction.showModal(
          statusModal('status_add_modal', 'Add Activity')
        );
      }

      if (id === 'status_interval') {
        const config = getSettings(guildId);

        return interaction.showModal(
          makeModal('status_interval_modal', 'Status Rotation Interval', [
            {
              id: 'interval_seconds',
              label: 'Interval in seconds (30–3600)',
              value: String(config.statusInterval),
              maxLength: 4,
            },
          ])
        );
      }

      if (id === 'status_edit_select') {
        const config = getSettings(guildId);

        if (config.statuses.length === 0) {
          return interaction.reply({
            content: 'No activities are available.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: 'Select an activity to edit.',
          components: [statusSelect(guildId, 'status_edit_pick')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'status_delete_select') {
        const config = getSettings(guildId);

        if (config.statuses.length === 0) {
          return interaction.reply({
            content: 'No activities are available.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: 'Select an activity to delete.',
          components: [statusSelect(guildId, 'status_delete_pick')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'custom_add') {
        return interaction.showModal(
          commandModal('custom_add_modal', 'Create Custom Command')
        );
      }

      if (id === 'custom_edit_select') {
        const commands = Object.keys(getSettings(guildId).customCommands);

        if (commands.length === 0) {
          return interaction.reply({
            content: 'No custom commands are available.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: 'Select a command to edit or rename.',
          components: [commandSelect(guildId, 'custom_edit_pick')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'custom_delete_select') {
        const commands = Object.keys(getSettings(guildId).customCommands);

        if (commands.length === 0) {
          return interaction.reply({
            content: 'No custom commands are available.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: 'Select a command to delete.',
          components: [commandSelect(guildId, 'custom_delete_pick')],
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (!interaction.guildId) return;

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need Manage Server permission.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const guildId = interaction.guildId;
      const config = getSettings(guildId);

      if (interaction.customId === 'status_edit_pick') {
        const index = Number(interaction.values[0]);
        const status = config.statuses[index];

        if (!Number.isInteger(index) || !status) {
          return interaction.reply({
            content: 'Activity not found. Reopen the panel.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.showModal(
          statusModal(`status_edit_modal:${index}`, 'Edit Activity', status)
        );
      }

      if (interaction.customId === 'status_delete_pick') {
        const index = Number(interaction.values[0]);

        if (!Number.isInteger(index) || !config.statuses[index]) {
          return interaction.update({
            content: 'Activity not found.',
            components: [],
          });
        }

        const removed = config.statuses.splice(index, 1)[0];

        if (config.statuses.length === 0) {
          config.statuses.push({ ...DEFAULT_SETTINGS.statuses[0] });
        }

        saveSettings();
        refreshStatus();

        return interaction.update({
          content: `Deleted activity: ${removed.text}`,
          components: [],
        });
      }

      if (interaction.customId === 'custom_edit_pick') {
        const name = interaction.values[0];
        const response = config.customCommands[name];

        if (typeof response !== 'string') {
          return interaction.reply({
            content: 'Command not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.showModal(
          commandModal(`custom_edit_modal:${name}`, 'Edit Custom Command', name, response)
        );
      }

      if (interaction.customId === 'custom_delete_pick') {
        const name = interaction.values[0];

        if (typeof config.customCommands[name] !== 'string') {
          return interaction.reply({
            content: 'Command not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        delete config.customCommands[name];
        saveSettings();

        await queueGuildCommandSync(guildId);

        return interaction.update({
          content: `Deleted /${name}.`,
          components: [],
        });
      }
    }

    if (interaction.isModalSubmit()) {
      if (!interaction.guildId) {
        return interaction.reply({
          content: 'Use this form in a server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need Manage Server permission.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const guildId = interaction.guildId;
      const config = getSettings(guildId);
      const id = interaction.customId;

      if (id === 'welcome_modal') {
        const message = interaction.fields
          .getTextInputValue('welcome_message')
          .trim();

        if (!message) {
          return interaction.reply({
            content: 'The welcome message cannot be empty.',
            flags: MessageFlags.Ephemeral,
          });
        }

        config.welcomeMessage = message;
        saveSettings();

        return interaction.reply({
          content: 'Welcome message saved.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'status_interval_modal') {
        const seconds = Number(
          interaction.fields.getTextInputValue('interval_seconds')
        );

        if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
          return interaction.reply({
            content: 'Enter a whole number between 30 and 3600.',
            flags: MessageFlags.Ephemeral,
          });
        }

        config.statusInterval = seconds;
        saveSettings();
        refreshStatus();

        return interaction.reply({
          content: `Status interval saved: ${seconds} seconds.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'status_add_modal' || id.startsWith('status_edit_modal:')) {
        const type = interaction.fields
          .getTextInputValue('activity_type')
          .trim()
          .toLowerCase();

        const text = interaction.fields
          .getTextInputValue('activity_text')
          .trim();

        if (!Object.hasOwn(ACTIVITY_TYPES, type)) {
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
          if (config.statuses.length >= 25) {
            return interaction.reply({
              content: 'The maximum is 25 activities per server.',
              flags: MessageFlags.Ephemeral,
            });
          }

          config.statuses.push({ type, text });
        } else {
          const index = Number(id.split(':')[1]);

          if (!Number.isInteger(index) || !config.statuses[index]) {
            return interaction.reply({
              content: 'Activity not found. Reopen the panel.',
              flags: MessageFlags.Ephemeral,
            });
          }

          config.statuses[index] = { type, text };
        }

        saveSettings();
        refreshStatus();

        return interaction.reply({
          content: 'Activity saved.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (id === 'custom_add_modal' || id.startsWith('custom_edit_modal:')) {
        const rawName = interaction.fields
          .getTextInputValue('command_name')
          .trim();

        const name = rawName.toLowerCase();

        const response = interaction.fields
          .getTextInputValue('command_response')
          .trim();

        if (
          !isValidCommandName(name) ||
          rawName !== name
        ) {
          return interaction.reply({
            content:
              'Use only lowercase letters, numbers, hyphens and underscores. Names must be 1–32 characters. /setup, /ping and /update are reserved.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!response) {
          return interaction.reply({
            content: 'The command response cannot be empty.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const oldName = id.startsWith('custom_edit_modal:')
          ? id.slice('custom_edit_modal:'.length)
          : null;

        if (id === 'custom_add_modal' && Object.hasOwn(config.customCommands, name)) {
          return interaction.reply({
            content: `/${name} already exists.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (
          oldName &&
          oldName !== name &&
          Object.hasOwn(config.customCommands, name)
        ) {
          return interaction.reply({
            content: `/${name} already exists. Choose another name.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (
          !Object.hasOwn(config.customCommands, name) &&
          Object.keys(config.customCommands).length >= 100
        ) {
          return interaction.reply({
            content: 'The maximum is 100 custom commands per server.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const previous = { ...config.customCommands };

        if (oldName && oldName !== name) {
          delete config.customCommands[oldName];
        }

        config.customCommands[name] = response;

        try {
          saveSettings();
          await queueGuildCommandSync(guildId);
        } catch (error) {
          console.error('Could not save or sync custom command:', error);

          // Restore the previous in-memory state if saving fails.
          config.customCommands = previous;

          return interaction.reply({
            content: 'Could not save the command. Check the Termux log.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: `Command /${name} saved.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  } catch (error) {
    console.error('Error handling interaction:', error);

    if (!interaction.isRepliable()) return;

    const payload = {
      content: 'An error occurred. Check the Termux log for details.',
      flags: MessageFlags.Ephemeral,
    };

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (replyError) {
      console.error('Could not respond to interaction:', replyError.message);
    }
  }
});

/* -------------------- STARTUP -------------------- */

async function startBot() {
  if (AUTO_UPDATE) {
    console.log('Checking GitHub for updates...');

    const result = updateFromGitHub();
    console.log(result.message);

    if (!result.ok) {
      console.warn('Continuing with the current local version.');
    }

    // If GitHub updated the code, this process may still have the old
    // code loaded. Restart before connecting to Discord.
    if (result.ok && result.updated) {
      console.log('Update downloaded. Restarting to load the new version.');
      restartBot();
      return;
    }

    loadSettings();
  }

  await client.login(TOKEN);
}

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});

startBot().catch(error => {
  console.error('Could not start KatBot:', error);
  process.exit(1);
});
