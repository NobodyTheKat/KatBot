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
} = require('discord.js');

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

if (!process.env.DISCORD_TOKEN) {
  console.error('Manca DISCORD_TOKEN nel file .env.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'settings.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadData() {
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '{}', 'utf8');
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (error) {
    console.error('settings.json non è JSON valido:', error);
    return {};
  }
}

const settings = loadData();

function saveData() {
  fs.writeFileSync(dataFile, JSON.stringify(settings, null, 2), 'utf8');
}

function getSettings(guildId) {
  if (!settings[guildId]) {
    settings[guildId] = {
      welcomeEnabled: true,
      welcomeMessage: 'Ciao {user}, benvenuto su {server}!',
      statuses: [
        { type: 'watching', text: 'la community' },
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
    config.welcomeMessage = 'Ciao {user}, benvenuto su {server}!';
  }

  if (!Array.isArray(config.statuses)) config.statuses = [];
  if (!Number.isInteger(config.statusInterval)) config.statusInterval = 60;

  if (!config.customCommands || typeof config.customCommands !== 'object') {
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
  playing: 'Gioca a',
  watching: 'Guarda',
  listening: 'Ascolta',
  competing: 'Compete in',
};

const baseCommands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Controlla se KatBot è online'),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Apri il pannello di configurazione di KatBot')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('update')
    .setDescription('Controlla GitHub e aggiorna KatBot se necessario')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

let statusTimer = null;
let statusIndex = 0;
let syncingGuilds = Promise.resolve();

function allConfiguredStatuses() {
  const all = Object.values(settings).flatMap((server) => server.statuses || []);

  return [
    ...new Map(
      all.map((item) => [`${item.type}:${item.text}`, item])
    ).values(),
  ];
}

function rotateStatus() {
  if (!client.user) return;

  const statuses = allConfiguredStatuses();

  if (statuses.length === 0) {
    client.user.setActivity('con la community', {
      type: ActivityType.Playing,
    });
  } else {
    const status = statuses[statusIndex % statuses.length];

    statusIndex = (statusIndex + 1) % statuses.length;

    client.user.setActivity(status.text, {
      type: activityTypes[status.type] ?? ActivityType.Playing,
    });
  }

  if (statusTimer) clearTimeout(statusTimer);

  const intervals = Object.values(settings)
    .map((server) => Number(server.statusInterval) || 60);

  const interval = Math.max(30, Math.min(...intervals, 3600));

  statusTimer = setTimeout(rotateStatus, interval * 1000);
}

function refreshStatusNow() {
  if (statusTimer) clearTimeout(statusTimer);

  statusIndex = 0;
  rotateStatus();
}

function cleanCommandName(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

function isValidCommandName(name) {
  return /^[a-z0-9_-]{1,32}$/.test(name)
    && !['setup', 'ping'].includes(name);
}

async function syncGuildCustomCommands(guildId) {
  const config = getSettings(guildId);

  const customCommands = Object.entries(config.customCommands)
    .filter(([name, response]) =>
      isValidCommandName(name) && typeof response === 'string'
    )
    .slice(0, 100)
    .map(([name]) =>
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(`Comando personalizzato di KatBot: ${name}`.slice(0, 100))
        .toJSON()
    );

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: customCommands }
  );
}

function queueGuildCommandSync(guildId) {
  syncingGuilds = syncingGuilds
    .then(() => syncGuildCustomCommands(guildId))
    .catch((error) =>
      console.error(`Errore aggiornando i comandi di ${guildId}:`, error)
    );

  return syncingGuilds;
}

async function syncAllGuildCustomCommands() {
  for (const guild of client.guilds.cache.values()) {
    await syncGuildCustomCommands(guild.id);
  }
}

function panelEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(description)
    .setFooter({
      text: 'KatBot • Le modifiche vengono salvate automaticamente',
    });
}

function mainPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('setup_welcome')
        .setLabel('Benvenuto')
        .setEmoji('👋')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('setup_statuses')
        .setLabel('Stati del bot')
        .setEmoji('🎮')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('setup_commands')
        .setLabel('Comandi personalizzati')
        .setEmoji('🛠️')
        .setStyle(ButtonStyle.Primary)
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('setup_refresh')
        .setLabel('Aggiorna pannello')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function welcomePanel(guildId) {
  const config = getSettings(guildId);

  return {
    embeds: [
      panelEmbed(
        '👋 Benvenuto',
        `**Messaggi in DM:** ${config.welcomeEnabled ? 'Attivi' : 'Disattivati'}\n` +
        `**Testo attuale:**\n${config.welcomeMessage}\n\n` +
        'Segnaposto disponibili: `{user}` e `{server}`.'
      ),
    ],

    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('welcome_toggle')
          .setLabel(config.welcomeEnabled ? 'Disattiva DM' : 'Attiva DM')
          .setStyle(
            config.welcomeEnabled
              ? ButtonStyle.Danger
              : ButtonStyle.Success
          ),

        new ButtonBuilder()
          .setCustomId('welcome_edit')
          .setLabel('Modifica messaggio')
          .setStyle(ButtonStyle.Primary)
      ),

      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('setup_home')
          .setLabel('Torna al pannello')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],

    ephemeral: true,
  };
}

function statusesPanel(guildId) {
  const config = getSettings(guildId);

  const statusList = config.statuses.length
    ? config.statuses
        .map((s, i) =>
          `**${i + 1}.** ${activityLabels[s.type] || s.type} **${s.text}**`
        )
        .join('\n')
    : 'Non hai ancora aggiunto attività.';

  return {
    embeds: [
      panelEmbed(
        '🎮 Stati del bot',
        `${statusList}\n\n**Intervallo:** ${config.statusInterval} secondi\n\n` +
        'Nota: il profilo e l’attività del bot sono globali su Discord; ' +
        'le attività configurate nei server vengono combinate nella stessa rotazione.'
      ),
    ],

    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('status_add')
          .setLabel('Aggiungi attività')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId('status_edit_select')
          .setLabel('Modifica attività')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(config.statuses.length === 0),

        new ButtonBuilder()
          .setCustomId('status_delete_select')
          .setLabel('Elimina attività')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(config.statuses.length === 0)
      ),

      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('status_interval_edit')
          .setLabel('Cambia intervallo')
          .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
          .setCustomId('setup_home')
          .setLabel('Torna al pannello')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],

    ephemeral: true,
  };
}

function commandsPanel(guildId) {
  const config = getSettings(guildId);
  const entries = Object.entries(config.customCommands);

  const description = entries.length
    ? entries
        .map(([name, response]) => `**/${name}** → ${response.slice(0, 120)}`)
        .join('\n')
    : 'Non hai ancora creato comandi personalizzati.';

  return {
    embeds: [
      panelEmbed(
        '🛠️ Comandi personalizzati',
        `${description}\n\nI comandi creati qui vengono registrati in questo server e sono utilizzabili come comandi slash. Gli aggiornamenti possono richiedere qualche secondo.`
      ),
    ],

    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('custom_add')
          .setLabel('Crea comando')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId('custom_edit_select')
          .setLabel('Modifica risposta')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(entries.length === 0),

        new ButtonBuilder()
          .setCustomId('custom_delete_select')
          .setLabel('Elimina comando')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(entries.length === 0)
      ),

      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('setup_home')
          .setLabel('Torna al pannello')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],

    ephemeral: true,
  };
}

function statusSelectRow(guildId, action) {
  const statuses = getSettings(guildId).statuses;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(action)
      .setPlaceholder('Scegli un’attività')
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

function commandSelectRow(guildId, action) {
  const commands = Object.entries(
    getSettings(guildId).customCommands
  ).slice(0, 25);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(action)
      .setPlaceholder('Scegli un comando')
      .addOptions(
        commands.map(([name]) => ({
          label: `/${name}`.slice(0, 100),
          value: name,
        }))
      )
  );
}

function statusModal(customId, title, status = null) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  const typeInput = new TextInputBuilder()
    .setCustomId('activity_type')
    .setLabel('Tipo: playing, watching, listening, competing')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('playing / watching / listening / competing')
    .setRequired(true)
    .setMaxLength(20)
    .setValue(status?.type || 'watching');

  const textInput = new TextInputBuilder()
    .setCustomId('activity_text')
    .setLabel('Testo dell’attività (max 128 caratteri)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(128)
    .setValue(status?.text || '');

  modal.addComponents(
    new ActionRowBuilder().addComponents(typeInput),
    new ActionRowBuilder().addComponents(textInput)
  );

  return modal;
}

function customCommandModal(customId, title, name = '', response = '') {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  const nameInput = new TextInputBuilder()
    .setCustomId('command_name')
    .setLabel('Nome senza /, spazi o accenti')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setValue(name);

  const responseInput = new TextInputBuilder()
    .setCustomId('command_response')
    .setLabel('Risposta del bot')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000)
    .setValue(response);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(responseInput)
  );

  return modal;
}

async function showHome(interaction, update = false) {
  const payload = {
    embeds: [
      panelEmbed(
        'KatBot • Configurazione',
        'Scegli una sezione da configurare. Le modifiche vengono salvate automaticamente e applicate senza riavviare KatBot.'
      ),
    ],
    components: mainPanelRows(),
    ephemeral: true,
  };

  if (update) {
    return interaction.update({
      embeds: payload.embeds,
      components: payload.components,
    });
  }

  return interaction.reply(payload);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`KatBot online come ${readyClient.user.tag}`);

  try {
    await rest.put(
      Routes.applicationCommands(readyClient.user.id),
      { body: baseCommands.map((command) => command.toJSON()) }
    );

    await syncAllGuildCustomCommands();

    console.log('Comandi base e personalizzati sincronizzati.');
  } catch (error) {
    console.error('Errore registrando i comandi:', error);
  }

  refreshStatusNow();
});

client.on(Events.GuildCreate, async (guild) => {
  getSettings(guild.id);
  await queueGuildCommandSync(guild.id);
  refreshStatusNow();
});

client.on(Events.GuildMemberAdd, async (member) => {
  const config = getSettings(member.guild.id);

  if (!config.welcomeEnabled) return;

  const message = config.welcomeMessage
    .replaceAll('{user}', member.user.username)
    .replaceAll('{server}', member.guild.name);

  try {
    await member.send(message);
  } catch {
    console.log(
      `Non posso inviare un DM a ${member.user.tag}; potrebbe avere i DM disattivati.`
    );
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === 'ping') {
        return interaction.reply({
          content: `Pong! ${client.ws.ping} ms`,
          ephemeral: true,
        });
      }

      if (!interaction.guildId) {
        return interaction.reply({
          content: 'Usa questo comando in un server.',
          ephemeral: true,
        });
      }

      if (name === 'update') {
        if (
          !interaction.memberPermissions?.has(
            PermissionFlagsBits.Administrator
          )
        ) {
          return interaction.reply({
            content: 'Solo gli amministratori possono usare /update.',
            ephemeral: true,
          });
        }

        await interaction.deferReply({ ephemeral: true });

        const gitDir = path.join(__dirname, '.git');

        if (!fs.existsSync(gitDir)) {
          return interaction.editReply(
            'Non trovo la cartella .git. /update funziona solo se KatBot è stato installato con Git.'
          );
        }

        const runGit = (args) =>
          spawnSync('git', args, {
            cwd: __dirname,
            encoding: 'utf8',
            timeout: 60000,
            maxBuffer: 2 * 1024 * 1024,
          });

        try {
          const branchResult = runGit(['branch', '--show-current']);

          if (branchResult.status !== 0) {
            throw new Error(
              branchResult.stderr || 'Impossibile determinare il branch Git.'
            );
          }

          const branch = (
            process.env.GITHUB_BRANCH ||
            branchResult.stdout.trim() ||
            'main'
          ).trim();

          const fetchResult = runGit(['fetch', 'origin', branch]);

          if (fetchResult.status !== 0) {
            throw new Error(
              fetchResult.stderr || 'Git fetch non riuscito.'
            );
          }

          const localResult = runGit(['rev-parse', 'HEAD']);
          const remoteResult = runGit(['rev-parse', `origin/${branch}`]);

          if (localResult.status !== 0 || remoteResult.status !== 0) {
            throw new Error(
              'Impossibile leggere la revisione locale o quella GitHub.'
            );
          }

          const local = localResult.stdout.trim();
          const remote = remoteResult.stdout.trim();

          if (local === remote) {
            return interaction.editReply(
              'KatBot è già aggiornato. Nessuna modifica necessaria.'
            );
          }

          const ancestorResult = runGit([
            'merge-base',
            '--is-ancestor',
            'HEAD',
            `origin/${branch}`,
          ]);

          if (ancestorResult.status !== 0) {
            throw new Error(
              'Il branch locale non è un antenato della versione GitHub. Non ho modificato i file per evitare di sovrascrivere modifiche o creare un merge rischioso.'
            );
          }

          const changedResult = runGit([
            'diff',
            '--name-only',
            'HEAD',
            `origin/${branch}`,
          ]);

          if (changedResult.status !== 0) {
            throw new Error(
              'Impossibile controllare i file che cambieranno.'
            );
          }

          const packageChanged = changedResult.stdout
            .split(/\r?\n/)
            .some((file) =>
              ['package.json', 'package-lock.json'].includes(file.trim())
            );

          const updateResult = runGit([
            'merge',
            '--ff-only',
            `origin/${branch}`,
          ]);

          if (updateResult.status !== 0) {
            throw new Error(
              updateResult.stderr ||
              'Aggiornamento rifiutato. Controlla se ci sono modifiche locali non salvate.'
            );
          }

          if (packageChanged) {
            const installResult = spawnSync('npm', ['ci'], {
              cwd: __dirname,
              encoding: 'utf8',
              timeout: 180000,
              maxBuffer: 4 * 1024 * 1024,
            });

            if (installResult.status !== 0) {
              throw new Error(
                `Il codice è stato aggiornato, ma npm ci non è riuscito. Controlla le dipendenze e riavvia manualmente.\n${installResult.stderr || ''}`
              );
            }
          }

          await interaction.editReply(
            `Aggiornamento completato (${local.slice(0, 7)} → ${remote.slice(0, 7)}). Avvio una nuova istanza di KatBot…`
          );

          const child = spawn(process.execPath, [__filename], {
            cwd: __dirname,
            detached: true,
            stdio: 'ignore',
            env: {
              ...process.env,
              KATBOT_RESTARTED_BY_UPDATE: '1',
            },
          });

          child.once('error', (error) => {
            console.error(
              'Errore avviando KatBot dopo /update:',
              error
            );
          });

          child.unref();

          setTimeout(async () => {
            try {
              await client.destroy();
            } catch {}

            process.exit(0);
          }, 2000).unref();

          return;
        } catch (error) {
          console.error('Errore durante /update:', error);

          return interaction.editReply(
            `Aggiornamento non completato: ${String(error.message || error).slice(0, 1500)}`
          );
        }
      }

      if (name === 'setup') {
        if (
          !interaction.memberPermissions?.has(
            PermissionFlagsBits.ManageGuild
          )
        ) {
          return interaction.reply({
            content: 'Solo chi può gestire il server può configurare KatBot.',
            ephemeral: true,
          });
        }

        return showHome(interaction);
      }

      const config = getSettings(interaction.guildId);
      const response = config.customCommands[name];

      if (typeof response === 'string') {
        return interaction.reply({
          content: response.slice(0, 2000),
          allowedMentions: { parse: [] },
        });
      }

      return;
    }

    if (interaction.isButton()) {
      if (!interaction.guildId) {
        return interaction.reply({
          content: 'Usa questo pannello in un server.',
          ephemeral: true,
        });
      }

      if (
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.ManageGuild
        )
      ) {
        return interaction.reply({
          content: 'Non hai i permessi per configurare KatBot.',
          ephemeral: true,
        });
      }

      const id = interaction.customId;
      const guildId = interaction.guildId;

      if (id === 'setup_refresh' || id === 'setup_home') {
        return showHome(interaction, true);
      }

      if (id === 'setup_welcome') {
        return interaction.reply(welcomePanel(guildId));
      }

      if (id === 'setup_statuses') {
        return interaction.reply(statusesPanel(guildId));
      }

      if (id === 'setup_commands') {
        return interaction.reply(commandsPanel(guildId));
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
          .setTitle('Messaggio di benvenuto');

        const input = new TextInputBuilder()
          .setCustomId('welcome_message')
          .setLabel('Usa {user} e {server} come segnaposto')
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
          statusModal('status_add_modal', 'Aggiungi attività')
        );
      }

      if (id === 'status_interval_edit') {
        const config = getSettings(guildId);

        const modal = new ModalBuilder()
          .setCustomId('status_interval_modal')
          .setTitle('Intervallo di rotazione');

        const input = new TextInputBuilder()
          .setCustomId('interval_seconds')
          .setLabel('Secondi (da 30 a 3600)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4)
          .setValue(String(config.statusInterval));

        modal.addComponents(
          new ActionRowBuilder().addComponents(input)
        );

        return interaction.showModal(modal);
      }

      if (id === 'status_edit_select') {
        return interaction.reply({
          content: 'Scegli l’attività da modificare:',
          components: [
            statusSelectRow(guildId, 'status_edit_pick'),
          ],
          ephemeral: true,
        });
      }

      if (id === 'status_delete_select') {
        return interaction.reply({
          content: 'Scegli l’attività da eliminare:',
          components: [
            statusSelectRow(guildId, 'status_delete_pick'),
          ],
          ephemeral: true,
        });
      }

      if (id === 'custom_add') {
        return interaction.showModal(
          customCommandModal('custom_add_modal', 'Crea comando')
        );
      }

      if (id === 'custom_edit_select') {
        return interaction.reply({
          content: 'Scegli il comando da modificare:',
          components: [
            commandSelectRow(guildId, 'custom_edit_pick'),
          ],
          ephemeral: true,
        });
      }

      if (id === 'custom_delete_select') {
        return interaction.reply({
          content: 'Scegli il comando da eliminare:',
          components: [
            commandSelectRow(guildId, 'custom_delete_pick'),
          ],
          ephemeral: true,
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
          content: 'Non hai i permessi per configurare KatBot.',
          ephemeral: true,
        });
      }

      const guildId = interaction.guildId;

      if (!guildId) {
        return interaction.reply({
          content: 'Usa questo pannello in un server.',
          ephemeral: true,
        });
      }

      if (interaction.customId === 'status_edit_pick') {
        const index = Number(interaction.values[0]);
        const status = getSettings(guildId).statuses[index];

        if (!status) {
          return interaction.reply({
            content: 'Attività non trovata. Riapri la sezione.',
            ephemeral: true,
          });
        }

        return interaction.showModal(
          statusModal(
            `status_edit_modal:${index}`,
            'Modifica attività',
            status
          )
        );
      }

      if (interaction.customId === 'status_delete_pick') {
        const index = Number(interaction.values[0]);
        const config = getSettings(guildId);

        if (!config.statuses[index]) {
          return interaction.reply({
            content: 'Attività non trovata.',
            ephemeral: true,
          });
        }

        const removed = config.statuses.splice(index, 1)[0];

        saveData();
        refreshStatusNow();

        return interaction.update({
          content: `Attività eliminata: ${activityLabels[removed.type] || removed.type} ${removed.text}`,
          components: [],
        });
      }

      if (interaction.customId === 'custom_edit_pick') {
        const name = interaction.values[0];
        const response = getSettings(guildId).customCommands[name];

        if (typeof response !== 'string') {
          return interaction.reply({
            content: 'Comando non trovato.',
            ephemeral: true,
          });
        }

        return interaction.showModal(
          customCommandModal(
            `custom_edit_modal:${name}`,
            'Modifica comando',
            name,
            response
          )
        );
      }

      if (interaction.customId === 'custom_delete_pick') {
        const name = interaction.values[0];
        const config = getSettings(guildId);

        if (!(name in config.customCommands)) {
          return interaction.reply({
            content: 'Comando non trovato.',
            ephemeral: true,
          });
        }

        delete config.customCommands[name];

        saveData();
        await queueGuildCommandSync(guildId);

        return interaction.update({
          content: `Comando /${name} eliminato.`,
          components: [],
        });
      }
    }

    if (interaction.isModalSubmit()) {
      if (!interaction.guildId) {
        return interaction.reply({
          content: 'Usa questo pannello in un server.',
          ephemeral: true,
        });
      }

      if (
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.ManageGuild
        )
      ) {
        return interaction.reply({
          content: 'Non hai i permessi per configurare KatBot.',
          ephemeral: true,
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
          content: 'Messaggio di benvenuto salvato e applicato.',
          ephemeral: true,
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
            content: 'Inserisci un numero intero da 30 a 3600.',
            ephemeral: true,
          });
        }

        config.statusInterval = seconds;

        saveData();
        refreshStatusNow();

        return interaction.reply({
          content: `Intervallo salvato: ${seconds} secondi.`,
          ephemeral: true,
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
            content: 'Tipo non valido. Usa playing, watching, listening oppure competing.',
            ephemeral: true,
          });
        }

        if (!text || text.length > 128) {
          return interaction.reply({
            content: 'Il testo deve contenere da 1 a 128 caratteri.',
            ephemeral: true,
          });
        }

        if (id === 'status_add_modal') {
          config.statuses.push({ type, text });
        } else {
          const index = Number(id.split(':')[1]);

          if (!config.statuses[index]) {
            return interaction.reply({
              content: 'Attività non trovata. Riapri la sezione.',
              ephemeral: true,
            });
          }

          config.statuses[index] = { type, text };
        }

        saveData();
        refreshStatusNow();

        return interaction.reply({
          content: 'Attività salvata e rotazione aggiornata senza riavviare KatBot.',
          ephemeral: true,
        });
      }

      if (
        id === 'custom_add_modal' ||
        id.startsWith('custom_edit_modal:')
      ) {
        const rawName = interaction.fields
          .getTextInputValue('command_name');

        const name = cleanCommandName(rawName);

        const response = interaction.fields
          .getTextInputValue('command_response')
          .trim();

        if (
          !isValidCommandName(name) ||
          rawName.trim().toLowerCase() !== name
        ) {
          return interaction.reply({
            content: 'Nome non valido. Usa solo lettere minuscole, numeri, trattini o underscore; da 1 a 32 caratteri. /setup e /ping sono riservati.',
            ephemeral: true,
          });
        }

        if (!response) {
          return interaction.reply({
            content: 'La risposta non può essere vuota.',
            ephemeral: true,
          });
        }

        const editingOldName = id.startsWith('custom_edit_modal:')
          ? id.slice('custom_edit_modal:'.length)
          : null;

        const exists = Object.hasOwn(config.customCommands, name);

        if (id === 'custom_add_modal' && exists) {
          return interaction.reply({
            content: `Il comando /${name} esiste già. Usa Modifica risposta.`,
            ephemeral: true,
          });
        }

        if (editingOldName && editingOldName !== name) {
          delete config.customCommands[editingOldName];
        }

        if (
          !exists &&
          Object.keys(config.customCommands).length >= 100
        ) {
          return interaction.reply({
            content: 'Hai raggiunto il limite di 100 comandi personalizzati per questo server.',
            ephemeral: true,
          });
        }

        config.customCommands[name] = response;

        saveData();
        await queueGuildCommandSync(guildId);

        return interaction.reply({
          content: `Comando /${name} salvato. È stato aggiornato senza riavviare KatBot; Discord potrebbe impiegare qualche secondo a mostrarlo.`,
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error('Errore gestendo un’interazione:', error);

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content: 'Si è verificato un errore. Controlla il Terminale per i dettagli.',
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
