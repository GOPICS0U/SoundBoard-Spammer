const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

// Configuration et variables globales
const SOUNDS_DIR = './sounds';
const CONFIG_FILE = './config.json';
let botLeaving = false;
let currentConnections = new Map(); // Stocke les connexions actives par guild
let soundStats = new Map(); // Statistiques d'utilisation des sons

// Configuration par défaut
let config = {
  maxFileSize: 10 * 1024 * 1024, // 10MB
  allowedFormats: ['.mp3', '.wav', '.ogg', '.m4a'],
  autoReconnect: true,
  volume: 0.5,
  maxSounds: 100
};

// -------- Fonctions utilitaires --------
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    } catch (error) {
      console.log('⚠️ Erreur lors du chargement de la config, utilisation des valeurs par défaut');
    }
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadSoundStats() {
  const statsFile = './sound_stats.json';
  if (fs.existsSync(statsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
      soundStats = new Map(Object.entries(data));
    } catch (error) {
      console.log('⚠️ Erreur lors du chargement des stats');
    }
  }
}

function saveSoundStats() {
  const statsFile = './sound_stats.json';
  const data = Object.fromEntries(soundStats);
  fs.writeFileSync(statsFile, JSON.stringify(data, null, 2));
}

function incrementSoundUsage(soundName) {
  const current = soundStats.get(soundName) || 0;
  soundStats.set(soundName, current + 1);
  saveSoundStats();
}

function getSoundFiles() {
  if (!fs.existsSync(SOUNDS_DIR)) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    return [];
  }
  return fs.readdirSync(SOUNDS_DIR)
    .filter(file => config.allowedFormats.some(format => file.toLowerCase().endsWith(format)))
    .map(file => path.parse(file).name);
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function createSuccessEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function createErrorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

// -------- Commandes --------
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Joue un soundboard dans un salon vocal')
    .addStringOption(option =>
      option.setName('nom')
        .setDescription('Nom du fichier audio')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Salon vocal où jouer le son (optionnel)')
        .setRequired(false)
    )
    .addNumberOption(option =>
      option.setName('volume')
        .setDescription('Volume de lecture (0.1 à 1.0)')
        .setRequired(false)
        .setMinValue(0.1)
        .setMaxValue(1.0)
    ),

  new SlashCommandBuilder()
    .setName('addsound')
    .setDescription('Ajoute un nouveau son au soundboard')
    .addStringOption(option =>
      option.setName('nom')
        .setDescription('Nom du son à sauvegarder')
        .setRequired(true)
    )
    .addAttachmentOption(option =>
      option.setName('fichier')
        .setDescription('Fichier audio')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('sounds')
    .setDescription('Liste tous les sons disponibles')
    .addStringOption(option =>
      option.setName('search')
        .setDescription('Rechercher un son spécifique')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('deletesound')
    .setDescription('Supprime un son du soundboard')
    .addStringOption(option =>
      option.setName('nom')
        .setDescription('Nom du son à supprimer')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName('soundinfo')
    .setDescription('Affiche les informations d\'un son')
    .addStringOption(option =>
      option.setName('nom')
        .setDescription('Nom du son')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Arrête la lecture et déconnecte le bot'),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Fait rejoindre le bot dans votre salon vocal'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Fait quitter le bot du salon vocal'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Affiche les statistiques d\'utilisation des sons'),

  new SlashCommandBuilder()
    .setName('random')
    .setDescription('Joue un son aléatoire')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Salon vocal où jouer le son (optionnel)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure les paramètres du bot')
    .addSubcommand(subcommand =>
      subcommand.setName('volume')
        .setDescription('Change le volume par défaut')
        .addNumberOption(option =>
          option.setName('value')
            .setDescription('Volume (0.1 à 1.0)')
            .setRequired(true)
            .setMinValue(0.1)
            .setMaxValue(1.0)
        )
    )
    .addSubcommand(subcommand =>
      subcommand.setName('autoreconnect')
        .setDescription('Active/désactive la reconnexion automatique')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Activer ou désactiver')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand.setName('show')
        .setDescription('Affiche la configuration actuelle')
    )
].map(cmd => cmd.toJSON());

// -------- Initialisation --------
loadConfig();
loadSoundStats();

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log('🔄 Enregistrement des commandes slash...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Commandes slash enregistrées !');
  } catch (error) {
    console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
  }
})();

// -------- Fonctions de gestion audio --------
async function playSound(interaction, soundName, targetChannel, volume = null) {
  const actualVolume = volume || config.volume;
  
  if (!targetChannel.isVoiceBased()) {
    return interaction.reply({ 
      embeds: [createErrorEmbed('❌ Erreur', 'Le salon choisi doit être vocal.')], 
      ephemeral: true 
    });
  }

  const soundFiles = getSoundFiles();
  const matchingFile = soundFiles.find(file => file.toLowerCase() === soundName.toLowerCase());
  
  if (!matchingFile) {
    return interaction.reply({ 
      embeds: [createErrorEmbed('❌ Son introuvable', `Le fichier **${soundName}** n'existe pas.`)], 
      ephemeral: true 
    });
  }

  const soundFile = fs.readdirSync(SOUNDS_DIR).find(file => 
    path.parse(file).name.toLowerCase() === matchingFile.toLowerCase()
  );
  const filePath = path.join(SOUNDS_DIR, soundFile);

  try {
    botLeaving = true;

    const connection = joinVoiceChannel({
      channelId: targetChannel.id,
      guildId: targetChannel.guild.id,
      adapterCreator: targetChannel.guild.voiceAdapterCreator,
    });

    currentConnections.set(targetChannel.guild.id, connection);

    await entersState(connection, VoiceConnectionStatus.Ready, 30000);

    const player = createAudioPlayer();
    const resource = createAudioResource(filePath, { inlineVolume: true });
    resource.volume.setVolume(actualVolume);
    
    connection.subscribe(player);
    player.play(resource);

    incrementSoundUsage(matchingFile);

    const embed = createSuccessEmbed(
      '🔊 Lecture en cours',
      `**${matchingFile}** dans ${targetChannel.name}\nVolume: ${Math.round(actualVolume * 100)}%`
    );

    await interaction.reply({ embeds: [embed] });

    player.on(AudioPlayerStatus.Playing, () => {
      console.log(`🔊 Lecture de ${matchingFile} démarrée !`);
    });

    player.on(AudioPlayerStatus.Idle, () => {
      console.log(`✅ Lecture de ${matchingFile} terminée`);
      connection.destroy();
      currentConnections.delete(targetChannel.guild.id);
      setTimeout(() => botLeaving = false, 1000);
    });

    player.on('error', error => {
      console.error(`❌ Erreur player: ${error.message}`);
      connection.destroy();
      currentConnections.delete(targetChannel.guild.id);
      setTimeout(() => botLeaving = false, 1000);
    });

  } catch (error) {
    console.error('❌ Erreur lors de la connexion vocale:', error);
    botLeaving = false;
    return interaction.followUp({ 
      embeds: [createErrorEmbed('❌ Erreur de connexion', 'Impossible de se connecter au salon vocal.')], 
      ephemeral: true 
    });
  }
}

// -------- Gestion des interactions --------
client.on('interactionCreate', async interaction => {

  // Autocomplétion
  if (interaction.isAutocomplete()) {
    const focusedValue = interaction.options.getFocused().toLowerCase();
    const soundFiles = getSoundFiles();
    const filtered = soundFiles
      .filter(f => f.toLowerCase().includes(focusedValue))
      .sort()
      .slice(0, 25);
    
    await interaction.respond(
      filtered.map(f => ({ name: f, value: f }))
    );
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    // Commande PLAY
    if (interaction.commandName === 'play') {
      const soundName = interaction.options.getString('nom');
      let targetChannel = interaction.options.getChannel('channel');
      const volume = interaction.options.getNumber('volume');

      if (!targetChannel) {
        const voiceState = interaction.member.voice;
        if (!voiceState.channel) {
          return interaction.reply({ 
            embeds: [createErrorEmbed('❌ Erreur', 'Vous devez être dans un salon vocal ou spécifier un salon.')], 
            ephemeral: true 
          });
        }
        targetChannel = voiceState.channel;
      }

      await playSound(interaction, soundName, targetChannel, volume);
    }

    // Commande ADDSOUND
    else if (interaction.commandName === 'addsound') {
      await interaction.deferReply({ ephemeral: true });

      const name = interaction.options.getString('nom').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const file = interaction.options.getAttachment('fichier');

      if (!name || name.length < 1) {
        return interaction.editReply({ 
          embeds: [createErrorEmbed('❌ Erreur', 'Le nom du son doit contenir au moins un caractère valide.')] 
        });
      }

      const fileExt = path.extname(file.name).toLowerCase();
      if (!config.allowedFormats.includes(fileExt)) {
        return interaction.editReply({ 
          embeds: [createErrorEmbed('❌ Format non supporté', `Formats acceptés: ${config.allowedFormats.join(', ')}`)] 
        });
      }

      if (file.size > config.maxFileSize) {
        return interaction.editReply({ 
          embeds: [createErrorEmbed('❌ Fichier trop volumineux', `Taille maximum: ${formatFileSize(config.maxFileSize)}`)] 
        });
      }

      const sounds = getSoundFiles();
      if (sounds.length >= config.maxSounds) {
        return interaction.editReply({ 
          embeds: [createErrorEmbed('❌ Limite atteinte', `Maximum ${config.maxSounds} sons autorisés.`)] 
        });
      }

      if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true });
      
      const savePath = path.join(SOUNDS_DIR, `${name}${fileExt}`);

      try {
        const res = await fetch(file.url);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(savePath, buffer);

        const embed = createSuccessEmbed(
          '✅ Son ajouté',
          `**${name}** ajouté avec succès !\nTaille: ${formatFileSize(file.size)}\nUtilisez \`/play ${name}\``
        );

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ 
          embeds: [createErrorEmbed('❌ Erreur', 'Erreur lors du téléchargement du fichier.')] 
        });
      }
    }

    // Commande SOUNDS
    else if (interaction.commandName === 'sounds') {
      const search = interaction.options.getString('search');
      let sounds = getSoundFiles();

      if (search) {
        sounds = sounds.filter(sound => sound.toLowerCase().includes(search.toLowerCase()));
      }

      if (sounds.length === 0) {
        const message = search ? 
          `Aucun son trouvé pour "${search}"` : 
          'Aucun son disponible. Utilisez `/addsound` pour en ajouter.';
        return interaction.reply({ 
          embeds: [createErrorEmbed('🔍 Recherche', message)], 
          ephemeral: true 
        });
      }

      sounds.sort();
      const pages = [];
      const itemsPerPage = 10;

      for (let i = 0; i < sounds.length; i += itemsPerPage) {
        const page = sounds.slice(i, i + itemsPerPage);
        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle('🎵 Sons disponibles')
          .setDescription(page.map((sound, index) => {
            const usage = soundStats.get(sound) || 0;
            return `**${i + index + 1}.** ${sound} ${usage > 0 ? `(${usage}x)` : ''}`;
          }).join('\n'))
          .setFooter({ text: `Page ${Math.floor(i/itemsPerPage) + 1}/${Math.ceil(sounds.length/itemsPerPage)} • Total: ${sounds.length} sons` })
          .setTimestamp();
        
        pages.push(embed);
      }

      await interaction.reply({ embeds: [pages[0]], ephemeral: true });
    }

    // Commande DELETESOUND
    else if (interaction.commandName === 'deletesound') {
      const soundName = interaction.options.getString('nom');
      const sounds = getSoundFiles();
      const matchingFile = sounds.find(file => file.toLowerCase() === soundName.toLowerCase());

      if (!matchingFile) {
        return interaction.reply({ 
          embeds: [createErrorEmbed('❌ Son introuvable', `Le son **${soundName}** n'existe pas.`)], 
          ephemeral: true 
        });
      }

      const soundFile = fs.readdirSync(SOUNDS_DIR).find(file => 
        path.parse(file).name.toLowerCase() === matchingFile.toLowerCase()
      );
      const filePath = path.join(SOUNDS_DIR, soundFile);

      try {
        fs.unlinkSync(filePath);
        soundStats.delete(matchingFile);
        saveSoundStats();

        await interaction.reply({ 
          embeds: [createSuccessEmbed('🗑️ Son supprimé', `**${matchingFile}** a été supprimé avec succès.`)] 
        });
      } catch (error) {
        console.error(error);
        await interaction.reply({ 
          embeds: [createErrorEmbed('❌ Erreur', 'Erreur lors de la suppression du fichier.')], 
          ephemeral: true 
        });
      }
    }

    // Commande SOUNDINFO
    else if (interaction.commandName === 'soundinfo') {
      const soundName = interaction.options.getString('nom');
      const sounds = getSoundFiles();
      const matchingFile = sounds.find(file => file.toLowerCase() === soundName.toLowerCase());

      if (!matchingFile) {
        return interaction.reply({ 
          embeds: [createErrorEmbed('❌ Son introuvable', `Le son **${soundName}** n'existe pas.`)], 
          ephemeral: true 
        });
      }

      const soundFile = fs.readdirSync(SOUNDS_DIR).find(file => 
        path.parse(file).name.toLowerCase() === matchingFile.toLowerCase()
      );
      const filePath = path.join(SOUNDS_DIR, soundFile);
      const stats = fs.statSync(filePath);
      const usage = soundStats.get(matchingFile) || 0;

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle(`ℹ️ Information: ${matchingFile}`)
        .addFields(
          { name: '📁 Nom du fichier', value: soundFile, inline: true },
          { name: '📏 Taille', value: formatFileSize(stats.size), inline: true },
          { name: '📊 Utilisations', value: usage.toString(), inline: true },
          { name: '📅 Créé le', value: stats.birthtime.toLocaleDateString('fr-FR'), inline: true },
          { name: '🔧 Modifié le', value: stats.mtime.toLocaleDateString('fr-FR'), inline: true }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Commande STOP
    else if (interaction.commandName === 'stop') {
      const connection = currentConnections.get(interaction.guild.id);
      if (connection) {
        botLeaving = true;
        connection.destroy();
        currentConnections.delete(interaction.guild.id);
        setTimeout(() => botLeaving = false, 1000);
        
        await interaction.reply({ 
          embeds: [createSuccessEmbed('⏹️ Arrêté', 'Lecture arrêtée et bot déconnecté.')] 
        });
      } else {
        await interaction.reply({ 
          embeds: [createErrorEmbed('❌ Erreur', 'Le bot n\'est pas connecté à un salon vocal.')], 
          ephemeral: true 
        });
      }
    }

    // Commande JOIN
    else if (interaction.commandName === 'join') {
      const voiceState = interaction.member.voice;
      if (!voiceState.channel) {
        return interaction.reply({ 
          embeds: [createErrorEmbed('❌ Erreur', 'Vous devez être dans un salon vocal.')], 
          ephemeral: true 
        });
      }

      try {
        const connection = joinVoiceChannel({
          channelId: voiceState.channel.id,
          guildId: voiceState.guild.id,
          adapterCreator: voiceState.guild.voiceAdapterCreator,
        });

        currentConnections.set(interaction.guild.id, connection);

        await interaction.reply({ 
          embeds: [createSuccessEmbed('✅ Connecté', `Rejoint ${voiceState.channel.name}`)] 
        });
      } catch (error) {
        await interaction.reply({ 
          embeds: [createErrorEmbed('❌ Erreur', 'Impossible de rejoindre le salon vocal.')], 
          ephemeral: true 
        });
      }
    }

    // Commande LEAVE
    else if (interaction.commandName === 'leave') {
      const connection = currentConnections.get(interaction.guild.id);
      if (connection) {
        botLeaving = true;
        connection.destroy();
        currentConnections.delete(interaction.guild.id);
        setTimeout(() => botLeaving = false, 1000);
        
        await interaction.reply({ 
          embeds: [createSuccessEmbed('👋 Déconnecté', 'Bot déconnecté du salon vocal.')] 
        });
      } else {
        await interaction.reply({ 
          embeds: [createErrorEmbed('❌ Erreur', 'Le bot n\'est pas connecté à un salon vocal.')], 
          ephemeral: true 
        });
      }
    }

    // Commande STATS
    else if (interaction.commandName === 'stats') {
      const sortedStats = Array.from(soundStats.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      if (sortedStats.length === 0) {
        return interaction.reply({ 
          embeds: [createErrorEmbed('📊 Statistiques', 'Aucune statistique disponible.')], 
          ephemeral: true 
        });
      }

      const totalPlays = Array.from(soundStats.values()).reduce((sum, count) => sum + count, 0);
      
      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle('📊 Statistiques d\'utilisation')
        .setDescription('**Top 10 des sons les plus utilisés:**\n\n' + 
          sortedStats.map(([ sound, count], index) => 
            `**${index + 1}.** ${sound} - ${count} fois`
          ).join('\n')
        )
        .setFooter({ text: `Total: ${totalPlays} lectures • ${getSoundFiles().length} sons disponibles` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Commande RANDOM
    else if (interaction.commandName === 'random') {
      const sounds = getSoundFiles();
      if (sounds.length === 0) {
        return interaction.reply({ 
          embeds: [createErrorEmbed('❌ Erreur', 'Aucun son disponible.')], 
          ephemeral: true 
        });
      }

      const randomSound = sounds[Math.floor(Math.random() * sounds.length)];
      let targetChannel = interaction.options.getChannel('channel');

      if (!targetChannel) {
        const voiceState = interaction.member.voice;
        if (!voiceState.channel) {
          return interaction.reply({ 
            embeds: [createErrorEmbed('❌ Erreur', 'Vous devez être dans un salon vocal ou spécifier un salon.')], 
            ephemeral: true 
          });
        }
        targetChannel = voiceState.channel;
      }

      await playSound(interaction, randomSound, targetChannel);
    }

    // Commande CONFIG
    else if (interaction.commandName === 'config') {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'volume') {
        const value = interaction.options.getNumber('value');
        config.volume = value;
        saveConfig();
        
        await interaction.reply({ 
          embeds: [createSuccessEmbed('🔊 Volume configuré', `Volume par défaut défini à ${Math.round(value * 100)}%`)] 
        });
      }
      
      else if (subcommand === 'autoreconnect') {
        const enabled = interaction.options.getBoolean('enabled');
        config.autoReconnect = enabled;
        saveConfig();
        
        await interaction.reply({ 
          embeds: [createSuccessEmbed('🔄 Reconnexion automatique', `${enabled ? 'Activée' : 'Désactivée'}`)] 
        });
      }
      
      else if (subcommand === 'show') {
        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle('⚙️ Configuration actuelle')
          .addFields(
            { name: '🔊 Volume par défaut', value: `${Math.round(config.volume * 100)}%`, inline: true },
            { name: '🔄 Reconnexion auto', value: config.autoReconnect ? 'Activée' : 'Désactivée', inline: true },
            { name: '📁 Sons maximum', value: config.maxSounds.toString(), inline: true },
            { name: '📏 Taille max fichier', value: formatFileSize(config.maxFileSize), inline: true },
            { name: '🎵 Formats supportés', value: config.allowedFormats.join(', '), inline: false }
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }

  } catch (error) {
    console.error('❌ Erreur lors du traitement de la commande:', error);
    
    const errorEmbed = createErrorEmbed('❌ Erreur système', 'Une erreur inattendue s\'est produite.');
    
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
    } else {
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
    }
  }
});

// -------- Gestion des états vocaux --------
client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.member.id !== client.user.id) return;

  // Reconnexion automatique si le bot est kické
  if (!newState.channel && oldState.channel && !botLeaving && config.autoReconnect) {
    console.log('⚠️ Bot déconnecté involontairement, reconnexion...');
    setTimeout(() => {
      try {
        joinVoiceChannel({
          channelId: oldState.channel.id,
          guildId: oldState.guild.id,
          adapterCreator: oldState.guild.voiceAdapterCreator,
        });
      } catch (error) {
        console.error('❌ Erreur lors de la reconnexion:', error);
      }
    }, 2000);
  }

  // Logs des changements d'état
  if (oldState.selfMute !== newState.selfMute) {
    console.log(`🔇 Bot ${newState.selfMute ? 'muté' : 'démuté'}`);
  }
  if (oldState.selfDeaf !== newState.selfDeaf) {
    console.log(`🎧 Bot ${newState.selfDeaf ? 'sourdine activée' : 'sourdine désactivée'}`);
  }
});

// -------- Événements du client --------
client.once('ready', () => {
  console.log(`🤖 ${client.user.tag} est connecté et prêt !`);
  console.log(`📊 ${getSoundFiles().length} sons chargés`);
  console.log(`🎮 ${commands.length} commandes disponibles`);
  
  client.user.setActivity(`/play • ${getSoundFiles().length} sons`, { type: 'LISTENING' });
});

client.on('error', error => {
  console.error('❌ Erreur client:', error);
});

// -------- Démarrage --------
process.on('unhandledRejection', error => {
  console.error('❌ Unhandled promise rejection:', error);
});

process.on('SIGINT', () => {
  console.log('🛑 Arrêt du bot...');
  saveSoundStats();
  saveConfig();
  process.exit(0);
});

client.login(process.env.TOKEN);