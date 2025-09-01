const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const fetch = require('node-fetch');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

// -------- Commandes --------
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Joue un soundboard dans un salon vocal')
    .addStringOption(option =>
      option.setName('nom')
        .setDescription('Nom du fichier audio (sans extension)')
        .setRequired(true)
    )
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Salon vocal où jouer le son')
        .setRequired(true)
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
        .setDescription('Fichier audio (mp3 ou wav)')
        .setRequired(true)
    )
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

// Enregistrer les commandes
(async () => {
  try {
    console.log('Enregistrement des commandes (/)...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Commandes enregistrées !');
  } catch (error) {
    console.error(error);
  }
})();

// -------- Gestion des commandes --------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // ---- Commande PLAY ----
  if (interaction.commandName === 'play') {
    const soundName = interaction.options.getString('nom');
    const channel = interaction.options.getChannel('channel');

    if (!channel.isVoiceBased()) {
      return interaction.reply({ content: '❌ Le salon choisi doit être vocal.', ephemeral: true });
    }

    const filePath = `./sounds/${soundName}.mp3`;
    if (!fs.existsSync(filePath)) {
      return interaction.reply({ content: `❌ Le fichier ${soundName}.mp3 n'existe pas.`, ephemeral: true });
    }

    await interaction.reply(`▶️ Lecture de **${soundName}** dans ${channel.name}`);

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    const player = createAudioPlayer();
    const resource = createAudioResource(filePath);
    connection.subscribe(player);

    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
      connection.destroy();
    });
  }

  // ---- Commande ADDSOUND ----
  if (interaction.commandName === 'addsound') {
    const name = interaction.options.getString('nom');
    const file = interaction.options.getAttachment('fichier');

    if (!file.name.endsWith('.mp3') && !file.name.endsWith('.wav')) {
      return interaction.reply({ content: '❌ Seuls les fichiers `.mp3` ou `.wav` sont acceptés.', ephemeral: true });
    }

    const savePath = `./sounds/${name}.mp3`; // on convertit tout en .mp3 localement

    try {
      const res = await fetch(file.url);
      const buffer = await res.buffer();
      fs.writeFileSync(savePath, buffer);

      await interaction.reply(`✅ Son **${name}** ajouté avec succès ! Utilise \`/play ${name}\` pour le lancer.`);
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: '❌ Erreur lors du téléchargement du fichier.', ephemeral: true });
    }
  }
});

client.login(process.env.TOKEN);
